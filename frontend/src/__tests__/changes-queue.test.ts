// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Changes review queue (UI revamp phase 5): ordering, keyboard, Space
 * flow, the pending count behind the badge, the collapsed noise group, and
 * the stale-stats guard.
 */
const gitStatus = vi.fn();
const gitChangeStats = vi.fn();
vi.mock('../api', () => ({
  api: {
    gitStatus: (root: string) => gitStatus(root),
    gitChangeStats: (root: string, changes: unknown) => gitChangeStats(root, changes),
  },
}));

import { ChangesView, type OpenHow } from '../changes-view';
import { ReviewState, type ReviewPersistence } from '../review-state';
import type { GitChange } from '../api';

const files: Array<[string, GitChange['status']]> = [
  ['docs/design.md', 'modified'],
  ['src/mcp.rs', 'modified'],
  ['package-lock.json', 'modified'],
  ['README.md', 'added'],
  ['dist/app.js', 'modified'],
];

let prints: Record<string, string> = {};

function setup(
  store: ReviewPersistence = { load: async () => ({}), save: async () => {} },
  keepPrints = false,
) {
  if (!keepPrints) prints = {};
  gitStatus.mockResolvedValue({
    is_repo: true,
    top_level: '/repo',
    branch: 'main',
    changes: files.map(([path, status]) => ({ path, status, staged: false })),
  });
  gitChangeStats.mockImplementation(async (_root: string, changes: GitChange[]) =>
    changes.map((c) => ({
      path: c.path,
      adds: c.path === 'README.md' ? 3 : 2,
      dels: c.status === 'added' ? 0 : 1,
      binary: false,
      fingerprint: prints[c.path] ?? `${c.path}@1`,
    })),
  );
  const listEl = document.createElement('div');
  document.body.appendChild(listEl);
  const opened: Array<[string, OpenHow]> = [];
  const pending: number[] = [];
  const cv = new ChangesView(listEl, (p, _s, how) => opened.push([p, how]), () => {}, {
    review: new ReviewState(store, 0),
    onPending: (n) => pending.push(n),
  });
  cv.setRoot('/repo');
  return { cv, listEl, opened, pending };
}

const last = <T>(a: T[]): T | undefined => a[a.length - 1];
const rowPaths = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('.change-row')].map((r) => r.dataset.path);
const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));

describe('ChangesView review queue', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    gitStatus.mockReset();
    gitChangeStats.mockReset();
  });

  it('renders the summary, counts, and a collapsed noise group', async () => {
    const { cv, listEl, pending } = setup();
    await cv.refresh();
    expect(listEl.querySelector('.changes-review-top')?.textContent).toBe('0 / 3 reviewed');
    expect(listEl.querySelectorAll('.changes-meter i').length).toBe(3);
    expect(rowPaths(listEl)).toEqual(['docs/design.md', 'src/mcp.rs', 'README.md']);
    const toggle = listEl.querySelector<HTMLElement>('.changes-noise-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.querySelector('.changes-group-count')?.textContent).toBe('2');
    // +/− counts, folder dim, status letter.
    const readme = listEl.querySelector('[data-path="README.md"]')!;
    expect(readme.querySelector('.change-counts')?.textContent).toBe('+3');
    expect(listEl.querySelector('[data-path="src/mcp.rs"] .change-counts')?.textContent).toBe('+2 −1');
    expect(listEl.querySelector('[data-path="src/mcp.rs"] .change-dir')?.textContent).toBe('src');
    expect(readme.querySelector('.change-badge')?.textContent).toBe('A');
    // Badge = pending files of the queue (noise excluded).
    expect(last(pending)).toBe(3);

    toggle.click();
    expect(rowPaths(listEl)).toContain('dist/app.js');
    expect(listEl.querySelectorAll('.change-row-noise').length).toBe(2);
  });

  it('↓/↑ move and open; Space marks reviewed and opens the next pending', async () => {
    const { cv, listEl, opened, pending } = setup();
    await cv.refresh();
    press(listEl, 'ArrowDown');
    expect(last(opened)).toEqual(['docs/design.md', 'diff']);
    press(listEl, 'j'); // vim alias still works
    expect(last(opened)).toEqual(['src/mcp.rs', 'diff']);
    press(listEl, 'ArrowUp');
    expect(cv.getCurrent()).toBe('docs/design.md');
    press(listEl, 'k'); // at the top: stays
    expect(cv.getCurrent()).toBe('docs/design.md');

    press(listEl, ' ');
    expect(cv.isReviewed('docs/design.md')).toBe(true);
    expect(last(opened)).toEqual(['src/mcp.rs', 'diff']);
    expect(last(pending)).toBe(2);
    // Reviewed rows sort after pending ones within their group, and dim.
    expect(rowPaths(listEl)).toEqual(['src/mcp.rs', 'README.md', 'docs/design.md']);
    expect(listEl.querySelector('[data-path="docs/design.md"]')?.classList.contains('reviewed')).toBe(true);
    expect(listEl.querySelector('.changes-review-top')?.textContent).toBe('1 / 3 reviewed');
    expect(listEl.querySelectorAll('.changes-meter i.done').length).toBe(1);
    expect(listEl.querySelectorAll('.changes-meter i.now').length).toBe(1);

    press(listEl, ' ');
    press(listEl, ' ');
    expect(last(pending)).toBe(0);
    expect(listEl.querySelector('.changes-review-sub')?.textContent).toBe('All caught up');
    // Space on a reviewed file toggles it back to pending and stays put.
    const before = opened.length;
    const cur = cv.getCurrent()!;
    press(listEl, ' ');
    expect(opened.length).toBe(before);
    expect(cv.getCurrent()).toBe(cur);
    expect(cv.isReviewed(cur)).toBe(false);
    expect(last(pending)).toBe(1);
    // …and Space again marks it reviewed.
    press(listEl, ' ');
    expect(cv.isReviewed(cur)).toBe(true);
    expect(last(pending)).toBe(0);

    // Enter opens the diff; Shift+Enter the editor.
    press(listEl, 'Enter');
    expect(last(opened)?.[1]).toBe('diff');
    press(listEl, 'Enter', { shiftKey: true });
    expect(last(opened)?.[1]).toBe('editor');
  });

  it('Space wraps to the first pending file above', async () => {
    const { cv, opened } = setup();
    await cv.refresh();
    cv.select('README.md');
    cv.markReviewedAndNext();
    expect(last(opened)).toEqual(['docs/design.md', 'diff']);
  });

  it('ignores modified keys and keys from inputs', async () => {
    const { cv, listEl, opened } = setup();
    await cv.refresh();
    press(listEl, 'j', { metaKey: true });
    const input = document.createElement('input');
    listEl.appendChild(input);
    press(input, 'j');
    expect(opened).toEqual([]);
  });

  it('checkbox toggles reviewed without opening', async () => {
    const { cv, listEl, opened } = setup();
    await cv.refresh();
    listEl.querySelector<HTMLElement>('[data-path="src/mcp.rs"] .change-check')!.click();
    expect(cv.isReviewed('src/mcp.rs')).toBe(true);
    expect(opened).toEqual([]);
    listEl.querySelector<HTMLElement>('[data-path="src/mcp.rs"] .change-check')!.click();
    expect(cv.isReviewed('src/mcp.rs')).toBe(false);
  });

  it('a file edited after review is pending again on the next refresh', async () => {
    const { cv, pending } = setup();
    await cv.refresh();
    cv.setReviewed('src/mcp.rs', true);
    expect(last(pending)).toBe(2);
    prints['src/mcp.rs'] = 'src/mcp.rs@2';
    await cv.refresh();
    expect(cv.isReviewed('src/mcp.rs')).toBe(false);
    expect(last(pending)).toBe(3);
    expect(cv.review.isChangedAgain('src/mcp.rs')).toBe(true);
  });

  it('"changed again" survives a restart until reviewed again or no longer changed', async () => {
    const data = new Map<string, Record<string, string>>();
    const store: ReviewPersistence = {
      load: async (ws) => ({ ...(data.get(ws) ?? {}) }),
      save: async (ws, entries) => {
        if (Object.keys(entries).length === 0) data.delete(ws);
        else data.set(ws, { ...entries });
      },
    };
    const first = setup(store);
    await first.cv.refresh();
    first.cv.setReviewed('src/mcp.rs', true);
    prints['src/mcp.rs'] = 'src/mcp.rs@2'; // the agent edits it after review
    await first.cv.refresh();
    await first.cv.review.flush();
    first.listEl.remove();

    // Restart: a fresh view and review state over the same store.
    const { cv, listEl } = setup(store, true);
    await cv.refresh();
    expect(cv.isReviewed('src/mcp.rs')).toBe(false);
    expect(cv.review.isChangedAgain('src/mcp.rs')).toBe(true);
    expect(listEl.querySelector('.change-row.changed-again')?.getAttribute('data-path')).toBe(
      'src/mcp.rs',
    );
    expect(listEl.querySelector('.changes-review-sub')?.textContent).toBe(
      '1 changed again since you reviewed it',
    );

    // Reviewed again: flag gone.
    cv.setReviewed('src/mcp.rs', true);
    expect(listEl.querySelector('.change-row.changed-again')).toBeNull();

    // Changed again, then no longer changed at all: the mark is dropped.
    prints['src/mcp.rs'] = 'src/mcp.rs@3';
    await cv.refresh();
    expect(cv.review.isChangedAgain('src/mcp.rs')).toBe(true);
    gitStatus.mockResolvedValue({
      is_repo: true,
      top_level: '/repo',
      branch: 'main',
      changes: files
        .filter(([path]) => path !== 'src/mcp.rs')
        .map(([path, status]) => ({ path, status, staged: false })),
    });
    await cv.refresh();
    expect(cv.review.isChangedAgain('src/mcp.rs')).toBe(false);
    expect(cv.review.entries()['src/mcp.rs']).toBeUndefined();
  });

  it('a failed stats call keeps the marks (no false reset)', async () => {
    const { cv, pending } = setup();
    await cv.refresh();
    cv.setReviewed('src/mcp.rs', true);
    gitChangeStats.mockRejectedValueOnce(new Error('ssh dropped'));
    await cv.refresh();
    expect(cv.isReviewed('src/mcp.rs')).toBe(true);
    expect(last(pending)).toBe(2);
  });

  it('mark all and reset', async () => {
    const { cv, pending } = setup();
    await cv.refresh();
    cv.markAllReviewed();
    expect(last(pending)).toBe(0);
    cv.resetReview();
    expect(last(pending)).toBe(3);
  });

  it('only noise changed: the noise files are the queue, shown open', async () => {
    const { cv, listEl, pending } = setup();
    gitStatus.mockResolvedValue({
      is_repo: true,
      top_level: '/repo',
      branch: 'main',
      changes: [{ path: 'Cargo.lock', status: 'modified', staged: false }],
    });
    await cv.refresh();
    expect(last(pending)).toBe(1);
    expect(listEl.textContent).toContain('Only generated / dependency files changed.');
    expect(rowPaths(listEl)).toEqual(['Cargo.lock']);
  });
});
