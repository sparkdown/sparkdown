// @vitest-environment jsdom
import './helpers/dom-shims';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Lifecycle/race coverage for the terminal layer (finding #7), updated for
 * per-pane Channel output (no global `terminal://data` listener):
 *  - TerminalPane.init awaits several times; destroying it mid-init must not
 *    leak listeners or leave an orphan PTY running.
 *  - Output is delivered only via the callback passed to terminalStart.
 *  - TerminalManager create / close / restore round-trips.
 * xterm and the Tauri IPC layer are mocked; the emulator itself is not tested.
 */

const api = vi.hoisted(() => ({
  terminalStart: vi.fn(
    async (
      _id: string,
      _cwd: string | null,
      _cols: number,
      _rows: number,
      _session: string | null,
      _launch: string | null,
      _onOutput?: (bytes: Uint8Array) => void,
    ) => 'shell',
  ),
  terminalAck: vi.fn(async (_id: string, _bytes: number) => {}),
  terminalClose: vi.fn(async () => {}),
  terminalWrite: vi.fn(async () => {}),
  terminalResize: vi.fn(async () => {}),
  tmuxSessions: vi.fn(async () => [] as string[]),
  tmuxKillSession: vi.fn(async () => {}),
  tmuxSendKeys: vi.fn(async () => {}),
  detectAgents: vi.fn(async () => [] as unknown[]),
  remoteSession: vi.fn(async () => null),
  shellName: vi.fn(async () => 'bash'),
  mcpShimCommand: vi.fn(async () => null),
  mcpAgentInstalled: vi.fn(async () => false),
  copyText: vi.fn(async () => {}),
}));

/** Named tauri event listeners so we can assert which events are used. */
const listeners = vi.hoisted(() => {
  const byName = new Map<string, number>();
  return {
    byName,
    active: 0,
    total: 0,
    count(name: string) {
      return byName.get(name) ?? 0;
    },
    reset() {
      byName.clear();
      this.active = 0;
      this.total = 0;
    },
  };
});

const terms = vi.hoisted(() => ({
  all: [] as {
    written: (string | Uint8Array)[];
    writeCallbacks: (() => void)[];
  }[],
}));

vi.mock('../api', () => ({ api }));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string) => {
    listeners.active++;
    listeners.total++;
    listeners.byName.set(name, (listeners.byName.get(name) ?? 0) + 1);
    return () => {
      listeners.active--;
      listeners.byName.set(name, Math.max(0, (listeners.byName.get(name) ?? 1) - 1));
    };
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    activate() {}
    dispose() {}
    onContextLoss() {
      return { dispose() {} };
    }
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    element: HTMLElement | null = null;
    buffer = { active: { getLine: () => null } };
    written: (string | Uint8Array)[] = [];
    writeCallbacks: (() => void)[] = [];
    constructor() {
      terms.all.push(this);
    }
    loadAddon() {}
    attachCustomKeyEventHandler() {}
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
    write(data: string | Uint8Array, cb?: () => void) {
      this.written.push(data);
      if (cb) this.writeCallbacks.push(cb);
    }
    focus() {}
    hasSelection() {
      return false;
    }
    getSelection() {
      return '';
    }
    clearSelection() {}
    dispose() {}
  },
}));

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
}

import { TerminalPane, TerminalManager } from '../terminal';

const flush = () => new Promise((r) => setTimeout(r, 0));
const enc = (s: string) => new TextEncoder().encode(s);

function outputOf(id: string): (bytes: Uint8Array) => void {
  const calls = api.terminalStart.mock.calls.filter((c) => c[0] === id);
  const call = calls[calls.length - 1]!;
  const onOutput = call[6];
  if (typeof onOutput !== 'function') {
    throw new Error(`terminalStart for ${id} was not given an onOutput Channel callback`);
  }
  return onOutput;
}

beforeEach(() => {
  document.body.innerHTML = '';
  listeners.reset();
  terms.all = [];
  for (const fn of Object.values(api)) fn.mockClear();
  api.terminalStart.mockImplementation(async () => 'shell');
});

describe('TerminalPane lifecycle (Channel output)', () => {
  it('registers only the exit event; pty bytes arrive via terminalStart callback', async () => {
    const pane = new TerminalPane('t-channel', () => {});
    await pane.init(document.createElement('div'), '/cwd', null, null);

    expect(listeners.count('terminal://exit')).toBe(1);
    expect(listeners.count('terminal://data')).toBe(0);
    expect(listeners.active).toBe(1);

    const onOutput = outputOf('t-channel');
    const term = terms.all[0]!;
    const batch = enc('hello');
    onOutput(batch);
    expect(term.written).toEqual([batch]);
    expect(api.terminalAck).not.toHaveBeenCalled();
    term.writeCallbacks[0]!();
    expect(api.terminalAck).toHaveBeenCalledWith('t-channel', 5);

    pane.destroy();
    expect(listeners.active).toBe(0);
  });

  it('destroyed while the shell is starting: closes the orphan PTY, leaks no listeners', async () => {
    let resolveStart!: (mode: string) => void;
    api.terminalStart.mockImplementation(
      () => new Promise<string>((r) => (resolveStart = r)),
    );

    const pane = new TerminalPane('t1', () => {});
    const container = document.createElement('div');
    const initP = pane.init(container, '/cwd', null, null);

    // Let init progress past its awaits up to the pending terminalStart.
    await flush();
    // Exit listener is registered before terminalStart; data uses the Channel
    // argument, so there is no second listen().
    expect(listeners.active).toBe(1);
    expect(listeners.count('terminal://exit')).toBe(1);
    expect(listeners.count('terminal://data')).toBe(0);

    // Tear down mid-init, then let the shell finish starting.
    pane.destroy();
    resolveStart('shell');
    await initP;

    // The PTY that started after destroy must be closed (not orphaned): once
    // from destroy(), once from the post-start disposed guard.
    expect(api.terminalClose).toHaveBeenCalledWith('t1');
    expect(api.terminalClose.mock.calls.length).toBeGreaterThanOrEqual(1);
    // destroy() drained the listeners it had; none left dangling.
    expect(listeners.active).toBe(0);
  });

  it('destroy() is idempotent and late Channel output is ignored', async () => {
    const pane = new TerminalPane('t2', () => {});
    await pane.init(document.createElement('div'), '/cwd', null, null);
    expect(listeners.active).toBe(1);
    expect(listeners.count('terminal://data')).toBe(0);

    const onOutput = outputOf('t2');
    const term = terms.all[0]!;
    onOutput(enc('before'));
    pane.destroy();
    pane.destroy();
    expect(listeners.active).toBe(0);
    expect(api.terminalClose).toHaveBeenCalledTimes(1);

    api.terminalAck.mockClear();
    term.writeCallbacks[0]!();
    onOutput(enc('after'));
    expect(term.written).toEqual([enc('before')]);
    expect(api.terminalAck).not.toHaveBeenCalled();
  });

  it('preserves UTF-8 split batches through the Channel callback unchanged', async () => {
    const pane = new TerminalPane('t3', () => {});
    await pane.init(document.createElement('div'), '/cwd', null, null);
    const term = terms.all[0]!;
    const a = new Uint8Array([0x61, 0xe2, 0x9d]); // 'a' + start of ❯
    const b = new Uint8Array([0xaf, 0x62]); // rest of ❯ + 'b'
    const onOutput = outputOf('t3');
    onOutput(a);
    onOutput(b);
    expect(term.written).toEqual([a, b]);
    // Same byte identity — no string round-trip that would break mid-sequence.
    expect(term.written[0]).toBe(a);
    expect(term.written[1]).toBe(b);
    pane.destroy();
  });
});

describe('TerminalManager create / close / restore', () => {
  function makeManager() {
    const host = document.createElement('div');
    document.body.append(host);
    const mgr = new TerminalManager(host, () => {});
    return mgr;
  }

  it('restoreOrCreate opens one fresh shell when nothing survived', async () => {
    const mgr = makeManager();
    mgr.setUseTmux(false);
    mgr.setCwd('/repo');
    await mgr.restoreOrCreate();

    expect(mgr.count).toBe(1);
    expect(api.terminalStart).toHaveBeenCalledTimes(1);
    // Manager-created panes also get a Channel callback, not a data listener.
    expect(typeof api.terminalStart.mock.calls[0]![6]).toBe('function');
    expect(listeners.count('terminal://data')).toBe(0);
  });

  it('closing the last terminal fires onEmpty and closes its PTY', async () => {
    const mgr = makeManager();
    const onEmpty = vi.fn();
    mgr.setOnEmpty(onEmpty);
    mgr.setUseTmux(false);
    mgr.setCwd('/repo');
    await mgr.restoreOrCreate();

    const id = mgr.active()!.id;
    mgr.closeTerminal(id);

    expect(mgr.count).toBe(0);
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(api.terminalClose).toHaveBeenCalledWith(id);
  });

  it('restoreOrCreate reattaches every surviving tmux session with per-pane callbacks', async () => {
    api.tmuxSessions.mockImplementation(async () => ['sd-x-zsh-1', 'sd-x-zsh-2']);
    const mgr = makeManager();
    mgr.setUseTmux(true);
    mgr.setCwd('/repo');
    await mgr.restoreOrCreate();

    expect(mgr.count).toBe(2);
    expect(api.terminalStart).toHaveBeenCalledTimes(2);
    for (const call of api.terminalStart.mock.calls) {
      expect(typeof call[6]).toBe('function');
      // session name is arg 4
      expect(typeof call[4]).toBe('string');
    }
    expect(listeners.count('terminal://data')).toBe(0);
  });
});
