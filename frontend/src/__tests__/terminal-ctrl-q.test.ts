// @vitest-environment jsdom
/**
 * Ctrl+Q always quits on Windows/Linux, even from a focused terminal (as in
 * VS Code): the terminal key handler hands it to the app keymap, which runs
 * the one quit flow. macOS ⌘Q stays with the native Quit menu item.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ShortcutManager, terminalPassesToApp } from '../shortcuts';
import { EventBus } from '../events';
import { ACTIONS } from '../event-names';

const key = (mods: Partial<KeyboardEvent>, k = 'q') => ({
  type: 'keydown',
  key: k,
  code: 'KeyQ',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('Ctrl+Q from a focused terminal', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
  });

  it('Windows/Linux: plain Ctrl+Q leaves xterm for the app; other Q chords stay', () => {
    expect(terminalPassesToApp(key({ ctrlKey: true }), false)).toBe(true);
    expect(terminalPassesToApp(key({ ctrlKey: true }, 'Q'), false)).toBe(true);
    expect(terminalPassesToApp(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(terminalPassesToApp(key({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(terminalPassesToApp(key({}), false)).toBe(false);
    // Plain Ctrl+letters the shell uses are unchanged.
    for (const k of ['c', 'd', 'w', 'r', 'z', 's']) {
      expect(terminalPassesToApp(key({ ctrlKey: true }, k), false), k).toBe(false);
    }
  });

  it('macOS: ⌘Q is not touched (the native Quit item handles it)', () => {
    expect(terminalPassesToApp(key({ metaKey: true }), true)).toBe(false);
    expect(terminalPassesToApp(key({ ctrlKey: true }), true)).toBe(false);
  });

  it('the Ctrl+Q keydown from inside the terminal reaches the one quit action', () => {
    // One manager (its document listener can't be removed); the platform
    // is read per key press.
    const bus = new EventBus();
    const quit = vi.fn();
    bus.on(ACTIONS.QUIT, quit);
    new ShortcutManager(bus).init();
    for (const platform of ['Win32', 'Linux x86_64']) {
      Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
      quit.mockClear();
      document.body.innerHTML = '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>';
      const ta = document.querySelector('textarea')!;
      ta.focus();
      const ev = new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', ctrlKey: true, bubbles: true, cancelable: true });
      ta.dispatchEvent(ev);
      expect(quit, platform).toHaveBeenCalledTimes(1);
      expect(ev.defaultPrevented).toBe(true);
    }
  });
});
