import type { Tab } from '../tabs';
import {
  ChangesView,
  renderUnifiedDiff,
  summarizeDiff,
  type OpenHow,
} from '../changes-view';
import { api, type GitChange } from '../api';
import type { Command } from '../commands';
import { EVENTS } from '../event-names';
import { effectiveView } from '../view-mode';
import {
  debounce,
  isMarkdownFile,
  joinPath,
  normalizePathForCompare,
  toRelativePath,
} from '../utils';
import type { AppContext } from './context';
import { syncEditorInput } from './editor-gate';
import { PreviewSearch } from '../preview-search';

/** What the diff controller needs from the App. */
export interface DiffDeps {
  /** Re-run the tab-switch pipeline (editor, preview, status, diff pane). */
  applyTabSwitch(tab: Tab): void;
  /** A fresh status arrived: files still to review (activity badge). */
  onChangeCount(count: number): void;
  /** A fresh git status arrived (the view control's Diff availability
   *  depends on it). */
  onGitStatus(): void;
  /** Switch the active document to Diff (ViewModeController.setViewMode). */
  showDiffView?(): void;
  /** Open `path` in the editor at `line` (leaves the diff view). */
  openAt?(path: string, line: number, column: number): void | Promise<void>;
}

/** The diff pane's elements, captured once at init. */
interface DiffDom {
  list: HTMLElement | null;
  view: HTMLElement | null;
  body: HTMLElement | null;
  title: HTMLElement | null;
  meta: HTMLElement | null;
  prev: HTMLButtonElement | null;
  next: HTMLButtonElement | null;
  review: HTMLElement | null;
  reading: HTMLElement | null;
  full: HTMLElement | null;
  editorArea: HTMLElement | null;
}

const isDiff = (tab: Tab | null | undefined): boolean =>
  !!tab && effectiveView(tab.viewMode, tab.path) === 'diff';

/**
 * Git changes: the sidebar Changes review queue (and its badge), the
 * per-file git letters in the explorer, the status bar's branch +
 * ahead/behind, and the diff pane — the Diff view of a file tab (see
 * ViewModeController) — with its header (path, hunks, +/−, Reading | Full,
 * previous / next file, Mark reviewed).
 */
export class DiffController {
  private changesView: ChangesView | null = null;
  private changesMode = false; // the sidebar is showing the Changes view
  // Diff pane: "reading" (meat-abridged) vs full verbatim. Reading by default,
  // matching the meat philosophy; the header control flips it (sticky across
  // diff tabs for the session).
  private diffReading = true;
  private debouncedChangesRefresh = debounce(() => void this.changesView?.refresh(), 400);
  private debouncedChangesCount = debounce(() => void this.changesView?.refreshCount(), 600);
  /** Root git status was last pointed at (see setRoot). */
  private gitRoot: string | null = null;
  /** Changed files from the last git status (normalized absolute paths). */
  private changed = new Set<string>();
  /** Repo the last branch query asked about; drops out-of-order answers. */
  private branchRepo: string | null = null;
  private debouncedBranch = debounce(() => void this.refreshBranch(), 300);
  /** The tab queue navigation opened for a file that had no tab: replaced
   *  (closed, if unmodified) when the queue moves to another file, so j/k
   *  through twenty files doesn't leave twenty tabs. */
  private previewTabId: string | null = null;
  /** Bumped per queue navigation; a slower earlier open drops out. */
  private navToken = 0;
  /** Find (⌘F) over the diff body; built on first use. */
  private search: PreviewSearch | null = null;
  /** Summary of the diff on screen (header meta), keyed by tab id. */
  private shownDiff: { tabId: string; hunks: number; adds: number; dels: number } | null = null;
  private dom: DiffDom = {
    list: null,
    view: null,
    body: null,
    title: null,
    meta: null,
    prev: null,
    next: null,
    review: null,
    reading: null,
    full: null,
    editorArea: null,
  };

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: DiffDeps,
  ) {}

  init(): void {
    const $ = (id: string) => document.getElementById(id);
    this.dom = {
      list: $('changes-list'),
      view: $('diff-view'),
      body: $('diff-body'),
      title: $('diff-title'),
      meta: $('diff-meta'),
      prev: $('diff-prev') as HTMLButtonElement | null,
      next: $('diff-next') as HTMLButtonElement | null,
      review: $('diff-review'),
      reading: $('diff-mode-reading'),
      full: $('diff-mode-full'),
      editorArea: $('editor-area'),
    };
    const list = this.dom.list;
    if (!list) return;
    this.changesView = new ChangesView(
      list,
      (path, status, how) => void this.openFromQueue(path, status, how),
      (changes) => this.applyGitStatus(changes),
      {
        origin: () => this.ctx.tabs.getOrigin(),
        onPending: (pending) => this.deps.onChangeCount(pending),
        onReviewChange: () => this.syncDiffHeader(),
      },
    );
    $('btn-changes-refresh')?.addEventListener('click', () => void this.changesView?.refresh());
    this.dom.reading?.addEventListener('click', () => this.setDiffReading(true));
    this.dom.full?.addEventListener('click', () => this.setDiffReading(false));
    this.dom.prev?.addEventListener('click', () => this.stepFile(-1));
    this.dom.next?.addEventListener('click', () => this.stepFile(1));
    this.dom.review?.addEventListener('click', () => this.toggleActiveReviewed());
    this.dom.body?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.diff-open-line');
      if (btn) void this.openActiveAtLine(Number(btn.dataset.line) || 1);
    });
    // Review keys while the diff pane has focus (never the editor/terminal:
    // those are outside #diff-view; nor the find widget's input).
    this.dom.view?.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const cv = this.changesView;
      const rel = this.queuePathForTab(this.ctx.tabs.activeTab());
      if (!cv || !rel) return;
      cv.select(rel);
      if (cv.handleKey(e, { enter: false })) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }

  /** Point git status at a new folder. */
  setRoot(dir: string | null): void {
    this.gitRoot = dir;
    this.changesView?.setRoot(dir);
  }

  /** No folder open: point git status at the active file's folder, and
   *  refresh only when that folder changed. */
  followRoot(dir: string): void {
    if (dir === this.gitRoot) return;
    this.setRoot(dir);
    this.refreshNow();
  }

  /** Refresh now: the full list if it's showing, otherwise just the badge. */
  refreshNow(): void {
    if (this.changesMode) void this.changesView?.refresh();
    else void this.changesView?.refreshCount();
  }

  /**
   * A tab was saved. A save is a known change on the active machine: refresh
   * Changes (and an open diff of that file) now instead of waiting for the
   * watcher. The remote watcher is a poll, so on a large or slow host its
   * tick can arrive late or not at all (#28).
   */
  onTabSaved(tab: Tab): void {
    if (tab.origin !== this.ctx.tabs.getOrigin()) return;
    this.refreshSoon();
    const active = this.ctx.tabs.activeTab();
    if (active && active.id === tab.id && active.viewMode === 'diff') {
      void this.showDiffForTab(active);
    }
  }

  /** Keep the Changes list live if it's showing; otherwise just the badge. */
  refreshSoon(): void {
    if (this.changesMode) this.debouncedChangesRefresh();
    else this.debouncedChangesCount();
  }

  /** Reading (abridged) vs full verbatim diff, then re-render if the diff
   *  view is showing. */
  private setDiffReading(reading: boolean): void {
    if (this.diffReading === reading) return;
    this.diffReading = reading;
    const tab = this.ctx.tabs.activeTab();
    if (tab && isDiff(tab)) void this.showDiffForTab(tab);
    else this.updateDiffModeToggle();
  }

  /** Whether `tab`'s file has git changes on the active machine (so its Diff
   *  view has something to show). A tab opened from the Changes list does,
   *  even when deleted (it has no working-tree file to match). */
  hasChanges(tab: Tab): boolean {
    if (!tab.path || tab.origin !== this.ctx.tabs.getOrigin()) return false;
    return !!tab.gitDiff || this.changed.has(normalizePathForCompare(tab.path));
  }

  /** Put the active tab in Diff: through the view controller when wired
   *  (the App), else directly (tests without a view controller). */
  private showActiveAsDiff(): void {
    const tab = this.ctx.tabs.activeTab();
    if (!tab || isDiff(tab)) return;
    if (this.deps.showDiffView) {
      this.deps.showDiffView();
      return;
    }
    this.ctx.tabs.setActiveViewMode('diff');
    this.ctx.bus.emit(EVENTS.TAB_SAVE_STATE, { tabId: tab.id });
    this.deps.applyTabSwitch(tab);
  }

  /** The repo root change paths resolve against. */
  private repoRoot(): string | null {
    return this.changesView?.getRepoRoot() ?? this.ctx.fileTree.getRoot() ?? this.ctx.baseDir;
  }

  /** The queue path (repo-relative) of `tab`'s file, or null when the file
   *  is not in the current change list (or lives on another machine). */
  queuePathForTab(tab: Tab | null): string | null {
    const cv = this.changesView;
    const root = cv?.getRepoRoot();
    if (!cv || !root || !tab?.path || tab.origin !== this.ctx.tabs.getOrigin()) return null;
    const rel =
      tab.gitDiff && tab.gitDiff.root === root
        ? tab.gitDiff.relPath
        : toRelativePath(tab.path, root);
    return rel && cv.change(rel) ? rel : null;
  }

  /** A row was activated in the queue (click, j/k, Space, Enter). */
  private async openFromQueue(
    relPath: string,
    status: GitChange['status'],
    how: OpenHow,
  ): Promise<void> {
    if (how === 'editor') return this.openInEditorAtFirstChange(relPath, status);
    // Keep keyboard focus where the review is happening (the list or the
    // diff pane): opening a tab runs the tab-switch pipeline, which focuses
    // the editor on the way.
    const active = document.activeElement as HTMLElement | null;
    const keepFocus =
      active && active.closest('#sidebar-changes, #diff-view') ? active : null;
    const token = ++this.navToken;
    const root = this.repoRoot();
    const abs = root ? joinPath(root, relPath) : relPath;
    const before = this.previewTabId ? this.ctx.tabs.getTab(this.previewTabId) : null;
    const existing = this.ctx.tabs.findByPath(abs);
    const opened = await this.openChangeInDiff(relPath, status, () => token === this.navToken);
    if (!opened) return;
    const now = this.ctx.tabs.activeTab();
    if (before && now && before.id !== now.id && !before.modified) {
      this.ctx.tabs.closeTab(before.id);
    }
    if (now) {
      if (!existing) this.previewTabId = now.id;
      else if (before?.id !== now.id) this.previewTabId = null;
    }
    if (keepFocus?.isConnected) keepFocus.focus({ preventScroll: true });
    else if (keepFocus) this.dom.list?.focus({ preventScroll: true });
  }

  /**
   * Open a file from the Changes queue and switch it into diff view. The
   * diff is a view mode of a normal file tab, so this opens (or focuses) the
   * file, then switches it to Diff. Deleted files can't be read into a
   * buffer, so they open empty — the diff still shows what was removed.
   * `stillWanted` lets a newer navigation cancel this one after the read.
   */
  private async openChangeInDiff(
    relPath: string,
    status: GitChange['status'],
    stillWanted: () => boolean = () => true,
  ): Promise<boolean> {
    // Change paths are relative to the repo's top level — which is NOT
    // necessarily the sidebar root (opening a file re-roots the tree to its
    // parent dir). Resolving against the wrong base built paths to
    // nonexistent files and re-rooted the tree into the void.
    const root = this.repoRoot();
    const abs = root ? joinPath(root, relPath) : relPath;
    let content = '';
    const existing = this.ctx.tabs.findByPath(abs);
    if (status !== 'deleted' && !existing) {
      try {
        content = await api.readFile(abs);
      } catch {
        // Unreadable (e.g. binary or vanished) — open empty; the diff still renders.
      }
    }
    if (!stillWanted()) return false;
    this.ctx.tabs.openTab(abs, content);
    // Capture git's own path + root so the diff query stays valid even after
    // opening the file re-roots the tree (updateBaseDirForTab).
    if (root) this.ctx.tabs.setActiveGitDiff(root, relPath);
    this.showActiveAsDiff();
    return true;
  }

  /** Shift+Enter: open the file in the editor at its first changed line. */
  private async openInEditorAtFirstChange(
    relPath: string,
    status: GitChange['status'],
  ): Promise<void> {
    const root = this.repoRoot();
    if (!root || status === 'deleted' || !this.deps.openAt) {
      await this.openChangeInDiff(relPath, status);
      return;
    }
    let line = 1;
    try {
      const diff = await api.gitDiffFile(root, relPath, status === 'untracked');
      line = summarizeDiff(diff).firstLine;
    } catch {
      // No diff: the top of the file.
    }
    await this.deps.openAt(joinPath(root, relPath), line, 1);
  }

  /** "Open in editor" on a hunk of the diff on screen. */
  private async openActiveAtLine(line: number): Promise<void> {
    const tab = this.ctx.tabs.activeTab();
    if (!tab?.path || !this.deps.openAt) return;
    await this.deps.openAt(tab.path, line, 1);
  }

  /** ↑ / ↓ in the diff header (and the palette): the previous / next file
   *  of the queue, from the file on screen. */
  stepFile(delta: 1 | -1): void {
    const cv = this.changesView;
    if (!cv) return;
    const from = this.queuePathForTab(this.ctx.tabs.activeTab()) ?? cv.getCurrent();
    cv.move(delta, from);
  }

  /** Space from the palette: mark the file on screen (or the selection)
   *  reviewed and open the next pending one. */
  markReviewedAndNext(): void {
    const cv = this.changesView;
    if (!cv) return;
    const rel = this.queuePathForTab(this.ctx.tabs.activeTab()) ?? cv.startFile();
    cv.markReviewedAndNext(rel);
  }

  /** The header's Mark reviewed / Mark as pending. */
  private toggleActiveReviewed(): void {
    const rel = this.queuePathForTab(this.ctx.tabs.activeTab());
    if (rel) this.changesView?.toggleReviewed(rel);
  }

  /** Review commands for the palette (commands.ts). */
  reviewCommands(): Command[] {
    const has = () => !!this.changesView?.hasChanges();
    return [
      {
        id: 'changes.nextFile',
        title: 'Changes: Next file',
        shortcut: '↓',
        keywords: 'review diff down',
        run: () => this.stepFile(1),
        enabled: has,
      },
      {
        id: 'changes.previousFile',
        title: 'Changes: Previous file',
        shortcut: '↑',
        keywords: 'review diff up',
        run: () => this.stepFile(-1),
        enabled: has,
      },
      {
        id: 'changes.markReviewedAndNext',
        title: 'Changes: Mark reviewed and go to next',
        shortcut: 'Space',
        keywords: 'review done check',
        run: () => this.markReviewedAndNext(),
        enabled: has,
      },
      {
        id: 'changes.markAllReviewed',
        title: 'Changes: Mark all as reviewed',
        keywords: 'review done check all',
        run: () => this.changesView?.markAllReviewed(),
        enabled: has,
      },
      {
        id: 'changes.resetReview',
        title: 'Changes: Reset review',
        keywords: 'review clear pending unmark',
        run: () => this.changesView?.resetReview(),
        enabled: has,
      },
    ];
  }

  /**
   * A fresh git status arrived: push per-file status letters into the file
   * tree for inline markers. (The badge counts pending files: onPending.)
   */
  private applyGitStatus(changes: GitChange[]): void {
    const letter: Record<GitChange['status'], string> = {
      modified: 'M',
      added: 'A',
      deleted: 'D',
      renamed: 'R',
      untracked: 'U',
    };
    const map = new Map<string, string>();
    this.changed.clear();
    // git paths are relative to the repo top level, not the sidebar root.
    const root = this.changesView?.getRepoRoot() ?? this.ctx.fileTree.getRoot();
    for (const c of changes) {
      const abs = root ? joinPath(root, c.path) : c.path;
      map.set(abs, letter[c.status]);
      this.changed.add(normalizePathForCompare(abs));
    }
    this.ctx.fileTree.setGitStatus(map);
    this.deps.onGitStatus();
    this.syncDiffHeader();
    // Same tick as the status (watcher-driven, no polling): the branch and
    // its ahead/behind for the status bar.
    if (this.changesView?.getRepoRoot()) this.debouncedBranch();
    else {
      this.branchRepo = null;
      this.ctx.statusbar.setBranch(null);
    }
  }

  /** Ask git for the branch and ahead/behind of the current repo. */
  private async refreshBranch(): Promise<void> {
    const repo = this.changesView?.getRepoRoot() ?? null;
    this.branchRepo = repo;
    if (!repo) {
      this.ctx.statusbar.setBranch(null);
      return;
    }
    try {
      const status = await api.gitBranchStatus(repo);
      if (this.branchRepo !== repo) return; // the repo moved on meanwhile
      this.ctx.statusbar.setBranch(status);
    } catch {
      if (this.branchRepo === repo) this.ctx.statusbar.setBranch(null);
    }
  }

  /**
   * The activity bar switched the sidebar to (or away from) the Changes
   * view. While it shows, the list stays live; otherwise only the badge
   * count is refreshed. Opening it switches the active document to Diff for
   * the selected file (the active file if it is changed, else the first
   * pending one) and puts focus in the list for j/k.
   */
  setChangesMode(on: boolean): void {
    const entering = on && !this.changesMode;
    this.changesMode = on;
    if (!on) return;
    this.changesView?.setRoot(
      this.ctx.workspaceRoot ?? this.ctx.fileTree.getRoot() ?? this.ctx.baseDir,
    );
    const refreshed = this.changesView?.refresh();
    if (entering && refreshed) void refreshed.then(() => this.showQueueInDiff());
  }

  private showQueueInDiff(): void {
    const cv = this.changesView;
    if (!this.changesMode || !cv?.hasChanges()) return;
    const tab = this.ctx.tabs.activeTab();
    const rel = this.queuePathForTab(tab);
    this.dom.list?.focus({ preventScroll: true });
    if (rel && tab) {
      cv.select(rel);
      this.showActiveAsDiff();
      this.dom.list?.focus({ preventScroll: true });
      return;
    }
    const start = cv.startFile();
    if (start) cv.open('diff', start);
  }

  /**
   * Render the active file tab's git diff into the diff pane, showing that
   * pane over the editor/preview split. The tab's editor buffer stays loaded
   * underneath (see applyTabSwitch) so toggling back to editing is instant.
   */
  async showDiffForTab(tab: Tab): Promise<void> {
    const { view, body } = this.dom;
    if (!view || !body) return;

    // Reveal the diff pane; hide the editor/preview split beneath it. The
    // status bar keeps reflecting the file (from applyTabSwitch).
    this.dom.editorArea?.classList.add('hidden');
    view.classList.remove('hidden');
    // The editor underneath must not take keys (it would edit the file
    // unseen): turn its input off, and put focus in the diff pane — where
    // the review keys work — unless it is somewhere that still makes sense
    // (the Changes list, the diff pane, a terminal, a dialog).
    syncEditorInput(this.ctx.editor);
    const active = document.activeElement;
    if (!active || active === document.body || active.closest('#editor-area')) {
      view.focus({ preventScroll: true });
    }
    this.updateDiffModeToggle();
    if (this.shownDiff?.tabId !== tab.id) {
      this.shownDiff = null;
      this.search?.close(); // its hits belong to another file's diff
    }

    // Prefer the git context captured when opened from Changes; otherwise
    // (Diff picked on an ordinary tab) derive it from the repo root — not
    // the sidebar root, which re-roots to an opened file's parent dir.
    const root = tab.gitDiff?.root ?? this.repoRoot();
    const rel =
      tab.gitDiff?.relPath ?? (root ? toRelativePath(tab.path, root) : tab.path);
    const queueRel = this.queuePathForTab(tab);
    if (queueRel) this.changesView?.select(queueRel);
    this.syncDiffHeader();
    if (!root || !rel) {
      body.innerHTML = '<div class="diff-empty">No folder open.</div>';
      return;
    }
    body.innerHTML = '<div class="diff-empty">Loading diff…</div>';
    const change = this.changesView?.change(rel);
    // Guard against a fast tab switch resolving out of order: only paint if
    // this tab is still active (and still in diff view) when it comes back.
    try {
      const diff = await api.gitDiffFile(
        root,
        rel,
        this.changesView?.isUntracked(rel) ?? false,
      );
      const active = this.ctx.tabs.activeTab();
      if (active?.id !== tab.id || !isDiff(active)) return;
      const deleted = change?.status === 'deleted';
      body.innerHTML = renderUnifiedDiff(diff, {
        reading: this.diffReading,
        markdown: !deleted && isMarkdownFile(tab.path) ? tab.content : null,
        openInEditor: !deleted && !!this.deps.openAt,
      });
      body.scrollTop = 0;
      this.shownDiff = { tabId: tab.id, ...summarizeDiff(diff) };
      this.syncDiffHeader();
    } catch {
      const active = this.ctx.tabs.activeTab();
      if (active?.id !== tab.id || !isDiff(active)) return;
      body.innerHTML = '<div class="diff-empty">Could not load diff.</div>';
    }
  }

  /** Header: name + folder + "N hunks · +a −d"; previous / next / Mark
   *  reviewed only for a file in the review queue. */
  private syncDiffHeader(): void {
    const tab = this.ctx.tabs.activeTab();
    const { title, meta: metaEl, prev, next, review } = this.dom;
    if (!tab || !title) return;
    title.textContent = tab.title;
    const root = tab.gitDiff?.root ?? this.changesView?.getRepoRoot() ?? null;
    const rel = tab.gitDiff?.relPath ?? (root ? toRelativePath(tab.path, root) : null);
    const folder = rel && rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const meta: string[] = [];
    if (folder) meta.push(folder);
    const shown = this.shownDiff?.tabId === tab.id ? this.shownDiff : null;
    if (shown) {
      meta.push(`${shown.hunks} ${shown.hunks === 1 ? 'hunk' : 'hunks'}`);
      const counts = [
        shown.adds > 0 ? `+${shown.adds}` : '',
        shown.dels > 0 ? `−${shown.dels}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      if (counts) meta.push(counts);
    }
    if (metaEl) metaEl.textContent = meta.join(' · ');

    const cv = this.changesView;
    const queueRel = this.queuePathForTab(tab);
    for (const el of [prev, next, review]) if (el) el.hidden = !queueRel;
    if (!cv || !queueRel) return;
    const order = cv.navOrder();
    const idx = order.findIndex((c) => c.path === queueRel);
    if (prev) prev.disabled = idx <= 0;
    if (next) next.disabled = idx === -1 || idx >= order.length - 1;
    if (review) {
      const reviewed = cv.isReviewed(queueRel);
      review.classList.toggle('reviewed', reviewed);
      review.setAttribute('aria-pressed', String(reviewed));
      review.title = reviewed ? 'Mark as pending' : 'Mark reviewed (Space)';
      const label = review.querySelector('.diff-review-label');
      const text = reviewed ? 'Reviewed' : 'Mark reviewed';
      if (label) label.textContent = text;
      else review.textContent = text;
    }
  }

  /** Sync the diff header's Reading | Full control to the current mode. */
  private updateDiffModeToggle(): void {
    this.dom.reading?.setAttribute('aria-pressed', String(this.diffReading));
    this.dom.full?.setAttribute('aria-pressed', String(!this.diffReading));
  }

  /** Hide the diff pane and restore the editor/preview split. */
  hideDiffPane(): void {
    this.search?.close();
    const view = this.dom.view;
    const hadFocus = !!view && view.contains(document.activeElement);
    view?.classList.add('hidden');
    this.dom.editorArea?.classList.remove('hidden');
    syncEditorInput(this.ctx.editor);
    // Focus in the now-hidden pane would strand the keyboard; hand it back to
    // the editor (a no-op when it is hidden too, e.g. Preview-only).
    if (hadFocus) this.ctx.editor.focus();
  }

  /** Find (⌘F) over the diff while the diff pane is on screen. */
  openFind(): boolean {
    const { view, body } = this.dom;
    if (!view || !body || view.classList.contains('hidden')) return false;
    if (!this.search) this.search = new PreviewSearch(view, 'Find in diff');
    this.search.open(body);
    return true;
  }
}
