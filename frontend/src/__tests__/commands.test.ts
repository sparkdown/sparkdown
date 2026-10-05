// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { CommandRegistry } from '../commands';
import { SIDEBAR_VIEWS, viewAccelerator } from '../activity-bar';
import { registerBuiltinCommands, type BuiltinCommandTargets } from '../app/builtin-commands';
import { EventBus } from '../events';
import { ACTIONS } from '../event-names';
import {
  KEYBINDINGS,
  ShortcutManager,
  TERMINAL_PANE_KEYS,
  formatShortcut,
  shortcutFor,
  terminalPaneAction,
  terminalPaneShortcut,
  type TerminalPaneAction,
} from '../shortcuts';

describe('CommandRegistry', () => {
  it('registers, replaces by id, and unregisters exactly its own entries', async () => {
    const reg = new CommandRegistry();
    const a = vi.fn();
    const b = vi.fn();
    const off1 = reg.register({ id: 'x', title: 'X: One', run: a });
    const off2 = reg.register({ id: 'x', title: 'X: Two', run: b });
    expect(reg.list().map((c) => c.title)).toEqual(['X: Two']);
    off1(); // stale handle: the replacement stays
    expect(reg.get('x')?.title).toBe('X: Two');
    expect(await reg.run('x')).toBe(true);
    expect(b).toHaveBeenCalled();
    off2();
    expect(reg.list()).toEqual([]);
    expect(await reg.run('x')).toBe(false);
  });

  it('refuses to run disabled commands and treats a throwing enabled() as disabled', async () => {
    const reg = new CommandRegistry();
    const run = vi.fn();
    reg.register(
      { id: 'off', title: 'A: Off', run, enabled: () => false },
      { id: 'bad', title: 'A: Bad', run, enabled: () => { throw new Error('x'); } },
    );
    expect(await reg.run('off')).toBe(false);
    expect(await reg.run('bad')).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('formats accelerators for the platform', () => {
    const reg = new CommandRegistry();
    const cmd = { id: 'c', title: 'C: C', keys: 'CmdOrCtrl+Shift+P', run() {} };
    expect(reg.shortcutLabel(cmd, true)).toBe('⌘⇧P');
    expect(reg.shortcutLabel(cmd, false)).toBe('Ctrl+Shift+P');
    expect(reg.shortcutLabel({ ...cmd, keys: undefined, shortcut: 'Space' })).toBe('Space');
    expect(formatShortcut('CmdOrCtrl+Alt+O', true)).toBe('⌘⌥O');
    expect(formatShortcut('Ctrl+`', true)).toBe('⌃`');
    expect(formatShortcut('CmdOrCtrl+Alt+Right', false)).toBe('Ctrl+Alt+→');
    expect(formatShortcut('CmdOrCtrl+,', true)).toBe('⌘,');
  });
});

function targets(over: Partial<BuiltinCommandTargets> = {}) {
  const bus = new EventBus();
  let tab: any = null;
  const t: BuiltinCommandTargets = {
    bus,
    tabs: { activeTab: () => tab, getAllTabs: () => (tab ? [tab] : []) },
    root: () => '/ws',
    setViewMode: vi.fn(),
    showSidebarView: vi.fn(),
    openLinePrompt: vi.fn(),
    toggleHtmlScripts: vi.fn(),
    checkForUpdates: vi.fn(),
    terminal: { isVisible: () => false, split: vi.fn(), closePane: vi.fn(), focusPane: vi.fn() },
    ...over,
  };
  return { t, bus, setTab: (x: any) => (tab = x) };
}

describe('built-in commands', () => {
  it('have unique ids and "Area: Action" sentence-case titles', () => {
    const reg = new CommandRegistry();
    registerBuiltinCommands(reg, targets().t);
    const list = reg.list();
    expect(list.length).toBeGreaterThan(30);
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
    for (const c of list) {
      expect(c.title, c.title).toMatch(/^[A-Z][a-z]+: [A-Z]/);
      // Sentence case: after the first word, only acronyms / proper nouns
      // may be capitalised.
      const words = c.title.split(': ')[1].split(' ').slice(1);
      for (const w of words) expect(/^[a-z(…]|^(HTML|JavaScript)/.test(w), `${c.title}: "${w}"`).toBe(true);
    }
  });

  it('shortcut labels come from KEYBINDINGS', () => {
    const reg = new CommandRegistry();
    registerBuiltinCommands(reg, targets().t);
    const label = (id: string) => reg.shortcutLabel(reg.get(id)!, true);
    expect(label('file.save')).toBe('⌘S');
    expect(label('go.file')).toBe('⌘P');
    expect(label('remote.openFolder')).toBe('⌘⇧O');
    expect(label('terminal.toggle')).toBe('⌃`');
    expect(label('tabs.next')).toBe('⌘⌥→');
    expect(label('view.toggleTheme')).toBe('');
    expect(label('view.search')).toBe('⌘⇧F');
    // Every key comes from one of the two tables (bus actions, activity bar).
    const known = [...Object.values(KEYBINDINGS), ...SIDEBAR_VIEWS.map(viewAccelerator)];
    for (const c of reg.list()) {
      if (c.keys) expect(known).toContain(c.keys);
    }
  });

  it('run through the bus actions (the same path as keys and menus)', async () => {
    const reg = new CommandRegistry();
    const { t, bus, setTab } = targets();
    registerBuiltinCommands(reg, t);
    const save = vi.fn();
    const term = vi.fn();
    bus.on(ACTIONS.SAVE, save);
    bus.on(ACTIONS.TOGGLE_TERMINAL, term);
    setTab({ id: '1', path: '/ws/a.md', viewMode: 'split' });
    await reg.run('file.save');
    await reg.run('terminal.toggle');
    await reg.run('view.split');
    await reg.run('view.changes');
    await reg.run('go.line');
    expect(save).toHaveBeenCalledTimes(1);
    expect(term).toHaveBeenCalledTimes(1);
    expect(t.setViewMode).toHaveBeenCalledWith('split');
    expect(t.showSidebarView).toHaveBeenCalledWith('changes');
    expect(t.openLinePrompt).toHaveBeenCalled();
  });

  it('terminal pane commands drive the split grid, with the pane keys as labels', async () => {
    const reg = new CommandRegistry();
    let visible = false;
    const { t } = targets();
    t.terminal.isVisible = () => visible;
    registerBuiltinCommands(reg, t);
    // Split works with the terminal hidden (it opens it); the rest need it.
    expect(reg.isEnabled(reg.get('terminal.splitRight')!)).toBe(true);
    expect(reg.isEnabled(reg.get('terminal.closePane')!)).toBe(false);
    visible = true;
    await reg.run('terminal.splitRight');
    await reg.run('terminal.splitDown');
    await reg.run('terminal.closePane');
    await reg.run('terminal.focusNext');
    await reg.run('terminal.focusPrevious');
    expect(t.terminal.split).toHaveBeenNthCalledWith(1, 'right');
    expect(t.terminal.split).toHaveBeenNthCalledWith(2, 'down');
    expect(t.terminal.closePane).toHaveBeenCalledTimes(1);
    expect(t.terminal.focusPane).toHaveBeenNthCalledWith(1, 1);
    expect(t.terminal.focusPane).toHaveBeenNthCalledWith(2, -1);
    // jsdom runs as Windows here (see the KEYBINDINGS tests).
    expect(reg.shortcutLabel(reg.get('terminal.splitRight')!)).toMatch(/^(⌘D|Ctrl\+Shift\+D)$/);
  });

  it('are disabled when they have nothing to act on', () => {
    const reg = new CommandRegistry();
    const { t, setTab } = targets({ root: () => null });
    registerBuiltinCommands(reg, t);
    const on = (id: string) => reg.isEnabled(reg.get(id)!);
    expect(on('file.save')).toBe(false);
    expect(on('view.split')).toBe(false);
    expect(on('view.changes')).toBe(false);
    expect(on('tabs.next')).toBe(false);
    expect(on('file.new')).toBe(true);
    setTab({ id: '1', path: '/ws/a.ts', viewMode: 'split' });
    expect(on('file.save')).toBe(true);
    expect(on('view.split')).toBe(false); // .ts has no preview
    expect(on('view.edit')).toBe(true);
    setTab({ id: '1', path: '/ws/a.md', viewMode: 'diff' });
    expect(on('format.bold')).toBe(false); // diff view is read-only
    expect(on('view.split')).toBe(true);
  });
});

describe('KEYBINDINGS', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
  });

  /** A keydown for a Tauri accelerator, as Windows/Linux delivers it. */
  function eventFor(accel: string): KeyboardEventInit {
    const parts = accel.split('+');
    const k = parts.pop()!;
    const init: KeyboardEventInit = {
      key: k === 'Right' ? 'ArrowRight' : k === 'Left' ? 'ArrowLeft' : k.toLowerCase(),
    };
    for (const m of parts) {
      if (m === 'CmdOrCtrl' || m === 'Ctrl') init.ctrlKey = true;
      if (m === 'Shift') init.shiftKey = true;
      if (m === 'Alt') init.altKey = true;
    }
    return init;
  }

  // Bound outside ShortcutManager (PaneController routes Cmd+F itself).
  const HANDLED_ELSEWHERE = new Set<string>([ACTIONS.FIND]);

  it('every listed key dispatches its action on Windows/Linux', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    const bus = new EventBus();
    const fired: string[] = [];
    for (const action of Object.values(ACTIONS)) bus.on(action, () => fired.push(action));
    new ShortcutManager(bus).init();
    for (const [action, accel] of Object.entries(KEYBINDINGS)) {
      if (HANDLED_ELSEWHERE.has(action)) continue;
      fired.length = 0;
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...eventFor(accel!) }));
      expect(fired, `${accel} → ${action}`).toEqual([action]);
    }
  });

  it('terminal pane labels match what terminalPaneAction answers to', () => {
    const paneEvent = (init: KeyboardEventInit) => ({
      type: 'keydown',
      code: '',
      key: init.key ?? '',
      metaKey: !!init.metaKey,
      ctrlKey: !!init.ctrlKey,
      shiftKey: !!init.shiftKey,
      altKey: !!init.altKey,
    });
    const entries = Object.entries(TERMINAL_PANE_KEYS) as Array<[TerminalPaneAction, { mac: string; other: string }]>;
    for (const [action, keys] of entries) {
      expect(terminalPaneAction(paneEvent(eventFor(keys.other)), false), keys.other).toBe(action);
      // macOS close pane is ⌘W through File → Close Tab, not the terminal.
      if (action === 'close-pane') continue;
      const mac = { ...eventFor(keys.mac.replace('Cmd+', '')), metaKey: true };
      expect(terminalPaneAction(paneEvent(mac), true), keys.mac).toBe(action);
    }
    expect(terminalPaneShortcut('split-down', true)).toBe('⌘⇧D');
    expect(terminalPaneShortcut('focus-prev', false)).toBe('Ctrl+Shift+[');
  });

  it('shortcutFor formats a bound action and is empty otherwise', () => {
    expect(shortcutFor(ACTIONS.COMMAND_PALETTE, true)).toBe('⌘⇧P');
    expect(shortcutFor(ACTIONS.TOGGLE_THEME, true)).toBe('');
  });
});
