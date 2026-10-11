import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { api, type RemoteSession } from './api';
import { shortcutFor, terminalPaneAction, terminalPassesToApp, type TerminalPaneAction } from './shortcuts';
import { ACTIONS } from './event-names';
import { attachResizeDrag } from './resize-drag';
import { isMacOS } from './utils';
import { showMcpInstallPrompt } from './mcp-install-prompt';
import {
  MAX_PANES,
  autoSplitDir,
  clampRatio,
  leaf,
  mapPanes,
  neighborPane,
  nodeAt,
  paneIds,
  removePane,
  restoreLayout,
  setRatio,
  splitPane,
  toPersisted,
  type LayoutNode,
  type SplitDir,
} from './split-layout';
import type { TerminalLayout } from './types/TerminalLayout';

// Keep in sync with --font-mono in themes.css. xterm measures cells in
// JS/canvas and needs a LITERAL font stack (a `var(--…)` never resolves).
// 'Apple Symbols' and 'Apple Color Emoji' are the per-glyph fallback for the
// prompt's `❯` (U+276F) and emoji: the code fonts ahead of them are often not
// installed and the webview does not otherwise reach a font with these glyphs,
// so it drew each as the fallback font's `.notdef` (an underscore).
const TERM_FONT =
  "'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, 'Apple Symbols', 'Apple Color Emoji', monospace";

/**
 * Map a terminal keydown to a clipboard action, or null to let xterm handle
 * it. macOS: ⌘C copies ONLY when text is selected (so ⌘C with no selection
 * stays inert — it never becomes ^C), ⌘V pastes. Linux/Windows: the terminal
 * convention Ctrl+Shift+C / Ctrl+Shift+V (plain Ctrl+C must stay SIGINT).
 * Pure, so it is unit-tested without xterm.
 */
export function clipboardAction(
  e: Pick<KeyboardEvent, 'type' | 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  hasSelection: boolean,
): 'copy' | 'paste' | null {
  if (e.type !== 'keydown' || e.altKey) return null;
  const key = e.key.toLowerCase();
  const mac = e.metaKey && !e.ctrlKey;
  const other = e.ctrlKey && e.shiftKey && !e.metaKey;
  if (!mac && !other) return null;
  if (key === 'c') return hasSelection ? 'copy' : null;
  if (key === 'v') return 'paste';
  return null;
}

/** Quiet time after the last container resize before a pane refits. */
export const REFIT_DEBOUNCE_MS = 40;

// Matches path-like tokens in terminal output: an optional ./ or a bare
// dotted/slashed path ending in a file extension (or a src-style path). Kept
// conservative to avoid turning ordinary prose into links.
const PATH_RE =
  /(?:\.\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|(?:\.\/)?[\w.-]+\.[A-Za-z0-9]{1,8}/g;

/**
 * One embedded terminal pane: an xterm.js view over a
 * backend pty keyed by `id`. Up to four run side by side in the
 * TerminalManager's split grid. SparkDown never runs the agent — the user
 * runs their CLI in this shell.
 */
export class TerminalPane {
  readonly id: string;
  private term: XTerm;
  private fit = new FitAddon();
  private unlisteners: UnlistenFn[] = [];
  private started = false;
  private exited = false;
  /** Set by destroy(). init() awaits several times; if the pane is destroyed
   *  mid-init, each await re-checks this so it stops before leaking event
   *  listeners or spawning an orphan PTY. */
  private disposed = false;
  /** True when the shell never started (spawn error). The tab then stays
   *  open so the error text stays readable — unlike a normal exit, where
   *  the manager closes the tab automatically. */
  private startFailed = false;
  private resizeObserver: ResizeObserver | null = null;
  /** Pending debounced refit (container resize / divider drag). */
  private refitTimer: ReturnType<typeof setTimeout> | null = null;
  private onExit: (() => void) | null = null;
  private onOpenPath: (path: string) => void;
  /** Split-grid keys pressed while this terminal has focus (⌘D, ⌘] …). */
  private onAction: ((action: TerminalPaneAction) => void) | null;
  /** Timestamp of the last pty output — used to wait for the shell prompt
   *  to settle before typing into a fresh terminal. */
  private lastOutputAt = 0;
  /** tmux session this pane is (re)attached to, and whether the backend
   *  actually gave us tmux ("tmux") or fell back to a plain shell ("shell"). */
  private session: string | null = null;
  private mode = 'shell';

  constructor(
    id: string,
    onOpenPath: (path: string) => void,
    onAction: ((action: TerminalPaneAction) => void) | null = null,
  ) {
    this.id = id;
    this.onOpenPath = onOpenPath;
    this.onAction = onAction;
    this.term = new XTerm({
      cursorBlink: true,
      fontFamily: TERM_FONT,
      fontSize: 12,
      // Integer line height: a fractional value (was 1.15) gives rows a
      // non-integer pixel height, which made the FitAddon over-count rows and
      // clip tmux's status bar. 1.0 keeps rows pixel-aligned. (The `❯`-as-
      // underscore bug was tmux running without a UTF-8 locale; see terminal.rs.)
      lineHeight: 1,
      allowProposedApi: true,
      scrollback: 5000,
    });
    this.term.loadAddon(this.fit);

    // Clipboard: xterm has no built-in copy/paste keys, and the Tauri webview
    // does not route ⌘C/⌘V to the terminal on its own. Copy goes through the
    // backend (system clipboard); paste reads the clipboard and types it.
    this.term.attachCustomKeyEventHandler((e) => {
      const action = clipboardAction(e, this.term.hasSelection());
      if (action === 'copy') {
        void api.copyText(this.term.getSelection());
        this.term.clearSelection();
        return false;
      }
      if (action === 'paste') {
        void navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text && this.started) void api.terminalWrite(this.id, text);
          })
          .catch(() => {});
        return false;
      }
      // Split-grid keys: handled here (terminal focus only) and kept away
      // from both xterm and the document shortcuts (Ctrl+Shift+W would also
      // toggle word wrap on Windows/Linux).
      const pane = terminalPaneAction(e, isMacOS());
      if (pane) {
        e.preventDefault();
        e.stopPropagation();
        this.onAction?.(pane);
        return false;
      }
      // App shortcuts that must work from a focused terminal (Ctrl+` on
      // Windows/Linux): skip xterm so the keydown reaches ShortcutManager.
      if (terminalPassesToApp(e, isMacOS())) return false;
      return true;
    });
  }

  /**
   * Detect file-path tokens in a rendered terminal line and expose them as
   * clickable links (agent output like "Edited src/app.ts" → open it).
   * Uses xterm's built-in link-provider API — no extra addon/dependency.
   */
  private registerPathLinks(): void {
    this.term.registerLinkProvider({
      provideLinks: (lineNumber, callback) => {
        const line = this.term.buffer.active.getLine(lineNumber);
        if (!line) return callback(undefined);
        const text = line.translateToString(true);
        const links = [];
        for (const m of text.matchAll(PATH_RE)) {
          if (m.index === undefined) continue;
          const raw = m[0];
          links.push({
            // xterm ranges are 1-based, end inclusive.
            range: {
              start: { x: m.index + 1, y: lineNumber + 1 },
              end: { x: m.index + raw.length, y: lineNumber + 1 },
            },
            text: raw,
            activate: () => this.onOpenPath(raw),
          });
        }
        callback(links.length ? links : undefined);
      },
    });
  }

  /** Notify the manager when this terminal's shell exits (to update the tab). */
  setOnExit(cb: () => void): void {
    this.onExit = cb;
  }

  isExited(): boolean {
    return this.exited;
  }

  /** True while the shell is running (drives the pane header's live dot). */
  isRunning(): boolean {
    return this.started && !this.exited;
  }

  /** True when the shell failed to spawn (the tab stays, error readable). */
  isStartFailed(): boolean {
    return this.startFailed;
  }

  /** The tmux session name, if this pane is backed by one (else null). */
  get sessionName(): string | null {
    return this.mode === 'tmux' ? this.session : null;
  }

  /**
   * Mount into `container`, start the shell rooted at `cwd`, stream I/O.
   * When `session` is given and tmux is installed, the pty runs
   * `tmux new-session -A -s <session>` so it survives app restarts (and
   * reattaches to a surviving session of the same name). Without tmux it's a
   * plain login shell.
   */
  async init(
    container: HTMLElement,
    cwd: string | null,
    session: string | null = null,
    launch: string | null = null,
  ): Promise<void> {
    this.session = session;
    if (this.disposed) return;
    this.term.open(container);
    this.applyTheme();

    // Render with xterm's built-in DOM renderer (no WebGL addon). The DOM
    // renderer draws each glyph with the system font, which is correct for an
    // embedded editor terminal and fast enough; dropping the addon also trims
    // the bundle.

    this.registerPathLinks();

    try {
      await document.fonts.ready;
    } catch {
      // non-browser env
    }
    if (this.disposed) return;
    this.fit.fit();

    // Route only THIS terminal's output/exit (events carry an id). Each listen
    // is async; if destroy() ran while it was pending, unlisten immediately —
    // destroy already drained unlisteners, so a late push would leak.
    const dataUn = await listen<{ id: string; chunk: string }>('terminal://data', (e) => {
      if (e.payload.id === this.id) {
        this.term.write(e.payload.chunk);
        this.lastOutputAt = performance.now();
      }
    });
    if (this.disposed) return void dataUn();
    this.unlisteners.push(dataUn);

    const exitUn = await listen<{ id: string }>('terminal://exit', (e) => {
      if (e.payload.id !== this.id) return;
      // No parting message: the manager closes this tab right away (a
      // dead shell has no further use), so nobody would read it.
      this.started = false;
      this.exited = true;
      this.onExit?.();
    });
    if (this.disposed) return void exitUn();
    this.unlisteners.push(exitUn);

    this.term.onData((data) => {
      if (this.started) void api.terminalWrite(this.id, data);
    });

    try {
      this.mode = await api.terminalStart(
        this.id,
        cwd,
        this.term.cols,
        this.term.rows,
        this.session,
        launch,
      );
    } catch (err) {
      if (this.disposed) return;
      this.term.write(`\r\n\x1b[31mFailed to start shell: ${err}\x1b[0m\r\n`);
      this.exited = true;
      this.startFailed = true;
      this.onExit?.();
      return;
    }
    // Destroyed while the shell was starting: the PTY now exists but nothing
    // owns it — close it so it isn't orphaned.
    if (this.disposed) {
      void api.terminalClose(this.id);
      return;
    }
    this.started = true;
    this.refitSoon();

    this.resizeObserver = new ResizeObserver(() => this.refitDebounced());
    this.resizeObserver.observe(container);
  }

  /** Coalesce a burst of container resizes (divider drag, window resize)
   *  into one fit + terminal_resize once the size settles. */
  private refitDebounced(): void {
    if (this.disposed) return;
    if (this.refitTimer) clearTimeout(this.refitTimer);
    this.refitTimer = setTimeout(() => {
      this.refitTimer = null;
      this.refit();
    }, REFIT_DEBOUNCE_MS);
  }

  private refit(): void {
    // A refitSoon() queued before destroy() must not resize a closed PTY.
    if (this.disposed) return;
    try {
      this.fit.fit();
      if (this.started) void api.terminalResize(this.id, this.term.cols, this.term.rows);
    } catch {
      // container momentarily 0-sized (hidden pane); ignore.
    }
  }

  refitSoon(): void {
    requestAnimationFrame(() => this.refit());
  }

  applyTheme(): void {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) =>
      cs.getPropertyValue(name).trim() || fallback;
    const isDark = document.documentElement.dataset.theme !== 'light';
    const ansi = isDark
      ? {
          black: '#3a3f4b', red: '#e06c75', green: '#98c379', yellow: '#d8c89a',
          blue: '#8ab4dd', magenta: '#c0a8e0', cyan: '#8fc7bb', white: '#c6cbd4',
          brightBlack: '#5c6370', brightRed: '#e88f97', brightGreen: '#b5d8a0',
          brightYellow: '#e6d9b0', brightBlue: '#a8cbe8', brightMagenta: '#d2c0ee',
          brightCyan: '#a8d8cd', brightWhite: '#f0f2f5',
        }
      : {
          black: '#26282e', red: '#c0392b', green: '#3d7a2f', yellow: '#8a6d1b',
          blue: '#2f6fb0', magenta: '#7c3f9e', cyan: '#2a8577', white: '#c6c8ce',
          brightBlack: '#6e7278', brightRed: '#d0483a', brightGreen: '#4a8f3a',
          brightYellow: '#9a7d2b', brightBlue: '#3d7fc0', brightMagenta: '#8f4fae',
          brightCyan: '#38967f', brightWhite: '#26282e',
        };
    this.term.options.theme = {
      background: v('--editor-bg', '#191b21'),
      foreground: v('--editor-fg', '#dde1e8'),
      cursor: v('--editor-caret', '#c3c8d2'),
      selectionBackground: v('--editor-selection', '#323848cc'),
      ...ansi,
    };
  }

  focus(): void {
    this.term.focus();
  }

  /** Type text at the shell prompt (agent launch, path insertion). Nothing is
   *  submitted without Enter. On a tmux-backed pane we go through tmux
   *  `send-keys` so the text is inserted into tmux's own serialized input/
   *  redraw cycle — writing raw pty bytes here races tmux's attach redraw and
   *  the line renders twice. Plain shells take the direct pty write. */
  paste(text: string): void {
    if (!this.started) return;
    const session = this.sessionName;
    if (session) void api.tmuxSendKeys(session, text).catch(() => {});
    else void api.terminalWrite(this.id, text);
  }

  /**
   * Resolves once the shell has produced output and then gone quiet for
   * `quietMs` — i.e. the login banner/prompt has finished printing. Typing
   * before that races the shell's startup echo (the pasted text renders
   * before the prompt, then the prompt redraws it → appears duplicated).
   *
   * tmux attaches in phases (clear+draw, rc runs, then a follow-up
   * full-screen redraw when the attach completes), and that last redraw can
   * land well after the first output — so a tmux pane needs a longer quiet
   * window than a plain shell or we resolve mid-attach.
   */
  whenIdle(
    quietMs = this.mode === 'tmux' ? 450 : 250,
    timeoutMs = 4000,
  ): Promise<void> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        const now = performance.now();
        const sawOutput = this.lastOutputAt > 0;
        if ((sawOutput && now - this.lastOutputAt >= quietMs) || now - t0 >= timeoutMs) {
          resolve();
          return;
        }
        setTimeout(tick, 60);
      };
      tick();
    });
  }

  /** The DOM node holding this terminal (managed by the manager's host). */
  get element(): HTMLElement | undefined {
    return this.term.element ?? undefined;
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.refitTimer) clearTimeout(this.refitTimer);
    this.refitTimer = null;
    this.resizeObserver?.disconnect();
    for (const un of this.unlisteners) un();
    this.unlisteners = [];
    void api.terminalClose(this.id);
    this.term.dispose();
  }
}

/**
 * Agents with no launch-time injection whose MCP config SparkDown can
 * install into (their own `mcp add`, or for Cursor / Antigravity one entry
 * in ~/.cursor/mcp.json / ~/.gemini/config/mcp_config.json). Launching one
 * of these while SparkDown is not installed shows the install prompt
 * (unless dismissed for that agent). Keep in sync with mcp.rs
 * `agent_mcp_commands` / `json_file_agent`.
 */
export const PROMPT_INSTALL_BINS: ReadonlySet<string> = new Set([
  'gemini',
  'grok',
  'kiro-cli',
  'cursor-agent',
  'agy',
]);

/** Agents that get our server injected per launched session (no install, no
 *  prompt): see agentLaunchCommand case 2. */
export const SESSION_INJECT_BINS: ReadonlySet<string> = new Set(['claude', 'codex', 'opencode']);

/** Where the "Don't ask again" choice per agent lives (AppConfig). */
export interface McpPromptStore {
  isDismissed(bin: string): boolean;
  dismiss(bin: string): void;
}

/**
 * The one-liner typed (not submitted) into a fresh terminal when the user
 * clicks an agent launch button. It starts the agent with an initial prompt
 * that teaches it the SparkDown context bridge; the user can edit the tail of
 * the prompt before pressing Enter.
 */
export interface LaunchContext {
  /** How to start our stdio MCP server (local binary or the remote shim
   *  script), or null when the server is unreachable. */
  shim: import('./api').ShimCommand | null;
  /** Whether this agent already has SparkDown in its own MCP config. */
  installed: boolean;
  /** Extra per-agent flags from Settings, appended verbatim (so they are in
   *  the syntax of the target shell: PowerShell on local Windows). */
  extraArgs?: string;
  /** Syntax of the shell that runs the line (default POSIX). */
  shell?: import('./api').LaunchShell;
}

/**
 * Build the command an agent chip runs. Order of preference:
 *
 *  1. Agent already has SparkDown installed (Settings → Agents): launch the
 *     bare command; its config points at our stdio shim, gated by
 *     `$SPARKDOWN_MCP`. (Codex also gets the env_vars override, see
 *     CODEX_ENV_OVERRIDE.)
 *  2. Claude Code / Codex / opencode, not installed: inject our stdio server
 *     at launch for this session only (additive `--mcp-config` / `-c` /
 *     `OPENCODE_CONFIG_CONTENT` — the user's own MCP config stays; nothing
 *     is written to disk). No prompt.
 *  3. Otherwise (server unreachable, or an agent with no launch flag and
 *     not installed): fall back to the file-bridge teaching prompt. For the
 *     agents in PROMPT_INSTALL_BINS, launchAgent first offers to install
 *     (consent dialog); on success it launches as case 1.
 *
 * On local Windows (`ctx.shell === 'powershell'`) the same choices are
 * spelled for PowerShell: see powershellLaunchCommand.
 *
 * Exported for tests.
 */
export function agentLaunchCommand(bin: string, ctx: LaunchContext): string {
  const extra = ctx.extraArgs?.trim() ? ` ${ctx.extraArgs.trim()}` : '';
  if (ctx.shell === 'powershell') return powershellLaunchCommand(bin, ctx, extra);

  // 1. Installed: the agent loads our server from its own config. The shim
  //    only exposes tools when $SPARKDOWN_MCP is set (i.e. in this terminal).
  //    Codex is the exception: it starts MCP servers with a filtered
  //    environment, so it still needs the env_vars override (`codex mcp add`
  //    has no option to save it; `-c` merges over the saved entry).
  if (ctx.installed) {
    return bin === 'codex' ? `codex ${CODEX_ENV_OVERRIDE}${extra}` : `${bin}${extra}`;
  }

  // 2. Launch-time injection for the agents with a session config. Point
  //    them at the same stdio shim; it connects to the running app. This is
  //    session-scoped — it lasts only for this launched process.
  if (ctx.shim) {
    const prog = JSON.stringify(ctx.shim.program);
    const args = JSON.stringify(ctx.shim.args);
    switch (bin) {
      case 'claude':
        // --mcp-config ADDS servers (no --strict-mcp-config, which replaces).
        return `claude --mcp-config '{"mcpServers":{"sparkdown":{"command":${prog},"args":${args}}}}'${extra}`;
      case 'codex':
        // Three -c overrides; the rest of ~/.codex/config.toml is untouched.
        // env_vars forwards $SPARKDOWN_MCP by name: without it Codex starts
        // the shim with a stripped environment and it offers zero tools.
        return `codex -c ${shq(`mcp_servers.sparkdown.command=${prog}`)} -c ${shq(`mcp_servers.sparkdown.args=${args}`)} ${CODEX_ENV_OVERRIDE}${extra}`;
      case 'opencode': {
        // Inline config (OPENCODE_CONFIG_CONTENT) MERGES over the user's own
        // opencode config for this process only. `{env:…}` is opencode's
        // documented substitution, so the server gets this terminal's
        // $SPARKDOWN_MCP. A POSIX `VAR=value cmd` prefix: the launch command
        // is eval'd by the login shell (terminal.rs `launch_wrapper`), and it
        // keeps a shell function/alias named opencode working (`env` would not).
        const config = JSON.stringify({
          mcp: {
            sparkdown: {
              type: 'local',
              command: [ctx.shim.program, ...ctx.shim.args],
              enabled: true,
              environment: { SPARKDOWN_MCP: '{env:SPARKDOWN_MCP}' },
            },
          },
        });
        return `OPENCODE_CONFIG_CONTENT=${shq(config)} opencode${extra}`;
      }
      default:
        break;
    }
  }

  // 3. Fallback: teach the file bridge (works with any agent, and remote).
  return `${bin}${extra} '${AGENT_TEACH_PROMPT}'`;
}

/** Single-quote `s` for the POSIX shell that evals the launch command
 *  (`$SPARKDOWN_LAUNCH`): wrap in '…' and turn each embedded ' into '\''. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Codex filters the environment of the MCP servers it starts
 *  (shell_environment_policy), so $SPARKDOWN_MCP would never reach our shim.
 *  `env_vars` forwards the named variables from Codex's own environment. */
const CODEX_ENV_OVERRIDE = `-c 'mcp_servers.sparkdown.env_vars=["SPARKDOWN_MCP"]'`;

// Shell-quoting notes for the fallback prompt:
  // - Single quotes, not double: inside double quotes zsh/bash still perform
  //   command substitution on backticks and expansion on $ — a `shadow`
  //   backtick in the prompt literally executed `shadow` as a command, and
  //   $SPARKDOWN_CONTEXT would have been expanded by the OUTER shell rather
  //   than passed through for the agent to resolve.
// - So: no backticks, no apostrophes in the prompt text; the env var name
//   survives verbatim for the agent to interpret.
const AGENT_TEACH_PROMPT =
  'Read the file $SPARKDOWN_CONTEXT/context.json first: it shows the file ' +
  'I am viewing in my editor and all open tabs; entries with a "shadow" ' +
  'field are unsaved buffers you can read at that path (relative to the ' +
  '$SPARKDOWN_CONTEXT directory). Re-read it whenever you need to know ' +
  'what I am looking at. Wait for further instructions before proceeding ' +
  'with any other task.';

/*
 * PowerShell (local Windows terminals). terminal.rs runs the line with
 * `Invoke-Expression` in `pwsh` (else Windows PowerShell 5.1), the shell
 * the terminal itself runs, and the same line is what a chip types into a
 * pane at the pane limit. Rules that keep it identical in 5.1 and 7.x:
 *
 * - Every literal is a PowerShell single-quoted string (psq): nothing
 *   expands inside, and the only escape is a doubled quote.
 * - No native-command ARGUMENT contains a double quote. Windows
 *   PowerShell 5.1 (and 7.3+ for .cmd files such as npm's shims, under the
 *   default $PSNativeCommandArgumentPassing = 'Windows') does not escape
 *   embedded " when it builds the command line, so inline JSON would reach
 *   the agent with its quotes stripped. Hence: Claude reads a config FILE
 *   (the backend writes it: ShimCommand.configFile), Codex gets TOML
 *   literal strings ('…', no " needed), opencode gets its JSON in an
 *   environment variable (never on a command line), and the teaching
 *   prompt has its double quotes removed.
 */

/** Single-quote `s` for PowerShell: '…' with each quote doubled. PowerShell
 *  also takes the typographic quotes ‘ ’ ‚ ‛ as single quotes, so they are
 *  doubled too (a path like C:\Users\O’Brien would otherwise end the string). */
export function psq(s: string): string {
  return `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
}

/** A TOML literal string for `s` ('…', backslashes stay literal: right for
 *  Windows paths). With an apostrophe inside, a one-line multi-line literal
 *  ('''…'''). null when neither can hold it (a "'''" run, a trailing quote,
 *  or a control character). */
export function tomlLiteral(s: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  if (!s.includes("'")) return `'${s}'`;
  if (s.includes("'''") || s.endsWith("'")) return null;
  return `'''${s}'''`;
}

/** The env_vars override (see CODEX_ENV_OVERRIDE), in TOML literal syntax. */
const CODEX_ENV_OVERRIDE_PS = `-c ${psq("mcp_servers.sparkdown.env_vars=['SPARKDOWN_MCP']")}`;

function powershellLaunchCommand(bin: string, ctx: LaunchContext, extra: string): string {
  if (ctx.installed) {
    return bin === 'codex' ? `codex ${CODEX_ENV_OVERRIDE_PS}${extra}` : `${bin}${extra}`;
  }
  const shim = ctx.shim;
  if (shim) {
    switch (bin) {
      case 'claude':
        // --mcp-config takes a file path too; the path has no " in it.
        if (shim.configFile) return `claude --mcp-config ${psq(shim.configFile)}${extra}`;
        break;
      case 'codex': {
        const prog = tomlLiteral(shim.program);
        const args = shim.args.map(tomlLiteral);
        if (prog === null || args.some((a) => a === null)) break;
        return `codex -c ${psq(`mcp_servers.sparkdown.command=${prog}`)} -c ${psq(`mcp_servers.sparkdown.args=[${args.join(',')}]`)} ${CODEX_ENV_OVERRIDE_PS}${extra}`;
      }
      case 'opencode': {
        // Set for this one run, then removed (try/finally also runs on
        // Ctrl+C), so later commands in the same shell do not inherit it.
        const config = JSON.stringify({
          mcp: {
            sparkdown: {
              type: 'local',
              command: [shim.program, ...shim.args],
              enabled: true,
              environment: { SPARKDOWN_MCP: '{env:SPARKDOWN_MCP}' },
            },
          },
        });
        return `$env:OPENCODE_CONFIG_CONTENT = ${psq(config)}; try { opencode${extra} } finally { Remove-Item Env:OPENCODE_CONFIG_CONTENT -ErrorAction SilentlyContinue }`;
      }
      default:
        break;
    }
  }
  return `${bin}${extra} ${psq(AGENT_TEACH_PROMPT.replace(/"/g, ''))}`;
}

/**
 * Brand logos for the agent launch chips (official marks from Simple Icons,
 * rendered in currentColor so they sit quietly in both themes). Kiro isn't in
 * Simple Icons; its mark is a ghost, drawn here to match. Grok uses the X
 * mark (xAI). Unknown agents fall back to a letter monogram; full names live
 * in the tooltip.
 */
const AGENT_ICONS: Record<string, string> = {
  // Claude (Anthropic)
  claude:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
  // Codex (OpenAI)
  codex:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
  // Kiro — the official ghost mark (from the brand SVG), body + eye cutouts
  // merged into one evenodd path so it renders in currentColor.
  kiro:
    '<svg width="14" height="14" viewBox="200 140 730 920" fill="currentColor"><path fill-rule="evenodd" d="M398.554 818.914C316.315 1001.03 491.477 1046.74 620.672 940.156C658.687 1059.66 801.052 970.473 852.234 877.795C964.787 673.567 919.318 465.357 907.64 422.374C827.637 129.443 427.623 128.946 358.8 423.865C342.651 475.544 342.402 534.18 333.458 595.051C328.986 625.86 325.507 645.488 313.83 677.785C306.873 696.424 297.68 712.819 282.773 740.645C259.915 783.881 269.604 867.113 387.87 823.883L399.051 818.914H398.554Z M636.123 549.353C603.328 549.353 598.359 510.097 598.359 486.742C598.359 465.623 602.086 448.977 609.293 438.293C615.504 428.852 624.697 424.131 636.123 424.131C647.555 424.131 657.492 428.852 664.447 438.541C672.398 449.474 676.623 466.12 676.623 486.742C676.623 525.998 661.471 549.353 636.375 549.353H636.123Z M771.24 549.353C738.445 549.353 733.477 510.097 733.477 486.742C733.477 465.623 737.203 448.977 744.41 438.293C750.621 428.852 759.814 424.131 771.24 424.131C782.672 424.131 792.609 428.852 799.564 438.541C807.516 449.474 811.74 466.12 811.74 486.742C811.74 525.998 796.588 549.353 771.492 549.353H771.24Z"/></svg>',
  // Grok — the SpaceX "X" swoosh mark, per user preference.
  grok:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M24 7.417C8.882 8.287 1.89 14.75.321 16.28L0 16.583h2.797C10.356 9.005 21.222 7.663 24 7.417zm-17.046 6.35c-.472.321-.945.68-1.398 1.02l2.457 1.796h2.778zM2.948 10.8H.189l3.25 2.381c.473-.321 1.02-.661 1.512-.945Z"/></svg>',
  // Cursor
  cursor:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"/></svg>',
  // Gemini (Google)
  gemini:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/></svg>',
};

/** Short, stable, tmux-safe key for a workspace path — used only to scope and
 *  match tmux session names (not a security/collision-critical hash). FNV-1a
 *  → 8 hex chars. */
function hashKey(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function agentIconHtml(id: string, label: string): string {
  return (
    AGENT_ICONS[id] ??
    `<span class="terminal-agent-monogram">${label.slice(0, 1).toUpperCase()}</span>`
  );
}

/** Where a pane runs, for its header: "~/Projects/app", or "devbox · ~/svc"
 *  on a remote host. `home` shortens the path to `~`; without it, a
 *  /Users/<name> or /home/<name> prefix is shortened. Exported for tests. */
export function paneLocation(
  cwd: string | null,
  remote: Pick<RemoteSession, 'host' | 'home'> | null,
): string {
  let path = cwd ?? '';
  const home = remote?.home?.replace(/\/+$/, '');
  if (home && (path === home || path.startsWith(`${home}/`))) {
    path = `~${path.slice(home.length)}`;
  } else if (!remote) {
    path = path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+)(?=\/|$)/, '~');
  }
  if (!path) path = '~';
  return remote ? `${remote.host} · ${path}` : path;
}

/** Persistence hook for the split layout (AppConfig.terminal_layouts),
 *  keyed by the workspace's tmux session prefix. */
export interface LayoutStore {
  load(key: string): unknown;
  save(key: string, layout: TerminalLayout | null): void;
}

/** What the manager knows about one pane beyond its TerminalPane. */
interface PaneMeta {
  shell: string;
  num: number;
  agentId?: string;
  /** Folder (and host) the pane was started in, for its header. */
  cwd: string | null;
  remote: Pick<RemoteSession, 'host' | 'home'> | null;
  /** User-chosen name (double-click the header name), if any. */
  customName?: string;
}

const SPLIT_RIGHT_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M12 4v16"/></svg>';
const SPLIT_DOWN_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 12h18"/></svg>';

const TERMINALS_ONLY_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';

const MAC = isMacOS();
const KEYS = MAC
  ? { right: '⌘D', down: '⌘⇧D', close: '⌘W' }
  : { right: 'Ctrl+Shift+D', down: 'Ctrl+Shift+E', close: 'Ctrl+Shift+W' };
const AT_MAX = `${MAX_PANES} panes is the maximum: close one to split`;

/**
 * The terminal split grid (spec item 6). A binary tree of rows / columns
 * (split-layout.ts) whose leaves are TerminalPanes, each its own pty and
 * tmux session. Split right / down, close, focus next / previous, drag the
 * dividers; at most MAX_PANES panes. The tree (with each pane's tmux
 * session) is persisted per workspace and restored on the next launch.
 * Lazy: nothing is created until the drawer is first opened.
 */
export class TerminalManager {
  private panes = new Map<string, TerminalPane>();
  private meta = new Map<string, PaneMeta>();
  /** The pane card (header + terminal body) per pane id. */
  private cards = new Map<string, HTMLElement>();
  private tree: LayoutNode | null = null;
  /** The pane that has (or last had) keyboard focus. */
  private focusedId: string | null = null;
  private seq = 0;
  private host: HTMLElement;
  private cwd: string | null = null;
  private remote: RemoteSession | null = null;
  /** Settles once the remote-session lookup for the current cwd is done, so
   *  a pane opened right after setCwd already knows its host. */
  private remoteReady: Promise<void> = Promise.resolve();
  private onOpenPath: (path: string) => void;
  private agents: import('./api').AgentCli[] = [];
  private agentArgs: Record<string, string> = {};
  private promptStore: McpPromptStore | null = null;
  /** True while the MCP install prompt is open (one at a time). */
  private prompting = false;
  /** Per-shell counters for session numbers ("zsh-1", "zsh-2"…). */
  private nameCounters = new Map<string, number>();
  /** tmux session-name prefix for this workspace, so surviving sessions can
   *  be listed and reattached on the next launch (see restoreOrCreate). */
  private sessionPrefix = 'sd-none-';
  /** Whether to back terminals with tmux (user setting; on by default). When
   *  off, panes start as plain shells (no session name passed to the backend)
   *  and no reattach is attempted. Takes effect for terminals opened after the
   *  change; existing panes keep their current backing. */
  private useTmux = true;
  /** Login shell name ("zsh"/"bash"), resolved once for pane names. */
  private shellName = '';
  private store: LayoutStore | null = null;

  /** Called when the last terminal closes (shell exited or pane closed), so
   *  the app can hide the empty drawer. */
  private onEmpty: (() => void) | null = null;

  setOnEmpty(cb: () => void): void {
    this.onEmpty = cb;
  }

  /** Pane-header "Terminals only" button (#21): the visible way into the
   *  layout where the terminal fills the center column (the title bar stays
   *  minimal; also View → Terminals Only, the palette, Ctrl+Shift+`). */
  private onTerminalsOnly: (() => void) | null = null;

  setOnTerminalsOnly(cb: () => void): void {
    this.onTerminalsOnly = cb;
  }

  /** Where the layout is persisted (the cockpit wires AppConfig here). */
  setLayoutStore(store: LayoutStore): void {
    this.store = store;
  }

  constructor(host: HTMLElement, onOpenPath: (path: string) => void) {
    this.host = host;
    this.onOpenPath = onOpenPath;
    this.host.addEventListener('click', (e) => this.onHostClick(e));
    // Track the focused pane: a click anywhere in a pane, or keyboard focus
    // entering its terminal.
    this.host.addEventListener('mousedown', (e) => this.focusFromEvent(e));
    this.host.addEventListener('focusin', (e) => this.focusFromEvent(e));
    this.refreshAgents();
  }

  /** Detect installed agent CLIs; chips render for found ones. Re-run on
   *  every workspace change: a remote workspace has its own set of agents
   *  (the chips launch them in the REMOTE shell), so the startup scan of
   *  the local machine must not stick. */
  private refreshAgents(): void {
    void api
      .detectAgents()
      .then((list) => {
        this.agents = list.filter((a) => a.found);
        this.renderHeaders();
      })
      .catch(() => {});
  }

  /**
   * Launch an agent CLI as the shell's foreground process (already
   * submitted, only after the login shell has finished initializing: the
   * backend runs it via `$SHELL -lic`, or `Invoke-Expression` in PowerShell
   * on Windows). The agent starts clean; with MCP it
   * discovers the editor context by itself, otherwise a teaching prompt tells
   * it to read the file bridge.
   *
   * Placement (the calm default): a NEW split next to the focused pane when
   * there is room, so nothing running is disturbed. At MAX_PANES the command
   * is typed into the focused pane instead, NOT submitted: the user reads
   * it and presses Enter (or clears it) at that prompt.
   */
  async launchAgent(bin: string): Promise<void> {
    const agentId = this.agents.find((a) => a.bin === bin)?.id ?? bin;
    // Resolve the launch command BEFORE opening the terminal: it is baked into
    // the shell invocation, so it must be known up front. The backend picks
    // the shim for the active target: the app binary locally, or the shim
    // script it installed on the remote host (reverse-forwarded socket). It
    // returns null when neither is reachable → the file-bridge fallback.
    const shim = await api.mcpShimCommand().catch(() => null);
    // Claude/Codex/opencode inject at launch (session-scoped); other agents
    // rely on a prior install, so only for those do we pay the "is it
    // installed" check.
    const injectable = SESSION_INJECT_BINS.has(bin);
    let installed =
      shim && !injectable ? await api.mcpAgentInstalled(bin).catch(() => false) : false;
    // Not installed, no launch flag: ask once whether to install (a
    // persistent change to the agent's own config needs consent).
    if (shim && !installed && PROMPT_INSTALL_BINS.has(bin) && !this.promptStore?.isDismissed(bin)) {
      if (this.prompting) return; // one prompt at a time
      this.prompting = true;
      try {
        const label = this.agents.find((a) => a.bin === bin)?.label ?? bin;
        const result = await showMcpInstallPrompt({
          label,
          install: () => api.mcpInstallAgent(bin),
        });
        if (result === 'installed') installed = true;
        else if (result === 'never') this.promptStore?.dismiss(bin);
      } finally {
        this.prompting = false;
      }
    }
    // Local Windows → PowerShell syntax; macOS / Linux and any remote host
    // (even from Windows) → POSIX. Asked per launch: it follows the remote
    // session.
    const shell = await api.launchShell().catch(() => 'posix' as const);
    const launch = agentLaunchCommand(bin, {
      shim,
      installed,
      extraArgs: this.agentArgs[bin] ?? '',
      shell,
    });
    if (!this.canSplit) {
      const target = this.active();
      target?.paste(launch);
      target?.focus();
      return;
    }
    await this.addTerminal({ agentId, launch, split: { dir: this.autoDir() } });
    this.active()?.focus();
  }

  /** Split direction for an agent launch: along the focused pane's longer side. */
  private autoDir(): SplitDir {
    const card = this.focusedId ? this.cards.get(this.focusedId) : undefined;
    const rect = card?.getBoundingClientRect();
    return autoSplitDir(rect?.width ?? 0, rect?.height ?? 0);
  }

  /** Where "Don't ask again" for the MCP install prompt is kept. */
  setMcpPromptStore(store: McpPromptStore): void {
    this.promptStore = store;
  }

  /** Per-agent extra launch flags (Settings → Agents), keyed by `bin`. */
  setAgentArgs(map: Record<string, string>): void {
    this.agentArgs = { ...map };
  }

  /** The user's login shell name, resolved once and reused for pane names. */
  private async resolveShell(): Promise<string> {
    if (!this.shellName) {
      this.shellName = await api.shellName().catch(() => 'shell');
    }
    return this.shellName;
  }

  /** Next auto-increment number for a shell ("zsh" → 1, 2, 3…), used in the
   *  tmux session name so every pane has its own session. */
  private nextNumber(shell: string): number {
    const n = (this.nameCounters.get(shell) ?? 0) + 1;
    this.nameCounters.set(shell, n);
    return n;
  }

  /** Build a tmux session id that encodes enough to restore the pane: the
   *  shell and its number, plus the launching agent id (so its name returns
   *  after a restart). e.g. "sd-ab12-zsh-3" or "sd-ab12-zsh-3-a-claude". */
  private buildSession(shell: string, num: number, agentId?: string): string {
    const core = `${shell}-${num}`.replace(/[^A-Za-z0-9-]+/g, '-');
    const agent = agentId ? `-a-${agentId.replace(/[^A-Za-z0-9]+/g, '-')}` : '';
    return `${this.sessionPrefix}${core}${agent}`;
  }

  /** Number of open terminals (0 = drawer empty). */
  get count(): number {
    return this.panes.size;
  }

  /** False at MAX_PANES: split buttons are disabled, split keys do nothing. */
  get canSplit(): boolean {
    return this.panes.size < MAX_PANES;
  }

  /** Pane ids in reading order (left→right, top→bottom). */
  get order(): string[] {
    return paneIds(this.tree);
  }

  /** The current layout tree of pane ids (tests, command palette). */
  get layout(): LayoutNode | null {
    return this.tree;
  }

  setCwd(cwd: string | null): void {
    const changed = cwd !== this.cwd;
    this.cwd = cwd;
    if (changed) {
      this.refreshAgents();
      // Remote workspaces show "host · path" in new pane headers.
      this.remoteReady = Promise.resolve()
        .then(() => api.remoteSession())
        .then((s) => {
          this.remote = s ?? null;
        })
        .catch(() => {
          this.remote = null;
        });
    }
    // Derive a stable, tmux-safe session prefix per workspace so surviving
    // sessions are scoped to (and reattachable within) this folder. tmux
    // forbids ':' and '.' in session names; a short hash sidesteps both.
    this.sessionPrefix = `sd-${cwd ? hashKey(cwd) : 'none'}-`;
  }

  /** Toggle tmux backing for terminals opened from now on (user setting). */
  setUseTmux(enabled: boolean): void {
    this.useTmux = enabled;
  }

  /**
   * On first open with an empty drawer, restore the grid: the saved layout
   * of this workspace, reattached to the tmux sessions that survived the last
   * run. Panes whose session is gone are dropped (their split collapses);
   * surviving sessions the layout does not know (a config from before splits
   * had no layout) are laid out after it in one row, up to MAX_PANES. With
   * nothing to reattach (or tmux off / not installed) one fresh terminal
   * opens.
   */
  async restoreOrCreate(): Promise<void> {
    if (this.panes.size > 0) {
      this.refitAll();
      this.focusActive();
      return;
    }
    const sessions = this.useTmux
      ? await api.tmuxSessions(this.sessionPrefix).catch(() => [] as string[])
      : [];
    await this.remoteReady;
    // Numeric order, so "zsh-10" comes after "zsh-2" (a plain sort() is
    // lexicographic and restored panes came back out of order).
    const ordered = [...sessions].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    const saved = this.store?.load(this.sessionPrefix);
    const sessionTree = restoreLayout(saved, ordered);
    if (!sessionTree) {
      await this.addTerminal();
      return;
    }
    // Build every pane first (ids + cards), lay the grid out, then start the
    // shells in reading order so each fits into its final cell.
    const starts: Array<() => Promise<void>> = [];
    const idBySession = new Map<string, string>();
    for (const session of paneIds(sessionTree)) {
      const { id, start } = this.createPane(this.metaForSession(session), session, null);
      idBySession.set(session, id);
      starts.push(start);
    }
    this.tree = mapPanes(sessionTree, (s) => idBySession.get(s) ?? null);
    this.focusedId = paneIds(this.tree)[0] ?? null;
    this.render();
    for (const start of starts) await start();
    this.persist();
    this.focusActive();
  }

  /** Recover shell, number and agent from a surviving session's encoded id,
   *  and advance the counter so later panes don't reuse the number. */
  private metaForSession(session: string): PaneMeta {
    const tail = session.slice(this.sessionPrefix.length); // "zsh-3[-a-claude]"
    const m = tail.match(/^(.+?)-(\d+)(?:-a-([\w-]+))?$/);
    const shell = m ? m[1] : tail || 'shell';
    const num = m ? Number(m[2]) : this.nextNumber(shell);
    if (num > (this.nameCounters.get(shell) ?? 0)) {
      this.nameCounters.set(shell, num);
    }
    return { shell, num, agentId: m?.[3], cwd: this.cwd, remote: this.remote };
  }

  /**
   * Open a new terminal pane and focus it. With no options it's a plain
   * shell (the first pane, or a split of the focused one); `agentId` names
   * it after an agent (launched from a chip); `split` picks the pane to split
   * (default: the focused one) and the direction. Returns false when the
   * grid is full (MAX_PANES) or the shell exited while starting.
   */
  async addTerminal(
    opts: {
      agentId?: string;
      /** Command to run as the shell's foreground process (agent chips). */
      launch?: string;
      split?: { dir: SplitDir; target?: string };
    } = {},
  ): Promise<boolean> {
    if (!this.canSplit) return false;
    const shell = await this.resolveShell();
    await this.remoteReady;
    // Re-check across the await: a quick double ⌘D must not pass MAX_PANES.
    if (!this.canSplit) return false;
    const num = this.nextNumber(shell);
    const meta: PaneMeta = {
      shell,
      num,
      agentId: opts.agentId,
      cwd: this.cwd,
      remote: this.remote,
    };
    const session = this.buildSession(shell, num, opts.agentId);
    const { id, pane, start } = this.createPane(meta, session, opts.launch ?? null);
    const order = paneIds(this.tree);
    const target =
      opts.split?.target && order.includes(opts.split.target)
        ? opts.split.target
        : (this.focusedId ?? order[order.length - 1]);
    this.tree = this.tree
      ? splitPane(this.tree, target, id, opts.split?.dir ?? 'row')
      : leaf(id);
    this.focusedId = id;
    this.render();
    await start();
    // The shell exited while starting: closeTerminal already removed it.
    if (!this.panes.has(id)) return false;
    this.persist();
    if (this.focusedId === id) pane.focus();
    return true;
  }

  /**
   * Create a pane and its card (not yet in the tree, shell not started).
   * `start()` mounts xterm into the card and starts the shell.
   */
  private createPane(
    meta: PaneMeta,
    session: string,
    launch: string | null,
  ): { id: string; pane: TerminalPane; start: () => Promise<void> } {
    const id = `term-${++this.seq}`;
    const pane = new TerminalPane(id, this.onOpenPath, (action) =>
      this.onPaneAction(id, action),
    );
    this.panes.set(id, pane);
    this.meta.set(id, meta);
    const card = this.buildCard(id);
    this.cards.set(id, card);

    // Shell/session exited (`exit` / Ctrl-D / process end): close THIS pane
    // only — a dead PTY has no further use — and if it was the last one, tell
    // the app to hide the drawer. A failed spawn is different: keep the pane
    // so the error stays readable.
    //
    // tmux: backend forces detach-on-destroy on for the sd-* session and also
    // watches session liveness, so typing `exit` in the pane's shell closes
    // the pane even when the user's tmux.conf sets detach-on-destroy off.
    // closeTerminal then kills the sd-* session so it does not resurrect.
    pane.setOnExit(() => {
      if (pane.isStartFailed()) {
        this.renderHeaders();
        return;
      }
      this.closeTerminal(pane.id);
    });
    const hostEl = card.querySelector<HTMLElement>('.terminal-pane-host')!;
    const start = async () => {
      if (!this.panes.has(id)) return;
      await pane.init(hostEl, meta.cwd, this.useTmux ? session : null, launch);
      this.renderHeaders();
    };
    return { id, pane, start };
  }

  /** Close a terminal by id (kills its shell); its split collapses. Empties
   *  the drawer if last. An explicit close also kills the tmux session — the
   *  user asked for this pane to go away, so it should NOT resurrect on next
   *  launch. (Quitting the app drops the pty without killing the session, so
   *  those survive and reattach.) */
  closeTerminal(id: string): void {
    const pane = this.panes.get(id);
    if (!pane) return;
    // Only hand focus to a neighbour when it was in the grid already: a
    // shell exiting in the background must not pull focus from the editor.
    const hadFocus = this.hasFocus();
    const order = paneIds(this.tree);
    const idx = order.indexOf(id);
    this.panes.delete(id);
    this.meta.delete(id);
    this.cards.get(id)?.remove();
    this.cards.delete(id);
    const session = pane.sessionName;
    if (session) void api.tmuxKillSession(session).catch(() => {});
    pane.destroy();
    this.tree = removePane(this.tree, id);
    if (this.focusedId === id || !this.focusedId || !this.panes.has(this.focusedId)) {
      const rest = order.filter((p) => p !== id);
      this.focusedId = rest[Math.min(Math.max(idx, 0), rest.length - 1)] ?? null;
    }
    this.render();
    this.persist();
    if (this.panes.size === 0) {
      // Last pane gone (shell exited or user closed it): the app hides the
      // empty drawer. ⌃` stays a pure panel toggle and reopens with a fresh
      // shell (restoreOrCreate).
      this.onEmpty?.();
      return;
    }
    if (hadFocus) this.focusActive();
  }

  /** Split the focused pane (right = 'row', down = 'column'). */
  splitFocused(dir: SplitDir): Promise<boolean> {
    return this.addTerminal({ split: { dir } });
  }

  /** Close the focused pane. */
  closeFocused(): void {
    if (this.focusedId) this.closeTerminal(this.focusedId);
  }

  /** Move focus `delta` panes along reading order (wraps). */
  focusNeighbor(delta: number): void {
    const next = neighborPane(this.tree, this.focusedId, delta);
    if (next) this.activate(next);
  }

  /** Whether keyboard focus is inside one of the terminal panes. */
  hasFocus(): boolean {
    const el = document.activeElement;
    return !!el && this.host.contains(el);
  }

  /** Focus pane `id` (keyboard focus + the focused outline). */
  activate(id: string): void {
    if (!this.panes.has(id)) return;
    this.setFocused(id);
    this.panes.get(id)?.focus();
  }

  active(): TerminalPane | null {
    return (this.focusedId && this.panes.get(this.focusedId)) || null;
  }

  focusActive(): void {
    this.active()?.focus();
  }

  /** Refit every pane (drawer resize, terminals-only switch, window resize). */
  refitAll(): void {
    for (const p of this.panes.values()) p.refitSoon();
  }

  /** @deprecated kept for callers from before splits: refits every pane. */
  refitActive(): void {
    this.refitAll();
  }

  applyTheme(): void {
    for (const p of this.panes.values()) p.applyTheme();
  }

  private onPaneAction(id: string, action: TerminalPaneAction): void {
    this.setFocused(id);
    switch (action) {
      case 'split-right':
        void this.splitFocused('row');
        break;
      case 'split-down':
        void this.splitFocused('column');
        break;
      case 'close-pane':
        this.closeTerminal(id);
        break;
      case 'focus-next':
        this.focusNeighbor(1);
        break;
      case 'focus-prev':
        this.focusNeighbor(-1);
        break;
    }
  }

  private setFocused(id: string): void {
    if (this.focusedId === id || !this.panes.has(id)) return;
    this.focusedId = id;
    this.renderHeaders();
  }

  private focusFromEvent(e: Event): void {
    const card = (e.target as HTMLElement | null)?.closest<HTMLElement>('.terminal-pane');
    const id = card?.dataset.termId;
    if (id) this.setFocused(id);
  }

  private onHostClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const agentBtn = target.closest<HTMLElement>('.terminal-agent-btn');
    if (agentBtn?.dataset.bin) {
      void this.launchAgent(agentBtn.dataset.bin);
      return;
    }
    const btn = target.closest<HTMLButtonElement>('[data-act]');
    const id = btn?.closest<HTMLElement>('.terminal-pane')?.dataset.termId;
    if (!btn || !id || btn.disabled) return;
    e.stopPropagation();
    switch (btn.dataset.act) {
      case 'split-right':
        void this.addTerminal({ split: { dir: 'row', target: id } });
        break;
      case 'split-down':
        void this.addTerminal({ split: { dir: 'column', target: id } });
        break;
      case 'close':
        this.closeTerminal(id);
        break;
      case 'terminals-only':
        this.onTerminalsOnly?.();
        break;
    }
  }

  /** Save the layout (tree + each pane's tmux session) for this workspace. */
  private persist(): void {
    if (!this.store) return;
    const layout = toPersisted(this.tree, (id) => this.panes.get(id)?.sessionName ?? null);
    this.store.save(this.sessionPrefix, layout);
  }

  /** One pane card: header (live dot, name, folder, agent chips, split /
   *  close buttons) above the terminal body. Built once per pane; the grid
   *  re-parents it on every layout change. */
  private buildCard(id: string): HTMLElement {
    const card = document.createElement('div');
    card.className = 'terminal-pane';
    card.dataset.termId = id;
    card.innerHTML = `
      <div class="terminal-pane-header">
        <span class="terminal-pane-live"></span>
        <span class="terminal-pane-name" title="Double-click to rename"></span>
        <span class="terminal-pane-cwd"></span>
        <span class="terminal-pane-agents"></span>
        <button class="terminal-pane-btn" data-act="split-right" aria-label="Split right">${SPLIT_RIGHT_ICON}</button>
        <button class="terminal-pane-btn" data-act="split-down" aria-label="Split down">${SPLIT_DOWN_ICON}</button>
        <button class="terminal-pane-btn" data-act="terminals-only" aria-label="Terminals only" title="Terminals only (${shortcutFor(ACTIONS.TOGGLE_TERMINALS_ONLY)})">${TERMINALS_ONLY_ICON}</button>
        <button class="terminal-pane-btn terminal-pane-close" data-act="close" aria-label="Close terminal" title="Close terminal (${KEYS.close})">×</button>
      </div>
      <div class="terminal-pane-body"><div class="terminal-pane-host"></div></div>`;
    const name = card.querySelector<HTMLElement>('.terminal-pane-name')!;
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.beginRename(id, name);
    });
    return card;
  }

  /** Rebuild the grid DOM from the tree (cards are re-parented, never
   *  rebuilt, so each xterm keeps its state). */
  private render(): void {
    const hadFocus = this.hasFocus();
    const root = this.tree ? this.buildNode(this.tree, '') : null;
    if (root) root.style.flex = '1 1 0px';
    this.host.replaceChildren(...(root ? [root] : []));
    this.renderHeaders();
    this.refitAll();
    // Re-parenting blurs the terminal that had focus; give it back.
    if (hadFocus) this.focusActive();
  }

  private buildNode(node: LayoutNode, path: string): HTMLElement {
    if (node.type === 'pane') return this.cards.get(node.id)!;
    const row = node.dir === 'row';
    const el = document.createElement('div');
    el.className = `terminal-split terminal-split--${node.dir}`;
    el.dataset.path = path;
    const a = this.buildNode(node.a, `${path}a`);
    const b = this.buildNode(node.b, `${path}b`);
    const applyRatio = (r: number) => {
      a.style.flex = `${r} 1 0px`;
      b.style.flex = `${1 - r} 1 0px`;
    };
    applyRatio(node.ratio);
    const divider = document.createElement('div');
    divider.className = `terminal-split-divider resize-divider resize-divider--${row ? 'col' : 'row'}`;
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', row ? 'vertical' : 'horizontal');
    divider.setAttribute('aria-label', 'Resize terminals');
    let rect: DOMRect | null = null;
    attachResizeDrag(divider, {
      cursor: row ? 'col-resize' : 'row-resize',
      onStart: () => {
        rect = el.getBoundingClientRect();
      },
      onMove: (e) => {
        if (!rect || !this.tree) return;
        const span = row ? rect.width : rect.height;
        if (span <= 0) return;
        const r = clampRatio(((row ? e.clientX - rect.left : e.clientY - rect.top)) / span);
        this.tree = setRatio(this.tree, path, r);
        const n = nodeAt(this.tree, path);
        if (n?.type === 'split') applyRatio(n.ratio);
        // Each pane's ResizeObserver refits it (debounced) as its cell changes.
      },
      onEnd: () => {
        this.refitAll();
        this.persist();
      },
    });
    el.append(a, divider, b);
    return el;
  }

  /** Update every pane header (focus, live state, name, folder, buttons). */
  private renderHeaders(): void {
    const multi = this.panes.size > 1;
    const canSplit = this.canSplit;
    for (const [id, card] of this.cards) {
      const pane = this.panes.get(id)!;
      const meta = this.meta.get(id)!;
      const focused = id === this.focusedId;
      card.classList.toggle('focused', focused && multi);

      const live = card.querySelector<HTMLElement>('.terminal-pane-live')!;
      const failed = pane.isStartFailed();
      live.classList.toggle('is-running', pane.isRunning());
      live.classList.toggle('is-failed', failed);
      live.title = failed ? 'Failed to start' : pane.isRunning() ? 'Running' : 'Starting';

      const agent = meta.agentId ? this.agents.find((a) => a.id === meta.agentId) : undefined;
      const process = meta.agentId ?? meta.shell;
      const nameEl = card.querySelector<HTMLElement>('.terminal-pane-name');
      if (nameEl) {
        nameEl.textContent = meta.customName ?? process;
        nameEl.title = `${agent?.label ?? process} (session ${meta.num}). Double-click to rename`;
      }

      const where = paneLocation(meta.cwd, meta.remote);
      const cwdEl = card.querySelector<HTMLElement>('.terminal-pane-cwd')!;
      cwdEl.textContent = where;
      cwdEl.title = meta.remote ? `${meta.remote.host}:${meta.cwd ?? '~'}` : (meta.cwd ?? '');

      for (const [act, label, key] of [
        ['split-right', 'Split right', KEYS.right],
        ['split-down', 'Split down', KEYS.down],
      ] as const) {
        const btn = card.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
        btn.disabled = !canSplit;
        btn.title = canSplit ? `${label} (${key})` : AT_MAX;
      }

      // Agent launch chips sit in the focused pane's header only (one set
      // for the grid, next to where the new split will open).
      const chips = card.querySelector<HTMLElement>('.terminal-pane-agents')!;
      const want = focused ? this.agents.map((a) => a.bin).join(',') : '';
      if (chips.dataset.bins !== want) {
        chips.dataset.bins = want;
        chips.replaceChildren();
        if (focused) {
          for (const a of this.agents) {
            const btn = document.createElement('button');
            btn.className = 'terminal-agent-btn';
            btn.dataset.bin = a.bin;
            btn.innerHTML = agentIconHtml(a.id, a.label);
            btn.setAttribute('aria-label', `Launch ${a.label}`);
            chips.appendChild(btn);
          }
        }
      }
      for (const btn of chips.querySelectorAll<HTMLElement>('.terminal-agent-btn')) {
        const label = this.agents.find((a) => a.bin === btn.dataset.bin)?.label ?? btn.dataset.bin;
        btn.title = canSplit
          ? `Launch ${label} in a new split, connected to the SparkDown editor context (what you're viewing)`
          : `Type the ${label} launch command into this pane (${MAX_PANES} panes open); press Enter to run it`;
      }
    }
  }

  /**
   * Inline rename: swap the name for a text input; Enter/blur commits,
   * Escape cancels. Empty input keeps the old name.
   */
  private beginRename(id: string, label: HTMLElement): void {
    const meta = this.meta.get(id);
    if (!meta) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'terminal-pane-rename';
    input.value = meta.customName ?? meta.agentId ?? meta.shell;
    input.maxLength = 40;
    label.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (commit && value) meta.customName = value;
      input.replaceWith(label);
      this.renderHeaders();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // don't let terminal shortcuts fire while typing
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }
}
