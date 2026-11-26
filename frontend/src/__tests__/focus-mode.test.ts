// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../events';
import { EVENTS } from '../event-names';
import { FocusMode, FOCUS_MODE_CLASS } from '../focus-mode';

function mount(): void {
  document.documentElement.className = '';
  document.body.innerHTML = `
    <div id="toolbar"><div class="tab-strip"></div></div>
    <div id="main-content">
      <nav id="activity-bar"><button id="act-files">Files</button></nav>
      <nav id="sidebar" style="--sidebar-width: 260px"><input id="sidebar-search-input" /></nav>
      <div id="sidebar-resize-handle"></div>
      <div id="center-column">
        <div id="workspace"><div id="editor-area">
          <div id="editor-container" style="width: 420px; flex: none"><div class="cm-content" tabindex="0"></div></div>
          <div id="resize-handle"></div>
          <div id="preview-container"></div>
        </div></div>
        <div id="terminal-resize-handle"></div>
        <div id="terminal-panel"><textarea id="term-input"></textarea></div>
      </div>
    </div>
    <div id="status-bar"></div>`;
}

/** Everything focus mode must leave exactly as it found it. */
function layout(): string {
  const ids = ['sidebar', 'center-column', 'editor-container', 'preview-container', 'resize-handle', 'terminal-panel', 'terminal-resize-handle'];
  return ids.map((id) => {
    const el = document.getElementById(id)!;
    return `${id}|${el.className}|${el.getAttribute('style') ?? ''}|${el.hidden}`;
  }).join('\n');
}

function setup() {
  mount();
  const bus = new EventBus();
  const changes: boolean[] = [];
  bus.on(EVENTS.FOCUS_MODE_CHANGED, ({ active }) => changes.push(active));
  const focusContent = vi.fn(() => (document.querySelector('.cm-content') as HTMLElement).focus());
  const fm = new FocusMode({ bus, focusContent });
  fm.init();
  return { fm, changes, focusContent };
}

const isOn = () => document.documentElement.classList.contains(FOCUS_MODE_CLASS);

function escape(target: Element = document.querySelector('.cm-content')!): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe('FocusMode', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('toggles the focus-mode class and reports each change', () => {
    const { fm, changes } = setup();
    fm.toggle();
    expect(isOn()).toBe(true);
    expect(fm.isActive()).toBe(true);
    fm.toggle();
    expect(isOn()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('restores the exact layout: split width, sidebar and terminal state are untouched', () => {
    const { fm } = setup();
    document.getElementById('terminal-panel')!.classList.add('hidden');
    document.getElementById('sidebar')!.classList.add('hidden');
    const before = layout();
    fm.enter();
    expect(layout()).toBe(before);
    fm.exit();
    expect(layout()).toBe(before);
  });

  it('Escape leaves focus mode', () => {
    const { fm } = setup();
    fm.enter();
    const e = escape();
    expect(isOn()).toBe(false);
    expect(e.defaultPrevented).toBe(true);
  });

  it('Escape does nothing outside focus mode', () => {
    setup();
    const e = escape();
    expect(e.defaultPrevented).toBe(false);
  });

  it('Escape already used by the editor (find panel, selection) stays there', () => {
    const { fm } = setup();
    fm.enter();
    const cm = document.querySelector('.cm-content')!;
    cm.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    escape(cm);
    expect(isOn()).toBe(true);
  });

  it('Escape closes an open dialog or context menu first, not focus mode', () => {
    const { fm } = setup();
    fm.enter();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    escape();
    expect(isOn()).toBe(true);
    dialog.remove();

    // The context menu removes itself in a capture listener on the same key.
    const menu = document.createElement('div');
    menu.className = 'sd-ctxmenu';
    document.body.appendChild(menu);
    const close = () => menu.remove();
    document.addEventListener('keydown', close, true);
    escape();
    document.removeEventListener('keydown', close, true);
    expect(isOn()).toBe(true);
    escape();
    expect(isOn()).toBe(false);
  });

  it('Escape with a modifier or inside a text field does not leave', () => {
    const { fm } = setup();
    fm.enter();
    document.querySelector('.cm-content')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true, bubbles: true, cancelable: true }),
    );
    const field = document.createElement('input');
    document.getElementById('editor-container')!.appendChild(field);
    escape(field);
    expect(isOn()).toBe(true);
  });

  it('moves focus out of hidden chrome on enter', () => {
    const { fm, focusContent } = setup();
    (document.getElementById('sidebar-search-input') as HTMLElement).focus();
    fm.enter();
    expect(focusContent).toHaveBeenCalledOnce();
    expect(isOn()).toBe(true);
    expect(document.activeElement?.classList.contains('cm-content')).toBe(true);
  });

  it('keeps focus where it is when it is already on the document', () => {
    const { fm, focusContent } = setup();
    (document.querySelector('.cm-content') as HTMLElement).focus();
    fm.enter();
    expect(focusContent).not.toHaveBeenCalled();
  });

  it('leaves when keyboard focus moves into hidden chrome', () => {
    const { fm } = setup();
    fm.enter();
    (document.getElementById('term-input') as HTMLElement).focus();
    expect(isOn()).toBe(false);
  });

  it('in the terminals-only layout the terminals stay part of the content', () => {
    const { fm, focusContent } = setup();
    document.getElementById('center-column')!.classList.add('terminals-only');
    (document.getElementById('term-input') as HTMLElement).focus();
    fm.enter();
    expect(focusContent).not.toHaveBeenCalled();
    (document.querySelector('.cm-content') as HTMLElement).focus();
    (document.getElementById('term-input') as HTMLElement).focus();
    expect(isOn()).toBe(true);
    (document.getElementById('sidebar-search-input') as HTMLElement).focus();
    expect(isOn()).toBe(false);
  });

  it('exit() reports whether focus mode was on', () => {
    const { fm, changes } = setup();
    expect(fm.exit()).toBe(false);
    fm.enter();
    fm.enter();
    expect(fm.exit()).toBe(true);
    expect(changes).toEqual([true, false]);
  });
});
