import { api } from './api';
import type { AgentMcpStatus, AppConfig, SaveHook, UserCommand, UserRunView } from './api';
import { joinCommandLine, trySplitCommandLine } from './user-run-argv';
import { trapFocus, type ModalHandle } from './modal';
import {
  TERMINAL_SCROLLBACK_DEFAULT,
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_MIN,
  clampScrollback,
} from './terminal-scrollback';

/**
 * Settings modal. A small, focused preferences dialog —
 * same overlay pattern as the shortcuts dialog. Reads/writes the live
 * AppConfig object and calls `onChange` so the app can persist and react
 * (e.g. re-detect terminals). The App owns one instance; the open overlay,
 * its focus trap and its Escape handler live on it (no module state).
 */

export interface SettingsHost {
  config: AppConfig;
  /** Called after a setting changes so the app can persist + apply it. */
  onChange: () => void;
  /** User-level custom commands (absent in tests that don't cover them). */
  userRun?: UserRunSettings;
}

export interface UserRunSettings {
  view(): UserRunView;
  saveCommands(commands: UserCommand[]): Promise<void>;
  saveHooks(hooks: SaveHook[]): Promise<void>;
  openFile(): void;
  /** Re-read user-run.json from disk; Settings calls it when it opens so an
   *  edit made outside SparkDown is listed. */
  reload?(): Promise<void>;
}

interface OpenSettings {
  overlay: HTMLElement;
  modal: ModalHandle;
  onKey: (e: KeyboardEvent) => void;
}

export class SettingsDialog {
  private open: OpenSettings | null = null;

  get isOpen(): boolean {
    return this.open !== null;
  }

  /** Open the dialog, or close it when it is already open. */
  toggle(host: SettingsHost): void {
    if (this.open) this.close();
    else this.show(host);
  }

  /** Open the dialog (reopening it if shown) scrolled to one section. */
  showSection(host: SettingsHost, section: 'agents'): void {
    this.close();
    this.show(host);
    const el = this.open?.overlay.querySelector<HTMLElement>(`[data-section="${section}"]`);
    el?.scrollIntoView?.({ block: 'start' });
  }

  close(): void {
    const open = this.open;
    if (!open) return;
    this.open = null;
    document.removeEventListener('keydown', open.onKey, true);
    try {
      // Closing (×, Escape, backdrop) must not drop a typed but uncommitted
      // number: commit it the way blur would have.
      for (const el of open.overlay.querySelectorAll<HTMLInputElement>('[data-commit-on-close]')) {
        el.dispatchEvent(new Event('change'));
      }
    } finally {
      open.overlay.remove();
      open.modal.release();
    }
  }

  private show(host: SettingsHost): void {
    let overlay: HTMLElement;
    try {
      overlay = buildSettingsOverlay(host, () => this.close());
    } catch (err) {
      // Still open (and close) a dialog, with what went wrong.
      overlay = buildSettingsFallback(err, () => this.close());
    }
    document.body.appendChild(overlay);
    const dialog = overlay.querySelector<HTMLElement>('.settings-dialog')!;
    const modal = trapFocus(dialog);
    // Move focus off the editor/terminal onto the dialog so Escape lands here
    // right away, without requiring a click inside the modal first.
    dialog.focus();
    // Capture phase: Escape closes the dialog wherever focus is inside it
    // (a switch, a text field), before any other handler can stop it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const open = { overlay, modal, onKey };
    this.open = open;
    const userRun = host.userRun;
    if (userRun?.reload) {
      const before = JSON.stringify(userRun.view());
      userRun.reload().then(() => {
        if (this.open !== open || JSON.stringify(userRun.view()) === before) return;
        overlay.querySelector('[data-user-run]')?.replaceWith(buildUserRunArea(userRun));
      }, () => {});
    }
  }
}

/** A dialog with only a message and ×, for when the full one cannot be built. */
function buildSettingsFallback(err: unknown, close: () => void): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  const dialog = document.createElement('div');
  dialog.className = 'settings-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', 'Settings');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;
  const header = document.createElement('div');
  header.className = 'settings-header';
  const title = document.createElement('h2');
  title.textContent = 'Settings';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'settings-close';
  closeBtn.setAttribute('aria-label', 'Close settings');
  closeBtn.title = 'Close (Esc)';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => close());
  header.append(title, closeBtn);
  const msg = document.createElement('p');
  msg.className = 'settings-run-file-error';
  msg.textContent = `Settings could not be shown: ${String(err)}`;
  dialog.append(header, msg);
  overlay.appendChild(dialog);
  return overlay;
}

/** The overlay + dialog DOM; `close` is wired to ×, backdrop and Escape. */
function buildSettingsOverlay(host: SettingsHost, close: () => void): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const dialog = document.createElement('div');
  dialog.className = 'settings-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', 'Settings');
  dialog.setAttribute('aria-modal', 'true');
  // Focusable so keystrokes (Escape) land on the dialog even when the editor
  // or terminal held focus when it opened.
  dialog.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'settings-header';
  const title = document.createElement('h2');
  title.textContent = 'Settings';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'settings-close';
  closeBtn.setAttribute('aria-label', 'Close settings');
  closeBtn.title = 'Close (Esc)';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => close());
  header.append(title, closeBtn);
  dialog.appendChild(header);

  const section = document.createElement('div');
  section.className = 'settings-section';
  const heading = document.createElement('h3');
  heading.textContent = 'Terminal';
  section.appendChild(heading);

  section.appendChild(
    toggleRow({
      label: 'Persist terminals with tmux',
      desc:
        'Keep terminal sessions (and any running agent) alive across app ' +
        'restarts, reattaching on relaunch. Requires tmux to be installed; ' +
        'has no effect otherwise.',
      checked: host.config.use_tmux,
      onToggle: (value) => {
        host.config.use_tmux = value;
        host.onChange();
      },
    }),
  );

  section.appendChild(
    scrollbackRow({
      value: host.config.terminal_scrollback ?? TERMINAL_SCROLLBACK_DEFAULT,
      onChange: (value) => {
        host.config.terminal_scrollback = clampScrollback(value);
        host.onChange();
      },
    }),
  );

  section.appendChild(
    toggleRow({
      label: 'Notify when an agent waits for input',
      desc:
        'Show an OS notification when a terminal emits OSC 9 or OSC 777 notify ' +
        '(agent CLIs waiting for input), but only when the SparkDown window is ' +
        'not focused.',
      checked: host.config.terminal_notify ?? true,
      onToggle: (value) => {
        host.config.terminal_notify = value;
        host.onChange();
      },
    }),
  );

  section.appendChild(
    toggleRow({
      label: 'Notify on terminal bell',
      desc:
        'Show an OS notification when a terminal emits BEL (bell character), but ' +
        'only when the SparkDown window is not focused. Off by default because ' +
        'shell tab completion rings the bell.',
      checked: host.config.terminal_notify_bell ?? false,
      onToggle: (value) => {
        host.config.terminal_notify_bell = value;
        host.onChange();
      },
    }),
  );

  dialog.appendChild(section);

  // #175: Settings → Git.
  const git = document.createElement('div');
  git.className = 'settings-section';
  git.dataset.section = 'git';
  const gitHeading = document.createElement('h3');
  gitHeading.textContent = 'Git';
  git.appendChild(gitHeading);
  git.appendChild(
    toggleRow({
      label: 'Fetch in the background',
      desc:
        "Quietly run git fetch for the current branch's upstream when the " +
        'window gains focus, every 5 minutes while it is focused, and after ' +
        'a rejected push, so the Pull count shows new commits. Fetch only: ' +
        'nothing is merged. Never asks for credentials (a remote that needs ' +
        'them is skipped). Off in remote (SSH) folders.',
      checked: host.config.git_background_fetch ?? true,
      onToggle: (value) => {
        host.config.git_background_fetch = value;
        host.onChange();
      },
    }),
  );
  dialog.appendChild(git);

  if (host.userRun) dialog.appendChild(buildUserRunArea(host.userRun));

  const agents = document.createElement('div');
  agents.className = 'settings-section';
  agents.dataset.section = 'agents';
  const agentsHeading = document.createElement('h3');
  agentsHeading.textContent = 'Agents';
  agents.appendChild(agentsHeading);
  agents.appendChild(
    toggleRow({
      label: 'Share editor context with agents',
      desc:
        'Mirror the open tabs and the live text of unsaved buffers into a ' +
        'private temp folder ($SPARKDOWN_CONTEXT) that agents in the ' +
        'terminal can read. Written only while the terminal is open; ' +
        'removed on quit. Off: nothing is written.',
      checked: host.config.agent_context_enabled,
      onToggle: (value) => {
        host.config.agent_context_enabled = value;
        host.onChange();
      },
    }),
  );

  agents.appendChild(
    toggleRow({
      label: 'External agents',
      desc:
        'Also serve agents started outside SparkDown terminals. Such an ' +
        'agent must name a folder (sparkdown --mcp-stdio --folder <path>, ' +
        'or $SPARKDOWN_FOLDER) unless exactly one window is open. Off: ' +
        'only agents in SparkDown terminals get the editor tools. On ' +
        'Windows this takes effect after a restart.',
      checked: host.config.mcp_external_agents ?? false,
      onToggle: (value) => {
        host.config.mcp_external_agents = value;
        host.onChange();
      },
    }),
  );

  // MCP install: register SparkDown as an MCP server in each found agent's
  // own config, so it needs no per-launch injection. Populated async.
  const mcpHeading = document.createElement('div');
  mcpHeading.className = 'settings-row-label';
  mcpHeading.textContent = 'Connect agents to SparkDown (MCP)';
  agents.appendChild(mcpHeading);
  const mcpDesc = document.createElement('div');
  mcpDesc.className = 'settings-row-desc';
  mcpDesc.textContent =
    'Install SparkDown as an MCP server in an agent, so it sees your editor ' +
    'when launched from a SparkDown terminal and nothing elsewhere. Claude ' +
    'and Codex also work without this; the others need it, and SparkDown ' +
    'asks once when you launch one. For Cursor, SparkDown adds one entry to ' +
    '~/.cursor/mcp.json. In a remote workspace this installs into the agent ' +
    'on that host.';
  agents.appendChild(mcpDesc);
  const mcpList = document.createElement('div');
  mcpList.className = 'settings-mcp-list';
  agents.appendChild(mcpList);
  void populateMcpInstallers(mcpList, host);

  // Per-agent launch flags: appended to the command a chip runs (e.g.
  // "--model opus" for claude, "--yolo" for gemini). Empty by default.
  const argsHeading = document.createElement('div');
  argsHeading.className = 'settings-row-label';
  argsHeading.textContent = 'Launch flags per agent';
  agents.appendChild(argsHeading);
  const argsDesc = document.createElement('div');
  argsDesc.className = 'settings-row-desc';
  argsDesc.textContent =
    'Extra command-line arguments added when a chip launches the agent. ' +
    'Left as typed; leave blank for none.';
  agents.appendChild(argsDesc);

  for (const agent of KNOWN_AGENTS) {
    agents.appendChild(
      textRow({
        label: agent.label,
        placeholder: agent.placeholder,
        value: host.config.agent_args?.[agent.bin] ?? '',
        onInput: (value) => {
          if (!host.config.agent_args) host.config.agent_args = {};
          const trimmed = value.trim();
          if (trimmed) host.config.agent_args[agent.bin] = trimmed;
          else delete host.config.agent_args[agent.bin];
          host.onChange();
        },
      }),
    );
  }
  dialog.appendChild(agents);

  const updates = document.createElement('div');
  updates.className = 'settings-section';
  const updatesHeading = document.createElement('h3');
  updatesHeading.textContent = 'Updates';
  updates.appendChild(updatesHeading);
  updates.appendChild(
    toggleRow({
      label: 'Check for updates',
      desc:
        'Look for a new version shortly after launch, at most once a day, ' +
        'through sparkdown.dev (or GitHub if that is unavailable). Nothing ' +
        'is downloaded until you choose Install. When this is off, ' +
        'SparkDown makes no update check, including Check for Updates in ' +
        'the menu.',
      checked: host.config.check_updates_automatically ?? true,
      onToggle: (value) => {
        host.config.check_updates_automatically = value;
        host.onChange();
      },
    }),
  );
  dialog.appendChild(updates);

  const hint = document.createElement('p');
  hint.className = 'settings-hint';
  hint.textContent = 'Press Escape to close';
  dialog.appendChild(hint);

  overlay.appendChild(dialog);
  return overlay;
}

/** Agents whose launch flags can be configured. `bin` matches AgentCli.bin
 *  (what the chip launches) so `agent_args` keys line up. */
const KNOWN_AGENTS: { bin: string; label: string; placeholder: string }[] = [
  { bin: 'claude', label: 'Claude Code', placeholder: 'e.g. --model opus' },
  { bin: 'codex', label: 'Codex', placeholder: 'e.g. --model gpt-5' },
  { bin: 'gemini', label: 'Gemini CLI', placeholder: 'e.g. -m gemini-2.5-pro' },
  { bin: 'kiro-cli', label: 'Kiro', placeholder: '' },
  { bin: 'cursor-agent', label: 'Cursor CLI', placeholder: '' },
  { bin: 'agy', label: 'Antigravity', placeholder: '' },
  { bin: 'grok', label: 'Grok', placeholder: '' },
  { bin: 'opencode', label: 'opencode', placeholder: 'e.g. --model anthropic/claude-sonnet-4-5' },
];

/** Agent bins SparkDown can install into: those whose CLI can register an
 *  MCP server (mcp.rs `agent_mcp_commands`), plus Cursor and Antigravity
 *  (one entry in ~/.cursor/mcp.json / ~/.gemini/config/mcp_config.json,
 *  mcp.rs `json_file_agent`). opencode is per-session only (no install). */
const INSTALLABLE_BINS = new Set([
  'claude',
  'codex',
  'grok',
  'kiro-cli',
  'gemini',
  'cursor-agent',
  'agy',
]);

/** Fill `container` with one Install/Remove row per found, installable agent.
 *  Rows render at once in a "Checking…" state; each status resolves on its
 *  own, in parallel, so the dialog never waits on a probe. Nothing is
 *  rendered when no such agent is present. */
async function populateMcpInstallers(container: HTMLElement, host: SettingsHost): Promise<void> {
  const [agents, shim] = await Promise.all([
    api.detectAgents().catch(() => []),
    api.mcpShimCommand().catch(() => null),
  ]);
  const installable = agents.filter((a) => a.found && INSTALLABLE_BINS.has(a.bin));
  const reset = askAgainRow(host, agents);
  if (installable.length === 0) {
    const none = document.createElement('div');
    none.className = 'settings-row-desc';
    none.textContent = 'No installable agents found on your PATH.';
    container.appendChild(none);
    if (reset) container.appendChild(reset);
    return;
  }
  for (const agent of installable) {
    const row = mcpInstallRow(agent.label, agent.bin, shim != null);
    container.appendChild(row.el);
    void api
      .mcpAgentStatus(agent.bin)
      .then((st) => row.setStatus(st))
      .catch(() => row.setStatus({ installed: false, command: null, stale: null }));
  }
  if (reset) container.appendChild(reset);
}

/** "Ask again when launching": clears the per-agent "Don't ask again"
 *  choices of the launch-time install prompt. Null when there are none. */
function askAgainRow(
  host: SettingsHost,
  agents: { bin: string; label: string }[],
): HTMLElement | null {
  const dismissed = host.config.mcp_install_prompt_dismissed ?? [];
  if (dismissed.length === 0) return null;
  const names = dismissed.map((bin) => agents.find((a) => a.bin === bin)?.label ?? bin);
  const row = document.createElement('div');
  row.className = 'settings-row settings-mcp-ask-again';
  const text = document.createElement('div');
  text.className = 'settings-row-text';
  const label = document.createElement('div');
  label.className = 'settings-row-label';
  label.textContent = 'Install prompt at launch';
  const desc = document.createElement('div');
  desc.className = 'settings-row-desc';
  desc.textContent = `Not asked for: ${names.join(', ')}.`;
  text.append(label, desc);
  const btn = document.createElement('button');
  btn.className = 'settings-btn';
  btn.textContent = 'Ask again when launching';
  btn.addEventListener('click', () => {
    host.config.mcp_install_prompt_dismissed = [];
    host.onChange();
    row.remove();
  });
  row.append(text, btn);
  return row;
}

/** Status line for an installed entry (#32: a stale path is not "Installed"). */
export function mcpStatusText(st: AgentMcpStatus): string {
  if (!st.installed) return 'Not installed';
  if (st.stale === 'missing') {
    return `Broken: points at ${st.command ?? 'a program'} which no longer exists. Repair to use this SparkDown.`;
  }
  if (st.stale === 'other') {
    return `Installed, but points at another SparkDown (${st.command ?? '?'}). Repair to use this one.`;
  }
  return 'Installed';
}

/** One agent's install control: label, status, a toggle button and, for a
 *  stale entry, Repair. Starts pending until `setStatus` is called. */
/** Frontend backstop for an MCP install/repair/remove (#49). */
export const MCP_ACTION_BACKSTOP_MS = 45_000;

function mcpInstallRow(
  label: string,
  bin: string,
  serverUp: boolean,
): { el: HTMLElement; setStatus: (st: AgentMcpStatus) => void } {
  const row = document.createElement('div');
  row.className = 'settings-row';
  const text = document.createElement('div');
  text.className = 'settings-row-text';
  const name = document.createElement('div');
  name.className = 'settings-row-label';
  name.textContent = label;
  const status = document.createElement('div');
  status.className = 'settings-row-desc';
  text.append(name, status);

  const btn = document.createElement('button');
  btn.className = 'settings-btn';
  const repair = document.createElement('button');
  repair.className = 'settings-btn settings-mcp-repair';
  repair.textContent = 'Repair';
  repair.hidden = true;

  let state: AgentMcpStatus | null = null;
  const render = () => {
    status.classList.remove('settings-row-error');
    if (state === null) {
      status.textContent = 'Checking…';
      btn.textContent = 'Install';
      btn.disabled = true;
      repair.hidden = true;
      return;
    }
    status.textContent = mcpStatusText(state);
    btn.textContent = state.installed ? 'Remove' : 'Install';
    repair.textContent = 'Repair';
    btn.disabled = !serverUp;
    repair.hidden = !(state.installed && state.stale);
    repair.disabled = !serverUp;
    if (!serverUp) status.textContent = 'MCP server not running';
  };
  render();

  const run = (action: Promise<string>, busy: string, after: AgentMcpStatus) => {
    btn.disabled = true;
    repair.disabled = true;
    (repair.hidden ? btn : repair).textContent = busy;
    // The backend stops the agent CLI after 20 s (a Repair after ~30 s);
    // this is only a backstop so the row can never stay busy (#49).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const backstop = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('The agent CLI did not answer. Try again, or run it in a terminal.')),
        MCP_ACTION_BACKSTOP_MS,
      );
    });
    void Promise.race([action, backstop])
      .then(() => {
        state = after;
        render();
      })
      .catch((err) => {
        render();
        status.textContent = err instanceof Error ? err.message : String(err);
        status.classList.add('settings-row-error');
      })
      .finally(() => clearTimeout(timer));
  };
  btn.addEventListener('click', () => {
    if (state === null) return;
    if (state.installed) {
      repair.hidden = true;
      run(api.mcpUninstallAgent(bin), 'Removing…', { installed: false, command: null, stale: null });
    } else {
      run(api.mcpInstallAgent(bin), 'Installing…', { installed: true, command: null, stale: null });
    }
  });
  // Install replaces an existing entry with this SparkDown's path.
  repair.addEventListener('click', () => {
    if (state === null) return;
    run(api.mcpInstallAgent(bin), 'Repairing…', { installed: true, command: null, stale: null });
  });

  row.append(text, repair, btn);
  return {
    el: row,
    setStatus: (st: AgentMcpStatus) => {
      state = st;
      render();
    },
  };
}

function scrollbackRow(spec: { value: number; onChange: (value: number) => void }): HTMLElement {
  const row = document.createElement('label');
  row.className = 'settings-row';
  const text = document.createElement('div');
  text.className = 'settings-row-text';
  const label = document.createElement('div');
  label.className = 'settings-row-label';
  label.textContent = 'Scrollback lines';
  const desc = document.createElement('div');
  desc.className = 'settings-row-desc';
  desc.textContent = `${TERMINAL_SCROLLBACK_MIN.toLocaleString()} to ${TERMINAL_SCROLLBACK_MAX.toLocaleString()} lines of history, applied live. tmux-backed terminals scroll tmux's own history instead.`;
  text.append(label, desc);
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'settings-text settings-number';
  input.dataset.settingScrollback = '';
  input.min = String(TERMINAL_SCROLLBACK_MIN);
  input.max = String(TERMINAL_SCROLLBACK_MAX);
  // Any whole number of lines: a coarser step made in-range values such as
  // 350 a stepMismatch, so validity failed and the change was dropped.
  input.step = '1';
  input.value = String(spec.value);
  const save = () => {
    // Empty or unparsable: keep the last saved value. Out of range: clamp
    // (and show the clamped value) instead of silently ignoring the edit.
    const typed = input.valueAsNumber;
    if (!Number.isFinite(typed)) {
      input.value = String(spec.value);
      return;
    }
    const lines = clampScrollback(typed);
    input.value = String(lines);
    if (lines === spec.value) return;
    spec.value = lines;
    spec.onChange(lines);
  };
  input.dataset.commitOnClose = '';
  input.addEventListener('change', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
  row.append(text, input);
  return row;
}

/**
 * Custom commands and On save, under one notice that lists what
 * user-run.json skipped. Never throws: if the sections cannot be built, a
 * notice with "Open user-run.json" stands in, so the rest of Settings (and
 * the way to fix the file) still opens.
 */
export function buildUserRunArea(userRun: UserRunSettings): HTMLElement {
  const area = document.createElement('div');
  area.dataset.userRun = '';
  try {
    const notice = buildRunNotice(userRun);
    const commands = buildCommandsSection(userRun, notice.refresh);
    const hooks = buildHooksSection(userRun, notice.refresh);
    // A file SparkDown cannot read is shown read-only: saving from here
    // would replace the hand edit.
    if (userRun.view().file_error) {
      for (const el of [commands, hooks]) {
        for (const c of el.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) {
          c.disabled = true;
        }
      }
    }
    area.append(notice.el, commands, hooks);
  } catch (err) {
    area.replaceChildren(runFallback(userRun, err));
  }
  return area;
}

function openFileButton(userRun: UserRunSettings): HTMLButtonElement {
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'settings-btn';
  open.textContent = 'Open user-run.json';
  open.addEventListener('click', () => userRun.openFile());
  return open;
}

function buildRunNotice(userRun: UserRunSettings): { el: HTMLElement; refresh: () => void } {
  const el = document.createElement('div');
  el.className = 'settings-section settings-run-notice';
  el.dataset.runNotice = '';
  el.setAttribute('role', 'status');
  const fileError = document.createElement('p');
  fileError.className = 'settings-run-file-error';
  const problems = document.createElement('p');
  problems.className = 'settings-run-problems';
  const actions = document.createElement('div');
  actions.className = 'settings-run-actions';
  actions.appendChild(openFileButton(userRun));
  el.append(fileError, problems, actions);
  const refresh = () => {
    const view = userRun.view();
    const error = view.file_error ?? '';
    // The file error is also the first problem line; list it once.
    const notes = view.problems.filter((p) => p !== error);
    fileError.hidden = !error;
    fileError.textContent = error
      ? `user-run.json could not be read: ${error.replace(/\.?\s*$/, '.')} Fix it in the editor; Settings shows it read-only until then.`
      : '';
    problems.hidden = notes.length === 0;
    problems.textContent = notes.length ? `Skipped in user-run.json:\n${notes.join('\n')}` : '';
    el.hidden = !error && notes.length === 0;
  };
  refresh();
  return { el, refresh };
}

function runFallback(userRun: UserRunSettings, err: unknown): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-section settings-run-notice';
  el.dataset.runNotice = '';
  const heading = document.createElement('h3');
  heading.textContent = 'Custom commands and on-save hooks';
  const msg = document.createElement('p');
  msg.className = 'settings-run-file-error';
  msg.textContent = `These settings could not be shown (${String(err)}). Open user-run.json to check it.`;
  const actions = document.createElement('div');
  actions.className = 'settings-run-actions';
  actions.appendChild(openFileButton(userRun));
  el.append(heading, msg, actions);
  return el;
}

function buildCommandsSection(userRun: UserRunSettings, refreshNotice: () => void): HTMLElement {
  const section = document.createElement('div');
  section.className = 'settings-section';
  section.dataset.section = 'commands';
  const heading = document.createElement('h3');
  heading.textContent = 'Custom commands';
  section.appendChild(heading);

  const desc = document.createElement('p');
  desc.className = 'settings-run-desc';
  desc.textContent =
    'These appear in the command palette. They are stored in your SparkDown ' +
    'user config, not in the opened folder. Each command is a program and ' +
    'its arguments (no shell), run with the folder as the working directory. ' +
    'Output appears in the Output tab.';
  section.appendChild(desc);

  const list = document.createElement('div');
  section.appendChild(list);

  const draft: UserCommand[] = userRun.view().commands.map((c) => ({ ...c, argv: [...c.argv] }));
  let saveTimer: number | null = null;

  const scheduleSave = () => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void userRun.saveCommands(draft).then(refreshNotice, refreshNotice);
    }, 400);
  };

  const render = () => {
    list.replaceChildren();
    draft.forEach((cmd, i) => {
      list.appendChild(commandRow(cmd, {
        onChange: (next) => {
          draft[i] = next;
          scheduleSave();
        },
        onRemove: () => {
          draft.splice(i, 1);
          render();
          scheduleSave();
        },
      }));
    });
  };
  render();

  const actions = document.createElement('div');
  actions.className = 'settings-run-actions';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'settings-btn';
  add.textContent = 'Add command';
  add.addEventListener('click', () => {
    draft.push({ name: 'New command', argv: ['echo', 'hello'] });
    render();
    scheduleSave();
    const inputs = list.querySelectorAll<HTMLInputElement>('input[data-run-field="name"]');
    inputs[inputs.length - 1]?.focus();
    inputs[inputs.length - 1]?.select();
  });
  actions.append(add, openFileButton(userRun));
  section.appendChild(actions);
  return section;
}

function buildHooksSection(userRun: UserRunSettings, refreshNotice: () => void): HTMLElement {
  const section = document.createElement('div');
  section.className = 'settings-section';
  section.dataset.section = 'hooks';
  const heading = document.createElement('h3');
  heading.textContent = 'On save';
  section.appendChild(heading);

  const desc = document.createElement('p');
  desc.className = 'settings-run-desc';
  desc.textContent =
    'When you save a file in a local folder, SparkDown can run a command ' +
    'with the file path as the last argument. A failed command never fails ' +
    'the save. Each hook is off until you turn it on. Hooks do not run in a ' +
    'remote (SSH) folder, or for files an agent writes on its own — they do ' +
    'run when you save after reviewing an agent edit. An empty file filter ' +
    'matches every file in the folder. Output appears in the Output tab.';
  section.appendChild(desc);

  const list = document.createElement('div');
  section.appendChild(list);

  const draft: SaveHook[] = userRun.view().save_hooks.map((h) => ({ ...h, argv: [...h.argv], globs: [...h.globs] }));
  let saveTimer: number | null = null;

  const scheduleSave = () => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void userRun.saveHooks(draft).then(refreshNotice, refreshNotice);
    }, 400);
  };

  const render = () => {
    list.replaceChildren();
    draft.forEach((hook, i) => {
      list.appendChild(hookRow(hook, {
        onChange: (next) => {
          draft[i] = next;
          scheduleSave();
        },
        onRemove: () => {
          draft.splice(i, 1);
          render();
          scheduleSave();
        },
      }));
    });
  };
  render();

  const actions = document.createElement('div');
  actions.className = 'settings-run-actions';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'settings-btn';
  add.textContent = 'Add hook';
  add.addEventListener('click', () => {
    draft.push({ name: 'New hook', argv: ['echo'], globs: [], enabled: false });
    render();
    scheduleSave();
  });
  actions.appendChild(add);
  section.appendChild(actions);
  return section;
}

interface HookRowHandlers {
  onChange: (hook: SaveHook) => void;
  onRemove: () => void;
}

function hookRow(hook: SaveHook, handlers: HookRowHandlers): HTMLElement {
  const item = document.createElement('div');
  item.className = 'settings-run-item';
  let current: SaveHook = { ...hook, argv: [...hook.argv], globs: [...hook.globs] };
  const emit = (next: SaveHook) => {
    current = next;
    handlers.onChange(next);
  };

  const on = document.createElement('label');
  on.className = 'settings-run-row';
  const onLabel = document.createElement('label');
  onLabel.textContent = 'Enabled';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'settings-switch';
  check.checked = current.enabled;
  check.addEventListener('change', () => emit({ ...current, enabled: check.checked }));
  on.append(onLabel, check);

  const nameRow = labeledField('Name', 'hook-name', current.name, (value) => {
    emit({ ...current, name: value.trim() || current.name });
  });
  const runRow = labeledField('Run', 'hook-run', joinCommandLine(current.argv), (value) => {
    const argv = trySplitCommandLine(value);
    if (!argv) return;
    emit({ ...current, argv });
  }, 'prettier --write');
  const globRow = labeledField('Files', 'hook-globs', current.globs.join(', '), (value) => {
    const globs = value.split(',').map((s) => s.trim()).filter(Boolean);
    emit({ ...current, globs });
  }, '*.md, **/*.{ts,js}');
  const timeout = current.timeout_ms != null ? String(current.timeout_ms) : '';
  const timeRow = labeledField('Timeout (ms)', 'hook-timeout', timeout, (value) => {
    const n = Number.parseInt(value, 10);
    emit({
      ...current,
      timeout_ms: Number.isFinite(n) && n > 0 ? n : null,
    });
  }, '30000');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'settings-btn';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => handlers.onRemove());
  timeRow.appendChild(remove);

  item.append(on, nameRow, runRow, globRow, timeRow);
  return item;
}

interface CommandRowHandlers {
  onChange: (cmd: UserCommand) => void;
  onRemove: () => void;
}

function commandRow(cmd: UserCommand, handlers: CommandRowHandlers): HTMLElement {
  const item = document.createElement('div');
  item.className = 'settings-run-item';
  let current: UserCommand = { ...cmd, argv: [...cmd.argv] };
  const emit = (next: UserCommand) => {
    current = next;
    handlers.onChange(next);
  };

  const nameRow = labeledField('Name', 'name', current.name, (value) => {
    emit({ ...current, name: value.trim() || current.name });
  });
  const line = joinCommandLine(current.argv);
  const runRow = labeledField('Run', 'run', line, (value) => {
    const argv = trySplitCommandLine(value);
    if (!argv) return;
    emit({ ...current, argv });
  }, 'prettier --write .');
  const timeout = current.timeout_ms != null ? String(current.timeout_ms) : '';
  const timeRow = labeledField('Timeout (ms)', 'timeout', timeout, (value) => {
    const n = Number.parseInt(value, 10);
    emit({
      ...current,
      timeout_ms: Number.isFinite(n) && n > 0 ? n : null,
    });
  }, '30000');

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'settings-btn';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => handlers.onRemove());
  timeRow.appendChild(remove);

  item.append(nameRow, runRow, timeRow);
  return item;
}

function labeledField(
  labelText: string,
  field: string,
  value: string,
  onInput: (value: string) => void,
  placeholder = '',
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'settings-run-row';
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'settings-text';
  input.dataset.runField = field;
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocapitalize = 'off';
  input.addEventListener('input', () => onInput(input.value));
  input.addEventListener('change', () => onInput(input.value));
  row.append(label, input);
  return row;
}

interface TextSpec {
  label: string;
  placeholder: string;
  value: string;
  onInput: (value: string) => void;
}

/** A labeled row with a single-line text input. */
function textRow(spec: TextSpec): HTMLElement {
  const row = document.createElement('label');
  row.className = 'settings-row';

  const text = document.createElement('div');
  text.className = 'settings-row-text';
  const label = document.createElement('div');
  label.className = 'settings-row-label';
  label.textContent = spec.label;
  text.appendChild(label);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'settings-text';
  input.placeholder = spec.placeholder;
  input.value = spec.value;
  input.spellcheck = false;
  input.autocapitalize = 'off';
  input.addEventListener('input', () => spec.onInput(input.value));

  row.append(text, input);
  return row;
}

interface ToggleSpec {
  label: string;
  desc: string;
  checked: boolean;
  onToggle: (value: boolean) => void;
}

/** A labeled row with a description and a checkbox styled as a switch. */
function toggleRow(spec: ToggleSpec): HTMLElement {
  const row = document.createElement('label');
  row.className = 'settings-row';

  const text = document.createElement('div');
  text.className = 'settings-row-text';
  const label = document.createElement('div');
  label.className = 'settings-row-label';
  label.textContent = spec.label;
  const desc = document.createElement('div');
  desc.className = 'settings-row-desc';
  desc.textContent = spec.desc;
  text.append(label, desc);

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'settings-switch';
  input.checked = spec.checked;
  input.addEventListener('change', () => spec.onToggle(input.checked));

  row.append(text, input);
  return row;
}

