// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Guards ChangesView.refresh / refreshCount against a stale git status
 * overwriting the current folder after a quick A -> B switch (finding #3).
 * The slow status for the folder we switched away from must be dropped.
 */
const gitStatus = vi.fn();
vi.mock('../api', () => ({
  api: { gitStatus: (root: string) => gitStatus(root) },
}));

import { ChangesView } from '../changes-view';
import type { GitChange } from '../api';

type Status = { is_repo: boolean; top_level: string | null; changes: GitChange[] };

function repo(top: string, paths: string[]): Status {
  return {
    is_repo: true,
    top_level: top,
    changes: paths.map((p) => ({ path: p, status: 'modified' }) as GitChange),
  };
}

function make() {
  const listEl = document.createElement('div');
  document.body.appendChild(listEl);
  const statuses: GitChange[][] = [];
  const cv = new ChangesView(listEl, () => {}, (c) => statuses.push(c));
  return { cv, statuses };
}

describe('ChangesView stale-result guard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    gitStatus.mockReset();
  });

  it('refresh: a slow status for the previous folder does not overwrite the current one', async () => {
    let resolveA!: (s: Status) => void;
    gitStatus.mockImplementation((root: string) => {
      if (root === '/A') return new Promise<Status>((r) => (resolveA = r));
      return Promise.resolve(repo('/B', ['b.md']));
    });

    const { cv, statuses } = make();
    cv.setRoot('/A');
    const pA = cv.refresh(); // blocks on resolveA
    cv.setRoot('/B');
    await cv.refresh(); // resolves to B immediately

    expect(cv.getRepoRoot()).toBe('/B');

    // A's status arrives late; it must be dropped, not applied.
    resolveA(repo('/A', ['a.md']));
    await pA;

    expect(cv.getRepoRoot()).toBe('/B');
    // The last status pushed to the badge is B's, never A's.
    expect(statuses[statuses.length - 1]?.map((c: GitChange) => c.path)).toEqual(['b.md']);
  });

  it('refreshCount: a stale count for the previous folder is dropped', async () => {
    let resolveA!: (s: Status) => void;
    gitStatus.mockImplementation((root: string) => {
      if (root === '/A') return new Promise<Status>((r) => (resolveA = r));
      return Promise.resolve(repo('/B', ['b1.md', 'b2.md']));
    });

    const { cv, statuses } = make();
    cv.setRoot('/A');
    const pA = cv.refreshCount();
    cv.setRoot('/B');
    await cv.refreshCount();

    resolveA(repo('/A', ['a.md']));
    await pA;

    expect(cv.getRepoRoot()).toBe('/B');
    expect(statuses[statuses.length - 1]?.map((c: GitChange) => c.path)).toEqual([
      'b1.md',
      'b2.md',
    ]);
  });
});
