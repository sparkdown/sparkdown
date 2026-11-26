// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gitStatus = vi.fn();
const gitChangeStats = vi.fn();
vi.mock('../api', () => ({
  api: {
    gitStatus: (root: string) => gitStatus(root),
    gitChangeStats: (root: string, changes: unknown) => gitChangeStats(root, changes),
  },
}));

import { ChangesView, type OpenHow } from '../changes-view';
import { ReviewState } from '../review-state';
import type { GitChange } from '../api';

function setup(changes: GitChange[], conflict_op: string | null = 'merge') {
  gitStatus.mockResolvedValue({
    is_repo: true,
    top_level: '/repo',
    branch: 'main',
    changes,
    conflict_op,
  });
  gitChangeStats.mockImplementation(async (_root: string, list: GitChange[]) =>
    list.map((c) => ({
      path: c.path,
      adds: 1,
      dels: 1,
      binary: false,
      fingerprint: `${c.path}@1`,
    })),
  );
  const listEl = document.createElement('div');
  document.body.appendChild(listEl);
  const opened: Array<[string, OpenHow, GitChange['status']]> = [];
  const accepted: Array<[string, 'ours' | 'theirs']> = [];
  const cv = new ChangesView(
    listEl,
    (p, s, how) => opened.push([p, how, s]),
    () => {},
    {
      review: new ReviewState({ load: async () => ({}), save: async () => {} }, 0),
      onAcceptConflict: (path, side) => accepted.push([path, side]),
    },
  );
  cv.setRoot('/repo');
  return { cv, listEl, opened, accepted };
}

const files: GitChange[] = [
  { path: 'src/app.ts', status: 'conflicted', staged: false, conflict: 'both-modified' },
  { path: 'README.md', status: 'modified', staged: false },
  { path: 'package-lock.json', status: 'conflicted', staged: false, conflict: 'both-modified' },
];

describe('ChangesView conflicted group', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    gitStatus.mockReset();
    gitChangeStats.mockReset();
  });

  it('lists unmerged files in a Conflicted group above Worth reading', async () => {
    const { cv, listEl } = setup(files);
    await cv.refresh();
    const headings = [...listEl.querySelectorAll('.changes-group-h')].map((h) => h.textContent);
    expect(headings[0]).toMatch(/^Conflicted/);
    expect(headings.some((h) => h?.startsWith('Worth reading'))).toBe(true);
    const { conflicts, meat } = cv.groups();
    expect(conflicts.map((c) => c.path)).toEqual(['src/app.ts', 'package-lock.json']);
    expect(meat.map((c) => c.path)).toEqual(['README.md']);
    expect(cv.getConflictOp()).toBe('merge');
    expect(listEl.querySelectorAll('.change-badge.change-conflicted')).toHaveLength(2);
    expect(listEl.querySelectorAll('.change-accept')).toHaveLength(4);
  });

  it('opens a conflicted file in the editor and keeps Accept buttons working', async () => {
    const { cv, listEl, opened, accepted } = setup(files);
    await cv.refresh();
    const row = listEl.querySelector<HTMLElement>('.change-row[data-path="src/app.ts"]')!;
    row.click();
    expect(opened).toEqual([['src/app.ts', 'editor', 'conflicted']]);
    const ours = row.querySelector<HTMLElement>('.change-accept[data-side="ours"]')!;
    ours.click();
    expect(accepted).toEqual([['src/app.ts', 'ours']]);
    expect(opened).toHaveLength(1);
  });

  it('does not fold a conflicted lockfile into Probably noise', async () => {
    const { cv } = setup(files);
    await cv.refresh();
    const { conflicts, noise } = cv.groups();
    expect(conflicts.some((c) => c.path === 'package-lock.json')).toBe(true);
    expect(noise.some((c) => c.path === 'package-lock.json')).toBe(false);
  });
});
