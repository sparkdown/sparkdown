// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  REMOTE_DISCARD_REASON,
  discardDialogHtml,
  dirtyTabsFor,
  runDiscard,
  showDiscardDialog,
  tabFate,
  type DiscardChoice,
  type DiscardDeps,
  type DiscardTab,
} from '../changes-discard';
import type { DiscardItem, DiscardRequest, DiscardResult } from '../api';

const ROOT = '/repo';

function item(path: string, action: DiscardItem['action'], extra: Partial<DiscardItem> = {}): DiscardItem {
  return {
    path,
    action,
    detail: action === 'delete' ? 'Untracked: moved to the Trash' : 'Reverted to the last commit',
    staged: false,
    partially_staged: false,
    untracked: action === 'delete',
    fingerprint: `fp:${path}`,
    ...extra,
  };
}

interface Harness {
  deps: DiscardDeps;
  tabs: DiscardTab[];
  sent: DiscardRequest[][];
  calls: string[];
  report: { start: ReturnType<typeof vi.fn>; done: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> };
}

function harness(opts: {
  items: DiscardItem[];
  result?: (sent: DiscardRequest[]) => DiscardResult;
  tabs?: DiscardTab[];
  choice?: DiscardChoice;
  remote?: boolean;
  /** Runs while the confirmation is open (the user keeps typing). */
  duringDialog?: (tabs: DiscardTab[]) => void;
  /** Absolute paths no longer on disk (reloadTab answers 'missing'). */
  missing?: string[];
}): Harness {
  const tabs = opts.tabs ?? [];
  const sent: DiscardRequest[][] = [];
  const calls: string[] = [];
  const report = { start: vi.fn(), done: vi.fn(), fail: vi.fn() };
  const deps: DiscardDeps = {
    isRemote: () => opts.remote ?? false,
    preview: vi.fn(async () => opts.items),
    discard: vi.fn(async (_root: string, rows: DiscardRequest[]) => {
      sent.push(rows);
      return (
        opts.result?.(rows) ?? {
          discarded: rows.map((r) => r.path),
          trashed: rows.filter((r) => r.action === 'delete').map((r) => r.path),
          failed: [],
          output: '',
        }
      );
    }),
    tabs: () => tabs,
    reloadTab: (id, p, force) => {
      calls.push(`reload:${id}:${force ? 'force' : 'keep'}`);
      return opts.missing?.includes(p) ? 'missing' : 'reloaded';
    },
    closeTab: (id) => void calls.push(`close:${id}`),
    markConflict: (id) => void calls.push(`conflict:${id}`),
    refresh: () => void calls.push('refresh'),
    report,
    confirm: async () => {
      opts.duringDialog?.(tabs);
      return opts.choice ?? { ok: true, dropBuffers: false };
    },
  };
  return { deps, tabs, sent, calls, report };
}

describe('runDiscard (#172)', () => {
  it('refuses in a remote session without asking git anything', async () => {
    const h = harness({ items: [item('a.md', 'revert')], remote: true });
    expect(await runDiscard(ROOT, ['a.md'], h.deps)).toBe('remote');
    expect(h.deps.preview).not.toHaveBeenCalled();
    expect(h.deps.discard).not.toHaveBeenCalled();
    expect(h.report.fail).toHaveBeenCalledWith('discard', expect.objectContaining({ kind: 'unsupported', message: REMOTE_DISCARD_REASON }));
  });

  it('does nothing without a repo or paths', async () => {
    const h = harness({ items: [] });
    expect(await runDiscard(null, ['a.md'], h.deps)).toBe('empty');
    expect(await runDiscard(ROOT, [], h.deps)).toBe('empty');
    expect(h.deps.preview).not.toHaveBeenCalled();
  });

  it('cancel discards nothing and touches no tab', async () => {
    const h = harness({
      items: [item('a.md', 'revert')],
      tabs: [{ id: 't1', path: '/repo/a.md', modified: true }],
      choice: { ok: false, dropBuffers: false },
    });
    expect(await runDiscard(ROOT, ['a.md'], h.deps)).toBe('cancelled');
    expect(h.deps.discard).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  it('sends back exactly the confirmed rows (path, action, rename source, preview fingerprint)', async () => {
    const h = harness({
      items: [item('a.md', 'revert'), item('new.md', 'delete', { source: 'old.md', untracked: false })],
    });
    await runDiscard(ROOT, ['a.md', 'new.md'], h.deps);
    expect(h.sent).toEqual([
      [
        { path: 'a.md', action: 'revert', fingerprint: 'fp:a.md' },
        { path: 'new.md', action: 'delete', source: 'old.md', fingerprint: 'fp:new.md' },
      ],
    ]);
  });

  it('clean tabs: a reverted file reloads, a trashed file closes, a rename source reloads', async () => {
    const h = harness({
      items: [item('a.md', 'revert'), item('new.md', 'delete', { source: 'old.md', untracked: false })],
      tabs: [
        { id: 'a', path: '/repo/a.md', modified: false },
        { id: 'n', path: '/repo/new.md', modified: false },
        { id: 'o', path: '/repo/old.md', modified: false },
        { id: 'x', path: '/repo/other.md', modified: false },
      ],
    });
    expect(await runDiscard(ROOT, ['a.md', 'new.md'], h.deps)).toBe('done');
    expect(h.calls).toEqual(['reload:a:keep', 'close:n', 'reload:o:keep', 'refresh']);
  });

  it('a dirty tab listed in the dialog keeps its text by default (flagged, never closed)', async () => {
    const h = harness({
      items: [item('a.md', 'revert'), item('scratch.md', 'delete')],
      tabs: [
        { id: 'a', path: '/repo/a.md', modified: true },
        { id: 's', path: '/repo/scratch.md', modified: true },
      ],
    });
    await runDiscard(ROOT, ['a.md', 'scratch.md'], h.deps);
    expect(h.calls).toEqual(['conflict:a', 'conflict:s', 'refresh']);
  });

  it('dropping unsaved edits is explicit: listed dirty tabs reload with force or close', async () => {
    const h = harness({
      items: [item('a.md', 'revert'), item('scratch.md', 'delete')],
      tabs: [
        { id: 'a', path: '/repo/a.md', modified: true },
        { id: 's', path: '/repo/scratch.md', modified: true },
      ],
      choice: { ok: true, dropBuffers: true },
    });
    await runDiscard(ROOT, ['a.md', 'scratch.md'], h.deps);
    expect(h.calls).toEqual(['reload:a:force', 'close:s', 'refresh']);
  });

  it('a tab that became dirty while the dialog was open is never dropped, even with "drop" ticked', async () => {
    const h = harness({
      items: [item('a.md', 'revert'), item('scratch.md', 'delete')],
      tabs: [
        { id: 'a', path: '/repo/a.md', modified: false },
        { id: 's', path: '/repo/scratch.md', modified: false },
      ],
      choice: { ok: true, dropBuffers: true },
      duringDialog: (tabs) => {
        for (const t of tabs) t.modified = true; // typed after the dialog opened
      },
    });
    await runDiscard(ROOT, ['a.md', 'scratch.md'], h.deps);
    expect(h.calls).toEqual(['conflict:a', 'conflict:s', 'refresh']);
  });

  it('partial failure: failed paths are reported per path and their tabs are left alone', async () => {
    const h = harness({
      items: [item('a.md', 'revert'), item('b.md', 'revert')],
      tabs: [
        { id: 'a', path: '/repo/a.md', modified: false },
        { id: 'b', path: '/repo/b.md', modified: false },
      ],
      result: () => ({
        discarded: ['a.md'],
        trashed: [],
        failed: [{ path: 'b.md', message: 'Changed since you confirmed; nothing was done.' }],
        output: '$ git restore …',
      }),
    });
    expect(await runDiscard(ROOT, ['a.md', 'b.md'], h.deps)).toBe('done');
    expect(h.calls).toEqual(['reload:a:keep', 'refresh']);
    expect(h.report.done).not.toHaveBeenCalled();
    const [, err] = h.report.fail.mock.calls[0];
    expect(err.message).toContain('1 failed');
    expect(err.detail).toContain('failed: b.md: Changed since you confirmed');
  });

  it('sends DiscardRequest records, never bare path strings', async () => {
    const h = harness({ items: [item('a.md', 'revert')] });
    await runDiscard(ROOT, ['a.md'], h.deps);
    const rows = h.sent[0];
    expect(rows.every((r) => typeof r === 'object' && (r.action === 'revert' || r.action === 'delete'))).toBe(true);
    expect(Object.keys(rows[0]).sort()).toEqual(['action', 'fingerprint', 'path']);
  });

  it('a file trashed whose next step failed: its clean tab closes, a dirty one keeps its text, the rename source is untouched', async () => {
    const h = harness({
      items: [item('n.md', 'delete', { source: 'o.md', untracked: false }), item('d.md', 'delete')],
      tabs: [
        { id: 'n', path: '/repo/n.md', modified: false },
        { id: 'o', path: '/repo/o.md', modified: false },
        { id: 'd', path: '/repo/d.md', modified: true },
      ],
      result: () => ({
        discarded: [],
        trashed: ['n.md', 'd.md'],
        failed: [
          { path: 'n.md', message: "Moved to the Trash, but o.md couldn't be restored" },
          { path: 'd.md', message: 'later step failed' },
        ],
        output: '',
      }),
    });
    expect(await runDiscard(ROOT, ['n.md', 'd.md'], h.deps)).toBe('done');
    expect(h.calls).toEqual(['close:n', 'conflict:d', 'refresh']);
    const [, err] = h.report.fail.mock.calls[0];
    expect(err.detail).toContain("failed: n.md: Moved to the Trash, but o.md couldn't be restored");
  });

  it('on a core error every affected tab is re-read without dropping edits; missing files close clean tabs and flag dirty ones', async () => {
    const h = harness({
      items: [item('a.md', 'revert'), item('s.md', 'delete'), item('t.md', 'delete')],
      tabs: [
        { id: 'a', path: '/repo/a.md', modified: false },
        { id: 's', path: '/repo/s.md', modified: false },
        { id: 't', path: '/repo/t.md', modified: true },
      ],
      missing: ['/repo/s.md', '/repo/t.md'],
      choice: { ok: true, dropBuffers: true },
    });
    h.deps.discard = vi.fn(async () => {
      throw { kind: 'other', message: 'boom', detail: '' };
    });
    expect(await runDiscard(ROOT, ['a.md', 's.md', 't.md'], h.deps)).toBe('failed');
    expect(h.calls).toEqual([
      'reload:a:keep',
      'reload:s:keep',
      'close:s',
      'reload:t:keep',
      'conflict:t',
      'refresh',
    ]);
  });

  it('a core error is reported, the list refreshes, and a still-present file only gets a non-destructive re-read', async () => {
    const h = harness({ items: [item('a.md', 'revert')], tabs: [{ id: 'a', path: '/repo/a.md', modified: false }] });
    h.deps.discard = vi.fn(async () => {
      throw { kind: 'other', message: 'Another git process is using this repository (its index is locked).', detail: '' };
    });
    expect(await runDiscard(ROOT, ['a.md'], h.deps)).toBe('failed');
    expect(h.report.fail).toHaveBeenCalledWith('discard', expect.objectContaining({ message: expect.stringContaining('locked') }));
    expect(h.calls).toEqual(['reload:a:keep', 'refresh']);
  });
});

describe('tabFate', () => {
  const tab = (modified: boolean): DiscardTab => ({ id: 't', path: '/repo/a.md', modified });
  const listed = [{ id: 't', path: '/repo/a.md', rel: 'a.md' }];
  it.each([
    [false, [], false, false, 'reload'],
    [false, [], false, true, 'close'],
    [true, [], true, true, 'keep'],
    [true, listed, false, true, 'keep'],
    [true, listed, true, true, 'close'],
    [true, listed, true, false, 'reload-dropping-edits'],
  ] as const)('modified=%s listed=%j drop=%s gone=%s → %s', (modified, dirty, dropBuffers, gone, fate) => {
    expect(tabFate({ tab: tab(modified), dirty: [...dirty], dropBuffers, gone })).toBe(fate);
  });
});

describe('dirtyTabsFor', () => {
  it('matches dirty tabs on the discarded files and rename sources only', () => {
    const items = [item('docs/a.md', 'revert'), item('n.md', 'delete', { source: 'o.md' })];
    const tabs: DiscardTab[] = [
      { id: '1', path: '/repo/docs/a.md', modified: true },
      { id: '2', path: '/repo//o.md', modified: true },
      { id: '3', path: '/repo/n.md', modified: false },
      { id: '4', path: '/repo/elsewhere.md', modified: true },
      { id: '5', path: null, modified: true },
    ];
    expect(dirtyTabsFor('/repo', items, tabs).map((d) => [d.id, d.rel])).toEqual([
      ['1', 'docs/a.md'],
      ['2', 'o.md'],
    ]);
  });
});

describe('discard dialog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('escapes file names and lists every row with its action', () => {
    const html = discardDialogHtml([item('<img src=x onerror=1>.md', 'revert'), item('*.md', 'delete')], []);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=1&gt;.md');
    expect(html).toContain('*.md');
    expect(html).toContain('Discard changes in 2 files?');
    expect(html).toContain('system Trash');
  });

  it('keeps a name with CR, LF or TAB intact in the row it acts on', () => {
    const name = 'docs/a\rb\nc\td.md';
    const host = document.createElement('div');
    host.innerHTML = discardDialogHtml([item(name, 'revert')], []);
    expect(host.querySelector<HTMLElement>('.discard-item')!.dataset.path).toBe(name);
  });

  it('shows direction and invisible characters in names as visible markers', () => {
    const html = discardDialogHtml(
      [{ ...item('docs/a\u202Egnp.md', 'revert'), detail: 'b\u200Bc' }],
      [{ id: 't', path: '/repo/x', rel: 'n\u2066ame.md' }],
    );
    // Only the data attribute (the real path) keeps the raw character.
    const visible = html.replace(/data-path="[^"]*"/g, '');
    expect(visible).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/);
    expect(html).toContain('a&lt;U+202E&gt;gnp.md');
    expect(html).toContain('b&lt;U+200B&gt;c');
    expect(html).toContain('n&lt;U+2066&gt;ame.md');
    expect(html).toContain('change-row-bidi');
    // The row still acts on the path git reported.
    expect(html).toContain('data-path="docs/a\u202Egnp.md"');
  });

  it('names the dirty tabs and the drop checkbox starts unticked', async () => {
    const p = showDiscardDialog([item('a.md', 'revert')], [{ id: 't', path: '/repo/a.md', rel: 'a.md' }]);
    const box = document.querySelector<HTMLInputElement>('.discard-drop-buffers')!;
    expect(box.checked).toBe(false);
    expect(document.querySelector('.discard-dirty')!.textContent).toContain('a.md');
    expect(document.activeElement?.classList.contains('discard-cancel')).toBe(true);
    document.querySelector<HTMLButtonElement>('.discard-ok')!.click();
    expect(await p).toEqual({ ok: true, dropBuffers: false });
  });

  it('Escape cancels even with drop ticked', async () => {
    const p = showDiscardDialog([item('a.md', 'revert')], [{ id: 't', path: '/repo/a.md', rel: 'a.md' }]);
    document.querySelector<HTMLInputElement>('.discard-drop-buffers')!.checked = true;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await p).toEqual({ ok: false, dropBuffers: false });
    expect(document.querySelector('.discard-overlay')).toBeNull();
  });
});

describe('runDiscard: asks before running repo commands', () => {
  const keys = [{ key: 'filter.lfs.smudge', value: 'git-lfs smudge -- %f' }];
  const ask = { discarded: [], trashed: [], failed: [], output: '', needs_confirmation: { keys, fingerprint: 'fp-d1' } };

  /** A harness whose core asks on the first call, then runs. */
  function gated(repoCommands: DiscardDeps['repoCommands']) {
    const h = harness({ items: [item('a.md', 'revert')] });
    const confirmedArgs: (boolean | undefined)[] = [];
    h.deps.discard = vi.fn(async (_root: string, rows: DiscardRequest[], confirmed?: boolean) => {
      confirmedArgs.push(confirmed);
      h.sent.push(rows);
      return confirmed
        ? { discarded: rows.map((r) => r.path), trashed: [], failed: [], output: '' }
        : ask;
    });
    h.deps.repoCommands = repoCommands;
    return { h, confirmedArgs };
  }

  it('shown: the dialog gets the keys; Run anyway runs the same rows with confirmation', async () => {
    const confirm = vi.fn(async () => true);
    const remember = vi.fn();
    const { h, confirmedArgs } = gated({ confirm, remember });
    expect(await runDiscard(ROOT, ['a.md'], h.deps)).toBe('done');
    expect(confirm).toHaveBeenCalledWith(keys);
    expect(confirmedArgs).toEqual([false, true]);
    expect(h.sent[0]).toEqual(h.sent[1]);
    expect(remember).toHaveBeenCalledWith(ROOT, 'fp-d1');
    expect(h.report.done).toHaveBeenCalled();
  });

  it('cancelled: nothing runs, nothing is remembered, tabs are left alone', async () => {
    const confirm = vi.fn(async () => false);
    const remember = vi.fn();
    const { h, confirmedArgs } = gated({ confirm, remember });
    expect(await runDiscard(ROOT, ['a.md'], h.deps)).toBe('cancelled');
    expect(confirmedArgs).toEqual([false]);
    expect(remember).not.toHaveBeenCalled();
    expect(h.report.done).not.toHaveBeenCalled();
    expect(h.report.fail).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  it('remembered: the same fingerprint skips the dialog', async () => {
    const confirm = vi.fn(async () => true);
    const { h, confirmedArgs } = gated({ confirm, remembered: () => 'fp-d1' });
    expect(await runDiscard(ROOT, ['a.md'], h.deps)).toBe('done');
    expect(confirm).not.toHaveBeenCalled();
    expect(confirmedArgs).toEqual([false, true]);
  });

  it('a changed fingerprint asks again', async () => {
    const confirm = vi.fn(async () => true);
    const { h } = gated({ confirm, remembered: () => 'older' });
    await runDiscard(ROOT, ['a.md'], h.deps);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('no question from the core: no dialog', async () => {
    const confirm = vi.fn(async () => true);
    const h = harness({ items: [item('a.md', 'revert')] });
    h.deps.repoCommands = { confirm };
    expect(await runDiscard(ROOT, ['a.md'], h.deps)).toBe('done');
    expect(confirm).not.toHaveBeenCalled();
    expect(h.deps.discard).toHaveBeenCalledTimes(1);
  });
});
