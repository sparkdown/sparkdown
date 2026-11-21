/**
 * Pull / Push confirmation when a repository's own Git settings will run
 * commands. Cancel is the default; "Run anyway" is remembered per repo
 * until those settings change.
 */
import { trapFocus } from './modal';
import { escapeHtml, escapeReviewText, hasUnicodeControls } from './utils';
import type { RepoCommandKey } from './api';

export const REPO_COMMANDS_TITLE = 'This repository runs its own commands';
export const REPO_COMMANDS_BODY =
  'Its Git settings will run these commands during Pull/Push:';
export const REPO_COMMANDS_CANCEL = 'Cancel';
export const REPO_COMMANDS_RUN = 'Run anyway';

/** The dialog's HTML body (exported for tests). */
export function repoCommandsDialogHtml(keys: RepoCommandKey[]): string {
  const rows = keys
    .map((k) => {
      const bidi =
        hasUnicodeControls(k.key) || hasUnicodeControls(k.value) ? ' change-row-bidi' : '';
      const value = k.value === '' ? '(empty)' : k.value;
      return (
        `<li class="repo-cmd-item${bidi}">` +
        `<code class="repo-cmd-key">${escapeReviewText(k.key)}</code>` +
        `<code class="repo-cmd-value">${escapeReviewText(value)}</code>` +
        `</li>`
      );
    })
    .join('');
  return (
    `<h2 class="repo-cmd-title">${escapeHtml(REPO_COMMANDS_TITLE)}</h2>` +
    `<p class="repo-cmd-body">${escapeHtml(REPO_COMMANDS_BODY)}</p>` +
    `<ul class="repo-cmd-list">${rows}</ul>` +
    `<div class="repo-cmd-buttons">` +
    `<button type="button" class="repo-cmd-cancel">${escapeHtml(REPO_COMMANDS_CANCEL)}</button>` +
    `<button type="button" class="repo-cmd-run">${escapeHtml(REPO_COMMANDS_RUN)}</button>` +
    `</div>`
  );
}

/** The confirmation modal. Cancel / Escape / backdrop resolve false. */
export function showRepoCommandsDialog(keys: RepoCommandKey[]): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay repo-cmd-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'settings-dialog repo-cmd-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'repo-cmd-title');
    dialog.tabIndex = -1;
    dialog.innerHTML = repoCommandsDialogHtml(keys);
    dialog.querySelector('.repo-cmd-title')?.setAttribute('id', 'repo-cmd-title');
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const modal = trapFocus(dialog);
    const done = (ok: boolean) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      modal.release();
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done(false);
    });
    dialog.querySelector('.repo-cmd-cancel')!.addEventListener('click', () => done(false));
    dialog.querySelector('.repo-cmd-run')!.addEventListener('click', () => done(true));
    // Cancel is the default focused button.
    dialog.querySelector<HTMLButtonElement>('.repo-cmd-cancel')!.focus();
  });
}
