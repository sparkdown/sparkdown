import { EventBus } from './events';
import { EVENTS, ACTIONS } from './event-names';
import { basename, dirname, isMacOS } from './utils';
import { api, type GitBranchStatus } from './api';
import { showContextMenu } from './context-menu';

/** Branch label for the status bar: `main`, `main ↑1`, `main ↑2 ↓3`; a
 *  detached HEAD shows its short commit id. */
export function formatBranch(s: GitBranchStatus): { text: string; title: string } {
  const name = s.branch ?? '';
  if (s.detached) {
    return { text: name, title: `Detached HEAD at ${name}` };
  }
  const sync: string[] = [];
  if (s.ahead > 0) sync.push(`↑${s.ahead}`);
  if (s.behind > 0) sync.push(`↓${s.behind}`);
  const text = sync.length ? `${name} ${sync.join(' ')}` : name;
  const plural = (n: number) => (n === 1 ? 'commit' : 'commits');
  let title = `Branch ${name}`;
  if (!s.has_upstream) title += ' (no upstream)';
  else if (s.ahead === 0 && s.behind === 0) title += ', up to date with its upstream';
  else {
    const parts: string[] = [];
    if (s.ahead > 0) parts.push(`${s.ahead} ${plural(s.ahead)} ahead`);
    if (s.behind > 0) parts.push(`${s.behind} ${plural(s.behind)} behind`);
    title += `, ${parts.join(', ')}`;
  }
  return { text, title };
}

/** MCP state for the status bar: the server is serving AND the user allows
 *  sharing (Settings → Agents). */
export interface AgentToolsState {
  running: boolean;
  enabled: boolean;
}

export class StatusBar {
  private bus: EventBus;
  private pathEl!: HTMLElement;
  private modifiedEl!: HTMLElement;
  private wordsEl!: HTMLElement;
  private charsEl!: HTMLElement;
  private linesEl!: HTMLElement;
  private cursorEl!: HTMLElement;
  private wrapEl!: HTMLElement;
  private branchEl: HTMLElement | null = null;
  private agentEl: HTMLElement | null = null;
  private lastLine = -1;
  private lastColumn = -1;
  // Full path of the active file, or null for an unsaved/untitled buffer.
  private currentPath: string | null = null;
  private currentTitle = 'Untitled';
  // Remote-session root. Paths under it display as ~/relative — the host
  // already shows in the remote chip, so the full prefix would repeat it.
  private pathBase: string | null = null;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  init(): void {
    this.pathEl = document.getElementById('status-path')!;
    this.modifiedEl = document.getElementById('status-modified')!;
    this.wordsEl = document.getElementById('status-words')!;
    this.charsEl = document.getElementById('status-chars')!;
    this.linesEl = document.getElementById('status-lines')!;
    this.cursorEl = document.getElementById('status-cursor')!;
    this.wrapEl = document.getElementById('status-wrap')!;
    this.branchEl = document.getElementById('status-branch');
    this.agentEl = document.getElementById('status-agent');

    // Ln/Col → go to line; Wrap → toggle word wrap; agent tools → Settings.
    const mac = isMacOS();
    this.cursorEl.title = `Go to line (${mac ? '⌘⌥G' : 'Ctrl+Alt+G'})`;
    this.wrapEl.title = `Toggle word wrap (${mac ? '⌘⇧W' : 'Ctrl+Shift+W'})`;
    this.cursorEl.addEventListener('click', () => this.bus.emit(ACTIONS.GOTO_LINE));
    this.wrapEl.addEventListener('click', () => this.bus.emit(ACTIONS.TOGGLE_WRAP));
    this.agentEl?.addEventListener('click', () => this.bus.emit(ACTIONS.SHOW_AGENT_SETTINGS));

    // Click the path → menu to copy full path / folder path / file name.
    this.pathEl.addEventListener('click', (e) => {
      if (!this.currentPath) return;
      const path = this.currentPath;
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Copy Full Path', onClick: () => void api.copyText(path) },
        { label: 'Copy Folder Path', onClick: () => void api.copyText(dirname(path)) },
        { label: 'Copy File Name', onClick: () => void api.copyText(basename(path)) },
      ]);
    });

    this.bus.on(EVENTS.CURSOR_CHANGED, (data) => {
      // Char count / selection can change without the caret line/col moving
      // (e.g. shift-select on the same line), so always refresh chars.
      this.updateCharCount(data.chars, data.selectedChars);
      if (data.line === this.lastLine && data.column === this.lastColumn) return;
      this.lastLine = data.line;
      this.lastColumn = data.column;
      this.cursorEl.textContent = `Ln ${data.line}, Col ${data.column}`;
    });

    this.bus.on(EVENTS.WORD_WRAP_CHANGED, (data) => {
      this.wrapEl.textContent = `Wrap: ${data.enabled ? 'On' : 'Off'}`;
    });
  }

  /**
   * Show the active document in the status bar: its full path when saved (which
   * conveys both folder and file name), or the title for an unsaved buffer.
   */
  setActiveFile(path: string | null, title: string): void {
    this.currentPath = path;
    this.currentTitle = title || 'Untitled';
    this.pathEl.textContent = path ? this.displayPath(path) : this.currentTitle;
    this.pathEl.classList.toggle('clickable', !!path);
    this.pathEl.title = path ? 'Click for path options' : '';
  }

  /** Set (or clear) the remote-session root and refresh the shown path.
   *  The copy menu is not changed — it always copies the full path. */
  setPathBase(base: string | null): void {
    this.pathBase = base;
    this.setActiveFile(this.currentPath, this.currentTitle);
  }

  private displayPath(path: string): string {
    const base = this.pathBase;
    if (!base) return path;
    if (path === base) return '~';
    const prefix = base.endsWith('/') ? base : `${base}/`;
    return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
  }

  /** The unsaved dot next to the path. */
  updateModified(modified: boolean): void {
    this.modifiedEl.classList.toggle('is-dirty', modified);
    this.modifiedEl.title = modified ? 'Unsaved changes' : '';
    this.modifiedEl.setAttribute('aria-label', modified ? 'Unsaved changes' : 'Saved');
  }

  /** Git branch + ahead/behind; null (or no branch) hides the item. */
  setBranch(status: GitBranchStatus | null): void {
    const el = this.branchEl;
    if (!el) return;
    if (!status?.branch) {
      el.classList.add('hidden');
      el.title = '';
      return;
    }
    const { text, title } = formatBranch(status);
    const label = el.querySelector<HTMLElement>('.status-branch-name');
    if (label) label.textContent = text;
    else el.textContent = text;
    el.title = title;
    el.setAttribute('aria-label', title);
    el.classList.remove('hidden');
  }

  /** "Agent tools on/off" (MCP). null hides the item. */
  setAgentTools(state: AgentToolsState | null): void {
    const el = this.agentEl;
    if (!el) return;
    el.classList.toggle('hidden', state === null);
    if (!state) return;
    const on = state.running && state.enabled;
    el.classList.toggle('is-on', on);
    const label = el.querySelector<HTMLElement>('.status-agent-label');
    const text = `Agent tools ${on ? 'on' : 'off'}`;
    if (label) label.textContent = text;
    else el.textContent = text;
    el.title = on
      ? 'Agents in SparkDown terminals can read the editor (MCP). Click for settings.'
      : !state.enabled
        ? 'Agent context sharing is off. Click to turn it on in Settings → Agents.'
        : 'The agent tools server (MCP) is not running. Click for settings.';
  }

  updateCounts(words: number, lines: number, chars = 0, selectedChars = 0): void {
    this.wordsEl.textContent = `${words} words`;
    this.linesEl.textContent = `${lines} lines`;
    this.updateCharCount(chars, selectedChars);
  }

  /** Plain `N chars`, or `N selected / M chars` when a range is selected. */
  updateCharCount(chars: number, selectedChars = 0): void {
    this.charsEl.textContent =
      selectedChars > 0
        ? `${selectedChars} selected / ${chars} chars`
        : `${chars} chars`;
  }

  updateWrap(enabled: boolean): void {
    this.wrapEl.textContent = `Wrap: ${enabled ? 'On' : 'Off'}`;
  }
}
