// @vitest-environment jsdom
import './helpers/dom-shims';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OffscreenOutput, watchInView } from '../terminal-offscreen';

const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (s: string) => enc.encode(s);

/** A fake xterm: records writes, parses when `parse()` is called. */
function fakeTerm() {
  const writes: string[] = [];
  const pending: (() => void)[] = [];
  return {
    writes,
    text: () => writes.join(''),
    write: (bytes: Uint8Array, done: () => void) => {
      writes.push(dec.decode(bytes));
      pending.push(done);
    },
    parse: () => pending.splice(0).forEach((d) => d()),
  };
}

describe('OffscreenOutput', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes straight through while the pane is in view, acking after parse', () => {
    const t = fakeTerm();
    const ack = vi.fn();
    const out = new OffscreenOutput(t.write, ack);
    out.push(b('one\r\n'));
    out.push(b('two\r\n'));
    expect(t.writes).toEqual(['one\r\n', 'two\r\n']);
    expect(ack).not.toHaveBeenCalled();
    t.parse();
    expect(ack.mock.calls).toEqual([[5], [5]]);
  });

  it('holds output while out of view and shows all of it, in order, on show', () => {
    const t = fakeTerm();
    const ack = vi.fn();
    const out = new OffscreenOutput(t.write, ack);
    out.push(b('before '));
    out.setVisible(false);
    out.push(b('a'));
    out.push(b('b'));
    out.push(b('c'));
    expect(t.writes).toEqual(['before ']);
    expect(out.pendingBytes).toBe(3);
    out.setVisible(true);
    out.push(b(' after'));
    expect(t.text()).toBe('before abc after');
    expect(t.writes).toEqual(['before ', 'abc', ' after']);
    t.parse();
    expect(ack.mock.calls.reduce((n, [k]) => n + k, 0)).toBe('before abc after'.length);
  });

  it('writes held output after the delay even if the pane stays out of view', () => {
    const t = fakeTerm();
    const out = new OffscreenOutput(t.write, () => {}, 1024, 250);
    out.setVisible(false);
    out.push(b('\x07bell'));
    vi.advanceTimersByTime(249);
    expect(t.writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.writes).toEqual(['\x07bell']);
    expect(out.pendingBytes).toBe(0);
  });

  it('writes as soon as the size limit is held, so the backend keeps sending', () => {
    const t = fakeTerm();
    const ack = vi.fn();
    const out = new OffscreenOutput(t.write, ack, 8, 250);
    out.setVisible(false);
    out.push(b('1234'));
    out.push(b('5678'));
    expect(t.writes).toEqual(['12345678']);
    out.push(b('9'));
    expect(out.pendingBytes).toBe(1);
    t.parse();
    expect(ack).toHaveBeenCalledWith(8);
    vi.advanceTimersByTime(250);
    expect(t.text()).toBe('123456789');
  });

  it('keeps multi-byte characters whole across held batches', () => {
    const t = fakeTerm();
    const out = new OffscreenOutput(t.write, () => {});
    out.setVisible(false);
    const bytes = b('❯ são');
    out.push(bytes.slice(0, 2));
    out.push(bytes.slice(2));
    out.setVisible(true);
    expect(t.text()).toBe('❯ são');
  });

  it('dispose stops the timer and writes nothing more', () => {
    const t = fakeTerm();
    const out = new OffscreenOutput(t.write, () => {});
    out.setVisible(false);
    out.push(b('x'));
    out.dispose();
    vi.advanceTimersByTime(1000);
    expect(t.writes).toEqual([]);
  });
});

describe('watchInView', () => {
  let observers: { cb: IntersectionObserverCallback; el: Element | null; disconnected: boolean }[];
  let origIO: typeof IntersectionObserver;
  let state: DocumentVisibilityState;

  beforeEach(() => {
    observers = [];
    origIO = window.IntersectionObserver;
    window.IntersectionObserver = class {
      rec: (typeof observers)[number];
      constructor(cb: IntersectionObserverCallback) {
        this.rec = { cb, el: null, disconnected: false };
        observers.push(this.rec);
      }
      observe(el: Element) {
        this.rec.el = el;
      }
      disconnect() {
        this.rec.disconnected = true;
      }
      unobserve() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
    state = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  });
  afterEach(() => {
    window.IntersectionObserver = origIO;
  });

  const intersect = (on: boolean) =>
    observers[0].cb([{ isIntersecting: on, intersectionRatio: on ? 1 : 0 } as IntersectionObserverEntry], {} as IntersectionObserver);

  it('reports out of view for a hidden container and for a hidden window', () => {
    const el = document.createElement('div');
    const seen: boolean[] = [];
    const stop = watchInView(el, (v) => seen.push(v));
    expect(observers[0].el).toBe(el);
    intersect(false);
    intersect(true);
    state = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toEqual([false, true, false, true]);
    stop();
    expect(observers[0].disconnected).toBe(true);
    state = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toEqual([false, true, false, true]);
  });

  it('starts out of view when the window is already hidden', () => {
    state = 'hidden';
    const seen: boolean[] = [];
    watchInView(document.createElement('div'), (v) => seen.push(v));
    expect(seen).toEqual([false]);
  });
});
