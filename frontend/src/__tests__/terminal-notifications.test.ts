import { describe, it, expect } from 'vitest';

/**
 * Terminal notification rate limiting tests.
 * The rate limiter lives in TerminalManager (terminal.ts) and enforces
 * 1 notification per pane per 10 seconds.
 */

class MockRateLimiter {
  private timestamps = new Map<string, number>();
  private readonly RATE_LIMIT_MS = 10_000;

  canNotify(paneId: string, now: number): boolean {
    const last = this.timestamps.get(paneId);
    if (last !== undefined && now - last < this.RATE_LIMIT_MS) {
      return false;
    }
    this.timestamps.set(paneId, now);
    return true;
  }

  reset(): void {
    this.timestamps.clear();
  }
}

describe('Terminal notification rate limiting', () => {
  it('allows the first notification immediately', () => {
    const limiter = new MockRateLimiter();
    expect(limiter.canNotify('pane-1', 0)).toBe(true);
  });

  it('blocks a second notification within 10 seconds', () => {
    const limiter = new MockRateLimiter();
    const now = 1000;
    expect(limiter.canNotify('pane-1', now)).toBe(true);
    expect(limiter.canNotify('pane-1', now + 5000)).toBe(false);
    expect(limiter.canNotify('pane-1', now + 9999)).toBe(false);
  });

  it('allows a notification after 10 seconds', () => {
    const limiter = new MockRateLimiter();
    const now = 1000;
    expect(limiter.canNotify('pane-1', now)).toBe(true);
    expect(limiter.canNotify('pane-1', now + 10_000)).toBe(true);
  });

  it('tracks different panes independently', () => {
    const limiter = new MockRateLimiter();
    const now = 2000;
    expect(limiter.canNotify('pane-1', now)).toBe(true);
    expect(limiter.canNotify('pane-2', now + 100)).toBe(true);
    expect(limiter.canNotify('pane-1', now + 5000)).toBe(false);
    expect(limiter.canNotify('pane-2', now + 5000)).toBe(false);
  });

  it('reset clears all timestamps', () => {
    const limiter = new MockRateLimiter();
    expect(limiter.canNotify('pane-1', 1000)).toBe(true);
    expect(limiter.canNotify('pane-1', 5000)).toBe(false);
    limiter.reset();
    expect(limiter.canNotify('pane-1', 6000)).toBe(true);
  });

  it('handles rapid fire attempts', () => {
    const limiter = new MockRateLimiter();
    const base = 10_000;
    expect(limiter.canNotify('pane-1', base)).toBe(true);
    for (let i = 1; i < 100; i++) {
      expect(limiter.canNotify('pane-1', base + i * 100)).toBe(false);
    }
    expect(limiter.canNotify('pane-1', base + 10_000)).toBe(true);
  });
});
