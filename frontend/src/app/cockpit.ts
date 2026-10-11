import type { TerminalManager } from '../terminal';
import { api } from '../api';
import { LAYOUT } from '../constants';
import { attachResizeDrag } from '../resize-drag';
import { isAbsolutePath, joinPath } from '../utils';
import { applyWorkspaceLayout, workspaceLayoutFromConfig } from '../workspace-layout';
import type { AppContext } from './context';
import type { TerminalLayout } from '../types/TerminalLayout';

/** What the cockpit needs from its siblings. */
export interface CockpitDeps {
  /** First terminal reveal arms the agent context bridge. */
  armAgentContext(): void;
  closePristineUntitled(): void;
  /** Drawer height to persist when the CSS variable is unset. */
  readonly defaultTerminalHeight: number;
}

/**
 * Agent cockpit: the embedded terminal drawer (lazy TerminalManager, height
 * handle, show/hide) and the terminals-only layout where the terminal fills
 * the center column.
 */
export class CockpitController {
  // Embedded terminal, lazy-loaded on first reveal.
  private terminals: TerminalManager | null = null;
  /** Single-flights the async terminal-open sequence (import + manager
   *  creation + restoreOrCreate). Without it, three quick ⌃` presses could
   *  each pass the null check across the dynamic-import await and build two
   *  TerminalManagers (and two shells). */
  private terminalOpenInFlight: Promise<void> | null = null;
  private terminalVisible = false;
  /** Terminals Only: terminal fills the center column; editor/preview hidden. */
  private terminalsOnly = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: CockpitDeps,
  ) {}

  /** Restore the drawer / terminals-only layout persisted last session. */
  async restore(): Promise<void> {
    // Restore the cockpit's terminal drawer if it was open last session.
    // terminals_only implies a visible terminal filling the center column.
    if (this.ctx.config.terminal_visible || this.ctx.config.terminals_only) {
      document.documentElement.style.setProperty(
        '--terminal-height',
        `${this.ctx.config.terminal_height}px`,
      );
      await this.toggleTerminal();
    }
    if (this.ctx.config.terminals_only) {
      this.terminalsOnly = true;
      this.applyTerminalsOnlyLayout();
    }
  }

  isVisible(): boolean {
    return this.terminalVisible;
  }

  isTerminalsOnly(): boolean {
    return this.terminalsOnly;
  }

  /** Root new shells at `dir` (null: no folder, e.g. after a disconnect). */
  setCwd(dir: string | null): void {
    this.terminals?.setCwd(dir);
  }

  applyTheme(): void {
    this.terminals?.applyTheme();
  }

  /** Push tmux / agent-args settings to a live manager. */
  applySettings(): void {
    this.terminals?.setUseTmux(this.ctx.config.use_tmux);
    this.terminals?.setAgentArgs(this.ctx.config.agent_args ?? {});
  }

  /** Drag-to-resize the terminal drawer height (gutter hit-target + selection lock). */
  initTerminalResize(): void {
    const handle = document.getElementById('terminal-resize-handle');
    const panel = document.getElementById('terminal-panel');
    if (!handle || !panel) return;
    let startY = 0;
    let startH = 0;
    attachResizeDrag(handle, {
      cursor: 'row-resize',
      onStart: (e) => {
        startY = e.clientY;
        startH = panel.getBoundingClientRect().height;
      },
      onMove: (e) => {
        const dy = startY - e.clientY;
        const max = window.innerHeight - LAYOUT.TERMINAL_TOP_RESERVE_PX;
        const h = Math.max(LAYOUT.TERMINAL_MIN_PX, Math.min(startH + dy, max));
        document.documentElement.style.setProperty('--terminal-height', `${h}px`);
        this.terminals?.refitAll();
      },
      onEnd: () => this.ctx.saveConfigSoon(),
    });
  }

  /** Show/hide the terminal drawer, lazy-creating the manager on first reveal. */
  async toggleTerminal(): Promise<void> {
    const panel = document.getElementById('terminal-panel');
    const handle = document.getElementById('terminal-resize-handle');
    if (!panel || !handle) return;

    // Hiding the drawer while in terminals-only would leave an empty center
    // column — leave that mode first so editor+preview come back.
    if (this.terminalVisible && this.terminalsOnly) {
      this.terminalsOnly = false;
      this.applyTerminalsOnlyLayout();
    }

    this.terminalVisible = !this.terminalVisible;
    panel.classList.toggle('hidden', !this.terminalVisible);
    // Resize gutter stays hidden in terminals-only (CSS); otherwise follows visibility.
    handle.classList.toggle('hidden', !this.terminalVisible || this.terminalsOnly);
    document.getElementById('btn-terminal')?.classList.toggle('off', !this.terminalVisible);
    this.ctx.saveConfigSoon(); // remember drawer state across sessions

    if (!this.terminalVisible) return;

    // First reveal arms the agent context bridge (see agent-context.ts)
    // and publishes right away so an agent started now sees current state.
    this.deps.armAgentContext();

    await this.openTerminals();
  }

  /**
   * Create the terminal manager (once) and restore or open a terminal, guarded
   * by a single shared promise so overlapping reveals can't build a second
   * manager or a duplicate shell (see terminalOpenInFlight).
   */
  private openTerminals(): Promise<void> {
    if (this.terminalOpenInFlight) return this.terminalOpenInFlight;
    this.terminalOpenInFlight = (async () => {
      try {
        if (!this.terminals) {
          const { TerminalManager } = await import('../terminal');
          // A concurrent open may have created it during the import await.
          if (!this.terminals) {
            const mgr = new TerminalManager(
              document.getElementById('terminal-host')!,
              (path) => void this.openPathFromTerminal(path),
            );
            // Split layout per workspace, persisted in AppConfig and
            // restored (tmux reattach) by restoreOrCreate.
            mgr.setOnTerminalsOnly(() => void this.toggleTerminalsOnly());
            mgr.setLayoutStore({
              load: (key) => this.ctx.config.terminal_layouts?.[key],
              save: (key, layout) => this.saveLayout(key, layout),
            });
            // "Don't ask again" in the MCP install prompt, per agent.
            mgr.setMcpPromptStore({
              isDismissed: (bin) =>
                (this.ctx.config.mcp_install_prompt_dismissed ?? []).includes(bin),
              dismiss: (bin) => {
                const list = this.ctx.config.mcp_install_prompt_dismissed ?? [];
                if (list.includes(bin)) return;
                this.ctx.config.mcp_install_prompt_dismissed = [...list, bin];
                this.ctx.saveConfigSoon();
              },
            });
            // Last terminal closed (shell exited or tab ×) → hide the empty
            // drawer. Reopening with ⌃` starts a fresh shell.
            mgr.setOnEmpty(() => {
              if (this.terminalVisible) void this.toggleTerminal();
            });
            this.terminals = mgr;
          }
        }
        // Root new shells at the open folder so agent and panes share a cwd.
        this.terminals.setCwd(this.ctx.fileTree.getRoot() ?? this.ctx.baseDir);
        this.terminals.setUseTmux(this.ctx.config.use_tmux);
        this.terminals.setAgentArgs(this.ctx.config.agent_args ?? {});
        // Reattach tmux sessions that survived a previous run (so a running
        // agent is right where the user left it); otherwise open one fresh
        // terminal. Always keeps at least one terminal when the drawer is open
        // — this is also what makes a closed/exited shell recoverable.
        await this.terminals.restoreOrCreate();
      } finally {
        this.terminalOpenInFlight = null;
      }
    })();
    return this.terminalOpenInFlight;
  }

  /**
   * Terminals-only layout: hide editor+preview and let the terminal
   * panel fill the center column. Sidebar stays. Toggle again to restore the
   * normal editor+preview (+ terminal drawer) layout.
   */
  async toggleTerminalsOnly(): Promise<void> {
    this.terminalsOnly = !this.terminalsOnly;
    this.applyTerminalsOnlyLayout();

    if (this.terminalsOnly) {
      // Mode requires a live terminal filling the column.
      if (!this.terminalVisible) {
        await this.toggleTerminal();
      } else {
        document.getElementById('terminal-resize-handle')?.classList.add('hidden');
        this.terminals?.refitAll();
      }
    } else if (this.terminalVisible) {
      // Restored: terminal stays as the normal bottom drawer.
      document.getElementById('terminal-resize-handle')?.classList.remove('hidden');
      this.terminals?.refitAll();
    }

    this.ctx.saveConfigSoon();
  }

  /** Sync the terminals-only CSS class and toolbar affordance. */
  private applyTerminalsOnlyLayout(): void {
    applyWorkspaceLayout(
      document,
      workspaceLayoutFromConfig(this.terminalsOnly),
    );
    const btn = document.getElementById('btn-terminals-only');
    btn?.classList.toggle('off', !this.terminalsOnly);
    btn?.setAttribute('aria-pressed', String(this.terminalsOnly));
  }

  /** Store (or, when the grid emptied, drop) one workspace's layout. */
  private saveLayout(key: string, layout: TerminalLayout | null): void {
    const all = { ...(this.ctx.config.terminal_layouts ?? {}) };
    const before = JSON.stringify(all[key] ?? null);
    if (layout) all[key] = layout;
    else delete all[key];
    if (JSON.stringify(layout) === before) return;
    this.ctx.config.terminal_layouts = all;
    this.ctx.saveConfigSoon();
  }

  /** Split the focused terminal pane (menu / command palette). Opens the
   *  drawer first when it is hidden; at the pane limit this does nothing. */
  async splitTerminal(dir: 'right' | 'down'): Promise<void> {
    if (!this.terminalVisible) {
      await this.toggleTerminal();
      return;
    }
    await this.terminals?.splitFocused(dir === 'right' ? 'row' : 'column');
  }

  /** Close the focused terminal pane (⌘W with a terminal focused, menu). */
  closeTerminalPane(): void {
    this.terminals?.closeFocused();
  }

  /** Move focus to the next (1) / previous (-1) terminal pane. */
  focusTerminalPane(delta: 1 | -1): void {
    if (this.terminalVisible) this.terminals?.focusNeighbor(delta);
  }

  /** Whether keyboard focus is in a terminal pane (routes ⌘W to the pane). */
  hasTerminalFocus(): boolean {
    return this.terminalVisible && (this.terminals?.hasFocus() ?? false);
  }

  /** Current terminal drawer height in px (falls back to the config default). */
  currentTerminalHeight(): number {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--terminal-height')
      .trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : this.deps.defaultTerminalHeight;
  }

  /**
   * Open a path clicked in the terminal. Agent output usually prints paths
   * relative to the working directory, so resolve against the folder root
   * (and try the raw path as a fallback for absolute paths). Silently ignores
   * paths that don't resolve to a readable file — a false-positive match on
   * ordinary output shouldn't pop errors.
   */
  private async openPathFromTerminal(path: string): Promise<void> {
    const root = this.ctx.fileTree.getRoot() ?? this.ctx.baseDir;
    const candidates = isAbsolutePath(path)
      ? [path]
      : root
        ? [joinPath(root, path.replace(/^\.\//, '')), path]
        : [path];
    for (const candidate of candidates) {
      try {
        const content = await api.readFile(candidate);
        this.deps.closePristineUntitled();
        this.ctx.tabs.openTab(candidate, content);
        return;
      } catch {
        // try next candidate
      }
    }
  }
}
