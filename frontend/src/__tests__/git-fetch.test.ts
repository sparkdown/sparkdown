import { describe, it, expect, vi } from 'vitest';
import { BackgroundFetcher, FETCH_INTERVAL_MS, MIN_GAP_MS, fetchedAgo, type BackgroundFetchOptions } from '../git-fetch';

function make(over: Partial<BackgroundFetchOptions> = {}) {
  let now = 1_000_000;
  let tick: (() => void) | null = null;
  const clear = vi.fn();
  const fetch = vi.fn(async (_root: string): Promise<unknown> => 'fetched');
  const onFetched = vi.fn();
  const f = new BackgroundFetcher({
    enabled: () => true,
    repoRoot: () => '/repo',
    isRemote: () => false,
    hasUpstream: () => true,
    fetch,
    onFetched,
    now: () => now,
    setInterval: (fn, ms) => {
      expect(ms).toBe(FETCH_INTERVAL_MS);
      tick = fn;
      return 7;
    },
    clearInterval: clear,
    ...over,
  });
  return {
    f,
    fetch,
    onFetched,
    clear,
    advance: (ms: number) => (now += ms),
    tick: () => tick?.(),
    hasTimer: () => tick !== null,
  };
}

describe('BackgroundFetcher (#175)', () => {
  it('fetches on focus, refreshes the branch, and records the time', async () => {
    const t = make();
    t.f.setFocused(true);
    await vi.waitFor(() => expect(t.onFetched).toHaveBeenCalledTimes(1));
    expect(t.fetch).toHaveBeenCalledWith('/repo');
    expect(t.f.lastFetchedAt()).toBe(1_000_000);
  });

  it('fetches every 5 minutes while focused and stops on blur', async () => {
    const t = make();
    t.f.setFocused(true);
    await vi.waitFor(() => expect(t.onFetched).toHaveBeenCalledTimes(1));
    expect(t.hasTimer()).toBe(true);
    t.advance(FETCH_INTERVAL_MS);
    t.tick();
    await vi.waitFor(() => expect(t.onFetched).toHaveBeenCalledTimes(2));
    t.f.setFocused(false);
    expect(t.clear).toHaveBeenCalledWith(7);
  });

  it('a focus burst right after a fetch does not fetch again', async () => {
    const t = make();
    t.f.setFocused(true);
    await vi.waitFor(() => expect(t.onFetched).toHaveBeenCalledTimes(1));
    t.f.setFocused(false);
    t.advance(MIN_GAP_MS - 1);
    t.f.setFocused(true);
    await Promise.resolve();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    t.f.setFocused(false);
    t.advance(2);
    t.f.setFocused(true);
    await vi.waitFor(() => expect(t.onFetched).toHaveBeenCalledTimes(2));
  });

  it('at most one fetch in flight', async () => {
    let release!: () => void;
    const t = make({
      fetch: vi.fn(
        () =>
          new Promise<unknown>((r) => {
            release = () => r('fetched');
          }),
      ),
    });
    const a = t.f.run();
    const b = t.f.afterRejectedPush();
    expect(a).toBe(b);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    expect(await a).toBe(true);
  });

  it('a rejected push fetches even right after a focus fetch', async () => {
    const t = make();
    t.f.setFocused(true);
    await vi.waitFor(() => expect(t.onFetched).toHaveBeenCalledTimes(1));
    await t.f.afterRejectedPush();
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['the setting is off', { enabled: () => false }],
    ['remote (SSH) session', { isRemote: () => true }],
    ['no upstream', { hasUpstream: () => false }],
    ['no repo', { repoRoot: () => null }],
  ])('never fetches when %s', async (_why, over) => {
    const t = make(over as Partial<BackgroundFetchOptions>);
    t.f.setFocused(true);
    expect(await t.f.run()).toBe(false);
    expect(await t.f.afterRejectedPush()).toBe(false);
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it('failures are silent and do not refresh', async () => {
    const t = make({ fetch: vi.fn(async () => Promise.reject({ kind: 'auth' })) });
    expect(await t.f.run()).toBe(false);
    expect(t.onFetched).not.toHaveBeenCalled();
    expect(t.f.lastFetchedAt()).toBeNull();
  });

  it('a busy answer from the core is not a fetch', async () => {
    const t = make({ fetch: vi.fn(async () => 'busy') });
    expect(await t.f.run()).toBe(false);
    expect(t.onFetched).not.toHaveBeenCalled();
  });

  it('formats the tooltip age', () => {
    expect(fetchedAgo(null)).toBeNull();
    expect(fetchedAgo(0, 30_000)).toBe('last fetched just now');
    expect(fetchedAgo(0, 60_000)).toBe('last fetched 1 min ago');
    expect(fetchedAgo(0, 125 * 60_000)).toBe('last fetched 2 h ago');
  });
});
