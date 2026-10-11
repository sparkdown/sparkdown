import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import type { Tab } from '../tabs';
import { parseRemoteRecent } from '../remote';
import { dirname, debounce, isUnderRoot } from '../utils';
import { api, type FsChange } from '../api';
import type { AppContext } from './context';
import type { DocumentController } from './documents';
import type { PaneController } from './panes';
import type { DiffController } from './diff';
import type { CockpitController } from './cockpit';
import type { SearchView } from '../search-view';

/** Cap on how many recent folders we remember for the welcome screen. */
const MAX_RECENT_FOLDERS = 8;

/** The slices of sibling controllers the workspace drives. */
export interface WorkspaceDeps {
  documents: Pick<
    DocumentController,
    'openFilesInOrder' | 'blockLocalPathWhileRemote' | 'closePristineUntitled' | 'isSaving'
  >;
  panes: Pick<PaneController, 'renderPreview' | 'setBaseDir'>;
  diff: Pick<
    DiffController,
    'setRoot' | 'followRoot' | 'refreshNow' | 'refreshSoon' | 'showDiffForTab'
  >;
  cockpit: Pick<CockpitController, 'setCwd'>;
  /** The sidebar's Search in files view: searches the workspace folder. */
  search: Pick<SearchView, 'setRoot'>;
  /** Empty state when no tab is open, editor otherwise (after a root change). */
  syncEmptyState(): void;
  /** App.openFolder: routes through the remote handler when one is set. */
  openFolder(dir: string): Promise<void>;
}

/**
 * The workspace folder: Open Folder / drops, the explorer root, recent
 * folders, the filesystem watcher, and re-syncing open tabs when a file
 * changes on disk (the agent-cockpit loop: an agent writes, the panes follow).
 */
export class WorkspaceController {
  // Root currently being watched (and on which machine), so we don't restart
  // the watcher on every tab switch within the same folder. The backend
  // stops watching on every remote connect/disconnect, so an origin switch
  // must drop this (resetForOriginSwitch).
  private watched: { origin: string | null; root: string } | null = null;
  private debouncedTreeRefresh = debounce(() => void this.ctx.fileTree.refresh(), 200);
  // Raw notify events are filtered in Rust but can still arrive in a burst
  // for one save; coalesce paths before flashing or reloading the UI.
  private pendingFsChanges = new Map<string, FsChange>();
  private debouncedFsChanges = debounce(() => {
    const changes = [...this.pendingFsChanges.values()];
    this.pendingFsChanges.clear();
    void this.handleFsChanges(changes);
  }, 250);


  constructor(
    private readonly ctx: AppContext,
    private readonly deps: WorkspaceDeps,
  ) {}

  /**
   * Handle files/folders dropped onto the window from Finder. Tauri intercepts
   * the OS drag at the webview layer, so HTML5 drop events never fire — we
   * listen to Tauri's own drag-drop event instead, which is window-global
   * (anywhere in the window, including the sidebar or editor, counts).
   *
   * A dropped directory becomes the sidebar root; dropped files open as tabs.
   */
  registerFileDrop(): void {
    const appEl = document.getElementById('app');
    void getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === 'enter' || payload.type === 'over') {
        appEl?.classList.add('drag-over');
      } else if (payload.type === 'leave') {
        appEl?.classList.remove('drag-over');
      } else if (payload.type === 'drop') {
        appEl?.classList.remove('drag-over');
        if (payload.paths.length > 0) void this.openDroppedPaths(payload.paths);
      }
    });
  }

  /** Open dropped files as tabs; a dropped directory becomes the sidebar root. */
  async openDroppedPaths(paths: string[]): Promise<void> {
    // Finder paths are local; while remote they would be read on the host.
    if (await this.deps.documents.blockLocalPathWhileRemote('Opening dropped files')) return;
    const kinds = await Promise.all(
      paths.map((p) => api.isDirectory(p).catch(() => false)),
    );
    const files = paths.filter((_, i) => !kinds[i]);
    const dirs = paths.filter((_, i) => kinds[i]);

    await this.deps.documents.openFilesInOrder(files);
    // If a folder was dropped, point the sidebar at it (last one wins) and
    // reveal the sidebar so the change is visible.
    const lastDir = dirs[dirs.length - 1];
    if (lastDir) {
      this.ctx.fileTree.ensureVisible();
      this.ctx.workspaceRoot = lastDir;
      this.deps.syncEmptyState();
      void this.ctx.fileTree.setRoot(lastDir, true);
      this.deps.diff.setRoot(lastDir);
      // Badge and tree letters now, not only after the first disk change.
      this.deps.diff.refreshNow();
      this.deps.search.setRoot(lastDir);
      void this.ensureWatching(lastDir);
    }
  }

  /**
   * Pick a folder and make it the workspace root: point the explorer at it and
   * start watching it, without needing to open a file first. This is the
   * cockpit entry point — "open the folder my agent is working in."
   */
  async openFolderDialog(): Promise<void> {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === 'string') await this.deps.openFolder(dir);
  }

  /**
   * Make `dir` the workspace root: point the explorer at it, watch it, and
   * root git status and new terminals there. Already-resolved local or
   * remote path — remote routing happens before this (App.openFolder).
   */
  async openFolder(dir: string): Promise<void> {
    this.deps.documents.closePristineUntitled();
    this.ctx.workspaceRoot = dir;
    this.deps.syncEmptyState();
    // Show the explorer before rendering it: a tree rendered into a hidden
    // sidebar measures a 0-height viewport and mounts only a few rows (#29).
    this.ctx.fileTree.ensureVisible();
    await this.ctx.fileTree.setRoot(dir, true);
    this.ctx.baseDir = dir;
    this.deps.panes.setBaseDir(dir);
    this.deps.cockpit.setCwd(dir);
    this.deps.diff.setRoot(dir);
    this.deps.diff.refreshNow();
    this.deps.search.setRoot(dir);
    void this.ensureWatching(dir);
    this.rememberRecentFolder(dir);
    this.ctx.saveConfigSoon();
    this.ctx.publishContextSoon();
    if (!this.ctx.tabs.activeTab()) void this.deps.panes.renderPreview('');
  }

  /**
   * The active machine changed (remote connect / disconnect / host switch).
   * Everything that names a path on the old machine goes: the explorer root,
   * workspace root, base dir, Changes root, terminal cwd, the watcher pin
   * and any queued watcher events. Otherwise a stale tree entry would read
   * a same-path file on the new machine. A connect opens its folder next.
   */
  resetForOriginSwitch(): void {
    this.watched = null;
    this.pendingFsChanges.clear();
    this.ctx.workspaceRoot = null;
    this.ctx.baseDir = null;
    this.ctx.fileTree.clear();
    this.deps.diff.setRoot(null);
    this.deps.diff.refreshNow();
    this.deps.search.setRoot(null);
    this.deps.cockpit.setCwd(null);
  }

  /** Record `dir` at the front of the recent-folders list (deduped, capped).
   *  Remote sessions store `ssh://host/abs/path` (see remote.ts); when that
   *  form is written we also drop any bare-path twin so the list stays clean. */
  rememberRecentFolder(dir: string): void {
    const remote = parseRemoteRecent(dir);
    const drop = new Set<string>([dir]);
    if (remote) drop.add(remote.path);
    const recents = [dir, ...(this.ctx.config.recent_folders ?? []).filter((d) => !drop.has(d))];
    this.ctx.config.recent_folders = recents.slice(0, MAX_RECENT_FOLDERS);
    // Persist even when remote.ts rewrites a bare path → ssh://host/path after
    // openFolder already scheduled a save (debounce may have already fired).
    this.ctx.saveConfigSoon();
  }

  updateBaseDirForTab(tab: Tab): void {
    // A kept (dirty) tab from another machine: its path means nothing here,
    // so it must not re-root the tree, the watcher or relative links.
    if (!tab.path || tab.origin !== this.ctx.tabs.getOrigin()) {
      this.ctx.fileTree.setCurrentPath(null);
      return;
    }
    const dir = dirname(tab.path);
    this.ctx.baseDir = dir;
    this.deps.panes.setBaseDir(dir);
    // Mark the open file in the tree without the watcher-flash class. This
    // is the #27 contract: activating a tab is not a disk change.
    this.ctx.fileTree.setCurrentPath(tab.path);
    // Open-a-file (no folder yet) still points the explorer at that file's
    // directory. Once a workspace folder is open, tab focus must not re-root
    // the tree or restart the watcher — both collapsed into a false "changed"
    // signal on Linux (WebKitGTK / inotify).
    if (!this.ctx.workspaceRoot) {
      void this.ctx.fileTree.setRoot(dir);
      void this.ensureWatching(dir);
      // No folder open: search where the explorer is rooted.
      const treeRoot = this.ctx.fileTree.getRoot();
      if (treeRoot) this.deps.search.setRoot(treeRoot);
      // Git status follows the explorer, so the Diff view and the branch
      // work for a file opened without a folder too.
      this.deps.diff.followRoot(dir);
    }
  }

  /**
   * Watch `root` for filesystem changes so the panes reflect what an agent
   * (running in the terminal, or anywhere) writes to disk. Agent-agnostic:
   * we watch files, not any specific tool. Restarts if the root changed.
   */
  private async ensureWatching(root: string): Promise<void> {
    // Already watching this root, or an ancestor, on this machine (tab
    // switch into a subdir must not drop and recreate the inotify watch —
    // that burst is what flashed the active file on Linux).
    const origin = this.ctx.tabs.getOrigin();
    const w = this.watched;
    if (w && w.origin === origin && (w.root === root || isUnderRoot(root, w.root))) {
      return;
    }
    try {
      await api.watchStart(root);
      this.watched = { origin, root };
    } catch {
      this.watched = null;
    }
  }

  /** Subscribe to debounced filesystem-change batches from the watcher. */
  registerWatcher(): void {
    this.ctx.listenTauri<FsChange[]>('watcher://changes', (e) => {
      this.onFsChanges(e.payload);
    });
  }

  /**
   * A batch of filesystem changes arrived (debounced in Rust). Refresh the
   * explorer and re-sync every open tab whose file changed on disk (see
   * syncTabWithDisk): clean tabs reload, dirty tabs are flagged as conflicted
   * and save() asks before it overwrites.
   */
  private onFsChanges(changes: FsChange[]): void {
    for (const change of changes) {
      const previous = this.pendingFsChanges.get(change.path);
      // Preserve a structural event if a later modify event for the same path
      // arrives in the same burst.
      if (!previous || change.kind !== 'modify') this.pendingFsChanges.set(change.path, change);
    }
    this.debouncedFsChanges();
  }

  private async handleFsChanges(changes: FsChange[]): Promise<void> {
    // Content-only writes do not change the directory structure. Avoid
    // remounting the virtualized tree for them: the flash and git badge are
    // enough, and preserving the existing DOM eliminates explorer blink.
    // Create/remove/rename (and unknown platform events) still refresh so the
    // tree reflects structural changes and keeps #74 expansion persistence.
    if (changes.some((change) => change.kind !== 'modify')) {
      this.debouncedTreeRefresh();
    }
    // Flash the changed files in the explorer so agent activity is visible.
    this.ctx.fileTree.markChanged(changes.map((c) => c.path));
    // Keep the Changes list live if it's showing; otherwise just the badge.
    this.deps.diff.refreshSoon();

    // Re-check every open file tab the batch may cover. The local watcher
    // reports file paths; the remote poller reports only the workspace
    // root, so a change at a directory counts for every tab below it.
    // Only tabs of the active machine: the watcher reports that machine's
    // disk, and a kept tab from another machine must not sync against it.
    const origin = this.ctx.tabs.getOrigin();
    const touched = (path: string) =>
      changes.some((c) => c.path === path || isUnderRoot(path, c.path));
    const tabs = this.ctx.tabs
      .getAllTabs()
      .filter((t) => t.path && t.origin === origin && touched(t.path));
    await Promise.all(tabs.map((t) => this.syncTabWithDisk(t.id, t.path!)));

    // An open diff view reads from git, not the tab buffer, so syncTabWithDisk
    // doesn't repaint it. If the active tab is showing its diff and its file is
    // in this batch, re-render the diff so it tracks what the agent just wrote.
    const active = this.ctx.tabs.activeTab();
    if (active?.viewMode === 'diff' && active.path && active.origin === origin && touched(active.path)) {
      void this.deps.diff.showDiffForTab(active);
    }
  }

  /**
   * Compare one tab with its file on disk after a watcher event. The tab's
   * savedContent is the text we last read from or wrote to disk, so a
   * matching disk read is a no-op (this is what filters our own saves).
   * - clean tab: take the disk text (active: into the editor; background:
   *   into the model, dropping the cached editor state so a switch shows it)
   * - dirty tab: keep the user's text and flag a conflict for save().
   */
  private async syncTabWithDisk(tabId: string, path: string): Promise<void> {
    const before = this.ctx.tabs.getTab(tabId);
    if (!before) return;
    const expectedContent = before.content;
    let disk: string;
    try {
      disk = await api.readFile(path);
    } catch {
      return; // removed/renamed mid-read; the tree refresh covers it
    }
    const tab = this.ctx.tabs.getTab(tabId);
    if (!tab || tab.path !== path || this.deps.documents.isSaving(tabId)) return;
    // The origin switched during the read: the text came from another disk.
    if (tab.origin !== this.ctx.tabs.getOrigin()) return;
    if (disk === tab.savedContent) {
      // No real change, or our own save. If the disk went back to our
      // baseline, an earlier conflict no longer applies.
      if (tab.diskConflict) this.ctx.tabs.setDiskConflict(tabId, false);
      return;
    }
    const isActive = tab.id === this.ctx.tabs.activeTab()?.id;
    // Compare the live editor text for the active tab: tab.content lags
    // behind typing only by the event loop, but be exact.
    const current = isActive ? this.ctx.editor.getContent() : tab.content;
    if (tab.modified || current !== expectedContent) {
      this.ctx.tabs.setDiskConflict(tabId, true);
      return;
    }
    this.ctx.tabs.reloadFromDisk(tabId, disk);
    if (isActive) {
      // Apply the disk text as a transaction (not loadFresh/setState) so the
      // reader keeps their undo history, cursor and scroll. reloadFromDisk
      // already reset the saved baseline, so the docChanged this fires
      // recomputes preview/TOC/counts and lands on "not modified".
      this.ctx.editor.replaceContentPreservingView(disk);
      this.ctx.statusbar.updateModified(false);
    } else {
      this.ctx.editor.forgetState(tabId);
    }
    this.ctx.publishContextSoon();
  }
}
