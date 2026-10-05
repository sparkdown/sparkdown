import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { api } from '../api';

describe('api.watchStart pinning', () => {
  beforeEach(async () => {
    invoke.mockClear();
    await api.watchStop();
    invoke.mockClear();
  });

  it('invokes watch_start once for the workspace root', async () => {
    await api.watchStart('/proj');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('watch_start', { root: '/proj' });
  });

  it('does not restart the watcher for a nested path (tab switch)', async () => {
    await api.watchStart('/proj');
    invoke.mockClear();
    await api.watchStart('/proj/src');
    await api.watchStart('/proj/src/lib');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does restart when moving to a sibling or parent workspace', async () => {
    await api.watchStart('/proj/src');
    invoke.mockClear();
    await api.watchStart('/proj');
    expect(invoke).toHaveBeenCalledWith('watch_start', { root: '/proj' });
  });
});
