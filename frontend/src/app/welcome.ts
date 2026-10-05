import { parseRemoteRecent } from '../remote';
import { ACTIONS } from '../event-names';
import { shortcutFor } from '../shortcuts';
import type { AppContext } from './context';
import { syncEditorInput } from './editor-gate';

/** What the welcome screen's buttons and state changes reach. */
export interface WelcomeDeps {
  openFolderDialog(): Promise<void>;
  openFileDialog(): Promise<void>;
  newFile(): void;
  /** ⌘P: the palette's file finder. */
  quickOpen(): void;
  /** App.openFolder (recent entries may be ssh://host/path). */
  openFolder(dir: string): Promise<void>;
  hideDiffPane(): void;
  /** No active tab: hide the title bar's view control. */
  refreshViewControl(): void;
}

/**
 * The empty state, shown whenever no tab is open. Two forms:
 * - no folder: the welcome screen (open folder/file, recent folders);
 * - a folder is open: one centered prompt to pick or find a file, instead of
 *   an empty editor + preview split.
 */
export class WelcomeController {
  private welcomeShown = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: WelcomeDeps,
  ) {}

  init(): void {
    const welcome = document.getElementById('welcome');
    welcome?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const action = target.closest<HTMLElement>('[data-welcome]')?.dataset.welcome;
      if (action === 'open-folder') void this.deps.openFolderDialog();
      else if (action === 'open-file') void this.deps.openFileDialog();
      else if (action === 'new-file') this.deps.newFile();
      else if (action === 'quick-open') this.deps.quickOpen();
      const recent = target.closest<HTMLElement>('[data-recent]');
      if (recent?.dataset.recent) void this.deps.openFolder(recent.dataset.recent);
    });
  }

  /** Show the empty state if no tab is open, else the editor. Call after the
   *  workspace root changes (opening a folder must not leave an empty
   *  editor on screen). */
  sync(): void {
    if (this.ctx.tabs.activeTab()) this.hide();
    else this.show();
  }

  show(): void {
    const welcome = document.getElementById('welcome');
    const editorArea = document.getElementById('editor-area');
    if (!welcome || !editorArea) return;
    this.renderMode();
    this.deps.hideDiffPane(); // no diff view is active on the welcome screen
    this.deps.refreshViewControl(); // no active tab → hide the view control
    // Clear status metrics so the last tab's counts don't linger.
    this.ctx.statusbar.setActiveFile(null, 'No file open');
    this.ctx.statusbar.updateModified(false);
    this.ctx.statusbar.updateCounts(0, 0, 0);
    welcome.classList.remove('hidden');
    editorArea.classList.add('hidden');
    syncEditorInput(this.ctx.editor);
    welcome.scrollTop = 0; // always reveal from the top, even in small windows
    this.welcomeShown = true;
  }

  hide(): void {
    if (!this.welcomeShown) return;
    document.getElementById('welcome')?.classList.add('hidden');
    document.getElementById('editor-area')?.classList.remove('hidden');
    syncEditorInput(this.ctx.editor);
    this.welcomeShown = false;
  }

  /** Welcome screen without a folder; the file prompt with one. */
  private renderMode(): void {
    const root = this.ctx.workspaceRoot;
    const start = document.getElementById('welcome-inner');
    const ws = document.getElementById('welcome-workspace');
    if (start) start.hidden = !!root;
    if (ws) ws.hidden = !root;
    if (!root) {
      this.renderRecentFolders();
      return;
    }
    const title = document.getElementById('welcome-workspace-title');
    const remote = parseRemoteRecent(root);
    const path = remote?.path ?? root;
    if (title) title.textContent = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    const key = document.getElementById('welcome-workspace-key');
    if (key) key.textContent = shortcutFor(ACTIONS.QUICK_OPEN);
  }

  private renderRecentFolders(): void {
    const wrap = document.getElementById('welcome-recent');
    const list = document.getElementById('welcome-recent-list');
    if (!wrap || !list) return;
    const recents = this.ctx.config.recent_folders ?? [];
    if (recents.length === 0) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    list.innerHTML = '';
    for (const dir of recents) {
      const remote = parseRemoteRecent(dir);
      const displayPath = remote?.path ?? dir;
      const row = document.createElement('button');
      row.className = 'welcome-recent-item';
      row.dataset.recent = dir;
      const name = document.createElement('span');
      name.className = 'welcome-recent-name';
      name.textContent = displayPath.split('/').filter(Boolean).pop() ?? displayPath;
      const path = document.createElement('span');
      path.className = 'welcome-recent-path';
      if (remote) {
        const chip = document.createElement('span');
        chip.className = 'welcome-recent-remote';
        chip.textContent = `ssh ${remote.host}`;
        path.append(chip, document.createTextNode(` ${displayPath}`));
      } else {
        path.textContent = displayPath.replace(/^\/Users\/[^/]+/, '~');
      }
      row.append(name, path);
      list.appendChild(row);
    }
  }
}
