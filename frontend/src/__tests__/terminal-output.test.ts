// @vitest-environment jsdom
import './helpers/dom-shims';
import { describe, it, expect, vi } from 'vitest';
import { loadWebglRenderer, ptyBytes, webgl2Supported } from '../terminal-output';

describe('ptyBytes', () => {
  it('passes ArrayBuffer and Uint8Array through without copying', () => {
    const u = new Uint8Array([1, 2, 3]);
    expect(ptyBytes(u)).toBe(u);
    const buf = new Uint8Array([0xe2, 0x9d, 0xaf]).buffer;
    const out = ptyBytes(buf);
    expect(out.buffer).toBe(buf);
    expect(Array.from(out)).toEqual([0xe2, 0x9d, 0xaf]);
  });

  it('accepts a plain number array', () => {
    expect(Array.from(ptyBytes([104, 105]))).toEqual([104, 105]);
  });
});

describe('webgl2Supported', () => {
  it('uses the injected probe', () => {
    expect(webgl2Supported(() => true)).toBe(true);
    expect(webgl2Supported(() => false)).toBe(false);
  });

  it('jsdom reports no WebGL2', () => {
    expect(webgl2Supported()).toBe(false);
  });
});

function fakeAddon() {
  let lost: (() => void) | null = null;
  return {
    activate: vi.fn(),
    dispose: vi.fn(),
    onContextLoss: vi.fn((l: () => void) => {
      lost = l;
      return { dispose() {} };
    }),
    loseContext: () => lost?.(),
  };
}

describe('loadWebglRenderer', () => {
  it('loads the WebGL addon when WebGL2 is available and it starts', () => {
    const addon = fakeAddon();
    const term = { loadAddon: vi.fn() };
    const fallback = vi.fn();
    expect(loadWebglRenderer(term, fallback, () => addon, () => true)).toBe('webgl');
    expect(term.loadAddon).toHaveBeenCalledWith(addon);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('keeps the DOM renderer when WebGL2 is unavailable (never constructs addon)', () => {
    const make = vi.fn(() => fakeAddon());
    const term = { loadAddon: vi.fn() };
    const fallback = vi.fn();
    expect(loadWebglRenderer(term, fallback, make, () => false)).toBe('dom');
    expect(make).not.toHaveBeenCalled();
    expect(term.loadAddon).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith('webgl2 unavailable');
  });

  it('keeps the DOM renderer when activate throws', () => {
    const addon = fakeAddon();
    const term = {
      loadAddon: vi.fn(() => {
        throw new Error('WebGL2 not supported');
      }),
    };
    const fallback = vi.fn();
    expect(loadWebglRenderer(term, fallback, () => addon, () => true)).toBe('dom');
    expect(addon.dispose).toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith(expect.stringContaining('WebGL2 not supported'));
  });

  it('keeps the DOM renderer when the addon cannot be constructed', () => {
    const term = { loadAddon: vi.fn() };
    const fallback = vi.fn();
    const r = loadWebglRenderer(
      term,
      fallback,
      () => {
        throw new Error('boom');
      },
      () => true,
    );
    expect(r).toBe('dom');
    expect(term.loadAddon).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('falls back to the DOM renderer when the GL context is lost', () => {
    const addon = fakeAddon();
    const fallback = vi.fn();
    loadWebglRenderer({ loadAddon: vi.fn() }, fallback, () => addon, () => true);
    addon.loseContext();
    expect(addon.dispose).toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith('webgl context lost');
  });

  it('jsdom (no WebGL2) ends on the DOM renderer with the real addon path', async () => {
    const { Terminal } = await import('@xterm/xterm');
    const term = new Terminal();
    term.open(document.createElement('div'));
    const fallback = vi.fn();
    // Default probe + make: must not throw, must not leave a half-loaded addon.
    expect(loadWebglRenderer(term, fallback)).toBe('dom');
    expect(fallback).toHaveBeenCalledWith('webgl2 unavailable');
    term.dispose();
  });
});
