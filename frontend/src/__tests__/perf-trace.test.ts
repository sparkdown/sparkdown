import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async () => '');
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

async function load(dev: boolean) {
  vi.resetModules();
  vi.stubEnv('DEV', dev);
  return import('../perf-trace');
}

afterEach(() => {
  vi.unstubAllEnvs();
  invoke.mockClear();
});

describe('perf trace', () => {
  it('does nothing in a release build, even when the marker file exists', async () => {
    const t = await load(false);
    await t.initPerfTrace();
    t.trace('x', 1);
    t.span('y')();
    t.traceNextPaint('z');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reads the marker file in a dev build', async () => {
    const t = await load(true);
    await t.initPerfTrace();
    expect(invoke).toHaveBeenCalledWith('read_file', expect.objectContaining({ path: '/tmp/sparkdown-trace-enable' }));
  });
});
