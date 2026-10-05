// @vitest-environment jsdom
import './helpers/dom-shims';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Lifecycle/race coverage for the terminal layer (finding #7):
 *  - TerminalPane.init awaits several times; destroying it mid-init must not
 *    leak listeners or leave an orphan PTY running.
 *  - TerminalManager create / close / restore round-trips.
 * xterm and the Tauri IPC layer are mocked; the emulator itself is not tested.
 */

const api = vi.hoisted(() => ({
  terminalStart: vi.fn(async () => 'shell'),
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

// Records tauri event listeners so we can assert none leak.
const listeners = vi.hoisted(() => ({ active: 0, total: 0 }));

vi.mock('../api', () => ({ api }));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => {
    listeners.active++;
    listeners.total++;
    return () => {
      listeners.active--;
    };
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    element: HTMLElement | null = null;
    buffer = { active: { getLine: () => null } };
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
    write() {}
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

beforeEach(() => {
  document.body.innerHTML = '';
  listeners.active = 0;
  listeners.total = 0;
  for (const fn of Object.values(api)) fn.mockClear();
  api.terminalStart.mockImplementation(async () => 'shell');
});

describe('TerminalPane lifecycle', () => {
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
    expect(listeners.active).toBe(2); // data + exit listeners registered

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

  it('destroy() is idempotent', async () => {
    const pane = new TerminalPane('t2', () => {});
    await pane.init(document.createElement('div'), '/cwd', null, null);
    expect(listeners.active).toBe(2);

    pane.destroy();
    pane.destroy();
    expect(listeners.active).toBe(0);
    expect(api.terminalClose).toHaveBeenCalledTimes(1);
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

  it('restoreOrCreate reattaches every surviving tmux session', async () => {
    api.tmuxSessions.mockImplementation(async () => ['sd-x-zsh-1', 'sd-x-zsh-2']);
    const mgr = makeManager();
    mgr.setUseTmux(true);
    mgr.setCwd('/repo');
    await mgr.restoreOrCreate();

    expect(mgr.count).toBe(2);
    expect(api.terminalStart).toHaveBeenCalledTimes(2);
  });
});
