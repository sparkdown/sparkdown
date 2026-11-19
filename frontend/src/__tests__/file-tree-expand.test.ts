// @vitest-environment jsdom
/**
 * Expanding a folder while the explorer refreshes or the user clicks again:
 * the folder must stay open, and a stale or failed listing must not undo it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@crabnebula/tauri-plugin-drag', () => ({ startDrag: vi.fn(async () => {}) }));
vi.mock('../context-menu', () => ({ showContextMenu: vi.fn() }));

type Entry = { name: string; path: string; is_dir: boolean };
type Pending = { path: string; resolve: (e: Entry[]) => void; reject: (err: unknown) => void };

/** Directory contents served by the fake backend. */
const disk = new Map<string, Entry[]>();
/** When set, listings of these paths wait until the test settles them. */
let held = new Set<string>();
let pendingListings: Pending[] = [];
let failing = new Set<string>();

const listDirectory = vi.fn((path: string) => {
  if (failing.has(path)) return Promise.reject(new Error('transient'));
  const entries = disk.get(path);
  if (!entries) return Promise.reject(new Error('missing'));
  if (!held.has(path)) return Promise.resolve(entries);
  return new Promise<Entry[]>((resolve, reject) => {
    pendingListings.push({ path, resolve: () => resolve(disk.get(path) ?? entries), reject });
  });
});
vi.mock('../api', () => ({
  api: {
    listDirectory: (path: string) => listDirectory(path),
    copyFile: vi.fn(),
    copyText: vi.fn(),
  },
}));

import { EventBus } from '../events';
import { FileTree } from '../file-tree';

const ROOT = '/proj';
const DOCS = '/proj/docs';
const NOTES = '/proj/docs/notes.md';
const README = '/proj/README.md';

function mountTree(): FileTree {
  document.body.innerHTML = `
    <nav id="sidebar">
      <div id="sidebar-header">
        <h2 id="sidebar-title">Files</h2>
        <button id="btn-search-toggle"></button>
        <button id="btn-toggle-hidden"></button>
        <button id="btn-collapse-all"></button>
      </div>
      <div id="sidebar-filter" class="hidden"><input id="sidebar-search-input" /></div>
      <div id="file-tree" style="height: 400px;"></div>
    </nav>`;
  const tree = new FileTree(new EventBus(), true, 220, false);
  const viewport = document.getElementById('file-tree')!;
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
  tree.init(viewport, document.getElementById('sidebar')!);
  return tree;
}

const row = (path: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('.tree-item')).find((el) => el.dataset.path === path);
const click = (path: string) => row(path)!.click();
const tick = () => new Promise((r) => setTimeout(r, 0));
const settleAll = async () => {
  const list = pendingListings;
  pendingListings = [];
  held = new Set();
  for (const p of list) p.resolve([]);
  await tick();
};

describe('FileTree expand races', () => {
  beforeEach(() => {
    listDirectory.mockClear();
    disk.clear();
    held = new Set();
    pendingListings = [];
    failing = new Set();
    disk.set(ROOT, [
      { name: 'docs', path: DOCS, is_dir: true },
      { name: 'README.md', path: README, is_dir: false },
    ]);
    disk.set(DOCS, [{ name: 'notes.md', path: NOTES, is_dir: false }]);
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('expands a folder and shows its children', async () => {
    const tree = mountTree();
    await tree.setRoot(ROOT);
    click(DOCS);
    await tick();
    expect(row(NOTES)).toBeTruthy();
    expect(row(DOCS)!.getAttribute('aria-expanded')).toBe('true');
  });

  it('a second click during the first listing leaves the folder expanded', async () => {
    const tree = mountTree();
    await tree.setRoot(ROOT);
    held.add(DOCS);
    click(DOCS);
    click(DOCS);
    click(DOCS);
    await settleAll();
    expect(row(DOCS)!.getAttribute('aria-expanded')).toBe('true');
    expect(row(NOTES)).toBeTruthy();
    expect(listDirectory.mock.calls.filter(([p]) => p === DOCS)).toHaveLength(1);
    // Once loaded, the next click collapses it as usual.
    click(DOCS);
    await tick();
    expect(row(DOCS)!.getAttribute('aria-expanded')).toBe('false');
    expect(row(NOTES)).toBeFalsy();
  });

  it('a refresh that starts during the listing keeps the folder expanded', async () => {
    const tree = mountTree();
    await tree.setRoot(ROOT);
    held.add(DOCS);
    click(DOCS);
    const refreshing = tree.refresh();
    await tick();
    await settleAll();
    await refreshing;
    await tick();
    expect(row(DOCS)!.getAttribute('aria-expanded')).toBe('true');
    expect(row(NOTES)).toBeTruthy();
  });

  it('a refresh that started before the click does not drop the new expansion', async () => {
    const tree = mountTree();
    await tree.setRoot(ROOT);
    held.add(ROOT);
    const refreshing = tree.refresh();
    await tick();
    click(DOCS); // root listing of the refresh is still in flight
    await tick();
    held = new Set();
    for (const p of pendingListings.splice(0)) p.resolve([]);
    await refreshing;
    await tick();
    expect(row(DOCS)!.getAttribute('aria-expanded')).toBe('true');
    expect(row(NOTES)).toBeTruthy();
  });

  it('a refresh does not drop an open folder because one listing failed', async () => {
    const tree = mountTree();
    await tree.setRoot(ROOT);
    click(DOCS);
    await tick();
    expect(row(NOTES)).toBeTruthy();

    failing.add(DOCS);
    await tree.refresh();
    expect(row(DOCS)!.getAttribute('aria-expanded')).toBe('true');
    expect(row(NOTES)).toBeTruthy(); // keeps what it showed

    failing.delete(DOCS);
    disk.set(DOCS, [{ name: 'later.md', path: '/proj/docs/later.md', is_dir: false }]);
    await tree.refresh();
    expect(row('/proj/docs/later.md')).toBeTruthy();
    expect(row(NOTES)).toBeFalsy();
  });

  it('a refresh still drops an open folder that no longer exists', async () => {
    const tree = mountTree();
    await tree.setRoot(ROOT);
    click(DOCS);
    await tick();
    disk.set(ROOT, [{ name: 'README.md', path: README, is_dir: false }]);
    disk.delete(DOCS);
    await tree.refresh();
    expect(row(DOCS)).toBeFalsy();
    expect(row(NOTES)).toBeFalsy();
    // Recreated later: it comes back closed.
    disk.set(ROOT, [
      { name: 'docs', path: DOCS, is_dir: true },
      { name: 'README.md', path: README, is_dir: false },
    ]);
    disk.set(DOCS, [{ name: 'notes.md', path: NOTES, is_dir: false }]);
    await tree.refresh();
    expect(row(DOCS)!.getAttribute('aria-expanded')).toBe('false');
  });

  it('ignores a listing that finishes after the root changed or Collapse all', async () => {
    const tree = mountTree();
    await tree.setRoot(ROOT);
    held.add(DOCS);
    click(DOCS);
    tree.collapseAll();
    await settleAll();
    expect(row(DOCS)!.getAttribute('aria-expanded')).toBe('false');
    expect(row(NOTES)).toBeFalsy();
  });

  it('a first listing that fails leaves the folder closed', async () => {
    const tree = mountTree();
    await tree.setRoot(ROOT);
    failing.add(DOCS);
    click(DOCS);
    await tick();
    failing.delete(DOCS);
    expect(row(NOTES)).toBeFalsy();
    click(DOCS); // not stuck: a later click tries again
    await tick();
    expect(row(NOTES)).toBeTruthy();
  });
});
