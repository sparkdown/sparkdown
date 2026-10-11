// @vitest-environment jsdom
/**
 * #27: the in-app SSH key passphrase prompt. Masked, names the key, never
 * the server password, answers once and clears the field.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const invoke = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => undefined,
);
let handler: ((e: { payload: unknown }) => void) | null = null;
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (_name: string, cb: (e: { payload: unknown }) => void) => {
      handler = cb;
      return () => {};
    },
  ),
}));

import { listen } from '@tauri-apps/api/event';
import {
  ASKPASS_REQUEST,
  installAskpassPrompt,
  showPassphrasePrompt,
} from '../askpass-prompt';

function input(): HTMLInputElement {
  return document.getElementById('askpass-input') as HTMLInputElement;
}

function type(value: string): void {
  input().value = value;
  input().dispatchEvent(new Event('input'));
}

describe('askpass prompt (#27)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    invoke.mockClear();
    handler = null;
  });

  it('is masked, names the key, and says it is not the server password', () => {
    void showPassphrasePrompt({ id: 1, key: '~/.ssh/id_ed25519' });
    expect(input().type).toBe('password');
    expect(input().autocomplete).toBe('off');
    const dialog = document.querySelector('.askpass-dialog')!;
    expect(dialog.querySelector('.askpass-key')!.textContent).toBe(
      '~/.ssh/id_ed25519',
    );
    expect(dialog.textContent).toContain('not the server password');
    expect(document.activeElement).toBe(input());
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(true);
    (
      document.querySelector('.askpass-dialog .remote-btn:not(.remote-btn-primary)') as HTMLElement
    ).click();
  });

  it('resolves the passphrase on Unlock, clears the field and closes', async () => {
    const p = showPassphrasePrompt({ id: 1, key: 'k' });
    const unlock = document.getElementById(
      'askpass-unlock',
    ) as HTMLButtonElement;
    expect(unlock.disabled).toBe(true);
    const field = input();
    type('s3cret');
    expect(unlock.disabled).toBe(false);
    document
      .querySelector('.askpass-dialog')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await expect(p).resolves.toBe('s3cret');
    expect(field.value).toBe('');
    expect(document.querySelector('.askpass-overlay')).toBeNull();
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(false);
  });

  it('resolves null on Cancel and on Escape (without reaching other dialogs)', async () => {
    let p = showPassphrasePrompt({ id: 1, key: 'k' });
    type('typed');
    (
      document.querySelector(
        '.askpass-dialog .remote-btn:not(.remote-btn-primary)',
      ) as HTMLElement
    ).click();
    await expect(p).resolves.toBeNull();

    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    p = showPassphrasePrompt({ id: 2, key: 'k' });
    input().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await expect(p).resolves.toBeNull();
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outer);
  });

  it('answers the backend request once with the typed passphrase or null', async () => {
    installAskpassPrompt();
    expect(listen).toHaveBeenCalledWith(ASKPASS_REQUEST, expect.any(Function));
    await vi.waitFor(() => expect(handler).not.toBeNull());

    handler!({ payload: { id: 7, key: '~/.ssh/id_rsa' } });
    type('pw');
    document
      .querySelector('.askpass-dialog')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('askpass_answer', {
        id: 7,
        passphrase: 'pw',
      }),
    );

    handler!({ payload: { id: 8, key: 'k' } });
    (
      document.querySelector(
        '.askpass-dialog .remote-btn:not(.remote-btn-primary)',
      ) as HTMLElement
    ).click();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('askpass_answer', {
        id: 8,
        passphrase: null,
      }),
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
