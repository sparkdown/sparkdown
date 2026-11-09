// @vitest-environment jsdom
import './helpers/dom-shims';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * TerminalManager / TerminalPane behaviour: tabs, restore from tmux, exit
 * events, resize, paste/write and agent launch. xterm, the fit addon, the
 * Tauri event bus and the IPC layer are mocked; the mocks record what the
 * code under test asks of them, and let the test fire pty events.
 */

const api = vi.hoisted(() => ({
  terminalStart: vi.fn(
    async (
      _id: string,
      _cwd: string | null,
      _cols: number,
      _rows: number,
      session: string | null,
      _launch: string | null,
    ): Promise<string> => (session ? 'tmux' : 'shell'),
  ),
  terminalClose: vi.fn(async (_id: string) => {}),
  terminalBusy: vi.fn(async (_id: string) => null as string | null),
  terminalWrite: vi.fn(async (_id: string, _data: string) => {}),
  terminalResize: vi.fn(async (_id: string, _cols: number, _rows: number) => {}),
  tmuxSessions: vi.fn(async (_prefix: string) => [] as string[]),
  tmuxKillSession: vi.fn(async (_session: string) => {}),
  tmuxSendKeys: vi.fn(async (_session: string, _text: string) => {}),
  tmuxWheel: vi.fn(async (_session: string, _lines: number) => {}),
  detectAgents: vi.fn(
    async () => [] as { id: string; label: string; bin: string; found: boolean }[],
  ),
  shellName: vi.fn(async () => 'bash'),
  launchShell: vi.fn(async () => 'posix' as 'posix' | 'powershell'),
  mcpShimCommand: vi.fn(
    async () => null as { program: string; args: string[]; configFile?: string } | null,
  ),
  mcpAgentInstalled: vi.fn(async (_bin: string) => false),
  mcpInstallAgent: vi.fn(async (_bin: string) => 'Installed'),
  copyText: vi.fn(async (_text: string) => {}),
  openExternal: vi.fn(async (_url: string) => {}),
  readClipboardText: vi.fn(async () => 'pasted text'),
  remoteSession: vi.fn(
    async () => null as { host: string; path: string; home: string } | null,
  ),
}));

/** Tauri event bus mock: handlers by event name; `emit` fires them. */
const bus = vi.hoisted(() => {
  type H = (e: { payload: unknown }) => void;
  const handlers = new Map<string, Set<H>>();
  return {
    handlers,
    emit(name: string, payload: unknown) {
      for (const h of [...(handlers.get(name) ?? [])]) h({ payload });
    },
    count(name: string) {
      return handlers.get(name)?.size ?? 0;
    },
  };
});

/** Every xterm instance created, to reach its handlers. */
const terms = vi.hoisted(() => ({
  all: [] as {
    cols: number;
    rows: number;
    keyHandler: ((e: KeyboardEvent) => boolean) | null;
    wheelHandler: ((e: WheelEvent) => boolean) | null;
    dataHandler: ((d: string) => void) | null;
    modes: { mouseTrackingMode: string };
    buffer: { active: { type: 'normal' | 'alternate' } };
    selection: string;
    options: Record<string, unknown>;
    linkProviders: { provideLinks(y: number, cb: (links: unknown) => void): void }[];
    rows_: string[];
  }[],
}));

/** Every SearchAddon created: calls made and a hook to fire result events. */
const searches = vi.hoisted(() => ({
  all: [] as {
    calls: Array<[string, string, Record<string, unknown> | undefined]>;
    fire: (index: number, count: number) => void;
  }[],
}));

/** ResizeObserver callbacks, to simulate a container resize. */
const observers = vi.hoisted(() => ({ callbacks: [] as (() => void)[] }));

vi.mock('../api', () => ({ api }));

const dialog = vi.hoisted(() => ({
  ask: vi.fn(async (_msg: string, _opts?: unknown) => true),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: dialog.ask }));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, h: (e: { payload: unknown }) => void) => {
    if (!bus.handlers.has(name)) bus.handlers.set(name, new Set());
    bus.handlers.get(name)!.add(h);
    return () => {
      bus.handlers.get(name)?.delete(h);
    };
  },
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
    private listener: ((r: { resultIndex: number; resultCount: number }) => void) | null = null;
    constructor() {
      searches.all.push(this);
    }
    fire(resultIndex: number, resultCount: number) {
      this.listener?.({ resultIndex, resultCount });
    }
    onDidChangeResults(l: (r: { resultIndex: number; resultCount: number }) => void) {
      this.listener = l;
      return { dispose() {} };
    }
    findNext(term: string, opts?: Record<string, unknown>) {
      this.calls.push(['next', term, opts]);
      return true;
    }
    findPrevious(term: string, opts?: Record<string, unknown>) {
      this.calls.push(['prev', term, opts]);
      return true;
    }
    clearDecorations() {
      this.calls.push(['clear', '', undefined]);
    }
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
    rows_: string[] = [];
    modes = { mouseTrackingMode: 'none' };
    buffer = {
      active: {
        type: 'normal' as 'normal' | 'alternate',
        getLine: (y: number) => {
          const text = this.rows_[y];
          return text === undefined
            ? undefined
            : { isWrapped: false, translateToString: () => text };
        },
      },
    };
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
    wheelHandler: ((e: WheelEvent) => boolean) | null = null;
    dataHandler: ((d: string) => void) | null = null;
    selection = '';
    linkProviders: { provideLinks(y: number, cb: (links: unknown) => void): void }[] = [];
    constructor(opts: Record<string, unknown> = {}) {
      this.options = { ...opts };
      terms.all.push(this);
    }
    loadAddon() {}
    attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) {
      this.keyHandler = h;
    }
    attachCustomWheelEventHandler(h: (e: WheelEvent) => boolean) {
      this.wheelHandler = h;
    }
    registerLinkProvider(p: { provideLinks(y: number, cb: (links: unknown) => void): void }) {
      this.linkProviders.push(p);
      return { dispose() {} };
    }
    open(container: HTMLElement) {
      this.element = document.createElement('div');
      container.appendChild(this.element);
    }
    onData(h: (d: string) => void) {
      this.dataHandler = h;
      return { dispose() {} };
    }
    write() {}
    focus() {}
    hasSelection() {
      return this.selection !== '';
    }
    getSelection() {
      return this.selection;
    }
    clearSelection() {
      this.selection = '';
    }
    dispose() {}
  },
}));

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
}

import {
  TerminalManager,
  TerminalPane,
  agentLaunchCommand,
  paneLocation,
  REFIT_DEBOUNCE_MS,
  TMUX_WHEEL_ROW_PX,
  isUrlOpenClick,
  type LayoutStore,
} from '../terminal';
import type { TerminalLayout } from '../types/TerminalLayout';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  // refitSoon() uses requestAnimationFrame: let a frame pass too.
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  document.body.innerHTML = '';
  bus.handlers.clear();
  terms.all = [];
  searches.all = [];
  observers.callbacks = [];
  for (const fn of Object.values(api)) fn.mockClear();
  api.terminalStart.mockImplementation(async (_i, _c, _w, _h, session) =>
    session ? 'tmux' : 'shell',
  );
  api.tmuxSessions.mockImplementation(async () => []);
  api.detectAgents.mockImplementation(async () => []);
  api.mcpShimCommand.mockImplementation(async () => null);
  api.mcpAgentInstalled.mockImplementation(async () => false);
  api.mcpInstallAgent.mockImplementation(async () => 'Installed');
  api.shellName.mockImplementation(async () => 'bash');
  api.launchShell.mockImplementation(async () => 'posix');
  api.remoteSession.mockImplementation(async () => null);
  api.terminalBusy.mockImplementation(async () => null);
  dialog.ask.mockReset();
  dialog.ask.mockImplementation(async () => true);
  window.ResizeObserver = class {
    constructor(cb: () => void) {
      observers.callbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});


/** In-memory LayoutStore: what the cockpit would keep in AppConfig. */
function memoryStore(initial: Record<string, TerminalLayout> = {}) {
  const data: Record<string, TerminalLayout> = { ...initial };
  const saves: Array<[string, TerminalLayout | null]> = [];
  const store: LayoutStore = {
    load: (key) => data[key],
    save: (key, layout) => {
      saves.push([key, layout]);
      if (layout) data[key] = layout;
      else delete data[key];
    },
  };
  return { store, data, saves };
}

function makeManager(opts: { tmux?: boolean; cwd?: string; store?: LayoutStore } = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const mgr = new TerminalManager(host, () => {});
  mgr.setUseTmux(opts.tmux ?? false);
  mgr.setCwd(opts.cwd ?? '/repo');
  if (opts.store) mgr.setLayoutStore(opts.store);
  return { mgr, host };
}

const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];
const cards = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.terminal-pane')];
const names = (host: HTMLElement) =>
  cards(host).map((c) => c.querySelector('.terminal-pane-name')?.textContent);
const card = (host: HTMLElement, id: string) =>
  host.querySelector<HTMLElement>(`.terminal-pane[data-term-id="${id}"]`)!;
const btn = (host: HTMLElement, id: string, act: string) =>
  card(host, id).querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
const keydown = (init: Partial<KeyboardEvent>) =>
  ({
    type: 'keydown',
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...init,
  }) as unknown as KeyboardEvent;

describe('TerminalManager split grid', () => {
  it('first pane is the whole grid; split right / down build rows and columns', async () => {
    const { mgr, host } = makeManager();
    await mgr.addTerminal();
    expect(mgr.layout).toEqual({ type: 'pane', id: 'term-1' });
    expect(host.querySelector('.terminal-split')).toBeNull();

    expect(await mgr.splitFocused('row')).toBe(true);
    expect(mgr.layout).toMatchObject({
      type: 'split',
      dir: 'row',
      a: { id: 'term-1' },
      b: { id: 'term-2' },
    });
    // The new pane takes focus; splitting again splits IT (down).
    expect(mgr.active()?.id).toBe('term-2');
    await mgr.splitFocused('column');
    expect(mgr.order).toEqual(['term-1', 'term-2', 'term-3']);
    expect(mgr.layout).toMatchObject({
      dir: 'row',
      b: { type: 'split', dir: 'column', a: { id: 'term-2' }, b: { id: 'term-3' } },
    });
    // DOM mirrors the tree: row split containing a column split.
    const root = host.firstElementChild as HTMLElement;
    expect(root.classList.contains('terminal-split--row')).toBe(true);
    expect(root.querySelector('.terminal-split--column')).not.toBeNull();
    expect(host.querySelectorAll('.terminal-split-divider').length).toBe(2);
    expect(cards(host).length).toBe(3);
    // Each pane is its own pty.
    expect(api.terminalStart.mock.calls.map((c) => c[0])).toEqual([
      'term-1',
      'term-2',
      'term-3',
    ]);
  });

  it('header buttons split and close that pane; close collapses its split', async () => {
    const { mgr, host } = makeManager();
    await mgr.addTerminal();
    btn(host, 'term-1', 'split-down').click();
    await flush();
    expect(mgr.layout).toMatchObject({ type: 'split', dir: 'column' });

    btn(host, 'term-1', 'close').click();
    await flush(); // the busy probe (#43) runs first
    expect(mgr.count).toBe(1);
    expect(mgr.layout).toEqual({ type: 'pane', id: 'term-2' });
    expect(api.terminalClose).toHaveBeenCalledWith('term-1');
    expect(host.querySelector('.terminal-split')).toBeNull();
    expect(mgr.active()?.id).toBe('term-2');
  });

  it('header "Terminals only" button asks the app to toggle the layout (#21)', async () => {
    const { mgr, host } = makeManager();
    const only = vi.fn();
    mgr.setOnTerminalsOnly(only);
    await mgr.addTerminal();
    const b = btn(host, 'term-1', 'terminals-only');
    expect(b.title).toMatch(/^Terminals only \((Ctrl\+Shift\+`|⌃⇧`)\)$/);
    b.click();
    expect(only).toHaveBeenCalledTimes(1);
    expect(mgr.count).toBe(1);
  });

  it('max 4 panes: split buttons disabled with a tooltip, extra splits refused', async () => {
    const { mgr, host } = makeManager();
    await mgr.addTerminal();
    await mgr.splitFocused('row');
    await mgr.splitFocused('column');
    expect(btn(host, 'term-1', 'split-right').disabled).toBe(false);
    await mgr.splitFocused('row');
    expect(mgr.count).toBe(4);
    for (const id of mgr.order) {
      const b = btn(host, id, 'split-right');
      expect(b.disabled).toBe(true);
      expect(b.title).toMatch(/maximum/i);
      expect(btn(host, id, 'split-down').disabled).toBe(true);
    }
    expect(await mgr.splitFocused('row')).toBe(false);
    expect(await mgr.addTerminal()).toBe(false);
    expect(mgr.count).toBe(4);
    expect(api.terminalStart).toHaveBeenCalledTimes(4);

    // Two quick splits racing the shell-name lookup still stop at the max.
    mgr.closeTerminal('term-4');
    await Promise.all([mgr.splitFocused('row'), mgr.splitFocused('row')]);
    expect(mgr.count).toBe(4);
    // Closing one re-enables splitting.
    mgr.closeFocused();
    await flush();
    expect(btn(host, mgr.order[0], 'split-right').disabled).toBe(false);
  });

  it('focus: click marks the pane focused (outline only with 2+), next/prev wrap', async () => {
    const { mgr, host } = makeManager();
    await mgr.addTerminal();
    expect(card(host, 'term-1').classList.contains('focused')).toBe(false);
    await mgr.splitFocused('row');
    await mgr.splitFocused('row');
    expect(card(host, 'term-3').classList.contains('focused')).toBe(true);

    card(host, 'term-1').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(mgr.active()?.id).toBe('term-1');
    expect(host.querySelectorAll('.terminal-pane.focused').length).toBe(1);
    expect(card(host, 'term-1').classList.contains('focused')).toBe(true);

    mgr.focusNeighbor(1);
    expect(mgr.active()?.id).toBe('term-2');
    mgr.focusNeighbor(-1);
    mgr.focusNeighbor(-1);
    expect(mgr.active()?.id).toBe('term-3'); // wrapped
  });

  it('split keys inside a terminal act on its pane and never reach the page', async () => {
    const { mgr } = makeManager();
    await mgr.addTerminal();
    const term = terms.all[0];
    // Windows/Linux mapping (jsdom is not macOS): Ctrl+Shift+D split right.
    const ev = keydown({ key: 'D', ctrlKey: true, shiftKey: true });
    expect(term.keyHandler!(ev)).toBe(false);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(ev.stopPropagation).toHaveBeenCalled();
    await flush();
    expect(mgr.count).toBe(2);
    expect(mgr.layout).toMatchObject({ dir: 'row' });

    // Ctrl+Shift+] from pane 2 → next pane (wraps to pane 1).
    terms.all[1].keyHandler!(keydown({ key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true }));
    expect(mgr.active()?.id).toBe('term-1');

    // Ctrl+Shift+W closes the pane the key was pressed in (idle shell: no ask).
    terms.all[1].keyHandler!(keydown({ key: 'W', ctrlKey: true, shiftKey: true }));
    await flush();
    expect(mgr.order).toEqual(['term-1']);
    expect(dialog.ask).not.toHaveBeenCalled();

    // Plain Ctrl+D / Ctrl+W stay with the shell (readline EOF / delete-word, #42).
    expect(term.keyHandler!(keydown({ key: 'd', ctrlKey: true }))).toBe(true);
    const w = keydown({ key: 'w', code: 'KeyW', ctrlKey: true });
    expect(term.keyHandler!(w)).toBe(true);
    await flush();
    expect(mgr.count).toBe(1);
  });

  describe('closing a busy pane asks first (#43)', () => {
    const closeBtn = (host: HTMLElement, id: string) =>
      card(host, id).querySelector<HTMLButtonElement>('[data-act="close"]')!;

    it('× on an idle shell closes at once, without a dialog', async () => {
      const { mgr, host } = makeManager();
      await mgr.addTerminal();
      await mgr.addTerminal({ split: { dir: 'row' } });
      closeBtn(host, 'term-2').click();
      await flush();
      expect(api.terminalBusy).toHaveBeenCalledWith('term-2');
      expect(dialog.ask).not.toHaveBeenCalled();
      expect(mgr.order).toEqual(['term-1']);
    });

    it('× on a busy pane asks; Cancel keeps it, Close kills it', async () => {
      const { mgr, host } = makeManager();
      await mgr.addTerminal();
      await mgr.addTerminal({ split: { dir: 'row' } });
      api.terminalBusy.mockImplementation(async () => 'claude');
      dialog.ask.mockImplementation(async () => false);
      closeBtn(host, 'term-2').click();
      await flush();
      expect(dialog.ask).toHaveBeenCalledTimes(1);
      expect(String(dialog.ask.mock.calls[0][0])).toContain('“claude” is still running');
      expect(mgr.order).toEqual(['term-1', 'term-2']);
      expect(api.terminalClose).not.toHaveBeenCalled();

      dialog.ask.mockImplementation(async () => true);
      closeBtn(host, 'term-2').click();
      await flush();
      expect(mgr.order).toEqual(['term-1']);
    });

    it('the shortcut path (Ctrl+Shift+W, menu / ⌘W → closeFocused) asks the same way', async () => {
      const { mgr } = makeManager();
      await mgr.addTerminal();
      await mgr.addTerminal({ split: { dir: 'row' } });
      api.terminalBusy.mockImplementation(async () => 'vim');
      dialog.ask.mockImplementation(async () => false);
      terms.all[1].keyHandler!(keydown({ key: 'W', ctrlKey: true, shiftKey: true }));
      await flush();
      mgr.activate('term-2');
      mgr.closeFocused();
      await flush();
      expect(dialog.ask).toHaveBeenCalledTimes(2);
      expect(mgr.count).toBe(2);
      dialog.ask.mockImplementation(async () => true);
      mgr.closeFocused();
      await flush();
      expect(mgr.count).toBe(1);
    });

    it('a shell that exits by itself closes its pane without asking', async () => {
      const { mgr } = makeManager();
      await mgr.addTerminal();
      await mgr.addTerminal({ split: { dir: 'row' } });
      api.terminalBusy.mockImplementation(async () => 'claude');
      bus.emit('terminal://exit', { id: 'term-2' });
      await flush();
      expect(dialog.ask).not.toHaveBeenCalled();
      expect(mgr.order).toEqual(['term-1']);
    });

    it('a failed busy probe does not block closing', async () => {
      const { mgr, host } = makeManager();
      await mgr.addTerminal();
      await mgr.addTerminal({ split: { dir: 'row' } });
      api.terminalBusy.mockImplementation(async () => {
        throw new Error('no such terminal');
      });
      closeBtn(host, 'term-2').click();
      await flush();
      expect(dialog.ask).not.toHaveBeenCalled();
      expect(mgr.order).toEqual(['term-1']);
    });
  });

  it('hasFocus() is true only while keyboard focus is inside a pane', async () => {
    const { mgr, host } = makeManager();
    await mgr.addTerminal();
    const outside = document.createElement('input');
    document.body.append(outside);
    outside.focus();
    expect(mgr.hasFocus()).toBe(false);
    const inside = document.createElement('input');
    host.querySelector('.terminal-pane-host')!.append(inside);
    inside.focus();
    expect(mgr.hasFocus()).toBe(true);
  });

  it('closing an unknown / already-closed id is a no-op; last close fires onEmpty once', async () => {
    const { mgr } = makeManager();
    const onEmpty = vi.fn();
    mgr.setOnEmpty(onEmpty);
    await mgr.addTerminal();
    mgr.closeTerminal('term-99');
    expect(mgr.count).toBe(1);
    mgr.closeTerminal('term-1');
    mgr.closeTerminal('term-1');
    expect(mgr.count).toBe(0);
    expect(mgr.layout).toBeNull();
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(api.terminalClose).toHaveBeenCalledTimes(1);
  });

  it('explicit close of a tmux-backed pane kills its session', async () => {
    const { mgr } = makeManager({ tmux: true });
    await mgr.addTerminal();
    const session = api.terminalStart.mock.calls[0][4]!;
    expect(session).toMatch(/^sd-[0-9a-f]{8}-bash-1$/);
    mgr.closeTerminal('term-1');
    expect(api.tmuxKillSession).toHaveBeenCalledWith(session);
  });

  it('pane header: live dot, process name, folder; remote panes show the host', async () => {
    const { mgr, host } = makeManager({ cwd: '/Users/me/Projects/app' });
    await mgr.addTerminal();
    const c = card(host, 'term-1');
    expect(c.querySelector('.terminal-pane-live')!.classList.contains('is-running')).toBe(true);
    expect(c.querySelector('.terminal-pane-name')!.textContent).toBe('bash');
    expect(c.querySelector('.terminal-pane-cwd')!.textContent).toBe('~/Projects/app');

    api.remoteSession.mockImplementation(async () => ({
      host: 'devbox',
      path: '/home/dev/svc',
      home: '/home/dev',
    }));
    mgr.setCwd('/home/dev/svc');
    await mgr.splitFocused('row');
    expect(card(host, 'term-2').querySelector('.terminal-pane-cwd')!.textContent).toBe(
      'devbox · ~/svc',
    );
    // The earlier pane keeps the folder it was started in.
    expect(c.querySelector('.terminal-pane-cwd')!.textContent).toBe('~/Projects/app');
  });

  it('paneLocation shortens home and prefixes the remote host', () => {
    expect(paneLocation('/Users/me/x', null)).toBe('~/x');
    expect(paneLocation('/home/me', null)).toBe('~');
    expect(paneLocation('/opt/work', null)).toBe('/opt/work');
    expect(paneLocation(null, null)).toBe('~');
    expect(paneLocation('/srv/app', { host: 'box', home: '/home/u' })).toBe('box · /srv/app');
    expect(paneLocation('/home/u/app', { host: 'box', home: '/home/u/' })).toBe('box · ~/app');
  });

  it('a failed spawn keeps the pane (error readable), marked failed', async () => {
    api.terminalStart.mockImplementation(async () => {
      throw new Error('no shell');
    });
    const { mgr, host } = makeManager();
    await mgr.addTerminal();
    expect(mgr.count).toBe(1);
    expect(card(host, 'term-1').querySelector('.terminal-pane-live')!.classList.contains('is-failed')).toBe(true);
  });

  it('a shell that exits while starting leaves the grid consistent', async () => {
    const { mgr, host } = makeManager();
    await mgr.addTerminal();
    api.terminalStart.mockImplementationOnce(async (id: string) => {
      bus.emit('terminal://exit', { id });
      return 'shell';
    });
    expect(await mgr.splitFocused('row')).toBe(false);
    expect(mgr.count).toBe(1);
    expect(mgr.layout).toEqual({ type: 'pane', id: 'term-1' });
    expect(mgr.active()?.id).toBe('term-1');
    expect(cards(host).length).toBe(1);
    expect(api.terminalClose).toHaveBeenCalledWith('term-2');
  });

  it('an exit closes only the pane with that id; stale ids are ignored', async () => {
    const { mgr } = makeManager({ tmux: true });
    const onEmpty = vi.fn();
    mgr.setOnEmpty(onEmpty);
    await mgr.addTerminal();
    await mgr.splitFocused('row');
    await mgr.splitFocused('column');
    const session2 = api.terminalStart.mock.calls[1][4];

    bus.emit('terminal://exit', { id: 'term-2' });
    expect(mgr.order).toEqual(['term-1', 'term-3']);
    expect(api.tmuxKillSession).toHaveBeenCalledWith(session2);

    bus.emit('terminal://exit', { id: 'term-42' });
    bus.emit('terminal://exit', { id: 'term-2' });
    expect(mgr.count).toBe(2);
    expect(api.terminalClose).toHaveBeenCalledTimes(1);

    bus.emit('terminal://exit', { id: 'term-1' });
    bus.emit('terminal://exit', { id: 'term-3' });
    expect(mgr.count).toBe(0);
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(bus.count('terminal://exit')).toBe(0);
    expect(bus.count('terminal://data')).toBe(0);
  });

  it('rename: double-click the name, Enter commits, Escape cancels', async () => {
    const { mgr, host } = makeManager();
    await mgr.addTerminal();
    const name = () => card(host, 'term-1').querySelector('.terminal-pane-name') as HTMLElement;
    name().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = card(host, 'term-1').querySelector('input')!;
    input.value = 'server';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(name().textContent).toBe('server');
    name().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const again = card(host, 'term-1').querySelector('input')!;
    again.value = 'nope';
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(name().textContent).toBe('server');
  });
});

describe('TerminalManager refit', () => {
  it('every pane refits on a structural change; a divider drag updates the ratio', async () => {
    const { mgr, host } = makeManager();
    await mgr.addTerminal();
    await mgr.splitFocused('row');
    await flush();
    api.terminalResize.mockClear();
    await mgr.splitFocused('column');
    await flush();
    // All three panes were refitted (each sends its fitted size).
    const ids = new Set(api.terminalResize.mock.calls.map((c) => c[0]));
    expect(ids).toEqual(new Set(['term-1', 'term-2', 'term-3']));

    // Drag the root divider to 30%.
    const root = host.firstElementChild as HTMLElement;
    root.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 300, right: 1000, bottom: 300 }) as DOMRect;
    const divider = root.querySelector(':scope > .terminal-split-divider') as HTMLElement;
    divider.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 10 }));
    document.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(mgr.layout).toMatchObject({ type: 'split', ratio: 0.3 });
    expect((root.children[0] as HTMLElement).style.flex).toMatch(/^0\.3 1 0(px)?/);
    // Dragging far past the edge clamps.
    divider.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: -500, clientY: 10 }));
    document.dispatchEvent(new MouseEvent('mouseup', {}));
    expect((mgr.layout as { ratio: number }).ratio).toBeCloseTo(0.15);
  });

  it('closing a pane sends no terminal_resize to it afterwards', async () => {
    const { mgr } = makeManager();
    await mgr.addTerminal();
    await mgr.splitFocused('row');
    await flush();
    api.terminalResize.mockClear();
    // A container resize is pending on term-1 when it closes.
    observers.callbacks[0]();
    mgr.closeTerminal('term-1');
    await new Promise((r) => setTimeout(r, REFIT_DEBOUNCE_MS + 20));
    await flush();
    expect(api.terminalResize.mock.calls.some((c) => c[0] === 'term-1')).toBe(false);
    expect(api.terminalResize.mock.calls.some((c) => c[0] === 'term-2')).toBe(true);
  });
});

describe('TerminalManager layout persistence + restore', () => {
  it('saves the tree with tmux sessions per workspace key; ratios included', async () => {
    const mem = memoryStore();
    const { mgr } = makeManager({ tmux: true, store: mem.store });
    await mgr.addTerminal();
    await mgr.splitFocused('column');
    const [key, layout] = last(mem.saves)!;
    expect(key).toMatch(/^sd-[0-9a-f]{8}-$/);
    expect(layout).toEqual({
      type: 'split',
      dir: 'column',
      ratio: 0.5,
      a: { type: 'pane', session: `${key}bash-1` },
      b: { type: 'pane', session: `${key}bash-2` },
    });
    // Closing the last pane drops the entry.
    mgr.closeTerminal('term-1');
    mgr.closeTerminal('term-2');
    expect(last(mem.saves)).toEqual([key, null]);
    expect(mem.data[key]).toBeUndefined();
  });

  it('round trip: a new manager restores the same tree, reattaching each session', async () => {
    const mem = memoryStore();
    const live: string[] = [];
    api.terminalStart.mockImplementation(async (_i, _c, _w, _h, session) => {
      if (session) live.push(session);
      return session ? 'tmux' : 'shell';
    });
    const first = makeManager({ tmux: true, cwd: '/w', store: mem.store });
    await first.mgr.addTerminal();
    await first.mgr.splitFocused('row');
    await first.mgr.splitFocused('column');
    const saved = last(mem.saves)![1];

    // "Restart": the sessions survive, a fresh manager opens the drawer.
    const survived = [...live];
    api.terminalStart.mockClear();
    api.tmuxSessions.mockImplementation(async () => [...survived]);
    const second = makeManager({ tmux: true, cwd: '/w', store: mem.store });
    await second.mgr.restoreOrCreate();
    expect(second.mgr.count).toBe(3);
    expect(api.shellName).toHaveBeenCalledTimes(1); // only the first manager asked
    expect(api.terminalStart.mock.calls.map((c) => c[4])).toEqual(survived);
    const shape = (n: unknown): unknown => JSON.stringify(n).replace(/"(id|session)":"[^"]+"/g, '"x"');
    expect(shape(second.mgr.layout)).toBe(shape(saved));
    expect(last(mem.saves)![1]).toEqual(saved);
    // New panes continue after the highest restored number.
    await second.mgr.splitFocused('row');
    expect(last(api.terminalStart.mock.calls)![4]).toMatch(/-bash-4$/);
  });

  it('restore with a missing session: its pane is dropped and the split collapses', async () => {
    let seen = '';
    api.tmuxSessions.mockImplementation(async (prefix: string) => {
      seen = prefix;
      return [`${prefix}zsh-1`, `${prefix}zsh-3-a-claude`];
    });
    const { mgr: probe } = makeManager({ tmux: true, cwd: '/w' });
    await probe.restoreOrCreate(); // learn the prefix
    const prefix = seen;
    api.terminalStart.mockClear();

    const mem = memoryStore({
      [prefix]: {
        type: 'split',
        dir: 'row',
        ratio: 0.6,
        a: { type: 'pane', session: `${prefix}zsh-1` },
        b: {
          type: 'split',
          dir: 'column',
          ratio: 0.5,
          a: { type: 'pane', session: `${prefix}zsh-2` }, // gone
          b: { type: 'pane', session: `${prefix}zsh-3-a-claude` },
        },
      },
    });
    const { mgr, host } = makeManager({ tmux: true, cwd: '/w', store: mem.store });
    await mgr.restoreOrCreate();
    expect(mgr.count).toBe(2);
    expect(mgr.layout).toMatchObject({
      type: 'split',
      dir: 'row',
      ratio: 0.6,
      a: { type: 'pane' },
      b: { type: 'pane' },
    });
    expect(api.terminalStart.mock.calls.map((c) => c[4])).toEqual([
      `${prefix}zsh-1`,
      `${prefix}zsh-3-a-claude`,
    ]);
    // The agent's name returns on its restored pane.
    expect(names(host)).toEqual(['zsh', 'claude']);
  });

  it('migration: no saved layout → surviving sessions in one even row (numeric order, max 4)', async () => {
    api.tmuxSessions.mockImplementation(async (prefix: string) =>
      ['zsh-10', 'zsh-2', 'zsh-1', 'zsh-3', 'zsh-4'].map((s) => `${prefix}${s}`),
    );
    const { mgr, host } = makeManager({ tmux: true, cwd: '/work/space', store: memoryStore().store });
    await mgr.restoreOrCreate();
    expect(mgr.count).toBe(4);
    expect(
      api.terminalStart.mock.calls.map((c) => (c[4] as string).replace(/^sd-[0-9a-f]{8}-/, '')),
    ).toEqual(['zsh-1', 'zsh-2', 'zsh-3', 'zsh-4']);
    // Extra sessions are left alone (never killed).
    expect(api.tmuxKillSession).not.toHaveBeenCalled();
    const root = mgr.layout as { dir: string; ratio: number };
    expect(root.dir).toBe('row');
    expect(root.ratio).toBeCloseTo(0.25);
    expect(host.querySelectorAll('.terminal-split--column').length).toBe(0);
  });

  it('opens one fresh shell when no session survived, the list fails, or tmux is off', async () => {
    api.tmuxSessions.mockImplementation(async () => {
      throw new Error('no tmux');
    });
    const a = makeManager({ tmux: true });
    await a.mgr.restoreOrCreate();
    expect(a.mgr.count).toBe(1);

    const b = makeManager({ tmux: false });
    await b.mgr.restoreOrCreate();
    await b.mgr.restoreOrCreate();
    expect(b.mgr.count).toBe(1);
    expect(api.tmuxSessions).toHaveBeenCalledTimes(1);
  });

  it('same workspace path → same prefix; another path → another prefix', async () => {
    const prefixes: string[] = [];
    api.tmuxSessions.mockImplementation(async (p: string) => {
      prefixes.push(p);
      return [];
    });
    await makeManager({ tmux: true, cwd: '/a' }).mgr.restoreOrCreate();
    await makeManager({ tmux: true, cwd: '/a' }).mgr.restoreOrCreate();
    await makeManager({ tmux: true, cwd: '/b' }).mgr.restoreOrCreate();
    expect(prefixes[0]).toBe(prefixes[1]);
    expect(prefixes[0]).not.toBe(prefixes[2]);
  });

  it('tmux off: panes are not persisted (nothing to reattach)', async () => {
    const mem = memoryStore();
    const { mgr } = makeManager({ tmux: false, store: mem.store });
    await mgr.addTerminal();
    await mgr.splitFocused('row');
    expect(mem.saves.every(([, l]) => l === null)).toBe(true);
  });
});

describe('TerminalPane events', () => {
  it('pty data for another id is not routed to this pane', async () => {
    const pane = new TerminalPane('p1', () => {});
    await pane.init(document.createElement('div'), '/cwd');
    let quick = false;
    const idle = pane.whenIdle(10, 200).then(() => (quick = true));
    bus.emit('terminal://data', { id: 'other', chunk: 'x' });
    await new Promise((r) => setTimeout(r, 80));
    expect(quick).toBe(false);
    bus.emit('terminal://data', { id: 'p1', chunk: 'prompt$ ' });
    await idle;
    expect(quick).toBe(true);
    pane.destroy();
  });
});

describe('TerminalPane resize / write / paste', () => {
  async function startedPane(session: string | null = null) {
    const pane = new TerminalPane('p1', () => {});
    const container = document.createElement('div');
    await pane.init(container, '/cwd', session);
    return { pane, term: last(terms.all)! };
  }

  it('a container resize sends one debounced terminal_resize with the fitted size', async () => {
    const { pane, term } = await startedPane();
    await flush(); // the post-start refitSoon
    api.terminalResize.mockClear();
    term.cols = 132;
    term.rows = 40;
    // Debounced: a burst of container resizes sends one resize.
    last(observers.callbacks)!();
    last(observers.callbacks)!();
    expect(api.terminalResize).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, REFIT_DEBOUNCE_MS + 10));
    expect(api.terminalResize).toHaveBeenCalledTimes(1);
    expect(api.terminalResize).toHaveBeenCalledWith('p1', 132, 40);
    pane.destroy();
  });

  it('a refit queued before destroy() does not resize the closed PTY', async () => {
    const { pane } = await startedPane();
    await flush();
    api.terminalResize.mockClear();
    pane.refitSoon();
    pane.destroy();
    await flush();
    expect(api.terminalResize).not.toHaveBeenCalled();
  });

  it('the start call carries the current size; no resize before the shell starts', async () => {
    let release!: (m: string) => void;
    api.terminalStart.mockImplementationOnce(
      () => new Promise<string>((r) => (release = r)),
    );
    const pane = new TerminalPane('p2', () => {});
    const initP = pane.init(document.createElement('div'), '/cwd');
    await flush();
    pane.refitSoon();
    await flush();
    expect(api.terminalResize).not.toHaveBeenCalled();
    release('shell');
    await initP;
    expect(api.terminalStart.mock.calls[0].slice(0, 4)).toEqual(['p2', '/cwd', 80, 24]);
    pane.destroy();
  });

  it('keystrokes go to terminal_write only once the shell has started', async () => {
    let release!: (m: string) => void;
    api.terminalStart.mockImplementationOnce(
      () => new Promise<string>((r) => (release = r)),
    );
    const pane = new TerminalPane('p3', () => {});
    const initP = pane.init(document.createElement('div'), '/cwd');
    await flush();
    const term = last(terms.all)!;
    term.dataHandler!('early');
    expect(api.terminalWrite).not.toHaveBeenCalled();
    release('shell');
    await initP;
    term.dataHandler!('ls\r');
    expect(api.terminalWrite).toHaveBeenCalledWith('p3', 'ls\r');
    // After the shell exits, input is dropped.
    bus.emit('terminal://exit', { id: 'p3' });
    term.dataHandler!('late');
    expect(api.terminalWrite).toHaveBeenCalledTimes(1);
    pane.destroy();
  });

  it('paste(): tmux pane → send-keys; plain pane → pty write; not started → nothing', async () => {
    const tmux = await startedPane('sd-abc-bash-1');
    tmux.pane.paste('src/app.ts');
    expect(api.tmuxSendKeys).toHaveBeenCalledWith('sd-abc-bash-1', 'src/app.ts');
    expect(api.terminalWrite).not.toHaveBeenCalled();
    tmux.pane.destroy();

    const plain = await startedPane(null);
    plain.pane.paste('hello');
    expect(api.terminalWrite).toHaveBeenCalledWith('p1', 'hello');
    plain.pane.destroy();

    const idle = new TerminalPane('p9', () => {});
    idle.paste('ignored');
    expect(api.terminalWrite).toHaveBeenCalledTimes(1);
    expect(api.tmuxSendKeys).toHaveBeenCalledTimes(1);
  });

  it('clipboard keys: ⌘V pastes clipboard text into the pty; ⌘C copies the selection', async () => {
    const { pane, term } = await startedPane();
    const prevent = vi.fn();
    const key = (k: string, mods: Partial<KeyboardEvent> = { metaKey: true }) =>
      ({
        type: 'keydown',
        key: k,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault: prevent,
        ...mods,
      }) as KeyboardEvent;

    // #130: the paste reads the clipboard through the core (WebKitGTK's
    // navigator.clipboard can't), and cancels the native paste.
    expect(term.keyHandler!(key('v'))).toBe(false);
    await flush();
    expect(api.readClipboardText).toHaveBeenCalled();
    expect(api.terminalWrite).toHaveBeenCalledWith('p1', 'pasted text');
    expect(prevent).toHaveBeenCalled();

    // Shift+Insert pastes too.
    vi.mocked(api.terminalWrite).mockClear();
    expect(term.keyHandler!(key('Insert', { shiftKey: true }))).toBe(false);
    await flush();
    expect(api.terminalWrite).toHaveBeenCalledWith('p1', 'pasted text');

    // ⌘C with no selection is left to xterm (never turns into a copy).
    expect(term.keyHandler!(key('c'))).toBe(true);
    expect(api.copyText).not.toHaveBeenCalled();
    term.selection = 'npm test';
    expect(term.keyHandler!(key('c'))).toBe(false);
    expect(api.copyText).toHaveBeenCalledWith('npm test');
    expect(term.selection).toBe('');

    // Other keys pass through.
    expect(term.keyHandler!(key('k'))).toBe(true);
    pane.destroy();
  });
});


describe('TerminalManager agent launch', () => {
  const SHIM = { program: '/opt/sd/sparkdown', args: ['--mcp-stdio'] };
  const agents = [
    { id: 'claude', label: 'Claude Code', bin: 'claude', found: true },
    { id: 'grok', label: 'Grok', bin: 'grok', found: true },
    { id: 'missing', label: 'Missing', bin: 'missing', found: false },
  ];

  /** A manager with one pane open (the chips live in the focused header). */
  async function managerWithAgents(tmux = true) {
    api.detectAgents.mockImplementation(async () => agents);
    const m = makeManager({ tmux });
    await m.mgr.addTerminal();
    await flush();
    api.terminalStart.mockClear();
    return m;
  }

  const clickAgent = async (host: HTMLElement, bin: string) => {
    (host.querySelector(`.terminal-agent-btn[data-bin="${bin}"]`) as HTMLElement).click();
    await flush();
  };

  it('renders chips only for found agents, in the focused pane only', async () => {
    const { mgr, host } = await managerWithAgents();
    await mgr.splitFocused('row');
    const chipBins = (id: string) =>
      [...card(host, id).querySelectorAll<HTMLElement>('.terminal-agent-btn')].map(
        (b) => b.dataset.bin,
      );
    expect(chipBins('term-2')).toEqual(['claude', 'grok']);
    expect(chipBins('term-1')).toEqual([]);
    mgr.activate('term-1');
    expect(chipBins('term-1')).toEqual(['claude', 'grok']);
    expect(chipBins('term-2')).toEqual([]);
  });

  it('opens the agent in a NEW split next to the focused pane, named after it', async () => {
    api.mcpShimCommand.mockImplementation(async () => SHIM);
    const { mgr, host } = await managerWithAgents();
    mgr.setAgentArgs({ claude: '--model opus' });
    await clickAgent(host, 'claude');

    expect(mgr.count).toBe(2);
    expect(mgr.layout).toMatchObject({ type: 'split', dir: 'row', a: { id: 'term-1' } });
    expect(mgr.active()?.id).toBe('term-2');
    expect(api.mcpAgentInstalled).not.toHaveBeenCalled();
    const [id, , , , session, launch] = api.terminalStart.mock.calls[0];
    expect(id).toBe('term-2');
    expect(launch).toBe(
      agentLaunchCommand('claude', { shim: SHIM, installed: false, extraArgs: '--model opus' }),
    );
    expect(launch).toContain('--mcp-config');
    expect(launch!.endsWith(' --model opus')).toBe(true);
    expect(session).toMatch(/^sd-[0-9a-f]{8}-bash-2-a-claude$/);
    expect(names(host)).toEqual(['bash', 'claude']);
  });

  it('a tall focused pane splits down for the agent', async () => {
    const { mgr, host } = await managerWithAgents();
    card(host, 'term-1').getBoundingClientRect = () =>
      ({ width: 400, height: 600, left: 0, top: 0, right: 400, bottom: 600 }) as DOMRect;
    await clickAgent(host, 'grok');
    expect(mgr.layout).toMatchObject({ type: 'split', dir: 'column' });
  });

  it('at the max, the command is typed into the focused pane (not submitted), no new pane', async () => {
    const { mgr, host } = await managerWithAgents(true);
    await mgr.splitFocused('row');
    await mgr.splitFocused('row');
    await mgr.splitFocused('row');
    expect(mgr.count).toBe(4);
    api.terminalStart.mockClear();
    const focused = mgr.active()!;
    const chip = card(host, focused.id).querySelector<HTMLElement>('.terminal-agent-btn[data-bin="grok"]')!;
    expect(chip.title).toMatch(/press Enter/);
    chip.click();
    await flush();
    expect(mgr.count).toBe(4);
    expect(api.terminalStart).not.toHaveBeenCalled();
    expect(api.tmuxSendKeys).toHaveBeenCalledWith(focused.sessionName, expect.stringMatching(/^grok /));
    expect(api.terminalWrite).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/\r$/));
  });

  it('non-injectable agent: checks install; installed → bare command', async () => {
    api.mcpShimCommand.mockImplementation(async () => SHIM);
    api.mcpAgentInstalled.mockImplementation(async () => true);
    const { host } = await managerWithAgents(false);
    await clickAgent(host, 'grok');
    expect(api.mcpAgentInstalled).toHaveBeenCalledWith('grok');
    expect(api.terminalStart.mock.calls[0][5]).toBe('grok');
    expect(api.terminalStart.mock.calls[0][4]).toBeNull();
  });

  it('no shim: no install check, file-bridge prompt fallback', async () => {
    const { host } = await managerWithAgents();
    await clickAgent(host, 'claude');
    expect(api.mcpAgentInstalled).not.toHaveBeenCalled();
    expect(api.terminalStart.mock.calls[0][5]).toMatch(
      /^claude 'Read the file \$SPARKDOWN_CONTEXT/,
    );
  });

  it('local Windows: the backend asks for PowerShell, the line follows', async () => {
    api.launchShell.mockImplementation(async () => 'powershell');
    api.mcpShimCommand.mockImplementation(async () => ({
      program: 'C:\\SD\\sparkdown.exe',
      args: ['--mcp-stdio'],
      configFile: "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\sparkdown-1-claude-mcp.json",
    }));
    const { host } = await managerWithAgents(false);
    await clickAgent(host, 'claude');
    expect(api.terminalStart.mock.calls[0][5]).toBe(
      "claude --mcp-config 'C:\\Users\\O''Brien\\AppData\\Local\\Temp\\sparkdown-1-claude-mcp.json'",
    );
  });

  it('launch-shell lookup failure falls back to POSIX syntax', async () => {
    api.launchShell.mockImplementation(async () => {
      throw new Error('ipc down');
    });
    api.mcpShimCommand.mockImplementation(async () => SHIM);
    const { host } = await managerWithAgents(false);
    await clickAgent(host, 'claude');
    expect(api.terminalStart.mock.calls[0][5]).toContain(`--mcp-config '{"mcpServers"`);
  });

  it('shim lookup failure falls back instead of blocking the launch', async () => {
    api.mcpShimCommand.mockImplementation(async () => {
      throw new Error('ipc down');
    });
    const { mgr, host } = await managerWithAgents();
    await clickAgent(host, 'grok');
    expect(mgr.count).toBe(2);
    expect(api.terminalStart.mock.calls[0][5]).toMatch(/^grok '/);
  });
});

describe('TerminalManager MCP install prompt at launch', () => {
  const SHIM = { program: '/opt/sd/sparkdown', args: ['--mcp-stdio'] };
  const agents = [
    { id: 'claude', label: 'Claude Code', bin: 'claude', found: true },
    { id: 'codex', label: 'Codex', bin: 'codex', found: true },
    { id: 'gemini', label: 'Gemini', bin: 'gemini', found: true },
    { id: 'grok', label: 'Grok', bin: 'grok', found: true },
    { id: 'kiro', label: 'Kiro', bin: 'kiro-cli', found: true },
    { id: 'cursor', label: 'Cursor CLI', bin: 'cursor-agent', found: true },
    { id: 'antigravity', label: 'Antigravity', bin: 'agy', found: true },
    { id: 'opencode', label: 'opencode', bin: 'opencode', found: true },
    { id: 'mystery', label: 'Mystery', bin: 'mystery', found: true },
  ];

  /** A manager with one pane, the shim up, and an in-memory prompt store. */
  async function setup(opts: { dismissed?: string[] } = {}) {
    api.detectAgents.mockImplementation(async () => agents);
    api.mcpShimCommand.mockImplementation(async () => SHIM);
    const dismissed = new Set(opts.dismissed ?? []);
    const store = {
      isDismissed: vi.fn((bin: string) => dismissed.has(bin)),
      dismiss: vi.fn((bin: string) => {
        dismissed.add(bin);
      }),
    };
    const m = makeManager({ tmux: false });
    m.mgr.setMcpPromptStore(store);
    await m.mgr.addTerminal();
    await flush();
    api.terminalStart.mockClear();
    return { ...m, store, dismissed };
  }

  const prompt = () => document.querySelector<HTMLElement>('.mcp-prompt');
  const launched = () => api.terminalStart.mock.calls.map((c) => c[5]);
  /** Click a chip; resolves once the prompt (or the launch) is reached. */
  const clickChip = async (host: HTMLElement, bin: string) => {
    host.querySelector<HTMLElement>(`.terminal-agent-btn[data-bin="${bin}"]`)!.click();
    await flush();
  };
  const press = (key: string) =>
    prompt()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  const button = (cls: string) => prompt()!.querySelector<HTMLButtonElement>(cls)!;
  const TEACH = /^(\S+) 'Read the file \$SPARKDOWN_CONTEXT/;

  it('Claude and Codex inject silently: no prompt, no install check', async () => {
    const { host } = await setup();
    await clickChip(host, 'claude');
    await clickChip(host, 'codex');
    expect(prompt()).toBeNull();
    expect(api.mcpAgentInstalled).not.toHaveBeenCalled();
    expect(api.mcpInstallAgent).not.toHaveBeenCalled();
    expect(launched()[0]).toContain('--mcp-config');
    expect(launched()[1]).toContain('mcp_servers.sparkdown.command=');
  });

  it.each([
    ['gemini', 'Gemini'],
    ['grok', 'Grok'],
    ['kiro-cli', 'Kiro'],
    ['cursor-agent', 'Cursor CLI'],
    ['agy', 'Antigravity'],
  ])('%s, not installed: prompts before launching', async (bin, label) => {
    const { host } = await setup();
    await clickChip(host, bin);
    expect(api.mcpAgentInstalled).toHaveBeenCalledWith(bin);
    const dlg = prompt()!;
    expect(dlg).not.toBeNull();
    expect(dlg.getAttribute('role')).toBe('dialog');
    expect(dlg.textContent).toContain(`Give ${label} SparkDown's tools?`);
    expect(dlg.textContent).toContain('Settings → Agents');
    expect(dlg.textContent).toContain(`Don't ask again for ${label}`);
    expect(document.activeElement).toBe(button('.mcp-prompt-install'));
    // Nothing launches while the prompt is open.
    expect(api.terminalStart).not.toHaveBeenCalled();
    button('.mcp-prompt-not-now').click();
    await flush();
  });

  it('Install → runs the install, then launches the plain command', async () => {
    const { host, mgr } = await setup();
    let finish!: () => void;
    api.mcpInstallAgent.mockImplementation(
      () => new Promise<string>((r) => (finish = () => r('Installed'))),
    );
    await clickChip(host, 'gemini');
    button('.mcp-prompt-install').click();
    await flush();
    // Spinner/status while the install runs; buttons disabled.
    const status = prompt()!.querySelector<HTMLElement>('.mcp-prompt-status')!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain('Installing into Gemini');
    expect(button('.mcp-prompt-install').disabled).toBe(true);
    finish();
    await flush();
    expect(api.mcpInstallAgent).toHaveBeenCalledWith('gemini');
    expect(prompt()).toBeNull();
    expect(launched()).toEqual(['gemini']);
    expect(mgr.count).toBe(2);
  });

  it('Not now → the teaching prompt this time, and asks again next time', async () => {
    const { host, store } = await setup();
    await clickChip(host, 'grok');
    button('.mcp-prompt-not-now').click();
    await flush();
    expect(prompt()).toBeNull();
    expect(api.mcpInstallAgent).not.toHaveBeenCalled();
    expect(store.dismiss).not.toHaveBeenCalled();
    expect(launched()[0]).toMatch(TEACH);
    expect(launched()[0]!.startsWith('grok ')).toBe(true);
    await clickChip(host, 'grok');
    expect(prompt()).not.toBeNull();
    button('.mcp-prompt-not-now').click();
    await flush();
  });

  it("Don't ask again → persisted; the next launch has no prompt", async () => {
    const { host, store } = await setup();
    await clickChip(host, 'kiro-cli');
    prompt()!.querySelector<HTMLInputElement>('.mcp-prompt-never-box')!.checked = true;
    button('.mcp-prompt-not-now').click();
    await flush();
    expect(store.dismiss).toHaveBeenCalledWith('kiro-cli');
    expect(launched()[0]).toMatch(/^kiro-cli 'Read the file/);
    await clickChip(host, 'kiro-cli');
    expect(prompt()).toBeNull();
    expect(launched()[1]).toMatch(/^kiro-cli 'Read the file/);
    expect(api.mcpInstallAgent).not.toHaveBeenCalled();
  });

  it('a dismissed agent (from config) is never prompted', async () => {
    const { host } = await setup({ dismissed: ['cursor-agent'] });
    await clickChip(host, 'cursor-agent');
    expect(prompt()).toBeNull();
    expect(launched()[0]).toMatch(/^cursor-agent 'Read the file/);
  });

  it('already installed → plain command, no prompt', async () => {
    api.mcpAgentInstalled.mockImplementation(async () => true);
    const { host } = await setup();
    await clickChip(host, 'cursor-agent');
    expect(prompt()).toBeNull();
    expect(launched()).toEqual(['cursor-agent']);
  });

  it('opencode injects silently: no prompt, no install check', async () => {
    const { host } = await setup();
    await clickChip(host, 'opencode');
    expect(prompt()).toBeNull();
    expect(api.mcpAgentInstalled).not.toHaveBeenCalled();
    expect(api.mcpInstallAgent).not.toHaveBeenCalled();
    expect(launched()[0]).toMatch(/^OPENCODE_CONFIG_CONTENT='\{"mcp":\{"sparkdown":/);
    expect(launched()[0]).toMatch(/' opencode$/);
  });

  it('unknown agents: teaching prompt, never the install prompt', async () => {
    const { host } = await setup();
    await clickChip(host, 'mystery');
    expect(prompt()).toBeNull();
    expect(api.mcpInstallAgent).not.toHaveBeenCalled();
    expect(launched()[0]).toMatch(/^mystery 'Read the file/);
  });

  it('no MCP server (no shim): no prompt, teaching prompt', async () => {
    const { host } = await setup();
    api.mcpShimCommand.mockImplementation(async () => null);
    await clickChip(host, 'gemini');
    expect(prompt()).toBeNull();
    expect(launched()[0]).toMatch(/^gemini 'Read the file/);
  });

  it('install failure → shows the error, then the teaching prompt', async () => {
    const { host, store } = await setup();
    api.mcpInstallAgent.mockImplementation(async () => {
      throw 'the agent CLI reported an error:\nboom';
    });
    await clickChip(host, 'gemini');
    button('.mcp-prompt-install').click();
    await flush();
    const status = prompt()!.querySelector<HTMLElement>('.mcp-prompt-status')!;
    expect(status.getAttribute('role')).toBe('alert');
    expect(status.textContent).toContain('boom');
    expect(api.terminalStart).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('.mcp-prompt-continue'));
    button('.mcp-prompt-continue').click();
    await flush();
    expect(prompt()).toBeNull();
    expect(store.dismiss).not.toHaveBeenCalled();
    expect(launched()[0]).toMatch(/^gemini 'Read the file/);
  });

  it('keyboard: Enter = Install', async () => {
    const { host } = await setup();
    await clickChip(host, 'grok');
    // Enter from the dialog itself (not a focused button) installs.
    prompt()!.focus();
    press('Enter');
    await flush();
    expect(api.mcpInstallAgent).toHaveBeenCalledWith('grok');
    expect(launched()).toEqual(['grok']);
  });

  it('keyboard: Escape = Not now', async () => {
    const { host, store } = await setup();
    await clickChip(host, 'grok');
    press('Escape');
    await flush();
    expect(prompt()).toBeNull();
    expect(api.mcpInstallAgent).not.toHaveBeenCalled();
    expect(store.dismiss).not.toHaveBeenCalled();
    expect(launched()[0]).toMatch(/^grok 'Read the file/);
  });

  it('remote workspace: Install goes through the (remote-aware) backend install', async () => {
    api.remoteSession.mockImplementation(async () => ({
      host: 'devbox',
      path: '/home/u/app',
      home: '/home/u',
    }));
    const remoteShim = { program: '/home/u/.cache/sparkdown/mcp-shim.sh', args: [] as string[] };
    const { host } = await setup();
    api.mcpShimCommand.mockImplementation(async () => remoteShim);
    await clickChip(host, 'cursor-agent');
    button('.mcp-prompt-install').click();
    await flush();
    expect(api.mcpInstallAgent).toHaveBeenCalledWith('cursor-agent');
    expect(launched()).toEqual(['cursor-agent']);
  });
});

describe('TerminalPane links', () => {
  type Click = { button: number; ctrlKey?: boolean; metaKey?: boolean };
  type Link = { text: string; range: unknown; activate: (e: Click) => void };
  const linksAt = async (row: number): Promise<Link[]> => {
    const t = terms.all[0]!;
    return await new Promise((resolve) =>
      t.linkProviders[0]!.provideLinks(row, (links) => resolve((links as Link[]) ?? [])),
    );
  };

  it('xterm row y (1-based) reads buffer line y-1; URLs open externally, paths in the app', async () => {
    const opened: string[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const mgr = new TerminalManager(host, (p) => opened.push(p));
    mgr.setCwd('/repo');
    await mgr.addTerminal();
    await flush();
    terms.all[0]!.rows_ = ['Edited src/app.ts', 'docs: https://sparkdown.dev/a). done'];

    const first = await linksAt(1);
    expect(first.map((l) => l.text)).toEqual(['src/app.ts']);
    first[0]!.activate({ button: 0 });
    expect(opened).toEqual(['src/app.ts']);

    const second = await linksAt(2);
    expect(second.map((l) => l.text)).toEqual(['https://sparkdown.dev/a']);
    second[0]!.activate({ button: 2 }); // not a primary click
    expect(api.openExternal).not.toHaveBeenCalled();
    second[0]!.activate({ button: 0, ctrlKey: true });
    expect(api.openExternal).toHaveBeenCalledWith('https://sparkdown.dev/a');
    expect(opened).toEqual(['src/app.ts']);
  });

  it('OSC 8 hyperlinks open only http(s) on primary click, through the same guard', async () => {
    const { mgr } = makeManager();
    await mgr.addTerminal();
    const handler = terms.all[0]!.options.linkHandler as {
      activate: (e: Click, uri: string) => void;
      allowNonHttpProtocols: boolean;
    };
    expect(handler.allowNonHttpProtocols).toBe(false);
    handler.activate({ button: 0, ctrlKey: true }, 'javascript:alert(1)');
    handler.activate({ button: 0, ctrlKey: true }, 'file:///etc/passwd');
    expect(api.openExternal).not.toHaveBeenCalled();
    handler.activate({ button: 2, ctrlKey: true }, 'https://sparkdown.dev/');
    handler.activate({ button: 0 }, 'https://sparkdown.dev/'); // plain click
    expect(api.openExternal).not.toHaveBeenCalled();
    handler.activate({ button: 0, ctrlKey: true }, 'https://sparkdown.dev/');
    expect(api.openExternal).toHaveBeenCalledTimes(1);
    expect(api.openExternal).toHaveBeenCalledWith('https://sparkdown.dev/');
  });

  it('box QA order: left, right, middle, then Ctrl+click opens exactly once', async () => {
    const { mgr } = makeManager();
    await mgr.addTerminal();
    await flush();
    terms.all[0]!.rows_ = ['see https://example.com/comfort-qa'];
    const [link] = await linksAt(1);
    expect(link!.text).toBe('https://example.com/comfort-qa');
    link!.activate({ button: 0 }); // plain left click: selection only
    link!.activate({ button: 2 }); // right
    link!.activate({ button: 1 }); // middle
    link!.activate({ button: 1, ctrlKey: true }); // Ctrl+middle
    link!.activate({ button: 0, metaKey: true }); // Super/Meta is not Ctrl off Mac
    expect(api.openExternal).not.toHaveBeenCalled();
    link!.activate({ button: 0, ctrlKey: true });
    expect(api.openExternal).toHaveBeenCalledTimes(1);
    expect(api.openExternal).toHaveBeenCalledWith('https://example.com/comfort-qa');
  });

  it('a disposed pane ignores late link-provider callbacks', async () => {
    const { mgr } = makeManager();
    await mgr.addTerminal();
    const t = terms.all[0]!;
    t.rows_ = ['see https://sparkdown.dev/a'];
    mgr.closeTerminal('term-1');
    const links = await new Promise((resolve) =>
      t.linkProviders[0]!.provideLinks(1, (l) => resolve(l ?? [])),
    );
    expect(links).toEqual([]);
  });
});

describe('TerminalPane scrollback', () => {
  it('new panes use the configured, clamped value; live panes update', async () => {
    const { mgr } = makeManager();
    mgr.setScrollback(12_345);
    await mgr.addTerminal();
    expect(terms.all[0]!.options.scrollback).toBe(12_345);
    mgr.setScrollback(10_000_000);
    expect(terms.all[0]!.options.scrollback).toBe(50_000);
    mgr.setScrollback(0);
    expect(terms.all[0]!.options.scrollback).toBe(200);
    mgr.setScrollback(Number.NaN);
    expect(terms.all[0]!.options.scrollback).toBe(5000);
  });
});

describe('TerminalManager find', () => {
  const input = (host: HTMLElement, id: string) =>
    card(host, id).querySelector<HTMLInputElement>('.sd-find-terminal .sd-find-input')!;

  it('the find key opens a bar on that pane and never reaches the shell or page', async () => {
    const { mgr, host } = makeManager();
    await mgr.addTerminal();
    await mgr.splitFocused('row');
    const ev = keydown({ key: 'F', ctrlKey: true, shiftKey: true });
    expect(terms.all[0]!.keyHandler!(ev)).toBe(false);
    expect(ev.stopPropagation).toHaveBeenCalled();
    expect(mgr.active()?.id).toBe('term-1');
    expect(input(host, 'term-1')).toBeTruthy();
    expect(document.activeElement).toBe(input(host, 'term-1'));
    expect(card(host, 'term-2').querySelector('.sd-find-terminal')).toBeNull();
    // Plain Ctrl+F stays the shell's forward-char.
    expect(terms.all[0]!.keyHandler!(keydown({ key: 'f', ctrlKey: true }))).toBe(true);
  });

  it('typing searches; Enter / Shift+Enter step; the count follows results', async () => {
    const { mgr, host } = makeManager();
    await mgr.addTerminal();
    expect(mgr.openFind()).toBe(true);
    const box = input(host, 'term-1');
    const count = card(host, 'term-1').querySelector('.sd-find-count')!;
    const addon = searches.all[0]!;
    box.value = 'err';
    box.dispatchEvent(new Event('input'));
    expect(last(addon.calls)).toMatchObject(['next', 'err', { incremental: true }]);
    expect((last(addon.calls)![2] as { decorations?: unknown }).decorations).toBeTruthy();
    addon.fire(0, 3);
    expect(count.textContent).toBe('1 of 3');

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    const docSpy = vi.fn();
    document.addEventListener('keydown', docSpy);
    box.dispatchEvent(enter);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    document.removeEventListener('keydown', docSpy);
    expect(addon.calls.slice(-2).map((c) => c[0])).toEqual(['next', 'prev']);
    expect(docSpy).not.toHaveBeenCalled();

    addon.fire(-1, 1000);
    expect(count.textContent).toBe('1000+');
    addon.fire(-1, 0);
    expect(count.textContent).toBe('No results');
  });

  it('Escape closes the bar, clears highlights and returns focus to the terminal', async () => {
    const { mgr, host } = makeManager();
    await mgr.addTerminal();
    mgr.openFind();
    const pane = mgr.active()!;
    const focus = vi.spyOn(pane, 'focus');
    const box = input(host, 'term-1');
    const docSpy = vi.fn();
    document.addEventListener('keydown', docSpy);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.removeEventListener('keydown', docSpy);
    expect(docSpy).not.toHaveBeenCalled();
    expect(card(host, 'term-1').querySelector<HTMLElement>('.sd-find-terminal')!.style.display).toBe(
      'none',
    );
    expect(last(searches.all[0]!.calls)![0]).toBe('clear');
    expect(focus).toHaveBeenCalled();
  });

  it('the bar survives a re-render and goes away with its pane', async () => {
    const { mgr, host } = makeManager();
    await mgr.addTerminal();
    mgr.openFind();
    const focusedSearch = input(host, 'term-1');
    focusedSearch.focus();
    await mgr.splitFocused('row');
    expect(card(host, 'term-1').querySelector('.sd-find-terminal')).toBeTruthy();
    expect(document.activeElement).toBe(input(host, 'term-1'));
    // Re-open find on the focused pane, then close a sibling: layout re-render
    // must restore find-bar focus instead of stealing it for xterm.
    mgr.activate('term-2');
    mgr.openFind();
    expect(document.activeElement).toBe(input(host, 'term-2'));
    mgr.closeTerminal('term-1');
    expect(document.activeElement).toBe(input(host, 'term-2'));
    mgr.closeTerminal('term-2');
    expect(host.querySelector('.sd-find-terminal')).toBeNull();
    expect(mgr.openFind('term-2')).toBe(false);
  });
});

describe('terminal URL click gate', () => {
  it('Linux/Windows: only Ctrl+primary; macOS: only Cmd+primary', () => {
    const c = (button: number, ctrlKey = false, metaKey = false) => ({ button, ctrlKey, metaKey });
    expect(isUrlOpenClick(c(0, true), false)).toBe(true);
    expect(isUrlOpenClick(c(0), false)).toBe(false);
    expect(isUrlOpenClick(c(1, true), false)).toBe(false);
    expect(isUrlOpenClick(c(2, true), false)).toBe(false);
    expect(isUrlOpenClick(c(0, false, true), false)).toBe(false);
    expect(isUrlOpenClick(c(0, false, true), true)).toBe(true);
    // Ctrl+click on a Mac is the context-menu click.
    expect(isUrlOpenClick(c(0, true), true)).toBe(false);
    expect(isUrlOpenClick(c(0, true, true), true)).toBe(false);
  });
});

describe('TerminalPane wheel on tmux panes', () => {
  const wheel = (deltaY: number) =>
    new WheelEvent('wheel', { deltaY, deltaMode: 0, cancelable: true });

  async function tmuxPane() {
    const { mgr } = makeManager({ tmux: true });
    await mgr.addTerminal();
    await flush();
    const t = terms.all[0]!;
    const session = api.terminalStart.mock.calls[0]![4]!;
    expect(session).toMatch(/^sd-/);
    return { mgr, t, session };
  }

  it('wheel up in tmux scrolls tmux history and never types into the shell', async () => {
    const { t, session } = await tmuxPane();
    t.buffer.active.type = 'alternate'; // tmux draws in the alternate screen
    const ev = wheel(-3 * TMUX_WHEEL_ROW_PX);
    expect(t.wheelHandler!(ev)).toBe(false); // xterm must not send Up keys
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(api.tmuxWheel).toHaveBeenCalledWith(session, 3);
    expect(api.terminalWrite).not.toHaveBeenCalled();
    expect(api.tmuxSendKeys).not.toHaveBeenCalled();
    t.wheelHandler!(wheel(2 * TMUX_WHEEL_ROW_PX));
    await flush();
    expect(api.tmuxWheel).toHaveBeenLastCalledWith(session, -2);
  });

  it('small trackpad deltas accumulate into whole lines', async () => {
    const { t, session } = await tmuxPane();
    t.buffer.active.type = 'alternate';
    t.wheelHandler!(wheel(-TMUX_WHEEL_ROW_PX / 2));
    await flush();
    expect(api.tmuxWheel).not.toHaveBeenCalled();
    t.wheelHandler!(wheel(-TMUX_WHEEL_ROW_PX / 2));
    await flush();
    expect(api.tmuxWheel).toHaveBeenCalledWith(session, 1);
  });

  it('typing after a wheel-up leaves copy mode first, then writes, in order', async () => {
    const { t, session } = await tmuxPane();
    t.buffer.active.type = 'alternate';
    const order: string[] = [];
    let release!: () => void;
    api.tmuxWheel.mockImplementation(async (_s: string, n: number) => {
      order.push(`wheel ${n}`);
      if (n > 0) await new Promise<void>((r) => (release = r));
    });
    api.terminalWrite.mockImplementation(async (_id: string, d: string) => {
      order.push(`write ${d}`);
    });
    t.wheelHandler!(wheel(-TMUX_WHEEL_ROW_PX));
    await flush();
    t.dataHandler!('l');
    t.dataHandler!('s');
    await flush();
    // Keys wait for the in-flight wheel call: nothing overtakes it.
    expect(order).toEqual(['wheel 1']);
    release();
    await flush();
    expect(order).toEqual(['wheel 1', 'wheel 0', 'write l', 'write s']);
    expect(api.tmuxWheel).toHaveBeenCalledWith(session, 0);
    api.tmuxWheel.mockImplementation(async () => {});
    api.terminalWrite.mockImplementation(async () => {});
  });

  it('plain shells, the normal buffer and mouse-reporting apps keep xterm defaults', async () => {
    const { t } = await tmuxPane();
    t.buffer.active.type = 'normal';
    expect(t.wheelHandler!(wheel(-50))).toBe(true);
    t.buffer.active.type = 'alternate';
    t.modes.mouseTrackingMode = 'any';
    expect(t.wheelHandler!(wheel(-50))).toBe(true);
    await flush();
    expect(api.tmuxWheel).not.toHaveBeenCalled();

    terms.all = [];
    const { mgr } = makeManager({ tmux: false });
    await mgr.addTerminal();
    await flush();
    const plain = terms.all[0]!;
    plain.buffer.active.type = 'alternate'; // e.g. less in a plain shell
    expect(plain.wheelHandler!(wheel(-50))).toBe(true);
    await flush();
    expect(api.tmuxWheel).not.toHaveBeenCalled();
  });
});
