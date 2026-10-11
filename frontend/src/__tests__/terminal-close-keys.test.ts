// @vitest-environment jsdom
/**
 * #42: on Windows/Linux, plain Ctrl+W in a focused terminal belongs to the
 * shell (readline delete-word); Ctrl+Shift+W closes the pane. macOS keeps
 * ⌘W (File → Close Tab, routed to a focused pane). The shortcuts dialog
 * says so.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { terminalPassesToApp, terminalPaneAction } from '../shortcuts';
import { showShortcutsDialog } from '../shortcuts-dialog';

function setPlatform(p: string): void {
  Object.defineProperty(navigator, 'platform', { value: p, configurable: true });
}

const key = (mods: Partial<KeyboardEvent>, k = 'w') => ({
  type: 'keydown',
  key: k,
  code: 'KeyW',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

function rows(): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of document.querySelectorAll('.shortcut-row')) {
    m.set(r.querySelector('.shortcut-desc')!.textContent!, r.querySelector('kbd')!.textContent!);
  }
  return m;
}

describe('terminal close keys (#42)', () => {
  afterEach(() => {
    // showShortcutsDialog toggles: a second call closes it.
    if (document.querySelector('.shortcuts-overlay')) showShortcutsDialog();
    document.body.innerHTML = '';
  });

  it('Windows/Linux: Ctrl+W and Super+W stay with the shell; Ctrl+Shift+W closes the pane', () => {
    expect(terminalPassesToApp(key({ ctrlKey: true }), false)).toBe(false);
    expect(terminalPassesToApp(key({ metaKey: true }), false)).toBe(false);
    expect(terminalPaneAction(key({ ctrlKey: true }), false)).toBeNull();
    expect(terminalPaneAction(key({ ctrlKey: true, shiftKey: true }, 'W'), false)).toBe('close-pane');
  });

  it('macOS: ⌘W is left to the native Close Tab accelerator (which closes a focused pane)', () => {
    expect(terminalPassesToApp(key({ metaKey: true }), true)).toBe(false);
    expect(terminalPaneAction(key({ metaKey: true }), true)).toBeNull();
  });

  it('shortcuts dialog on Linux: Close Tab Ctrl+W, Close Pane Ctrl+Shift+W, Ctrl+W deletes a word in the shell', () => {
    setPlatform('Linux x86_64');
    showShortcutsDialog();
    const r = rows();
    expect(r.get('Close Tab')).toBe('Ctrl+W');
    expect(r.get('Close Pane (asks if a program is running)')).toBe('Ctrl+Shift+W');
    expect(r.get('Delete Word (in the shell)')).toBe('Ctrl+W');
  });

  it('shortcuts dialog on macOS: Close Pane is ⌘W and there is no Delete Word row', () => {
    setPlatform('MacIntel');
    showShortcutsDialog();
    const r = rows();
    expect(r.get('Close Pane (asks if a program is running)')).toMatch(/⌘W|Cmd\+W/);
    expect(r.has('Delete Word (in the shell)')).toBe(false);
  });
});
