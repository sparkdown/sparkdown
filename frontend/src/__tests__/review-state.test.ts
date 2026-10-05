import { describe, it, expect, vi } from 'vitest';
import {
  ReviewState,
  MAX_REVIEW_ENTRIES,
  workspaceId,
  type ReviewPersistence,
} from '../review-state';

/** An in-memory persistence, like review_state_* over a JSON file. */
function memoryStore() {
  const data = new Map<string, Record<string, string>>();
  const store: ReviewPersistence & { data: typeof data; saves: number } = {
    data,
    saves: 0,
    load: async (ws) => ({ ...(data.get(ws) ?? {}) }),
    save: async (ws, entries) => {
      store.saves++;
      if (Object.keys(entries).length === 0) data.delete(ws);
      else data.set(ws, { ...entries });
    },
  };
  return store;
}

const prints = (o: Record<string, string>) => new Map(Object.entries(o));

describe('ReviewState', () => {
  it('a reviewed file becomes pending again when its fingerprint moves', async () => {
    const r = new ReviewState(memoryStore(), 0);
    await r.setWorkspace(workspaceId(null, '/repo'));
    r.set('a.md', 'fp1', true);
    expect(r.isReviewed('a.md', 'fp1')).toBe(true);
    expect(r.pendingCount(prints({ 'a.md': 'fp1', 'b.md': 'x' }))).toBe(1);

    // The file changes again: new fingerprint → pending and flagged; the
    // stale mark stays (it is the "changed again" record).
    r.reconcile(prints({ 'a.md': 'fp2', 'b.md': 'x' }));
    expect(r.isReviewed('a.md', 'fp2')).toBe(false);
    expect(r.isChangedAgain('a.md')).toBe(true);
    expect(r.changedAgainCount()).toBe(1);
    expect(r.entries()).toEqual({ 'a.md': 'fp1' });
    expect(r.pendingCount(prints({ 'a.md': 'fp2', 'b.md': 'x' }))).toBe(2);

    // Reviewing it again clears the flag.
    r.set('a.md', 'fp2', true);
    expect(r.isChangedAgain('a.md')).toBe(false);
  });

  it('drops marks for files no longer changed', async () => {
    const r = new ReviewState(memoryStore(), 0);
    await r.setWorkspace('local\n/repo');
    r.set('a.md', 'fp', true);
    r.set('b.md', 'fp', true);
    r.reconcile(prints({ 'b.md': 'fp' }));
    expect(r.entries()).toEqual({ 'b.md': 'fp' });
    expect(r.isChangedAgain('a.md')).toBe(false);
  });

  it('persists per workspace and round-trips through a restart', async () => {
    const store = memoryStore();
    const r = new ReviewState(store, 0);
    await r.setWorkspace(workspaceId(null, '/repo'));
    r.set('a.md', 'fp', true);
    await r.flush();
    expect(store.data.get('local\n/repo')).toEqual({ 'a.md': 'fp' });

    // Another machine with the same path is a different workspace.
    await r.setWorkspace(workspaceId('devbox', '/repo'));
    expect(r.isReviewed('a.md', 'fp')).toBe(false);

    const restarted = new ReviewState(store, 0);
    await restarted.setWorkspace(workspaceId(null, '/repo'));
    expect(restarted.isReviewed('a.md', 'fp')).toBe(true);

    restarted.clear();
    await restarted.flush();
    expect(store.data.has('local\n/repo')).toBe(false);
  });

  it('a "changed again" file stays flagged across a restart', async () => {
    const store = memoryStore();
    const ws = workspaceId(null, '/repo');
    const r = new ReviewState(store, 0);
    await r.setWorkspace(ws);
    r.reconcile(prints({ 'a.md': 'fp1', 'b.md': 'x' }));
    r.set('a.md', 'fp1', true);
    // The agent edits a.md after the review.
    r.reconcile(prints({ 'a.md': 'fp2', 'b.md': 'x' }));
    expect(r.isChangedAgain('a.md')).toBe(true);
    await r.flush();
    expect(store.data.get(ws)).toEqual({ 'a.md': 'fp1' });

    // Restart: load, then the first change list arrives.
    const restarted = new ReviewState(store, 0);
    await restarted.setWorkspace(ws);
    restarted.reconcile(prints({ 'a.md': 'fp2', 'b.md': 'x' }));
    expect(restarted.isReviewed('a.md', 'fp2')).toBe(false);
    expect(restarted.isChangedAgain('a.md')).toBe(true);
    expect(restarted.changedAgainCount()).toBe(1);
    expect(restarted.pendingCount(prints({ 'a.md': 'fp2', 'b.md': 'x' }))).toBe(2);

    // Reviewing it again clears the flag, and that persists too.
    restarted.set('a.md', 'fp2', true);
    expect(restarted.isChangedAgain('a.md')).toBe(false);
    await restarted.flush();
    expect(store.data.get(ws)).toEqual({ 'a.md': 'fp2' });
    const again = new ReviewState(store, 0);
    await again.setWorkspace(ws);
    again.reconcile(prints({ 'a.md': 'fp2' }));
    expect(again.isReviewed('a.md', 'fp2')).toBe(true);
    expect(again.isChangedAgain('a.md')).toBe(false);
  });

  it('a stale mark is dropped (and persisted) once the file is no longer changed', async () => {
    const store = memoryStore();
    const ws = workspaceId(null, '/repo');
    const r = new ReviewState(store, 0);
    await r.setWorkspace(ws);
    r.set('a.md', 'fp1', true);
    r.reconcile(prints({ 'a.md': 'fp2' }));
    expect(r.isChangedAgain('a.md')).toBe(true);
    await r.flush();

    const restarted = new ReviewState(store, 0);
    await restarted.setWorkspace(ws);
    restarted.reconcile(prints({})); // committed or reverted
    expect(restarted.isChangedAgain('a.md')).toBe(false);
    expect(restarted.changedAgainCount()).toBe(0);
    expect(restarted.entries()).toEqual({});
    await restarted.flush();
    expect(store.data.has(ws)).toBe(false);
  });

  it('marking a changed-again file pending clears the flag', async () => {
    const r = new ReviewState(memoryStore(), 0);
    await r.setWorkspace('local\n/repo');
    r.set('a.md', 'fp1', true);
    r.reconcile(prints({ 'a.md': 'fp2' }));
    r.set('a.md', 'fp2', false);
    expect(r.isChangedAgain('a.md')).toBe(false);
    expect(r.entries()).toEqual({});
  });

  it('caps entries, oldest first', async () => {
    const r = new ReviewState(memoryStore(), 0);
    await r.setWorkspace('local\n/big');
    for (let i = 0; i < MAX_REVIEW_ENTRIES + 5; i++) r.set(`f${i}`, 'x', true);
    const e = r.entries();
    expect(Object.keys(e).length).toBe(MAX_REVIEW_ENTRIES);
    expect(e.f0).toBeUndefined();
    expect(e[`f${MAX_REVIEW_ENTRIES + 4}`]).toBe('x');
  });

  it('debounces saves and survives a failing store', async () => {
    vi.useFakeTimers();
    try {
      const store = memoryStore();
      const r = new ReviewState(store, 250);
      await r.setWorkspace('local\n/repo');
      r.set('a', '1', true);
      r.set('b', '1', true);
      expect(store.saves).toBe(0);
      await vi.advanceTimersByTimeAsync(300);
      expect(store.saves).toBe(1);

      const broken = new ReviewState(
        { load: () => Promise.reject(new Error('io')), save: () => Promise.reject(new Error('io')) },
        0,
      );
      await broken.setWorkspace('local\n/x');
      broken.set('a', '1', true);
      await broken.flush();
      expect(broken.isReviewed('a', '1')).toBe(true); // kept in memory
    } finally {
      vi.useRealTimers();
    }
  });

  it('a slow load for a previous workspace is dropped', async () => {
    let release!: (v: Record<string, string>) => void;
    const store: ReviewPersistence = {
      load: (ws) =>
        ws === 'A' ? new Promise((r) => (release = r)) : Promise.resolve({ 'b.md': 'fp' }),
      save: async () => {},
    };
    const r = new ReviewState(store, 0);
    const pA = r.setWorkspace('A');
    await r.setWorkspace('B');
    release({ 'a.md': 'fp' });
    await pA;
    expect(r.getWorkspace()).toBe('B');
    expect(r.entries()).toEqual({ 'b.md': 'fp' });
  });
});
