// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Palette, type PaletteDeps, type FileListing } from '../palette';
import { CommandRegistry } from '../commands';
import { resetModalStateForTests } from '../modal';

const FILES = [
  'README.md',
  'docs/agent-context-design.md',
  'docs/agent-cockpit-plan.md',
  'frontend/src/app/agent-context.ts',
  'src-tauri/src/context.rs',
  'notes/todo.md',
];

function makeDeps(over: Partial<PaletteDeps> = {}): PaletteDeps & {
  listFiles: ReturnType<typeof vi.fn>;
  openFile: ReturnType<typeof vi.fn>;
  openToSide: ReturnType<typeof vi.fn>;
  gotoLine: ReturnType<typeof vi.fn>;
} {
  const deps = {
    root: () => '/ws',
    origin: () => null,
    showHidden: () => false,
    listFiles: vi.fn(async (): Promise<FileListing> => ({ files: FILES, truncated: false })),
    openFile: vi.fn(),
    openToSide: vi.fn(),
    activePath: () => null,
    gotoLine: vi.fn(),
    lineCount: () => 120,
    ...over,
  };
  return deps as any;
}

const layer = () => document.querySelector('.palette-layer');
const input = () => document.querySelector<HTMLInputElement>('.pal-input')!;
const items = () => Array.from(document.querySelectorAll<HTMLElement>('.pal-item'));
const selected = () => document.querySelector<HTMLElement>('.pal-item.sel');
/** A row's main label (without the dim folder). */
const labelOf = (el: HTMLElement | null | undefined) =>
  el
    ? Array.from(el.querySelector('.t')!.childNodes)
        .filter((n) => n.nodeName !== 'SMALL')
        .map((n) => n.textContent)
        .join('')
    : '';

function type(text: string): void {
  const el = input();
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function key(k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(ev);
  return ev;
}

async function openFiles(p: Palette): Promise<void> {
  p.open('files');
  await p.whenFilesLoaded();
}

describe('Palette', () => {
  let reg: CommandRegistry;

  beforeEach(() => {
    resetModalStateForTests();
    document.body.innerHTML = '<div id="app"><textarea id="ed"></textarea></div>';
    (document.getElementById('ed') as HTMLTextAreaElement).focus();
    reg = new CommandRegistry();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens as a modal, traps focus and restores it on Escape', async () => {
    const p = new Palette(makeDeps(), reg);
    await openFiles(p);
    expect(layer()).not.toBeNull();
    expect(document.activeElement).toBe(input());
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(true);
    // Tab stays inside (the input is the only stop).
    key('Tab');
    expect(document.activeElement).toBe(input());

    const esc = key('Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(layer()).toBeNull();
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('ed'));
  });

  it('closes on a click outside the dialog', async () => {
    const p = new Palette(makeDeps(), reg);
    await openFiles(p);
    layer()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(p.isOpen()).toBe(false);
  });

  it('fuzzy-finds files, highlights matches and shows the folder dimmed', async () => {
    const deps = makeDeps();
    const p = new Palette(deps, reg);
    await openFiles(p);
    expect(deps.listFiles).toHaveBeenCalledWith('/ws', false);
    type('agcon');
    const first = items()[0];
    expect(labelOf(first)).toBe('agent-context-design.md');
    expect(first.querySelector('small')!.textContent).toBe('docs');
    expect(Array.from(first.querySelectorAll('.t > mark')).map((m) => m.textContent).join('')).toBe('agcon');
    expect(first.classList.contains('sel')).toBe(true);
    expect(input().getAttribute('aria-activedescendant')).toBe(first.id);
  });

  it('moves the selection with the arrow keys (wrapping) and opens on Enter', async () => {
    const deps = makeDeps();
    const p = new Palette(deps, reg);
    await openFiles(p);
    type('md');
    const n = items().length;
    expect(n).toBeGreaterThan(2);
    key('ArrowDown');
    expect(selected()).toBe(items()[1]);
    key('ArrowUp');
    key('ArrowUp');
    expect(selected()).toBe(items()[n - 1]);
    key('ArrowDown');
    const name = labelOf(selected());
    const dir = selected()!.querySelector('small')?.textContent;
    key('Enter');
    expect(p.isOpen()).toBe(false);
    expect(deps.openFile).toHaveBeenCalledWith(dir ? `/ws/${dir}/${name}` : `/ws/${name}`);
  });

  it('Cmd+Enter opens to the side', async () => {
    const deps = makeDeps();
    const p = new Palette(deps, reg);
    await openFiles(p);
    type('todo');
    key('Enter', { metaKey: true });
    expect(deps.openToSide).toHaveBeenCalledWith('/ws/notes/todo.md');
    expect(deps.openFile).not.toHaveBeenCalled();
  });

  it('lists recently opened files first on an empty query', async () => {
    const p = new Palette(makeDeps({ activePath: () => '/ws/README.md' }), reg);
    p.noteOpened('/ws/notes/todo.md', null);
    p.noteOpened('/ws/src-tauri/src/context.rs', null);
    p.noteOpened('/ws/README.md', null); // the active file: not offered
    p.noteOpened('/elsewhere/x.md', null); // outside the root
    p.noteOpened('/ws/docs/agent-cockpit-plan.md', 'ssh://box'); // other machine
    await openFiles(p);
    const labels = items().map(labelOf);
    expect(labels.slice(0, 2)).toEqual(['context.rs', 'todo.md']);
    expect(items()[0].querySelector('.k')!.textContent).toBe('recent');
    expect(labels).not.toContain('x.md');
    // The rest of the workspace follows, without duplicates.
    expect(labels.filter((l) => l === 'todo.md')).toHaveLength(1);
    expect(labels).toContain('agent-cockpit-plan.md');
  });

  it('shows a loading row until the listing arrives, then the matches', async () => {
    let resolve!: (l: FileListing) => void;
    const deps = makeDeps({ listFiles: vi.fn(() => new Promise<FileListing>((r) => (resolve = r))) as any });
    const p = new Palette(deps, reg);
    p.open('files');
    type('todo');
    expect(items()[0].textContent).toContain('Loading files');
    expect(selected()).toBeNull();
    resolve({ files: FILES, truncated: false });
    await p.whenFilesLoaded();
    expect(labelOf(items()[0])).toBe('todo.md');
  });

  it('caches the listing per root and refetches after invalidateFiles', async () => {
    const deps = makeDeps();
    const p = new Palette(deps, reg);
    await openFiles(p);
    p.close();
    await openFiles(p);
    expect(deps.listFiles).toHaveBeenCalledTimes(1);
    p.invalidateFiles();
    await p.whenFilesLoaded();
    expect(deps.listFiles).toHaveBeenCalledTimes(2);
  });

  it('asks for hidden files when the explorer shows them', async () => {
    const deps = makeDeps({ showHidden: () => true });
    await openFiles(new Palette(deps, reg));
    expect(deps.listFiles).toHaveBeenCalledWith('/ws', true);
  });

  it('lists the remote workspace root when a remote folder is open', async () => {
    const deps = makeDeps({ root: () => '/home/u/proj', origin: () => 'ssh://box' });
    const p = new Palette(deps, reg);
    await openFiles(p);
    expect(deps.listFiles).toHaveBeenCalledWith('/home/u/proj', false);
    type('todo');
    key('Enter');
    expect(deps.openFile).toHaveBeenCalledWith('/home/u/proj/notes/todo.md');
  });

  it('without a folder offers recent files only', async () => {
    const deps = makeDeps({ root: () => null });
    const p = new Palette(deps, reg);
    p.open('files');
    expect(items()[0].textContent).toContain('Open a folder');
    p.close();
    p.noteOpened('/tmp/notes.md', null);
    p.open('files');
    type('notes');
    expect(labelOf(items()[0])).toBe('notes.md');
    key('Enter');
    expect(deps.openFile).toHaveBeenCalledWith('/tmp/notes.md');
    expect(deps.listFiles).not.toHaveBeenCalled();
  });

  describe('commands', () => {
    beforeEach(() => {
      reg.register(
        { id: 'a.split', title: 'Terminal: Split right', keys: 'CmdOrCtrl+D', run: vi.fn() },
        { id: 'a.save', title: 'File: Save', keys: 'CmdOrCtrl+S', run: vi.fn() },
        { id: 'a.off', title: 'Changes: Mark reviewed', shortcut: 'Space', run: vi.fn(), enabled: () => false },
        { id: 'a.wrap', title: 'View: Toggle word wrap', run: vi.fn() },
      );
    });

    it('typing ">" switches to commands; Backspace on empty goes back', async () => {
      const p = new Palette(makeDeps(), reg);
      await openFiles(p);
      type('>');
      expect(p.getMode()).toBe('commands');
      expect(input().value).toBe('');
      expect(document.querySelector('.pal-mode')!.textContent).toBe('>');
      expect(document.querySelector('.palette')!.getAttribute('aria-label')).toBe('Command palette');
      expect(items().map(labelOf)).toContain('File: Save');
      key('Backspace');
      expect(p.getMode()).toBe('files');
    });

    it('">query" typed at once keeps the query', async () => {
      const p = new Palette(makeDeps(), reg);
      await openFiles(p);
      type('>split');
      expect(p.getMode()).toBe('commands');
      expect(input().value).toBe('split');
      expect(labelOf(items()[0])).toBe('Terminal: Split right');
    });

    it('runs the selected command and shows its shortcut', async () => {
      const p = new Palette(makeDeps(), reg);
      p.open('commands');
      type('save');
      expect(items()[0].querySelector('.k')!.textContent).toMatch(/^(⌘S|Ctrl\+S)$/);
      key('Enter');
      await Promise.resolve();
      expect(reg.get('a.save')!.run).toHaveBeenCalledTimes(1);
      expect(p.isOpen()).toBe(false);
    });

    it('dims disabled commands, lists them last and never runs them', async () => {
      const p = new Palette(makeDeps(), reg);
      p.open('commands');
      const rows = items();
      const off = rows.find((r) => labelOf(r) === 'Changes: Mark reviewed')!;
      expect(off.classList.contains('disabled')).toBe(true);
      expect(off.getAttribute('aria-disabled')).toBe('true');
      expect(off.querySelector('.k')!.textContent).toBe('Space');
      expect(rows[rows.length - 1]).toBe(off);
      // Arrow keys skip it; a click does nothing.
      for (let i = 0; i < rows.length * 2; i++) {
        key('ArrowDown');
        expect(selected()).not.toBe(off);
      }
      off.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(reg.get('a.off')!.run).not.toHaveBeenCalled();
      expect(p.isOpen()).toBe(true);
    });

    it('recently run commands come first on an empty query', async () => {
      const p = new Palette(makeDeps(), reg);
      p.open('commands');
      type('wrap');
      key('Enter');
      await Promise.resolve();
      p.open('commands');
      expect(labelOf(items()[0])).toBe('View: Toggle word wrap');
    });

    it('open("commands") on an open palette switches mode', async () => {
      const p = new Palette(makeDeps(), reg);
      await openFiles(p);
      p.open('commands');
      expect(p.getMode()).toBe('commands');
      expect(document.querySelectorAll('.palette')).toHaveLength(1);
    });

    it('a command registered later shows without touching the palette', () => {
      const p = new Palette(makeDeps(), reg);
      const off = reg.register({ id: 'x.new', title: 'Review: Next file', run: vi.fn() });
      p.open('commands');
      type('next file');
      expect(labelOf(items()[0])).toBe('Review: Next file');
      p.close();
      off();
      p.open('commands');
      type('next file');
      expect(items().map(labelOf)).not.toContain('Review: Next file');
    });
  });

  it('":" goes to a line, clamped to the document', async () => {
    const deps = makeDeps({ activePath: () => '/ws/README.md', lineCount: () => 40 });
    const p = new Palette(deps, reg);
    await openFiles(p);
    type(':');
    expect(p.getMode()).toBe('line');
    type('400');
    expect(labelOf(items()[0])).toBe('Go to line 40');
    key('Enter');
    expect(deps.gotoLine).toHaveBeenCalledWith(40);
  });
});
