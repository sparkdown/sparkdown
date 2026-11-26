// @vitest-environment jsdom
import './helpers/dom-shims';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Clicking anywhere in a terminal pane gives that pane keyboard focus, so the
 * focused outline and the pane that receives keystrokes are always the same.
 */

const api = vi.hoisted(() => ({
  terminalStart: vi.fn(async () => 'shell'),
  terminalClose: vi.fn(async () => {}),
  terminalBusy: vi.fn(async () => null),
  terminalWrite: vi.fn(async () => {}),
  terminalResize: vi.fn(async () => {}),
  terminalAck: vi.fn(async () => {}),
  tmuxSessions: vi.fn(async () => [] as string[]),
  tmuxKillSession: vi.fn(async () => {}),
  detectAgents: vi.fn(async () => []),
  shellName: vi.fn(async () => 'bash'),
  launchShell: vi.fn(async () => 'posix'),
  remoteSession: vi.fn(async () => null),
}));
vi.mock('../api', () => ({ api }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(async () => true) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    onDidChangeResults() {
      return { dispose() {} };
    }
    findNext() {
      return false;
    }
    findPrevious() {
      return false;
    }
    clearDecorations() {}
    dispose() {}
  },
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    element: HTMLElement | null = null;
    textarea: HTMLTextAreaElement | null = null;
    buffer = { active: { type: 'normal', getLine: () => null } };
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    modes = { mouseTrackingMode: 'none' };
    unicode = { activeVersion: '6' };
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    onBell() {
      return { dispose() {} };
    }
    onSelectionChange() {
      return { dispose() {} };
    }
    onTitleChange() {
      return { dispose() {} };
    }
    registerLinkProvider() {
      return { dispose() {} };
    }
    open(container: HTMLElement) {
      // Like xterm: an `.xterm` element holding the hidden input textarea.
      this.element = document.createElement('div');
      this.element.className = 'xterm';
      this.textarea = document.createElement('textarea');
      this.textarea.className = 'xterm-helper-textarea';
      this.element.appendChild(this.textarea);
      container.appendChild(this.element);
    }
    onData() {
      return { dispose() {} };
    }
    write() {}
    refresh() {}
    hasSelection() {
      return false;
    }
    getSelection() {
      return '';
    }
    focus() {
      this.textarea?.focus();
    }
    blur() {
      this.textarea?.blur();
    }
    dispose() {
      this.element?.remove();
    }
  },
}));

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
}

import { TerminalManager } from '../terminal';

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const card = (host: HTMLElement, id: string) =>
  host.querySelector<HTMLElement>(`.terminal-pane[data-term-id="${id}"]`)!;
/** The pane with the focused outline. */
const ring = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>('.terminal-pane.focused')].map((c) => c.dataset.termId);
/** The pane whose terminal input has keyboard focus (where keys go). */
const inputPane = () =>
  (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.terminal-pane')?.dataset.termId ?? null;
const press = (el: Element) => {
  const e = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

async function threePanes() {
  const host = document.createElement('div');
  document.body.append(host);
  const mgr = new TerminalManager(host, () => {});
  mgr.setUseTmux(false);
  mgr.setCwd('/repo');
  await mgr.addTerminal();
  await mgr.splitFocused('row');
  await mgr.splitFocused('row');
  await flush();
  mgr.activate('term-1');
  return { mgr, host };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('TerminalManager click to focus', () => {
  it('a press in a blank part of any of 3 panes moves the outline and the keyboard to it', async () => {
    const { host } = await threePanes();
    expect(ring(host)).toEqual(['term-1']);
    expect(inputPane()).toBe('term-1');

    const spots: Array<[string, (c: HTMLElement) => Element]> = [
      ['term-3', (c) => c.querySelector('.terminal-pane-body')!], // padding around the terminal
      ['term-2', (c) => c.querySelector('.terminal-pane-host')!], // below the last row
      ['term-1', (c) => c.querySelector('.terminal-pane-header')!], // header, not a button
      ['term-2', (c) => c.querySelector('.terminal-pane-cwd')!],
    ];
    for (const [id, pick] of spots) {
      const e = press(pick(card(host, id)));
      expect(ring(host)).toEqual([id]);
      expect(inputPane()).toBe(id);
      // The press must not also blur the terminal input afterwards.
      expect(e.defaultPrevented).toBe(true);
    }
  });

  it('leaves a press inside the terminal to xterm, and header buttons alone', async () => {
    const { host } = await threePanes();
    const e = press(card(host, 'term-2').querySelector('.xterm')!);
    expect(ring(host)).toEqual(['term-2']);
    // xterm handles its own presses (selection, mouse reporting).
    expect(e.defaultPrevented).toBe(false);

    const b = press(card(host, 'term-3').querySelector('[data-act="close"]')!);
    expect(b.defaultPrevented).toBe(false);
  });
});
