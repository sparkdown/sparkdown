import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
const state = { status: { busy: [] as any[], unsaved: [] as string[] }, fail: false };
vi.mock('../api', () => ({
  api: {
    closeFolderStatus: vi.fn(async () => {
      calls.push('status');
      return state.status;
    }),
    closeFolder: vi.fn(async () => {
      calls.push('close-folder');
      if (state.fail) throw new Error('nope');
      return 'w-empty-2';
    }),
  },
}));
const ask = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (...a: unknown[]) => ask(...a) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ hide: vi.fn() }) }));
import { LifecycleController, quitConfirmText, CLOSE_FOLDER_QUESTION } from '../app/lifecycle';

function controller(root: string | null, resolve: () => Promise<boolean>) {
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
    destroy: vi.fn(() => {
      calls.push('destroy');
    }),
  };
  const ctx = { listenTauri: vi.fn(), workspaceRoot: root } as any;
  return { lc: new LifecycleController(ctx, deps), deps };
}

describe('File > Close Folder (#127)', () => {
  beforeEach(() => {
    calls.length = 0;
    state.status = { busy: [], unsaved: [] };
    state.fail = false;
    ask.mockReset();
  });

  it('does nothing without a folder (the item is greyed out too)', async () => {
    const { lc } = controller(null, async () => true);
    expect(await lc.closeFolder()).toBe(false);
    expect(calls).toEqual([]);
  });

  it('no running job: save prompts, then the core swaps in an empty window', async () => {
    const { lc } = controller('/w/alpha', async () => true);
    expect(await lc.closeFolder()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(calls).toEqual(['status', 'unsaved', 'persist', 'destroy', 'clear-agent', 'close-folder']);
  });

  it('a running job asks first, and Cancel keeps everything', async () => {
    state.status = { busy: [{ window: 'alpha', command: 'sleep', keeps_running: false }], unsaved: [] };
    ask.mockResolvedValue(false);
    const { lc, deps } = controller('/w/alpha', async () => true);
    expect(await lc.closeFolder()).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
    const [text, opts] = ask.mock.calls[0] as [string, { title: string; okLabel: string }];
    expect(text).toContain('sleep — alpha');
    expect(text).toContain('Close the folder and stop them?');
    expect(opts.title).toBe('Close Folder');
    expect(deps.resolveUnsavedChanges).not.toHaveBeenCalled();
    expect(calls).toEqual(['status']);
  });

  it('Cancel on the save prompt keeps the folder open', async () => {
    const { lc, deps } = controller('/w/alpha', async () => false);
    expect(await lc.closeFolder()).toBe(false);
    expect(deps.destroy).not.toHaveBeenCalled();
    expect(calls).toEqual(['status', 'unsaved']);
  });

  it('a check that fails still asks ("couldn\'t check"), never reads as idle', async () => {
    state.status = { busy: [{ window: 'alpha', command: '', unchecked: 'tmux did not answer' }], unsaved: [] };
    ask.mockResolvedValue(false);
    const { lc } = controller('/w/alpha', async () => true);
    await lc.closeFolder();
    expect(String(ask.mock.calls[0][0])).toContain("Couldn't check");
    expect(String(ask.mock.calls[0][0])).toContain('Close the folder anyway?');
  });

  it('the quit prompt wording is unchanged', () => {
    const s = { busy: [{ window: 'B', command: 'vim', keeps_running: false }], unsaved: [] };
    expect(quitConfirmText(s)).toMatch(/Quit SparkDown and stop them\?$/);
    expect(quitConfirmText(s, CLOSE_FOLDER_QUESTION)).toMatch(/Close the folder and stop them\?$/);
  });
});
