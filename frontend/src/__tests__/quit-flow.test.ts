import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
const state = { begin: true, prepare: true, status: { busy: [] as any[], unsaved: [] as string[] } };
vi.mock('../api', () => ({
  api: {
    quitBegin: vi.fn(async () => {
      calls.push('begin');
      return state.begin;
    }),
    quitEnd: vi.fn(async () => {
      calls.push('end');
    }),
    quitStatus: vi.fn(async () => state.status),
    quitPrepareOthers: vi.fn(async () => {
      calls.push('prepare');
      return state.prepare;
    }),
    quit: vi.fn(async () => {
      calls.push('quit');
    }),
  },
}));
const ask = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (...a: unknown[]) => ask(...a) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ hide: vi.fn() }) }));
import { LifecycleController } from '../app/lifecycle';

function controller(resolve: () => Promise<boolean>) {
  const deps = {
    resolveUnsavedChanges: vi.fn(resolve),
    persistConfig: vi.fn(async () => {}),
    clearAgentContext: vi.fn(async () => {}),
    destroy: vi.fn(),
  };
  return { lc: new LifecycleController({ listenTauri: vi.fn() } as any, deps), deps };
}

describe('quit flow (#88)', () => {
  beforeEach(() => {
    calls.length = 0;
    state.begin = true;
    state.prepare = true;
    state.status = { busy: [], unsaved: [] };
    ask.mockReset();
  });

  it('Cancel on the combined prompt keeps everything open', async () => {
    state.status = { busy: [{ window: 'B', command: 'sleep', keeps_running: true }], unsaved: ['A'] };
    ask.mockResolvedValue(false);
    const { lc, deps } = controller(async () => true);
    await lc.requestQuit();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(deps.resolveUnsavedChanges).not.toHaveBeenCalled();
    expect(calls).toEqual(['begin', 'end']);
  });

  it('Cancel on the save prompt does not quit', async () => {
    const { lc, deps } = controller(async () => false);
    await lc.requestQuit();
    expect(calls).toEqual(['begin', 'end']);
    expect(deps.destroy).not.toHaveBeenCalled();
  });

  it('another window cancelling stops the quit', async () => {
    state.prepare = false;
    const { lc } = controller(async () => true);
    await lc.requestQuit();
    expect(calls).toEqual(['begin', 'prepare', 'end']);
  });

  it('two quit requests at once run one flow (one prompt)', async () => {
    let release!: (v: boolean) => void;
    const { lc, deps } = controller(() => new Promise<boolean>((r) => (release = r)));
    const first = lc.requestQuit();
    const second = lc.requestQuit(); // same ⌘Q via the other native path
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    release(false);
    await Promise.all([first, second]);
    expect(deps.resolveUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c === 'begin')).toHaveLength(1);
  });

  it('does nothing when another window owns the quit', async () => {
    state.begin = false;
    const { lc, deps } = controller(async () => true);
    await lc.requestQuit();
    expect(deps.resolveUnsavedChanges).not.toHaveBeenCalled();
    expect(calls).toEqual(['begin', 'end']);
  });

  it('exits only after every window agreed', async () => {
    const { lc } = controller(async () => true);
    await lc.requestQuit();
    expect(calls).toEqual(['begin', 'prepare', 'quit']);
  });
});
