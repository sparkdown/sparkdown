// @vitest-environment jsdom
/**
 * #52: no key may be bound to two different things on one platform. The
 * shortcuts dialog lists every binding (app-wide keys and the keys a focused
 * terminal pane takes), so two rows with the same key are a conflict unless
 * listed below as a deliberate share. Ctrl+Shift+W used to be both Toggle
 * Word Wrap and Close Pane on Windows/Linux; wrap moved to Alt+Z.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { showShortcutsDialog } from '../shortcuts-dialog';
import { KEYBINDINGS, ShortcutManager, formatShortcut } from '../shortcuts';
import { EventBus } from '../events';
import { ACTIONS } from '../event-names';

const PLATFORMS = { macOS: 'MacIntel', Windows: 'Win32', Linux: 'Linux x86_64' } as const;

function setPlatform(p: string): void {
  Object.defineProperty(navigator, 'platform', { value: p, configurable: true });
}

/** Deliberate shares: one key, two rows that are really one gesture. */
const ALLOWED: Record<keyof typeof PLATFORMS, string[][]> = {
  // ⌘W closes the focused pane when a terminal has focus, else the tab.
  macOS: [['Close Pane (asks if a program is running)', 'Close Tab']],
  // Ctrl+W closes the tab from the editor and deletes a word in a shell.
  // Ctrl+Shift+E is Split Down only in a focused terminal (documented in the
  // README as terminal-scoped); elsewhere it shows Files. Kept as before
  // pending a product call; remove the entry if Split Down gets its own key.
  Windows: [
    ['Close Tab', 'Delete Word (in the shell)'],
    ['Files', 'Split Down'],
  ],
  Linux: [
    ['Close Tab', 'Delete Word (in the shell)'],
    ['Files', 'Split Down'],
  ],
};

function dialogRows(): Array<[string, string]> {
  showShortcutsDialog();
  const out: Array<[string, string]> = [];
  for (const r of document.querySelectorAll('.shortcut-row')) {
    out.push([r.querySelector('kbd')!.textContent!, r.querySelector('.shortcut-desc')!.textContent!]);
  }
  showShortcutsDialog(); // toggles closed
  return out;
}

/** Keys bound to more than one row, minus the allowed shares. */
function conflicts(
  rows: Array<[string, string]>,
  allowed: string[][],
): Array<[string, string[]]> {
  const byKey = new Map<string, string[]>();
  for (const [key, desc] of rows) {
    const norm = key.replace(/\s+/g, '').toLowerCase();
    byKey.set(norm, [...(byKey.get(norm) ?? []), desc]);
  }
  const ok = new Set(allowed.map((a) => [...a].sort().join(' | ')));
  return [...byKey.entries()]
    .filter(([, descs]) => descs.length > 1 && !ok.has([...descs].sort().join(' | ')))
    .map(([k, descs]) => [k, descs]);
}

describe('no duplicate key bindings per platform (#52)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  for (const [name, platform] of Object.entries(PLATFORMS) as Array<
    [keyof typeof PLATFORMS, string]
  >) {
    it(`${name}: every shortcut in the dialog is unique`, () => {
      setPlatform(platform);
      const rows = dialogRows();
      expect(rows.length).toBeGreaterThan(20);
      expect(conflicts(rows, ALLOWED[name])).toEqual([]);
    });

    it(`${name}: the allowed shares are still real (stale entries fail)`, () => {
      setPlatform(platform);
      const rows = dialogRows();
      for (const pair of ALLOWED[name]) {
        const keys = pair.map((d) => rows.find(([, desc]) => desc === d)?.[0]);
        expect(keys[0], pair.join(' / ')).toBeDefined();
        expect(keys[0]).toBe(keys[1]);
      }
    });
  }

  it('the check catches a clash (Ctrl+Shift+W as wrap and close pane)', () => {
    const rows: Array<[string, string]> = [
      ['Ctrl+Shift+W', 'Toggle Word Wrap'],
      ['Ctrl+Shift+W', 'Close Pane (asks if a program is running)'],
      ['Ctrl+W', 'Close Tab'],
      ['Ctrl+W', 'Delete Word (in the shell)'],
    ];
    expect(conflicts(rows, ALLOWED.Linux)).toEqual([
      ['ctrl+shift+w', ['Toggle Word Wrap', 'Close Pane (asks if a program is running)']],
    ]);
  });

  it('KEYBINDINGS has no accelerator twice', () => {
    const seen = new Map<string, string>();
    for (const [action, accel] of Object.entries(KEYBINDINGS)) {
      const norm = accel!.toLowerCase();
      expect(seen.get(norm), `${accel}: ${action}`).toBeUndefined();
      seen.set(norm, action);
    }
  });
});

describe('Toggle Word Wrap is Alt+Z (#52)', () => {
  const fired: string[] = [];
  beforeAll(() => {
    const bus = new EventBus();
    for (const action of Object.values(ACTIONS)) bus.on(action, () => fired.push(action));
    new ShortcutManager(bus).init();
  });

  const press = (init: KeyboardEventInit) => {
    fired.length = 0;
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    return [...fired];
  };

  it('labels: Alt+Z on Windows/Linux, ⌥Z on macOS', () => {
    expect(KEYBINDINGS[ACTIONS.TOGGLE_WRAP]).toBe('Alt+Z');
    setPlatform('Linux x86_64');
    expect(formatShortcut('Alt+Z')).toBe('Alt+Z');
    setPlatform('MacIntel');
    expect(formatShortcut('Alt+Z')).toBe('⌥Z');
  });

  it('Windows/Linux: Alt+Z toggles wrap (also by physical key); Ctrl+Shift+W no longer does', () => {
    setPlatform('Linux x86_64');
    expect(press({ key: 'z', code: 'KeyZ', altKey: true })).toEqual([ACTIONS.TOGGLE_WRAP]);
    // A layout where Alt+Z types another character still hits KeyZ.
    expect(press({ key: 'ζ', code: 'KeyZ', altKey: true })).toEqual([ACTIONS.TOGGLE_WRAP]);
    expect(press({ key: 'W', code: 'KeyW', ctrlKey: true, shiftKey: true })).toEqual([]);
    // Other Alt/Ctrl combinations on Z are not wrap (Ctrl+Z is undo).
    expect(press({ key: 'z', code: 'KeyZ', ctrlKey: true })).toEqual([]);
    expect(press({ key: 'Z', code: 'KeyZ', altKey: true, shiftKey: true })).toEqual([]);
    expect(press({ key: 'z', code: 'KeyZ', altKey: true, ctrlKey: true })).toEqual([]);
  });

  it('macOS: the menu owns ⌥Z, so the document handler stays out', () => {
    setPlatform('MacIntel');
    expect(press({ key: 'Ω', code: 'KeyZ', altKey: true })).toEqual([]);
  });
});
