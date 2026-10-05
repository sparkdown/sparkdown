import { trapFocus } from './modal';

/**
 * The "Give <Agent> SparkDown's tools?" prompt, shown when an agent chip
 * launches an agent that has no launch-time injection (Gemini, Grok, Kiro,
 * Cursor, Antigravity) and does not have SparkDown installed yet. Installing is a
 * persistent change to the agent's own config, so it needs the user's
 * explicit consent: this dialog asks for it once.
 *
 * Results:
 * - `installed`: the install succeeded; launch the plain command.
 * - `not-now`: launch with the teaching prompt this time.
 * - `never`: same as not-now, and do not ask again for this agent.
 * - `failed`: the install failed (the error was shown); teaching prompt.
 *
 * Keys: Enter = Install, Escape = Not now (the checkbox still applies).
 */
export type InstallPromptResult = 'installed' | 'not-now' | 'never' | 'failed';

export interface InstallPromptOptions {
  /** Display name of the agent ("Gemini", "Cursor CLI"). */
  label: string;
  /** Runs the (remote-aware) install; rejects with the error text. */
  install: () => Promise<unknown>;
}

export function showMcpInstallPrompt(opts: InstallPromptOptions): Promise<InstallPromptResult> {
  return new Promise((resolve) => {
    const { label } = opts;
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay mcp-prompt-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'settings-dialog mcp-prompt';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1;

    const title = document.createElement('h2');
    title.className = 'mcp-prompt-title';
    title.id = 'mcp-prompt-title';
    title.textContent = `Give ${label} SparkDown's tools?`;
    dialog.setAttribute('aria-labelledby', title.id);

    const body = document.createElement('p');
    body.className = 'mcp-prompt-body';
    body.id = 'mcp-prompt-body';
    body.textContent =
      `${label} can then read what you are editing and review your changes. ` +
      `SparkDown adds one entry to ${label}'s own config, once. ` +
      'Remove it at any time in Settings → Agents.';
    dialog.setAttribute('aria-describedby', body.id);

    const never = document.createElement('label');
    never.className = 'mcp-prompt-never';
    const neverBox = document.createElement('input');
    neverBox.type = 'checkbox';
    neverBox.className = 'mcp-prompt-never-box';
    never.append(neverBox, document.createTextNode(` Don't ask again for ${label}`));

    const status = document.createElement('div');
    status.className = 'mcp-prompt-status';
    status.hidden = true;
    const spinner = document.createElement('span');
    spinner.className = 'mcp-prompt-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const statusText = document.createElement('span');
    statusText.className = 'mcp-prompt-status-text';
    status.append(spinner, statusText);

    const actions = document.createElement('div');
    actions.className = 'mcp-prompt-actions';
    const notNow = document.createElement('button');
    notNow.className = 'settings-btn mcp-prompt-not-now';
    notNow.textContent = 'Not now';
    const install = document.createElement('button');
    install.className = 'settings-btn settings-btn--primary mcp-prompt-install';
    install.textContent = 'Install';
    const cont = document.createElement('button');
    cont.className = 'settings-btn settings-btn--primary mcp-prompt-continue';
    cont.textContent = 'Continue';
    cont.hidden = true;
    actions.append(notNow, install, cont);

    dialog.append(title, body, never, status, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const modal = trapFocus(dialog);

    /** idle → installing → (done | failed). */
    let phase: 'idle' | 'installing' | 'failed' | 'done' = 'idle';

    const finish = (result: InstallPromptResult) => {
      if (phase === 'done') return;
      phase = 'done';
      dialog.removeEventListener('keydown', onKey);
      overlay.remove();
      modal.release();
      resolve(result);
    };

    const decline = () => finish(neverBox.checked ? 'never' : 'not-now');

    const doInstall = () => {
      if (phase !== 'idle') return;
      phase = 'installing';
      install.disabled = true;
      notNow.disabled = true;
      never.hidden = true;
      status.hidden = false;
      status.classList.remove('is-error');
      statusText.textContent = `Installing into ${label}…`;
      dialog.focus();
      void opts.install().then(
        () => finish('installed'),
        (err) => {
          if (phase !== 'installing') return;
          phase = 'failed';
          status.classList.add('is-error');
          status.setAttribute('role', 'alert');
          statusText.textContent =
            `Could not install: ${String(err)}\n` +
            `${label} starts with the SparkDown reading prompt instead.`;
          install.hidden = true;
          notNow.hidden = true;
          cont.hidden = false;
          cont.focus();
        },
      );
    };

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (phase === 'idle') decline();
        else if (phase === 'failed') finish('failed');
        return;
      }
      if (e.key === 'Enter') {
        // A focused button handles its own Enter (its click).
        if (e.target instanceof HTMLButtonElement) return;
        e.preventDefault();
        e.stopPropagation();
        if (phase === 'idle') doInstall();
        else if (phase === 'failed') finish('failed');
      }
    }
    dialog.addEventListener('keydown', onKey);
    install.addEventListener('click', doInstall);
    notNow.addEventListener('click', decline);
    cont.addEventListener('click', () => finish('failed'));

    install.focus();
  });
}
