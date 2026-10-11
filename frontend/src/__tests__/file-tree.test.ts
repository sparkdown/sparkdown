// @vitest-environment jsdom
/**
 * Explorer indicator split (#35 / #27): tab focus, watcher flash, and git
 * badges are three distinct signals. Activating a file must never apply the
 * change-highlight class that WebKitGTK painted as a native selected row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@crabnebula/tauri-plugin-drag', () => ({
  startDrag: vi.fn(async () => {}),
}));

vi.mock('../context-menu', () => ({
  showContextMenu: vi.fn(),
}));

const listDirectory = vi.fn();
vi.mock('../api', () => ({
  api: {
    listDirectory: (...args: unknown[]) => listDirectory(...args),
    copyFile: vi.fn(),
    copyText: vi.fn(),
  },
}));

import { EventBus } from '../events';
import { EVENTS } from '../event-names';
import {
  FileTree,
  TREE_FLASH_CLASS,
  TREE_CURRENT_CLASS,
  TREE_OPEN_CLASS,
} from '../file-tree';

const ROOT = '/proj';
const FILE_A = '/proj/a.md';
const FILE_B = '/proj/b.md';

function mountTree(): { tree: FileTree; bus: EventBus } {
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
  const bus = new EventBus();
  const tree = new FileTree(bus, true, 220, false);
  const viewport = document.getElementById('file-tree')!;
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
  tree.init(viewport, document.getElementById('sidebar')!);
  return { tree, bus };
}

function row(path: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('.tree-item')).find(
    (el) => el.dataset.path === path,
  );
}

describe('FileTree indicator split', () => {
  beforeEach(() => {
    listDirectory.mockReset();
    listDirectory.mockResolvedValue([
      { name: 'a.md', path: FILE_A, is_dir: false },
      { name: 'b.md', path: FILE_B, is_dir: false },
    ]);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('setCurrentPath (tab activation) does not apply watcher flash or changed', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);

    tree.setCurrentPath(FILE_A);

    const el = row(FILE_A);
    expect(el).toBeTruthy();
    expect(el!.classList.contains(TREE_CURRENT_CLASS)).toBe(true);
    expect(el!.classList.contains(TREE_FLASH_CLASS)).toBe(false);
    expect(el!.classList.contains('changed')).toBe(false);
    expect(document.querySelectorAll('.tree-flash').length).toBe(0);
    expect(document.querySelectorAll('.changed').length).toBe(0);
  });

  it('switching the current path moves tree-current and never flashes', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);

    tree.setCurrentPath(FILE_A);
    tree.setCurrentPath(FILE_B);

    expect(row(FILE_A)!.classList.contains(TREE_CURRENT_CLASS)).toBe(false);
    expect(row(FILE_B)!.classList.contains(TREE_CURRENT_CLASS)).toBe(true);
    expect(row(FILE_A)!.classList.contains(TREE_FLASH_CLASS)).toBe(false);
    expect(row(FILE_B)!.classList.contains(TREE_FLASH_CLASS)).toBe(false);
    expect(row(FILE_B)!.classList.contains('changed')).toBe(false);
  });

  it('markChanged applies tree-flash, not current, and not a git badge', async () => {
    vi.useFakeTimers();
    try {
      const { tree } = mountTree();
      await tree.setRoot(ROOT);

      tree.markChanged([FILE_A]);

      const el = row(FILE_A);
      expect(el!.classList.contains(TREE_FLASH_CLASS)).toBe(true);
      expect(el!.classList.contains(TREE_CURRENT_CLASS)).toBe(false);
      expect(el!.querySelector('.tree-git-badge')).toBeNull();

      vi.advanceTimersByTime(4000);
      expect(row(FILE_A)!.classList.contains(TREE_FLASH_CLASS)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('git badges come only from setGitStatus and do not flash', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);

    tree.setGitStatus(new Map([[FILE_A, 'M']]));
    // setGitStatus re-renders asynchronously via renderTree
    await Promise.resolve();
    await Promise.resolve();

    const el = row(FILE_A);
    const badge = el?.querySelector('.tree-git-badge');
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toBe('M');
    expect(badge!.classList.contains('git-m')).toBe(true);
    expect(el!.classList.contains(TREE_FLASH_CLASS)).toBe(false);
    expect(el!.classList.contains(TREE_CURRENT_CLASS)).toBe(false);
    expect(row(FILE_B)!.querySelector('.tree-git-badge')).toBeNull();
  });

  it('current, flash, and git badge can coexist without collapsing', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);

    tree.setGitStatus(new Map([[FILE_A, 'M']]));
    await Promise.resolve();
    await Promise.resolve();

    tree.setCurrentPath(FILE_A);
    tree.markChanged([FILE_A]);

    const el = row(FILE_A);
    expect(el!.classList.contains(TREE_CURRENT_CLASS)).toBe(true);
    expect(el!.classList.contains(TREE_FLASH_CLASS)).toBe(true);
    expect(el!.querySelector('.tree-git-badge')?.textContent).toBe('M');
    expect(el!.classList.contains('changed')).toBe(false);
  });

  it('tree rows are unfocusable so WebKitGTK cannot paint selected-row chrome', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);
    for (const el of document.querySelectorAll<HTMLElement>('.tree-item')) {
      expect(el.tabIndex).toBe(-1);
    }
  });

  it('TAB_SWITCHED applies tree-current and never tree-flash or changed', async () => {
    const { tree, bus } = mountTree();
    await tree.setRoot(ROOT);

    bus.emit(EVENTS.TAB_SWITCHED, { tab: { path: FILE_A } as never });

    const el = row(FILE_A)!;
    expect(el.classList.contains(TREE_CURRENT_CLASS)).toBe(true);
    expect(el.classList.contains(TREE_FLASH_CLASS)).toBe(false);
    expect(el.classList.contains('changed')).toBe(false);
  });

  it('setRoot of a nested dir is a no-op (tab switch) unless force (Open Folder / drop)', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);
    const calls = listDirectory.mock.calls.length;

    await tree.setRoot(`${ROOT}/src`);
    expect(tree.getRoot()).toBe(ROOT);
    expect(listDirectory.mock.calls.length).toBe(calls);

    listDirectory.mockResolvedValue([
      { name: 'c.md', path: `${ROOT}/src/c.md`, is_dir: false },
    ]);
    await tree.setRoot(`${ROOT}/src`, true);
    expect(tree.getRoot()).toBe(`${ROOT}/src`);
    expect(listDirectory.mock.calls.length).toBeGreaterThan(calls);
  });
  it('refresh keeps expanded folders and reloads their children', async () => {
    const dir = `${ROOT}/src`;
    const child = `${dir}/nested.md`;
    listDirectory.mockImplementation((path: string) => Promise.resolve(
      path === ROOT
        ? [{ name: 'src', path: dir, is_dir: true }]
        : [{ name: 'nested.md', path: child, is_dir: false }],
    ));
    const { tree } = mountTree();
    await tree.setRoot(ROOT);
    row(dir)!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(row(child)).toBeTruthy();

    await tree.refresh();

    expect(row(dir)?.querySelector('.tree-chevron')?.classList.contains('expanded')).toBe(true);
    expect(row(child)).toBeTruthy();
  });

  it('refresh with unchanged structure does not remount tree DOM', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);
    const before = row(FILE_A)!;
    before.dataset.probe = 'keep-me';
    const calls = listDirectory.mock.calls.length;

    await tree.refresh();

    expect(listDirectory.mock.calls.length).toBeGreaterThan(calls);
    const after = row(FILE_A)!;
    expect(after).toBe(before);
    expect(after.dataset.probe).toBe('keep-me');
  });

  it('refresh preserves scrollTop across a real structure change', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `f${i}.md`,
      path: `${ROOT}/f${i}.md`,
      is_dir: false,
    }));
    listDirectory.mockResolvedValue(many);
    const { tree } = mountTree();
    await tree.setRoot(ROOT);
    const viewport = document.getElementById('file-tree')!;
    const spacer = () => (viewport.querySelector('.tree-spacer') as HTMLElement).style.height;
    viewport.scrollTop = 180;
    expect(viewport.scrollTop).toBe(180);
    const spacerBefore = spacer();

    // Prepend so the new entry is near the top of the tree after remount.
    listDirectory.mockResolvedValue([
      { name: 'a-new.md', path: `${ROOT}/a-new.md`, is_dir: false },
      ...many,
    ]);
    await tree.refresh();

    expect(viewport.scrollTop).toBe(180);
    expect(spacer()).not.toBe(spacerBefore);
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    expect(row(`${ROOT}/a-new.md`)).toBeTruthy();
  });

});

describe('FileTree: files-only tree (UI revamp phase 1)', () => {
  const DIR = `${ROOT}/docs`;
  const SUB = `${DIR}/deep`;
  const NESTED = `${SUB}/n.md`;

  beforeEach(() => {
    listDirectory.mockReset();
    listDirectory.mockImplementation((path: string) => Promise.resolve(
      path === ROOT
        ? [
            { name: 'docs', path: DIR, is_dir: true },
            { name: 'a.md', path: FILE_A, is_dir: false },
            { name: 'b.md', path: FILE_B, is_dir: false },
          ]
        : path === DIR
          ? [{ name: 'deep', path: SUB, is_dir: true }]
          : [{ name: 'n.md', path: NESTED, is_dir: false }],
    ));
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const settle = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  it('has no "Documents" section: each root file is listed once, in the tree', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);
    expect(document.querySelector('.tree-section-header')).toBeNull();
    expect(document.body.textContent).not.toContain('Documents');
    const paths = [...document.querySelectorAll<HTMLElement>('.tree-item')].map((e) => e.dataset.path);
    expect(paths).toEqual([DIR, FILE_A, FILE_B]);
  });

  it('shows the folder name as the header title', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);
    const title = document.getElementById('sidebar-title')!;
    expect(title.textContent).toBe('proj');
    expect(title.title).toBe(ROOT);
    tree.clear();
    expect(title.textContent).toBe('Files');
  });

  it('marks other open tabs with a dot; the current file gets the highlight instead', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);
    tree.setOpenPaths([FILE_A, FILE_B]);
    tree.setCurrentPath(FILE_A);
    await settle();

    expect(row(FILE_A)!.classList.contains(TREE_CURRENT_CLASS)).toBe(true);
    expect(row(FILE_A)!.classList.contains(TREE_OPEN_CLASS)).toBe(true);
    expect(row(FILE_A)!.querySelector('.tree-open-dot')).toBeNull();
    expect(row(FILE_B)!.querySelector('.tree-open-dot')).toBeTruthy();

    tree.setCurrentPath(FILE_B);
    await settle();
    expect(row(FILE_A)!.querySelector('.tree-open-dot')).toBeTruthy();
    expect(row(FILE_B)!.querySelector('.tree-open-dot')).toBeNull();

    tree.setOpenPaths([FILE_B]);
    expect(row(FILE_A)!.classList.contains(TREE_OPEN_CLASS)).toBe(false);
    expect(row(FILE_A)!.querySelector('.tree-open-dot')).toBeNull();
  });

  it('reveals the active file on tab switch: expands its folders and scrolls it into view', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      name: `f${String(i).padStart(2, '0')}.md`,
      path: `${ROOT}/f${String(i).padStart(2, '0')}.md`,
      is_dir: false,
    }));
    listDirectory.mockImplementation((path: string) => Promise.resolve(
      path === ROOT
        ? [...many, { name: 'zz', path: `${ROOT}/zz`, is_dir: true }]
        : [{ name: 'deep.md', path: `${ROOT}/zz/deep.md`, is_dir: false }],
    ));
    const { tree, bus } = mountTree();
    await tree.setRoot(ROOT);
    const viewport = document.getElementById('file-tree')!;
    expect(row(`${ROOT}/zz/deep.md`)).toBeUndefined();

    bus.emit(EVENTS.TAB_SWITCHED, { tab: { path: `${ROOT}/zz/deep.md` } as never });
    await settle();

    // Folder expanded (chevron turned) and the row scrolled into view.
    const target = row(`${ROOT}/zz/deep.md`);
    expect(target).toBeTruthy();
    expect(target!.classList.contains(TREE_CURRENT_CLASS)).toBe(true);
    expect(row(`${ROOT}/zz`)!.querySelector('.tree-chevron')!.classList.contains('expanded')).toBe(true);
    const top = parseInt(target!.style.top, 10);
    expect(top).toBeGreaterThanOrEqual(viewport.scrollTop);
    expect(top + 24).toBeLessThanOrEqual(viewport.scrollTop + 400);
    // Never a flash: a tab switch is not a disk change.
    expect(document.querySelectorAll(`.${TREE_FLASH_CLASS}`).length).toBe(0);
  });

  it('reveals through several folder levels', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);
    tree.setCurrentPath(NESTED);
    await settle();
    expect(row(NESTED)).toBeTruthy();
    expect(row(DIR)!.getAttribute('aria-expanded')).toBe('true');
    expect(row(SUB)!.getAttribute('aria-expanded')).toBe('true');
  });

  it('ignores a file outside the root (no re-root, no reads)', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);
    const calls = listDirectory.mock.calls.length;
    tree.setCurrentPath('/elsewhere/x.md');
    await settle();
    expect(tree.getRoot()).toBe(ROOT);
    expect(listDirectory.mock.calls.length).toBe(calls);
  });

  it('collapse all closes every folder', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);
    tree.setCurrentPath(NESTED);
    await settle();
    expect(row(NESTED)).toBeTruthy();
    document.getElementById('btn-collapse-all')!.click();
    expect(row(NESTED)).toBeUndefined();
    expect(row(SUB)).toBeUndefined();
    expect(row(DIR)!.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps git badges on files and adds a dot on folders above a change', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);
    tree.setGitStatus(new Map([[NESTED, 'U'], [`${DIR}/other.md`, 'M'], [FILE_A, 'M']]));
    expect(row(FILE_A)!.querySelector('.tree-git-badge')!.textContent).toBe('M');
    const dot = row(DIR)!.querySelector('.tree-git-dot');
    expect(dot).toBeTruthy();
    // Modified beats untracked for the folder's dot color.
    expect(dot!.classList.contains('git-m')).toBe(true);
    tree.setCurrentPath(NESTED);
    await settle();
    expect(row(SUB)!.querySelector('.tree-git-dot')!.classList.contains('git-u')).toBe(true);
  });

  it('the filter button shows a field under the header; Escape clears it', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);
    const btn = document.getElementById('btn-search-toggle')!;
    const field = document.getElementById('sidebar-filter')!;
    const input = document.getElementById('sidebar-search-input') as HTMLInputElement;
    btn.click();
    expect(field.classList.contains('hidden')).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(input);
    input.value = 'b.md';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(field.classList.contains('hidden')).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(input.value).toBe('');
  });

  it('show hidden reflects its state in aria-pressed', async () => {
    const { tree } = mountTree();
    await tree.setRoot(ROOT);
    const btn = document.getElementById('btn-toggle-hidden')!;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.click();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(tree.isShowHidden()).toBe(true);
  });
});

describe('FileTree viewport sizing (#29)', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    name: `f${String(i).padStart(2, '0')}.md`,
    path: `${ROOT}/f${String(i).padStart(2, '0')}.md`,
    is_dir: false,
  }));
  let observers: Array<() => void> = [];

  beforeEach(() => {
    listDirectory.mockReset();
    listDirectory.mockResolvedValue(many);
    observers = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private cb: () => void) {
          observers.push(() => this.cb());
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function setHeight(h: number) {
    const viewport = document.getElementById('file-tree')!;
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: h });
  }

  it('a tree rendered while hidden shows every row once the viewport gets its size', async () => {
    const { tree } = mountTree();
    setHeight(0); // sidebar hidden / another activity view in front
    await tree.setRoot(ROOT);
    const mountedHidden = document.querySelectorAll('.tree-item').length;
    expect(mountedHidden).toBeLessThan(many.length);
    expect(row(`${ROOT}/f30.md`)).toBeUndefined();

    setHeight(40 * 24);
    observers.forEach((fire) => fire());
    expect(document.querySelectorAll('.tree-item').length).toBe(many.length);
    expect(row(`${ROOT}/f39.md`)).toBeDefined();
  });

  it('showing the sidebar re-windows rows rendered while it was hidden', async () => {
    const { tree } = mountTree();
    tree.setVisible(false);
    setHeight(0);
    await tree.setRoot(ROOT);
    expect(row(`${ROOT}/f39.md`)).toBeUndefined();
    setHeight(40 * 24);
    tree.setVisible(true);
    expect(row(`${ROOT}/f39.md`)).toBeDefined();
  });
});
