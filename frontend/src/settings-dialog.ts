import { api } from './api';
import type { AppConfig } from './api';
import { trapFocus, type ModalHandle } from './modal';

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
    document.removeEventListener('keydown', open.onKey);
    open.overlay.remove();
    open.modal.release();
  }

  private show(host: SettingsHost): void {
    const overlay = buildSettingsOverlay(host, () => this.close());
    document.body.appendChild(overlay);
    const dialog = overlay.querySelector<HTMLElement>('.settings-dialog')!;
    const modal = trapFocus(dialog);
    // Move focus off the editor/terminal onto the dialog so Escape lands here
    // right away, without requiring a click inside the modal first.
    dialog.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    };
    document.addEventListener('keydown', onKey);
    this.open = { overlay, modal, onKey };
  }
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

  dialog.appendChild(section);

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
      label: 'Check for updates automatically',
      desc:
        'Look for a new version on GitHub Releases shortly after launch, at ' +
        'most once a day. Nothing is downloaded until you choose Install. ' +
        '"Check for Updates..." in the menu works either way.',
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
      .mcpAgentInstalled(agent.bin)
      .then((v) => row.setInstalled(v))
      .catch(() => row.setInstalled(false));
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

/** One agent's install control: label, status, and a toggle button. Starts
 *  in a pending state until `setInstalled` is called. */
function mcpInstallRow(
  label: string,
  bin: string,
  serverUp: boolean,
): { el: HTMLElement; setInstalled: (v: boolean) => void } {
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

  let state: boolean | null = null;
  const render = () => {
    if (state === null) {
      status.textContent = 'Checking…';
      btn.textContent = 'Install';
      btn.disabled = true;
      return;
    }
    status.textContent = state ? 'Installed' : 'Not installed';
    btn.textContent = state ? 'Remove' : 'Install';
    btn.disabled = !serverUp;
    if (!serverUp) status.textContent = 'MCP server not running';
  };
  render();

  btn.addEventListener('click', () => {
    if (state === null) return;
    const was = state;
    btn.disabled = true;
    btn.textContent = was ? 'Removing…' : 'Installing…';
    const action = was ? api.mcpUninstallAgent(bin) : api.mcpInstallAgent(bin);
    void action
      .then(() => {
        state = !was;
        render();
      })
      .catch((err) => {
        render();
        status.textContent = String(err);
      });
  });

  row.append(text, btn);
  return {
    el: row,
    setInstalled: (v: boolean) => {
      state = v;
      render();
    },
  };
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

