// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import {
  REPO_COMMANDS_BODY,
  REPO_COMMANDS_CANCEL,
  REPO_COMMANDS_RUN,
  REPO_COMMANDS_TITLE,
  repoCommandsDialogHtml,
  showRepoCommandsDialog,
} from '../git-repo-commands';

const keys = [
  { key: 'core.fsmonitor', value: 'touch /tmp/x' },
  { key: 'filter.lfs.clean', value: 'git-lfs clean -- %f' },
];

afterEach(() => {
  document.body.innerHTML = '';
});

describe('repo commands dialog', () => {
  it('names the keys and values in plain words', () => {
    const html = repoCommandsDialogHtml(keys);
    expect(html).toContain(REPO_COMMANDS_TITLE);
    expect(html).toContain(REPO_COMMANDS_BODY);
    expect(html).toContain('core.fsmonitor');
    expect(html).toContain('touch /tmp/x');
    expect(html).toContain('filter.lfs.clean');
    expect(html).toContain('git-lfs clean -- %f');
    expect(html).toContain(REPO_COMMANDS_CANCEL);
    expect(html).toContain(REPO_COMMANDS_RUN);
  });

  it('focuses Cancel by default, and Run anyway resolves true', async () => {
    const pending = showRepoCommandsDialog(keys);
    const dialog = document.querySelector('.repo-cmd-dialog') as HTMLElement;
    expect(dialog).toBeTruthy();
    const cancel = dialog.querySelector<HTMLButtonElement>('.repo-cmd-cancel')!;
    const run = dialog.querySelector<HTMLButtonElement>('.repo-cmd-run')!;
    expect(document.activeElement).toBe(cancel);
    run.click();
    await expect(pending).resolves.toBe(true);
    expect(document.querySelector('.repo-cmd-dialog')).toBeNull();
  });

  it('Cancel, Escape and the backdrop resolve false', async () => {
    const a = showRepoCommandsDialog(keys);
    document.querySelector<HTMLButtonElement>('.repo-cmd-cancel')!.click();
    await expect(a).resolves.toBe(false);

    const b = showRepoCommandsDialog(keys);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(b).resolves.toBe(false);

    const c = showRepoCommandsDialog(keys);
    document.querySelector('.repo-cmd-overlay')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await expect(c).resolves.toBe(false);
  });
});
