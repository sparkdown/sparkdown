// @vitest-environment jsdom
/** Remote file picker: path helpers + backend error surfacing. The full
 *  open / save / export flows are in app.integration.test.ts. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => {
  throw new Error(`unmocked ${String(_args[0])}`);
});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  folderNameError,
  matchesFilter,
  normalizeRemotePath,
  RemotePicker,
  remotePathError,
} from '../remote-picker';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('remote picker helpers', () => {
  it('normalizes typed paths against the current folder and $HOME', () => {
    expect(normalizeRemotePath('sub/x.md', '/home/u/proj')).toBe('/home/u/proj/sub/x.md');
    expect(normalizeRemotePath('../a', '/home/u/proj')).toBe('/home/u/a');
    expect(normalizeRemotePath('~/notes', '/srv', '/home/u')).toBe('/home/u/notes');
    expect(normalizeRemotePath('~', '/srv', '/home/u/')).toBe('/home/u');
    expect(normalizeRemotePath('//a/./b//', '/')).toBe('/a/b');
    expect(normalizeRemotePath('../../..', '/a')).toBe('/');
  });

  it('rejects relative paths and control characters', () => {
    expect(remotePathError('/ok/path')).toBeNull();
    expect(remotePathError('rel/path')).toMatch(/absolute/);
    expect(remotePathError('/bad\npath')).toMatch(/control/);
  });

  it('accepts one folder name for New Folder, not a path', () => {
    expect(folderNameError('drafts')).toBeNull();
    expect(folderNameError('my notes')).toBeNull();
    expect(folderNameError('')).toMatch(/Type a folder name/);
    expect(folderNameError('..')).toMatch(/Type a folder name/);
    expect(folderNameError('a/b')).toMatch(/cannot contain/);
    expect(folderNameError('a\tb')).toMatch(/control/);
  });

  it('filters by extension; All Files matches everything', () => {
    const md = { name: 'Markdown', extensions: ['md', 'markdown'] };
    expect(matchesFilter('a.MD', md)).toBe(true);
    expect(matchesFilter('a.txt', md)).toBe(false);
    expect(matchesFilter('Makefile', md)).toBe(false);
    expect(matchesFilter('Makefile', { name: 'All Files', extensions: ['*'] })).toBe(true);
  });
});

describe('RemotePicker', () => {
  let picker: RemotePicker;
  beforeEach(() => {
    picker = new RemotePicker();
  });
  afterEach(() => {
    picker.close();
    document.body.innerHTML = '';
    invoke.mockReset();
  });

  it('shows backend errors inline and falls back to $HOME', async () => {
    invoke.mockImplementation(async (cmd: unknown, args: unknown) => {
      const path = (args as { path: string }).path;
      if (cmd === 'list_directory' && path === '/gone') {
        throw 'Invalid path: Path is not a directory: /gone';
      }
      if (cmd === 'list_directory') return [{ name: 'a.md', path: `${path}/a.md`, is_dir: false }];
      throw new Error(`unmocked ${String(cmd)}`);
    });
    const done = picker.pick({ mode: 'open', host: 'dev', startDir: '/gone', home: '/home/u' });
    for (let i = 0; i < 5; i++) await flush();
    const path = document.querySelector<HTMLInputElement>('.rp-path')!;
    expect(path.value).toBe('/home/u');
    expect(document.querySelectorAll('.rp-item')).toHaveLength(1);

    path.value = '/gone';
    invoke.mockImplementationOnce(async () => true); // is_directory → yes
    path.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i = 0; i < 5; i++) await flush();
    const err = document.querySelector('.remote-error')!;
    expect(err.classList.contains('hidden')).toBe(false);
    expect(err.textContent).toContain('Path is not a directory: /gone');

    picker.close();
    expect(await done).toBeNull();
  });
});

describe('RemotePicker modality (focus trap, inert, focus restore)', () => {
  let editor: HTMLTextAreaElement;
  let picker: RemotePicker;

  const listing = async (cmd: unknown, args: unknown) => {
    const path = (args as { path: string }).path;
    if (cmd === 'list_directory') {
      if (path === '/home/u/docs') return [{ name: 'b.md', path: '/home/u/docs/b.md', is_dir: false }];
      return [
        { name: 'docs', path: `${path}/docs`, is_dir: true },
        { name: 'a.md', path: `${path}/a.md`, is_dir: false },
      ];
    }
    if (cmd === 'is_directory') return path === '/home/u/docs';
    throw new Error(`unmocked ${String(cmd)}`);
  };

  const open = async (mode: 'open' | 'save' = 'open') => {
    const done = picker.pick({ mode, host: 'dev', startDir: '/home/u', defaultName: 'new.md' });
    for (let i = 0; i < 5; i++) await flush();
    // Wrapped: awaiting a bare promise here would wait for the picker result.
    return { done };
  };
  const dialog = () => document.querySelector<HTMLElement>('.remote-picker')!;
  const key = (target: Element, k: string, init: KeyboardEventInit = {}) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  const app = () => document.getElementById('app')!;

  beforeEach(() => {
    picker = new RemotePicker();
    document.body.innerHTML = '<div id="app"><textarea id="editor"></textarea></div>';
    editor = document.getElementById('editor') as HTMLTextAreaElement;
    editor.focus();
    invoke.mockImplementation(listing);
  });
  afterEach(() => {
    picker.close();
    document.body.innerHTML = '';
    invoke.mockReset();
  });

  it('marks #app inert while open and clears it + restores focus on Esc', async () => {
    const { done } = await open();
    expect(app().hasAttribute('inert')).toBe(true);
    expect(dialog().contains(document.activeElement)).toBe(true);

    key(document.activeElement!, 'Escape');
    expect(await done).toBeNull();
    expect(app().hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(editor);
  });

  it('clears inert on every close path (Cancel, ×, backdrop, close(), confirm)', async () => {
    const closers: Array<() => void> = [
      () => Array.from(document.querySelectorAll<HTMLButtonElement>('.remote-actions .remote-btn'))
        .find((b) => b.textContent === 'Cancel')!.click(),
      () => document.querySelector<HTMLButtonElement>('.remote-picker .remote-close')!.click(),
      () => document.querySelector('.remote-picker-overlay')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
      () => picker.close(),
    ];
    for (const close of closers) {
      const { done } = await open();
      expect(app().hasAttribute('inert')).toBe(true);
      close();
      expect(await done).toBeNull();
      expect(app().hasAttribute('inert')).toBe(false);
      expect(document.activeElement).toBe(editor);
    }
    // Confirm: Enter in the path field on an existing file resolves it.
    const { done } = await open();
    const path = document.querySelector<HTMLInputElement>('.rp-path')!;
    path.value = '/home/u/a.md';
    key(path, 'Enter');
    expect(await done).toBe('/home/u/a.md');
    expect(app().hasAttribute('inert')).toBe(false);
  });

  it('wraps Tab and Shift+Tab inside the dialog and never reaches the editor', async () => {
    const { done } = await open();
    const items = Array.from(dialog().querySelectorAll<HTMLElement>('button, input, select, [tabindex="0"]'))
      .filter((el) => el.tabIndex >= 0);
    const first = items[0];
    const last = items[items.length - 1];
    last.focus();
    key(last, 'Tab');
    expect(document.activeElement).toBe(first);
    key(first, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
    // Walk more than a full cycle forward: focus stays in the dialog.
    for (let i = 0; i < items.length + 2; i++) {
      const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(dialog().contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(editor);
    }
    picker.close();
    await done;
  });

  it('Enter in the path field navigates to the typed folder', async () => {
    const { done } = await open();
    const path = document.querySelector<HTMLInputElement>('.rp-path')!;
    path.value = '/home/u/docs';
    key(path, 'Enter');
    for (let i = 0; i < 5; i++) await flush();
    expect(invoke).toHaveBeenCalledWith('list_directory', expect.objectContaining({ path: '/home/u/docs' }));
    expect(document.querySelector('.rp-list')!.textContent).toContain('b.md');
    picker.close();
    await done;
  });

  it('Enter in the name field saves (save mode)', async () => {
    const { done } = await open('save');
    const name = document.querySelector<HTMLInputElement>('.rp-name')!;
    expect(document.activeElement).toBe(name);
    name.value = 'fresh.md';
    key(name, 'Enter');
    expect(await done).toBe('/home/u/fresh.md');
    expect(app().hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(editor);
  });
});
