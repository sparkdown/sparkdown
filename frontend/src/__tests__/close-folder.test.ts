import { describe, it, expect, vi, beforeEach } from 'vitest';

// #127 File > Close Folder: same checks as closing a window (running
// terminals, then unsaved tabs, each with Cancel), then the core tears the
// folder down and the window reloads empty.
const calls: string[] = [];
const state = { status: { busy: [] as any[], unsaved: [] as string[] }, closeFails: false };
vi.mock('../api', () => ({
  api: {
    windowCloseStatus: vi.fn(async () => {
      calls.push('status');
      return state.status;
    }),
    windowCloseFolder: vi.fn(async () => {
      calls.push('close-folder');
      if (state.closeFails) throw new Error('boom');
      return [];
    }),
  },
}));
const ask = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (...a: unknown[]) => ask(...a) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ hide: vi.fn() }) }));
import { LifecycleController, closeFolderConfirmText } from '../app/lifecycle';

function controller(resolve: () => Promise<boolean>, hasFolder = true) {
  const deps = {
    resolveUnsavedChanges: vi.fn(async () => {
      calls.push('unsaved');
      return resolve();
    }),
    persistConfig: vi.fn(async () => {
      calls.push('persist');
    }),
    clearAgentContext: vi.fn(async () => {
      calls.push('clear-agent');
    }),
    destroy: vi.fn(() => calls.push('destroy')),
    hasFolder: vi.fn(() => hasFolder),
    suspendSaves: vi.fn(() => calls.push('suspend')),
    reload: vi.fn(() => calls.push('reload')),
  };
  return { lc: new LifecycleController({ listenTauri: vi.fn() } as any, deps), deps };
}

describe('Close Folder (#127)', () => {
  beforeEach(() => {
    calls.length = 0;
    state.status = { busy: [], unsaved: [] };
    state.closeFails = false;
    ask.mockReset();
  });

  it('Cancel on the unsaved-changes prompt keeps the folder open', async () => {
    const { lc, deps } = controller(async () => false);
    expect(await lc.closeFolder()).toBe(false);
    expect(calls).toEqual(['status', 'unsaved']);
    expect(deps.destroy).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('Cancel on the running-terminal prompt asks nothing else', async () => {
    state.status = { busy: [{ window: 'beta', command: 'sleep 300', keeps_running: false }], unsaved: [] };
    ask.mockResolvedValue(false);
    const { lc, deps } = controller(async () => true);
    expect(await lc.closeFolder()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][1]).toMatchObject({ title: 'Close Folder', cancelLabel: 'Cancel' });
    expect(deps.resolveUnsavedChanges).not.toHaveBeenCalled();
    expect(calls).toEqual(['status']);
  });

  it('confirmed: saves prefs, stops saving, tears down in the core, then reloads empty', async () => {
    state.status = { busy: [{ window: 'beta', command: 'sleep 300', keeps_running: false }], unsaved: [] };
    ask.mockResolvedValue(true);
    const { lc } = controller(async () => true);
    expect(await lc.closeFolder()).toBe(true);
    expect(calls).toEqual(['status', 'unsaved', 'persist', 'suspend', 'destroy', 'clear-agent', 'close-folder', 'reload']);
  });

  it('a failed teardown still reloads (listeners are already gone)', async () => {
    state.closeFails = true;
    const { lc, deps } = controller(async () => true);
    expect(await lc.closeFolder()).toBe(false);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a folder (the menu item is greyed out too)', async () => {
    const { lc } = controller(async () => true, false);
    expect(await lc.closeFolder()).toBe(false);
    expect(calls).toEqual([]);
  });

  it('a second request while one runs is dropped', async () => {
    let release!: (v: boolean) => void;
    const { lc, deps } = controller(() => new Promise<boolean>((r) => (release = r)));
    const first = lc.closeFolder();
    const second = lc.closeFolder();
    await new Promise((r) => setTimeout(r, 0));
    release(false);
    await Promise.all([first, second]);
    expect(deps.resolveUnsavedChanges).toHaveBeenCalledTimes(1);
  });

  it('the prompt says the jobs will stop, tmux too, never "keeps running"', () => {
    const t = closeFolderConfirmText({
      busy: [{ window: 'beta', command: 'sleep 300', keeps_running: false }],
      unsaved: [],
    })!;
    expect(t).toContain('sleep 300');
    expect(t).toContain('will stop');
    expect(t).toContain('tmux');
    expect(t).not.toContain('keeps running');
    expect(closeFolderConfirmText({ busy: [], unsaved: ['beta'] })).toBeNull();
    const u = closeFolderConfirmText({ busy: [{ window: 'beta', command: '', unchecked: 'no answer' }], unsaved: [] })!;
    expect(u).toContain("Couldn't check");
    expect(u).toContain('anyway');
  });
});
