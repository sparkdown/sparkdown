// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventBus } from '../events';
import { ACTIONS } from '../event-names';
import {
  KEYBINDINGS,
  ShortcutManager,
  applyShortcutLabels,
  formatShortcut,
  isBacktickKey,
  shortcutFor,
  shortcutKey,
  terminalPassesToApp,
} from '../shortcuts';
import { editorPlaceholder } from '../editor';

// Regression tests for #16: Windows behaved Mac-only (glyph labels,
// Ctrl+Alt+O and Ctrl+` dead on AltGr / dead-key layouts, Ctrl+` eaten by a
// focused terminal) and the "⌘/" placeholder on Linux.

const MAC_GLYPHS = /[⌘⌥⇧⌃⏎]/;

function setPlatform(p: string): void {
  Object.defineProperty(navigator, 'platform', { value: p, configurable: true });
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, ...init });
  document.dispatchEvent(e);
  return e;
}

function manager(): { bus: EventBus; spy: (action: string) => ReturnType<typeof vi.fn> } {
  const bus = new EventBus();
  new ShortcutManager(bus).init();
  return {
    bus,
    spy: (action) => {
      const fn = vi.fn();
      bus.on(action as never, fn);
      return fn;
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  setPlatform('Win32');
});

describe('shortcut labels per platform', () => {
  it('renders every binding in words, never Mac glyphs, on Windows and Linux', () => {
    for (const accel of Object.values(KEYBINDINGS)) {
      const label = formatShortcut(accel!, false);
      expect(label, accel).not.toMatch(MAC_GLYPHS);
      if (accel!.startsWith('CmdOrCtrl+')) expect(label.startsWith('Ctrl+'), label).toBe(true);
    }
    expect(formatShortcut('CmdOrCtrl+Alt+O', false)).toBe('Ctrl+Alt+O');
    expect(formatShortcut('CmdOrCtrl+Shift+O', false)).toBe('Ctrl+Shift+O');
    expect(formatShortcut('Option+Shift+X', false)).toBe('Alt+Shift+X');
    expect(formatShortcut('Ctrl+`', false)).toBe('Ctrl+`');
    expect(formatShortcut('Shift+Enter', false)).toBe('Shift+Enter');
  });

  it('keeps the macOS glyphs on macOS', () => {
    expect(formatShortcut('CmdOrCtrl+Alt+O', true)).toBe('⌘⌥O');
    expect(formatShortcut('CmdOrCtrl+Shift+O', true)).toBe('⌘⇧O');
    expect(formatShortcut('Ctrl+`', true)).toBe('⌃`');
    expect(formatShortcut('Shift+Enter', true)).toBe('⇧↩');
  });

  it('editor placeholder names the real shortcuts key (no ⌘/ off macOS)', () => {
    expect(editorPlaceholder(false)).toBe('Start writing…  (Ctrl+Shift+H for shortcuts)');
    expect(editorPlaceholder(true)).toBe('Start writing…  (⌘⇧H for shortcuts)');
    expect(editorPlaceholder(false)).not.toMatch(MAC_GLYPHS);
  });

  it('applyShortcutLabels fills static titles and hints for the platform', () => {
    document.body.innerHTML = `
      <button id="b" title="x" data-shortcut-title="Bold ({action:bold})"></button>
      <button id="t" data-shortcut-title="Terminals ({action:toggle-terminal}) · Terminals only: {action:toggle-terminals-only}"></button>
      <kbd id="k" data-shortcut="action:toggle-terminal">?</kbd>`;
    const q = (id: string) => document.getElementById(id)!;
    applyShortcutLabels(document, false);
    expect(q('b').title).toBe('Bold (Ctrl+B)');
    expect(q('t').title).toBe('Terminals (Ctrl+`) · Terminals only: Ctrl+Shift+`');
    expect(q('k').textContent).toBe('Ctrl+`');
    applyShortcutLabels(document, true);
    expect(q('b').title).toBe('Bold (⌘B)');
    expect(q('k').textContent).toBe('⌃`');
  });

  it('index.html has no hard-coded Mac glyphs outside data-shortcut templates', async () => {
    const html = (await import('../../index.html?raw')).default;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const offenders: string[] = [];
    for (const el of doc.querySelectorAll<HTMLElement>('*')) {
      if (MAC_GLYPHS.test(el.title) && !el.dataset.shortcutTitle) offenders.push(el.outerHTML.slice(0, 80));
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
      if (MAC_GLYPHS.test(own) && !el.dataset.shortcut) offenders.push(el.outerHTML.slice(0, 80));
    }
    expect(offenders).toEqual([]);
    // Every template token is a real binding.
    for (const el of doc.querySelectorAll<HTMLElement>('[data-shortcut-title]')) {
      for (const [, action] of el.dataset.shortcutTitle!.matchAll(/\{([^}]+)\}/g)) {
        expect(shortcutFor(action, false), action).not.toBe('');
      }
    }
    for (const el of doc.querySelectorAll<HTMLElement>('[data-shortcut]')) {
      expect(shortcutFor(el.dataset.shortcut!, false)).not.toBe('');
    }
  });
});

describe('shortcut key matching', () => {
  it('uses e.key for printable ASCII, else the physical key', () => {
    expect(shortcutKey({ key: 'o', code: 'KeyO' })).toBe('o');
    expect(shortcutKey({ key: 'O', code: 'KeyO' })).toBe('o');
    // AltGr (Ctrl+Alt) on US-International / ABNT2 types ó.
    expect(shortcutKey({ key: 'ó', code: 'KeyO' })).toBe('o');
    // Dead backtick (US-International).
    expect(shortcutKey({ key: 'Dead', code: 'Backquote' })).toBe('`');
    // AZERTY keeps its own letters: the key labelled A sits on KeyQ.
    expect(shortcutKey({ key: 'a', code: 'KeyQ' })).toBe('a');
    expect(shortcutKey({ key: 'ArrowRight', code: 'ArrowRight' })).toBe('arrowright');
  });

  it('recognises the terminal-toggle key on any layout', () => {
    expect(isBacktickKey({ key: '`', code: 'Backquote' })).toBe(true);
    expect(isBacktickKey({ key: 'Dead', code: 'Backquote' })).toBe(true);
    expect(isBacktickKey({ key: '~', code: 'Backquote' })).toBe(true);
    expect(isBacktickKey({ key: 'o', code: 'KeyO' })).toBe(false);
  });

  it('Ctrl+Alt+O opens the folder dialog on Windows, also when AltGr types ó', () => {
    setPlatform('Win32');
    const { spy } = manager();
    const folder = spy(ACTIONS.OPEN_FOLDER);
    const file = spy(ACTIONS.OPEN_FILE);
    press({ key: 'o', code: 'KeyO', ctrlKey: true, altKey: true });
    press({ key: 'ó', code: 'KeyO', ctrlKey: true, altKey: true });
    expect(folder).toHaveBeenCalledTimes(2);
    expect(file).not.toHaveBeenCalled();
  });

  it('Ctrl+O / Ctrl+Shift+O map to Open File / Open Remote on Linux', () => {
    setPlatform('Linux x86_64');
    const { spy } = manager();
    const file = spy(ACTIONS.OPEN_FILE);
    const remote = spy(ACTIONS.OPEN_REMOTE);
    press({ key: 'o', code: 'KeyO', ctrlKey: true });
    press({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true });
    expect(file).toHaveBeenCalledTimes(1);
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+` toggles the terminal with a dead-key backtick; Ctrl+Shift+` (~) is terminals-only', () => {
    setPlatform('Win32');
    const { spy } = manager();
    const term = spy(ACTIONS.TOGGLE_TERMINAL);
    const only = spy(ACTIONS.TOGGLE_TERMINALS_ONLY);
    press({ key: 'Dead', code: 'Backquote', ctrlKey: true });
    expect(term).toHaveBeenCalledTimes(1);
    press({ key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true });
    expect(only).toHaveBeenCalledTimes(1);
    expect(term).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+digit switches views by physical key', () => {
    setPlatform('Win32');
    const { spy } = manager();
    const view = spy(ACTIONS.SET_VIEW_MODE);
    press({ key: '3', code: 'Digit3', ctrlKey: true });
    expect(view).toHaveBeenCalledWith({ mode: 'preview' });
  });

  it('a focused terminal hands Ctrl+` (and Ctrl+Shift+`) to the app on Windows/Linux only', () => {
    const k = (init: Partial<KeyboardEvent>) => ({
      key: '`', code: 'Backquote', metaKey: false, ctrlKey: false, altKey: false, ...init,
    });
    expect(terminalPassesToApp(k({ ctrlKey: true }), false)).toBe(true);
    expect(terminalPassesToApp(k({ ctrlKey: true, key: 'Dead' }), false)).toBe(true);
    expect(terminalPassesToApp(k({ ctrlKey: true, key: '~' }), false)).toBe(true);
    // macOS: the native menu owns it.
    expect(terminalPassesToApp(k({ ctrlKey: true }), true)).toBe(false);
    // Plain ` and other Ctrl keys stay with the shell.
    expect(terminalPassesToApp(k({}), false)).toBe(false);
    expect(terminalPassesToApp(k({ ctrlKey: true, key: 'c', code: 'KeyC' }), false)).toBe(false);
    expect(terminalPassesToApp(k({ ctrlKey: true, altKey: true }), false)).toBe(false);
  });
});
