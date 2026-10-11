// @vitest-environment jsdom
/**
 * macOS Option changes the typed character: ⌥Z is "Ω" on a US layout. The
 * Toggle Word Wrap key (⌥Z) and other Option shortcuts must match the
 * physical/unmodified key, never e.key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ShortcutManager, isWrapMenuEcho, shortcutKey } from '../shortcuts';
import { EventBus } from '../events';
import { ACTIONS } from '../event-names';

function setPlatform(p: string): void {
  Object.defineProperty(navigator, 'platform', { value: p, configurable: true });
}

describe('macOS Option shortcuts match by key code', () => {
  const fired: string[] = [];
  beforeAll(() => {
    setPlatform('MacIntel');
    const bus = new EventBus();
    for (const action of Object.values(ACTIONS)) bus.on(action, () => fired.push(action));
    new ShortcutManager(bus).init();
  });
  afterAll(() => setPlatform(''));

  const press = (init: KeyboardEventInit) => {
    fired.length = 0;
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    document.dispatchEvent(ev);
    return { fired: [...fired], prevented: ev.defaultPrevented };
  };

  it("⌥Z (key 'Ω', code 'KeyZ') toggles word wrap and does not type Ω", () => {
    const r = press({ key: 'Ω', code: 'KeyZ', altKey: true });
    expect(r.fired).toEqual([ACTIONS.TOGGLE_WRAP]);
    expect(r.prevented).toBe(true);
  });

  it('the native menu echo of the same press is dropped, a later menu click is not', () => {
    press({ key: 'Ω', code: 'KeyZ', altKey: true });
    expect(isWrapMenuEcho()).toBe(true);
    expect(isWrapMenuEcho(Date.now() + 1000)).toBe(false);
  });

  it('other Option/Z combinations are not wrap', () => {
    expect(press({ key: '¸', code: 'KeyZ', altKey: true, shiftKey: true }).fired).toEqual([]);
    expect(press({ key: 'z', code: 'KeyZ', metaKey: true }).fired).toEqual([]);
    expect(press({ key: 'Ω', code: 'KeyZ', altKey: true, metaKey: true }).fired).toEqual([]);
    // ⌥ plus another key that happens to type z-like text is not Z.
    expect(press({ key: 'z', code: 'KeyX', altKey: true }).fired).toEqual([]);
  });

  it('shortcutKey ignores the Option character on macOS', () => {
    expect(shortcutKey({ key: 'Ω', code: 'KeyZ', altKey: true })).toBe('z');
    // German: ⌥L types "@" (ASCII), still the L key.
    expect(shortcutKey({ key: '@', code: 'KeyL', altKey: true })).toBe('l');
    // ⌥G is "©"; ⌥5 is "∞"; ⌥E is a dead key.
    expect(shortcutKey({ key: '©', code: 'KeyG', altKey: true })).toBe('g');
    expect(shortcutKey({ key: '∞', code: 'Digit5', altKey: true })).toBe('5');
    expect(shortcutKey({ key: 'Dead', code: 'KeyE', altKey: true })).toBe('e');
    // AZERTY: the key labelled Z sits at code KeyW; WebKit's keyCode is 90 (Z).
    expect(shortcutKey({ key: 'Â', code: 'KeyW', altKey: true, keyCode: 90 })).toBe('z');
    // Without Option, layouts keep their letters (AZERTY "a" at KeyQ).
    expect(shortcutKey({ key: 'a', code: 'KeyQ' })).toBe('a');
  });
});

describe('Windows/Linux are unchanged', () => {
  it('Alt with an ASCII character keeps e.key (no Option remapping)', () => {
    setPlatform('Linux x86_64');
    expect(shortcutKey({ key: 'a', code: 'KeyQ', altKey: true })).toBe('a');
    expect(shortcutKey({ key: 'ó', code: 'KeyO', altKey: true })).toBe('o');
  });
});
