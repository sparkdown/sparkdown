// @vitest-environment jsdom
/** 0.4.1: contextual explorer right-click menu, inline New File / New
 *  Folder, and no webview default menu outside text fields. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@crabnebula/tauri-plugin-drag', () => ({ startDrag: vi.fn(async () => {}) }));

const menus: Array<{ x: number; y: number; items: Array<{ label: string; onClick: () => void; separatorBefore?: boolean }> }> = [];
vi.mock('../context-menu', () => ({
  showContextMenu: (x: number, y: number, items: Array<{ label: string; onClick: () => void }>) => menus.push({ x, y, items }),
}));

const listDirectory = vi.fn();
const createEntry = vi.fn();
const revealPath = vi.fn();
const copyText = vi.fn();
vi.mock('../api', () => ({
  api: {
    listDirectory: (...a: unknown[]) => listDirectory(...a),
    createEntry: (...a: unknown[]) => createEntry(...a),
    revealPath: (...a: unknown[]) => revealPath(...a),
    copyText: (...a: unknown[]) => copyText(...a),
    copyFile: vi.fn(),
  },
}));

import { EventBus } from '../events';
import { EVENTS } from '../event-names';
import { FileTree, explorerMenu, createParentFor, entryNameError, revealLabel } from '../file-tree';
import { keepsNativeMenu, installContextMenuGuard } from '../webview-menu';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('explorerMenu', () => {
  const labels = (t: Parameters<typeof explorerMenu>[0], remote = false, os: 'mac' | 'windows' | 'linux' = 'mac') =>
    explorerMenu(t, { remote, os }).map((i) => i.label);

  it('files and folders get New File, New Folder, Delete…, Reveal, Copy Path (no Reload, no Rename)', () => {
    const want = ['New File', 'New Folder', 'Delete…', 'Reveal in Finder', 'Copy Path'];
    expect(labels({ kind: 'file', path: '/p/a.md' })).toEqual(want);
    expect(labels({ kind: 'dir', path: '/p/d' })).toEqual(want);
  });
  it('empty space gets only New File and New Folder', () => {
    expect(labels({ kind: 'empty' })).toEqual(['New File', 'New Folder']);
  });
  it('names the file manager per OS and hides Reveal for a remote folder', () => {
    expect(revealLabel('windows')).toBe('Reveal in File Explorer');
    expect(revealLabel('linux')).toBe('Reveal in File Manager');
    expect(labels({ kind: 'file', path: '/p/a.md' }, false, 'windows')).toContain('Reveal in File Explorer');
    expect(labels({ kind: 'file', path: '/p/a.md' }, true)).toEqual(['New File', 'New Folder', 'Delete…', 'Copy Path']);
  });
  it('creates inside a folder, next to a file, at the root for empty space', () => {
    expect(createParentFor({ kind: 'dir', path: '/p/d' }, '/p')).toBe('/p/d');
    expect(createParentFor({ kind: 'file', path: '/p/d/x.md' }, '/p')).toBe('/p/d');
    expect(createParentFor({ kind: 'file', path: 'C:\\p\\x.md' }, 'C:\\p')).toBe('C:\\p');
    expect(createParentFor({ kind: 'empty' }, '/p')).toBe('/p');
  });
  it('flags bad names while typing', () => {
    expect(entryNameError('notes.md')).toBeNull();
    expect(entryNameError('.env')).toBeNull();
    for (const bad of ['', ' ', '.', '..', 'a/b', 'a\\b', 'a:b', 'x?', 'end.', 'end ']) expect(entryNameError(bad)).not.toBeNull();
  });
});

function mount(): { tree: FileTree; bus: EventBus } {
  document.body.innerHTML = `
    <nav id="sidebar"><h2 id="sidebar-title"></h2>
      <div id="file-tree" style="height: 400px;"></div></nav>`;
  const bus = new EventBus();
  const tree = new FileTree(bus, true, 220, false);
  const vp = document.getElementById('file-tree')!;
  Object.defineProperty(vp, 'clientHeight', { configurable: true, value: 400 });
  tree.init(vp, document.getElementById('sidebar')!);
  return { tree, bus };
}

const row = (path: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('.tree-item')).find((e) => e.dataset.path === path)!;
const rightClick = (el: Element) =>
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }));
const pick = (label: string) => menus[menus.length - 1].items.find((i) => i.label === label)!.onClick();
const input = () => document.querySelector<HTMLInputElement>('.tree-new-input');
function type(text: string) {
  const i = input()!;
  i.value = text;
  i.dispatchEvent(new Event('input'));
}
const key = (k: string) => input()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('FileTree right-click menu and inline create', () => {
  let files: Record<string, Array<{ name: string; path: string; is_dir: boolean }>>;
  beforeEach(() => {
    menus.length = 0;
    files = {
      '/p': [{ name: 'docs', path: '/p/docs', is_dir: true }, { name: 'a.md', path: '/p/a.md', is_dir: false }],
      '/p/docs': [{ name: 'x.md', path: '/p/docs/x.md', is_dir: false }],
    };
    listDirectory.mockReset().mockImplementation(async (p: string) => files[p] ?? []);
    createEntry.mockReset();
    revealPath.mockReset().mockResolvedValue(undefined);
    copyText.mockReset();
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('New File on a folder expands it and creates inside with an inline name, then opens the file', async () => {
    const { tree, bus } = mount();
    const opened: string[] = [];
    bus.on(EVENTS.FILE_TREE_OPEN, (d) => opened.push(d.path));
    await tree.setRoot('/p');
    rightClick(row('/p/docs'));
    pick('New File');
    await tick(); await tick();
    const i = input()!;
    expect(i).toBeTruthy();
    expect(document.activeElement).toBe(i);
    // The field sits right under the folder row, above its children.
    const order = Array.from(document.querySelectorAll<HTMLElement>('.tree-item')).sort(
      (a, b) => parseInt(a.style.top) - parseInt(b.style.top)).map((e) => e.dataset.path ?? 'NEW');
    expect(order).toEqual(['/p/docs', 'NEW', '/p/docs/x.md', '/p/a.md']);
    createEntry.mockImplementation(async (parent: string, name: string) => {
      files['/p/docs'].push({ name, path: `${parent}/${name}`, is_dir: false });
      return `${parent}/${name}`;
    });
    type('new.md');
    key('Enter');
    await tick(); await tick(); await tick();
    expect(createEntry).toHaveBeenCalledWith('/p/docs', 'new.md', false);
    expect(input()).toBeNull();
    expect(row('/p/docs/new.md')).toBeTruthy();
    expect(opened).toEqual(['/p/docs/new.md']);
    expect(tree.getSaveDir()).toBe('/p/docs');
  });

  it('New Folder on a file creates next to it; Esc cancels without creating', async () => {
    const { tree } = mount();
    await tree.setRoot('/p');
    rightClick(row('/p/a.md'));
    pick('New Folder');
    await tick();
    type('stuff');
    key('Escape');
    expect(input()).toBeNull();
    expect(createEntry).not.toHaveBeenCalled();
    rightClick(row('/p/a.md'));
    pick('New Folder');
    await tick();
    createEntry.mockResolvedValue('/p/stuff');
    type('stuff');
    key('Enter');
    await tick();
    expect(createEntry).toHaveBeenCalledWith('/p', 'stuff', true);
  });

  it('a bad or taken name keeps the field open with the error', async () => {
    const { tree } = mount();
    await tree.setRoot('/p');
    rightClick(document.getElementById('file-tree')!.querySelector('.tree-spacer')!);
    expect(menus[0].items.map((i) => i.label)).toEqual(['New File', 'New Folder']);
    pick('New File');
    await tick();
    type('a/b');
    key('Enter');
    await tick();
    expect(createEntry).not.toHaveBeenCalled();
    expect(document.querySelector('.tree-new-error')?.textContent).toContain('/');
    createEntry.mockRejectedValue('“a.md” already exists');
    type('a.md');
    key('Enter');
    await tick(); await tick();
    expect(createEntry).toHaveBeenCalledWith('/p', 'a.md', false);
    expect(input()?.value).toBe('a.md');
    expect(document.querySelector('.tree-new-error')?.textContent).toBe('“a.md” already exists');
  });

  it('Reveal and Copy Path act on the row; Delete goes through the confirm event', async () => {
    const { tree, bus } = mount();
    const del: unknown[] = [];
    bus.on(EVENTS.FILE_TREE_DELETE, (d) => del.push(d));
    await tree.setRoot('/p');
    rightClick(row('/p/docs'));
    pick(menus[0].items.find((i) => i.label.startsWith('Reveal'))!.label);
    expect(revealPath).toHaveBeenCalledWith('/p/docs');
    rightClick(row('/p/a.md'));
    pick('Copy Path');
    expect(copyText).toHaveBeenCalledWith('/p/a.md');
    rightClick(row('/p/a.md'));
    pick('Delete…');
    expect(del).toEqual([{ path: '/p/a.md', isDir: false }]);
  });

  it('a remote folder has no Reveal item', async () => {
    const { tree } = mount();
    tree.configureActions({ isRemote: () => true, showError: () => {} });
    await tree.setRoot('/p');
    rightClick(row('/p/a.md'));
    expect(menus[0].items.some((i) => i.label.startsWith('Reveal'))).toBe(false);
  });
});

describe('webview default context menu', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('is blocked outside text fields and kept in inputs, textareas and the editor', () => {
    document.body.innerHTML = `<div id="d"><span id="s">x</span></div><input id="t" type="text"><input id="c" type="checkbox">
      <textarea id="ta"></textarea><div class="cm-editor"><div class="cm-content" id="cm" contenteditable="true">x</div></div>`;
    installContextMenuGuard(document);
    const fire = (id: string) => {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      document.getElementById(id)!.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire('s')).toBe(true);
    expect(fire('c')).toBe(true);
    expect(fire('t')).toBe(false);
    expect(fire('ta')).toBe(false);
    expect(fire('cm')).toBe(false);
    expect(keepsNativeMenu(null)).toBe(false);
  });
});
