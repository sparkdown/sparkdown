// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #47: git lists an untracked nested repo as a folder (`?? proj/`). The
 * Changes view must show it as a folder row that never opens a tab and never
 * joins the review queue, counts or line stats.
 */
const gitStatus = vi.fn();
const gitChangeStats = vi.fn();
vi.mock('../api', () => ({
  api: {
    gitStatus: (root: string) => gitStatus(root),
    gitChangeStats: (root: string, changes: unknown) => gitChangeStats(root, changes),
    reviewStateLoad: () => Promise.resolve({}),
    reviewStateSave: () => Promise.resolve(),
  },
}));

import { ChangesView } from '../changes-view';
import type { GitChange } from '../api';

function make() {
  const listEl = document.createElement('div');
  document.body.appendChild(listEl);
  const opened: string[] = [];
  const statuses: GitChange[][] = [];
  const pending: number[] = [];
  const cv = new ChangesView(
    listEl,
    (path) => opened.push(path),
    (c) => statuses.push(c),
    { onPending: (n) => pending.push(n) },
  );
  return { cv, listEl, opened, statuses, pending };
}

describe('Changes: untracked nested repo (#47)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    gitStatus.mockReset();
    gitChangeStats.mockReset();
    gitChangeStats.mockResolvedValue([]);
  });

  it('shows a folder row that does not open, and keeps it out of the queue', async () => {
    gitStatus.mockResolvedValue({
      is_repo: true,
      top_level: '/home/u',
      changes: [
        { path: 'proj', status: 'untracked', staged: false, is_dir: true },
        { path: 'notes.md', status: 'untracked', staged: false },
      ],
    });
    const { cv, listEl, opened, statuses, pending } = make();
    cv.setRoot('/home/u');
    await cv.refresh();

    // Stats are asked for files only.
    const asked = gitChangeStats.mock.calls[0][1] as GitChange[];
    expect(asked.map((c) => c.path)).toEqual(['notes.md']);
    // Callbacks and the queue see the file only.
    expect(statuses[statuses.length - 1]?.map((c) => c.path)).toEqual(['notes.md']);
    expect(pending[pending.length - 1]).toBe(1);
    expect(cv.change('proj')).toBeUndefined();

    const folder = listEl.querySelector<HTMLElement>('.change-row-folder');
    expect(folder).not.toBeNull();
    expect(folder!.textContent).toContain('proj/');
    expect(folder!.dataset.path).toBeUndefined();
    folder!.click();
    expect(opened).toEqual([]);
  });

  it('a tree with only a nested repo is not reported as clean', async () => {
    gitStatus.mockResolvedValue({
      is_repo: true,
      top_level: '/home/u',
      changes: [{ path: 'proj', status: 'untracked', staged: false, is_dir: true }],
    });
    const { cv, listEl, pending } = make();
    cv.setRoot('/home/u');
    await cv.refresh();
    expect(gitChangeStats).not.toHaveBeenCalled();
    expect(listEl.textContent).not.toContain('Working tree is clean');
    expect(listEl.querySelector('.change-row-folder')).not.toBeNull();
    expect(listEl.querySelector('.change-row:not(.change-row-folder)')).toBeNull();
    expect(pending[pending.length - 1]).toBe(0);
  });
});
