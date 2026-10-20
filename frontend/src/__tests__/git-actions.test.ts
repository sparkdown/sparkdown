// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gitCommit = vi.fn();
const gitPull = vi.fn();
const gitPush = vi.fn();
vi.mock('../api', () => ({
  api: {
    gitCommit: (...a: unknown[]) => gitCommit(...a),
    gitPull: (...a: unknown[]) => gitPull(...a),
    gitPush: (...a: unknown[]) => gitPush(...a),
  },
}));

import { GitActions } from '../git-actions';
import type { GitBranchStatus, GitChange } from '../api';

function make(root: string | null = '/repo') {
  document.body.innerHTML = `
    <div id="g"><span id="s"></span><button id="pull"></button><button id="push"></button>
    <textarea id="m"></textarea><div id="f"></div><button id="c"></button><div id="st" hidden></div></div>`;
  const $ = (id: string) => document.getElementById(id)!;
  const refresh = vi.fn(async () => {});
  const ga = new GitActions(
    {
      root: $('g'),
      message: $('m') as HTMLTextAreaElement,
      commit: $('c') as HTMLButtonElement,
      pull: $('pull') as HTMLButtonElement,
      push: $('push') as HTMLButtonElement,
      sync: $('s'),
      files: $('f'),
      status: $('st'),
    },
    { repoRoot: () => root, refresh },
  );
  return { ga, refresh, $ };
}

const changes = (...p: string[]) => p.map((path) => ({ path, status: 'modified', staged: false }) as GitChange);
const branch = (o: Partial<GitBranchStatus> = {}): GitBranchStatus => ({
  branch: 'main',
  detached: false,
  has_upstream: true,
  ahead: 0,
  behind: 0,
  ...o,
});

describe('GitActions (#122)', () => {
  beforeEach(() => {
    gitCommit.mockReset();
    gitPull.mockReset();
    gitPush.mockReset();
  });

  it('blocks an empty message without calling git', async () => {
    const { ga, $ } = make();
    ga.setChanges(changes('a.md'));
    (($('m') as HTMLTextAreaElement).value = '   ');
    await ga.commit();
    expect(gitCommit).not.toHaveBeenCalled();
    expect($('st').dataset.kind).toBe('empty_message');
    expect($('st').hidden).toBe(false);
  });

  it('commits every change when all are ticked, then clears and refreshes', async () => {
    gitCommit.mockResolvedValue({ summary: '[main abc] Msg' });
    const { ga, $, refresh } = make();
    ga.setChanges(changes('a.md', 'b.md'));
    ($('m') as HTMLTextAreaElement).value = 'Msg';
    await ga.commit();
    expect(gitCommit).toHaveBeenCalledWith('/repo', 'Msg', null);
    expect(($('m') as HTMLTextAreaElement).value).toBe('');
    expect(refresh).toHaveBeenCalled();
    expect($('st').textContent).toContain('Committed');
  });

  it('commits only the ticked files', async () => {
    gitCommit.mockResolvedValue({ summary: '' });
    const { ga, $ } = make();
    ga.setChanges(changes('a.md', 'b.md'));
    const box = $('f').querySelector<HTMLInputElement>('input[data-path="b.md"]')!;
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect($('c').textContent).toBe('Commit 1 of 2');
    ($('m') as HTMLTextAreaElement).value = 'Only a';
    await ga.commit();
    expect(gitCommit).toHaveBeenCalledWith('/repo', 'Only a', ['a.md']);
  });

  it('shows a typed error with details and still refreshes', async () => {
    gitPush.mockRejectedValue({ kind: 'rejected', message: 'The remote rejected the push.', detail: '! [rejected] main -> main (fetch first)' });
    const { ga, $, refresh } = make();
    ga.setBranch(branch({ ahead: 1 }));
    await ga.push();
    expect($('st').dataset.kind).toBe('rejected');
    expect($('st').getAttribute('role')).toBe('alert');
    expect($('st').textContent).toContain('rejected the push');
    expect($('st').querySelector('pre')?.textContent).toContain('fetch first');
    expect(refresh).toHaveBeenCalled();
  });

  it('shows ahead/behind on the buttons and disables them without an upstream', () => {
    const { ga, $ } = make();
    ga.setBranch(branch({ ahead: 2, behind: 3 }));
    expect($('push').textContent).toBe('Push ↑2');
    expect($('pull').textContent).toBe('Pull ↓3');
    expect(($('push') as HTMLButtonElement).disabled).toBe(false);
    ga.setBranch(branch({ has_upstream: false }));
    expect(($('push') as HTMLButtonElement).disabled).toBe(true);
    expect($('push').title).toContain('no upstream');
    expect($('s').textContent).toContain('no upstream');
  });

  it('pull calls git and refreshes', async () => {
    gitPull.mockResolvedValue({ summary: 'Fast-forward' });
    const { ga, refresh } = make();
    ga.setBranch(branch({ behind: 1 }));
    await ga.pull();
    expect(gitPull).toHaveBeenCalledWith('/repo');
    expect(refresh).toHaveBeenCalled();
  });

  it('hides without a repo', () => {
    const { $ } = make(null);
    expect($('g').hidden).toBe(true);
  });
});
