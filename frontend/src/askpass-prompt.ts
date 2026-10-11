/**
 * In-app SSH KEY passphrase prompt (#27). The Rust askpass broker emits
 * `askpass://request` when ssh asks to unlock a passphrase-protected key
 * (never for the server password: the backend refuses any other prompt and
 * disables password auth). We show a masked field naming the key, send the
 * answer back once, and clear the field. Nothing is stored here.
 */
import { listen } from '@tauri-apps/api/event';
import { api } from './api';
import { trapFocus } from './modal';

export const ASKPASS_REQUEST = 'askpass://request';

export interface AskpassRequest {
  id: number;
  /** Key path from ssh's prompt, home shown as ~. */
  key: string;
}

/**
 * Show the masked prompt. Resolves the passphrase, or null on Cancel / Esc /
 * a click outside. The input is emptied before the promise resolves.
 */
export function showPassphrasePrompt(
  req: AskpassRequest,
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'remote-overlay askpass-overlay';

    const dialog = document.createElement('form');
    dialog.className = 'remote-dialog askpass-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'SSH key passphrase');
    dialog.tabIndex = -1;
    dialog.autocomplete = 'off';

    const title = document.createElement('h2');
    title.textContent = 'Unlock SSH key';
    const lead = document.createElement('p');
    lead.className = 'remote-lead';
    lead.textContent =
      'Enter the passphrase of this SSH key (the key file’s passphrase, not the server password). ' +
      'SparkDown keeps it in memory for this remote session only and never saves it.';
    const key = document.createElement('code');
    key.className = 'askpass-key';
    key.textContent = req.key;

    const label = document.createElement('label');
    label.className = 'remote-field';
    label.textContent = 'Key passphrase';
    const input = document.createElement('input');
    input.type = 'password';
    input.id = 'askpass-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('aria-label', `Passphrase for ${req.key}`);
    label.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'remote-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'remote-btn';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'remote-btn remote-btn-primary';
    ok.id = 'askpass-unlock';
    ok.textContent = 'Unlock';
    ok.disabled = true;
    actions.append(cancel, ok);

    dialog.append(title, lead, key, label, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const modal = trapFocus(dialog);
    input.focus();

    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      input.value = '';
      modal.release();
      overlay.remove();
      resolve(value);
    };
    input.addEventListener('input', () => {
      ok.disabled = input.value.length === 0;
    });
    dialog.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.length > 0) finish(input.value);
    });
    cancel.addEventListener('click', () => finish(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    });
  });
}

/** Answer backend passphrase requests with the in-app prompt. */
export function installAskpassPrompt(): void {
  void listen<AskpassRequest>(ASKPASS_REQUEST, (e) => {
    void showPassphrasePrompt(e.payload).then((passphrase) =>
      api.askpassAnswer(e.payload.id, passphrase).catch(() => undefined),
    );
  });
}
