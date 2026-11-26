// @vitest-environment jsdom
import './helpers/dom-shims';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** A terminal pane out of view holds pty output and shows all of it, in order, when shown. */

const api = vi.hoisted(() => ({
  terminalStart: vi.fn(),
  terminalAck: vi.fn(async () => {}),
  terminalClose: vi.fn(async () => {}),
  terminalWrite: vi.fn(async () => {}),
  terminalResize: vi.fn(async () => {}),
}));
const written = vi.hoisted(() => ({ chunks: [] as string[], parse: [] as (() => void)[] }));

vi.mock('../api', () => ({ api }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    element: HTMLElement | null = null;
    buffer = { active: { getLine: () => null } };
    parser = { registerOscHandler: () => false };
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    onBell() {}
    registerLinkProvider() {
      return { dispose() {} };
    }
    open(container: HTMLElement) {
      this.element = document.createElement('div');
      container.appendChild(this.element);
    }
    onData() {
      return { dispose() {} };
    }
    write(data: Uint8Array | string, done?: () => void) {
      written.chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
      if (done) written.parse.push(done);
    }
    focus() {}
    dispose() {}
  },
}));

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
}

let io: IntersectionObserverCallback | null = null;
const origIO = window.IntersectionObserver;

import { TerminalPane } from '../terminal';

beforeEach(() => {
  written.chunks = [];
  written.parse = [];
  io = null;
  window.IntersectionObserver = class {
    constructor(cb: IntersectionObserverCallback) {
      io = cb;
    }
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  window.IntersectionObserver = origIO;
});

const setInView = (on: boolean) =>
  io!([{ isIntersecting: on, intersectionRatio: on ? 1 : 0 } as IntersectionObserverEntry], {} as IntersectionObserver);

describe('TerminalPane out of view', () => {
  it('holds output while hidden, shows it all in order on show, and acks every byte', async () => {
    let emit!: (b: Uint8Array) => void;
    api.terminalStart.mockImplementation(async (...args: unknown[]) => {
      emit = args[6] as (b: Uint8Array) => void;
      return 'shell';
    });
    const pane = new TerminalPane('t1', () => {});
    await pane.init(document.createElement('div'), '/cwd');
    const enc = new TextEncoder();

    emit(enc.encode('$ make\r\n'));
    setInView(false);
    for (let i = 0; i < 50; i++) emit(enc.encode(`line ${i}\r\n`));
    expect(written.chunks).toEqual(['$ make\r\n']);

    setInView(true);
    emit(enc.encode('$ '));
    const want = '$ make\r\n' + Array.from({ length: 50 }, (_, i) => `line ${i}\r\n`).join('') + '$ ';
    expect(written.chunks.join('')).toBe(want);
    expect(written.chunks.length).toBe(3);

    written.parse.splice(0).forEach((d) => d());
    await Promise.resolve();
    const acked = api.terminalAck.mock.calls.reduce((n, c) => n + (c as unknown as [string, number])[1], 0);
    expect(acked).toBe(enc.encode(want).length);
    pane.destroy();
  });
});
