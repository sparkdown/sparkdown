// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventBus } from '../events';
import { ACTIONS } from '../event-names';
import { ShortcutManager, tabSwitchLabel, tabSwitchStep, terminalPaneAction, terminalPassesToApp } from '../shortcuts';

function press(init: KeyboardEventInit): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
}

describe('ShortcutManager', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
  });

  it('emits file shortcuts on Windows/Linux (no native menu bar)', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    const bus = new EventBus();
    const save = vi.fn();
    const saveAs = vi.fn();
    const neu = vi.fn();
    bus.on(ACTIONS.SAVE, save);
    bus.on(ACTIONS.SAVE_AS, saveAs);
    bus.on(ACTIONS.NEW_FILE, neu);
    new ShortcutManager(bus).init();

    press({ key: 's', ctrlKey: true });
    press({ key: 's', ctrlKey: true, shiftKey: true });
    press({ key: 'n', ctrlKey: true });

    expect(save).toHaveBeenCalledTimes(1);
    expect(saveAs).toHaveBeenCalledTimes(1);
    expect(neu).toHaveBeenCalledTimes(1);
  });

  it('toggles the terminal on Ctrl+`', () => {
    const bus = new EventBus();
    const term = vi.fn();
    bus.on(ACTIONS.TOGGLE_TERMINAL, term);
    new ShortcutManager(bus).init();

    press({ key: '`', ctrlKey: true });
    expect(term).toHaveBeenCalledTimes(1);
  });

  it('does not steal file accelerators on macOS (native menu owns them)', () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    const bus = new EventBus();
    const save = vi.fn();
    bus.on(ACTIONS.SAVE, save);
    new ShortcutManager(bus).init();

    press({ key: 's', metaKey: true });
    expect(save).not.toHaveBeenCalled();
  });

  it('emits OPEN_REMOTE on Ctrl+Shift+O (Win/Linux JS twin of menu accelerator)', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    const bus = new EventBus();
    const remote = vi.fn();
    bus.on(ACTIONS.OPEN_REMOTE, remote);
    new ShortcutManager(bus).init();

    press({ key: 'o', ctrlKey: true, shiftKey: true });
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it('emits OPEN_FOLDER on Ctrl+Alt+O (Win/Linux JS twin of menu accelerator)', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    const bus = new EventBus();
    const folder = vi.fn();
    const file = vi.fn();
    bus.on(ACTIONS.OPEN_FOLDER, folder);
    bus.on(ACTIONS.OPEN_FILE, file);
    new ShortcutManager(bus).init();

    press({ key: 'o', ctrlKey: true, altKey: true });
    expect(folder).toHaveBeenCalledTimes(1);
    expect(file).not.toHaveBeenCalled();
  });

  it('Ctrl+1–4 pick the document view on Windows/Linux (JS twin of View menu)', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    const bus = new EventBus();
    const modes: string[] = [];
    bus.on(ACTIONS.SET_VIEW_MODE, ({ mode }) => modes.push(mode));
    new ShortcutManager(bus).init();

    for (const key of ['1', '2', '3', '4', '5']) press({ key, ctrlKey: true });
    press({ key: '1', ctrlKey: true, shiftKey: true }); // not the view keys
    press({ key: '2' }); // no modifier
    expect(modes).toEqual(['edit', 'split', 'preview', 'diff']);
  });

  it('frees Ctrl+Shift+P / Ctrl+Shift+E (the old preview / editor toggles)', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    const bus = new EventBus();
    const toggles = vi.fn();
    bus.on(ACTIONS.TOGGLE_PREVIEW, toggles);
    bus.on(ACTIONS.TOGGLE_EDITOR, toggles);
    new ShortcutManager(bus).init();

    press({ key: 'p', ctrlKey: true, shiftKey: true });
    press({ key: 'e', ctrlKey: true, shiftKey: true });
    expect(toggles).not.toHaveBeenCalled();
  });

  it('leaves the view keys to the native menu on macOS', () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    const bus = new EventBus();
    const set = vi.fn();
    bus.on(ACTIONS.SET_VIEW_MODE, set);
    new ShortcutManager(bus).init();

    press({ key: '2', metaKey: true });
    expect(set).not.toHaveBeenCalled();
  });

  it('still handles formatting shortcuts on macOS', () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    const bus = new EventBus();
    const bold = vi.fn();
    bus.on(ACTIONS.BOLD, bold);
    new ShortcutManager(bus).init();

    press({ key: 'b', metaKey: true });
    expect(bold).toHaveBeenCalledTimes(1);
  });

  it('does not treat Ctrl as the formatting modifier on macOS', () => {
    // On macOS Ctrl+B / Ctrl+I are editor cursor motions, not bold/italic.
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    const bus = new EventBus();
    const bold = vi.fn();
    const italic = vi.fn();
    bus.on(ACTIONS.BOLD, bold);
    bus.on(ACTIONS.ITALIC, italic);
    new ShortcutManager(bus).init();

    press({ key: 'b', ctrlKey: true });
    press({ key: 'i', ctrlKey: true });
    expect(bold).not.toHaveBeenCalled();
    expect(italic).not.toHaveBeenCalled();
  });

  it('skips a formatting shortcut the editor already handled (defaultPrevented)', () => {
    // The editor's CodeMirror keymap handles Cmd/Ctrl+B first and calls
    // preventDefault; the global handler must not fire it a second time.
    const bus = new EventBus();
    const bold = vi.fn();
    bus.on(ACTIONS.BOLD, bold);
    new ShortcutManager(bus).init();

    const ev = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true });
    ev.preventDefault(); // simulate CodeMirror having handled it
    document.dispatchEvent(ev);
    expect(bold).not.toHaveBeenCalled();
  });
});

describe('terminalPaneAction (keys inside a focused terminal pane)', () => {
  const ev = (init: Partial<KeyboardEvent>) =>
    ({
      type: 'keydown',
      key: '',
      code: '',
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...init,
    }) as KeyboardEvent;

  it('macOS: ⌘D / ⌘⇧D split, ⌘] / ⌘[ move focus, ⌘W left to the menu', () => {
    expect(terminalPaneAction(ev({ key: 'd', metaKey: true }), true)).toBe('split-right');
    expect(terminalPaneAction(ev({ key: 'D', metaKey: true, shiftKey: true }), true)).toBe(
      'split-down',
    );
    expect(terminalPaneAction(ev({ key: ']', code: 'BracketRight', metaKey: true }), true)).toBe(
      'focus-next',
    );
    expect(terminalPaneAction(ev({ key: '[', code: 'BracketLeft', metaKey: true }), true)).toBe(
      'focus-prev',
    );
    expect(terminalPaneAction(ev({ key: 'w', metaKey: true }), true)).toBeNull();
    // Ctrl+D is EOF for the shell; ⌘⌥D and keyup are not ours.
    expect(terminalPaneAction(ev({ key: 'd', ctrlKey: true }), true)).toBeNull();
    expect(terminalPaneAction(ev({ key: 'd', metaKey: true, altKey: true }), true)).toBeNull();
    expect(terminalPaneAction(ev({ type: 'keyup', key: 'd', metaKey: true }), true)).toBeNull();
  });

  it('Windows/Linux: Ctrl+Shift+D/E/W/]/[; plain Ctrl+D / Ctrl+W stay with the shell', () => {
    const cs = (key: string, code = '') => ev({ key, code, ctrlKey: true, shiftKey: true });
    expect(terminalPaneAction(cs('D'), false)).toBe('split-right');
    expect(terminalPaneAction(cs('E'), false)).toBe('split-down');
    expect(terminalPaneAction(cs('W'), false)).toBe('close-pane');
    expect(terminalPaneAction(cs('}', 'BracketRight'), false)).toBe('focus-next');
    expect(terminalPaneAction(cs('{', 'BracketLeft'), false)).toBe('focus-prev');
    expect(terminalPaneAction(ev({ key: 'd', ctrlKey: true }), false)).toBeNull();
    expect(terminalPaneAction(ev({ key: 'w', ctrlKey: true }), false)).toBeNull();
    expect(terminalPaneAction(ev({ key: 'd', metaKey: true }), false)).toBeNull();
  });
});

describe('next / previous tab keys', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
  });

  /** Fire from `target` (bubbling to the document listener); returns the tab
   *  actions it dispatched. */
  function tabActions(platform: string, init: KeyboardEventInit, target: Element = document.body): string[] {
    Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
    const bus = new EventBus();
    const fired: string[] = [];
    bus.on(ACTIONS.NEXT_TAB, () => fired.push('next'));
    bus.on(ACTIONS.PREV_TAB, () => fired.push('prev'));
    const m = new ShortcutManager(bus);
    m.init();
    // Not cancelable: every earlier test's manager is still listening, and a
    // preventDefault there would make this one bail.
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    return fired;
  }

  for (const platform of ['Win32', 'Linux x86_64', 'MacIntel']) {
    it(`Ctrl+Tab, Ctrl+PageDown and the reverse switch tabs (${platform})`, () => {
      expect(tabActions(platform, { key: 'Tab', ctrlKey: true })).toEqual(['next']);
      document.body.innerHTML = '';
      expect(tabActions(platform, { key: 'Tab', ctrlKey: true, shiftKey: true })).toEqual(['prev']);
      expect(tabActions(platform, { key: 'Unidentified', code: 'Tab', ctrlKey: true, shiftKey: true })).toEqual(['prev']);
      expect(tabActions(platform, { key: 'PageDown', ctrlKey: true })).toEqual(['next']);
      expect(tabActions(platform, { key: 'PageUp', ctrlKey: true })).toEqual(['prev']);
    });
  }

  it('Ctrl+Alt+Right / Left still switch tabs', () => {
    expect(tabActions('Linux x86_64', { key: 'ArrowRight', ctrlKey: true, altKey: true })).toEqual(['next']);
    expect(tabActions('Linux x86_64', { key: 'ArrowLeft', ctrlKey: true, altKey: true })).toEqual(['prev']);
    expect(tabActions('MacIntel', { key: 'ArrowRight', metaKey: true, altKey: true })).toEqual(['next']);
  });

  it('plain Tab, Shift+Tab, PageDown and Cmd+Tab do not switch tabs', () => {
    expect(tabActions('Linux x86_64', { key: 'Tab' })).toEqual([]);
    expect(tabActions('Linux x86_64', { key: 'Tab', shiftKey: true })).toEqual([]);
    expect(tabActions('Linux x86_64', { key: 'PageDown' })).toEqual([]);
    expect(tabActions('Linux x86_64', { key: 'PageDown', ctrlKey: true, shiftKey: true })).toEqual([]);
    expect(tabActions('MacIntel', { key: 'Tab', metaKey: true })).toEqual([]);
  });

  it('a focused terminal pane keeps Ctrl+Tab and Ctrl+PageDown / PageUp', () => {
    const pane = document.createElement('div');
    pane.className = 'xterm';
    const input = document.createElement('textarea');
    pane.appendChild(input);
    document.body.appendChild(pane);
    for (const init of [
      { key: 'Tab', ctrlKey: true },
      { key: 'Tab', ctrlKey: true, shiftKey: true },
      { key: 'PageDown', ctrlKey: true },
      { key: 'PageUp', ctrlKey: true },
    ]) {
      expect(tabActions('Linux x86_64', init, input), JSON.stringify(init)).toEqual([]);
      expect(terminalPassesToApp({ code: '', metaKey: false, altKey: false, shiftKey: false, ...init }, false)).toBe(false);
    }
    // Ctrl+Alt+→ still reaches the app from a terminal (#16).
    expect(tabActions('Linux x86_64', { key: 'ArrowRight', ctrlKey: true, altKey: true }, input)).toEqual(['next']);
  });

  it('tabSwitchStep and the labels', () => {
    expect(tabSwitchStep({ key: 'Tab', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe('next');
    expect(tabSwitchStep({ key: 'Tab', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false })).toBe(null);
    // WebKitGTK: Shift+Tab arrives as key "Unidentified" (ISO_Left_Tab), code "Tab".
    expect(tabSwitchStep({ key: 'Unidentified', code: 'Tab', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe('prev');
    expect(tabSwitchLabel('next', false)).toBe('Ctrl+Tab / Ctrl+PageDown / Ctrl+Alt+→');
    expect(tabSwitchLabel('prev', false)).toBe('Ctrl+Shift+Tab / Ctrl+PageUp / Ctrl+Alt+←');
    expect(tabSwitchLabel('next', true)).toBe('⌃⇥ / ⌃⇟ / ⌘⌥→');
    expect(tabSwitchLabel('prev', true)).toBe('⌃⇧⇥ / ⌃⇞ / ⌘⌥←');
  });
});
