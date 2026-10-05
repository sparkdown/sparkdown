// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { focusableIn, resetModalStateForTests, trapFocus } from '../modal';

function makeDialog(html: string): HTMLElement {
  const overlay = document.createElement('div');
  const dialog = document.createElement('div');
  dialog.tabIndex = -1;
  dialog.innerHTML = html;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  return dialog;
}

const tab = (shiftKey = false) => {
  const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(ev);
  return ev;
};

describe('trapFocus', () => {
  beforeEach(() => {
    resetModalStateForTests();
    document.body.innerHTML = '<div id="app"><textarea id="ed"></textarea></div>';
    (document.getElementById('ed') as HTMLTextAreaElement).focus();
  });

  it('skips disabled, hidden and negative-tabindex elements', () => {
    const d = makeDialog(
      '<button id="a">a</button><button disabled>x</button><div class="hidden"><input></div>' +
        '<span tabindex="-1">y</span><input id="b">',
    );
    expect(focusableIn(d).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('keeps #app inert until the last nested modal releases, then restores focus', () => {
    const app = document.getElementById('app')!;
    const outer = makeDialog('<button id="o">o</button>');
    const m1 = trapFocus(outer);
    document.getElementById('o')!.focus();
    const inner = makeDialog('<button id="i">i</button>');
    const m2 = trapFocus(inner);
    expect(app.hasAttribute('inert')).toBe(true);
    m2.release();
    expect(app.hasAttribute('inert')).toBe(true);
    expect(document.activeElement?.id).toBe('o');
    m1.release();
    m1.release(); // idempotent
    expect(app.hasAttribute('inert')).toBe(false);
    expect(document.activeElement?.id).toBe('ed');
  });

  it('with no focusable content, Tab keeps focus on the dialog', () => {
    const d = makeDialog('<p>text</p>');
    const m = trapFocus(d);
    d.focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(d);
    m.release();
  });

  it('wraps forward and backward', () => {
    const d = makeDialog('<button id="a">a</button><button id="b">b</button>');
    const m = trapFocus(d);
    document.getElementById('b')!.focus();
    tab();
    expect(document.activeElement?.id).toBe('a');
    tab(true);
    expect(document.activeElement?.id).toBe('b');
    m.release();
  });
});
