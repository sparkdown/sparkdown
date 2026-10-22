// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import { GitFeedback, STATUS_FADE_MS } from '../git-output';
import type { GitBranchStatus, GitChange } from '../api';

function make(root: string | null = '/repo') {
  document.body.innerHTML = `
    <div id="acts" hidden>
      <button id="tog"></button>
      <button id="pull"><svg class="git-icon"></svg><span id="pc" hidden></span></button>
      <button id="push"><svg class="git-icon"></svg><span id="uc" hidden></span></button>
    </div>
    <div id="panel" hidden><textarea id="m"></textarea><input type="checkbox" id="all" />
      <div id="f"></div><button id="c"></button></div>
    <button id="st" class="hidden"><i class="status-git-spin"></i><span class="status-git-label"></span></button>
    <div id="out"></div>`;
  const $ = (id: string) => document.getElementById(id)!;
  const refresh = vi.fn(async () => {});
  const openOutput = vi.fn();
  const fb = new GitFeedback({ status: $('st'), output: $('out') }, openOutput);
  const ga = new GitActions(
    {
      actions: $('acts'),
      commitToggle: $('tog') as HTMLButtonElement,
      pull: $('pull') as HTMLButtonElement,
      push: $('push') as HTMLButtonElement,
      pullCount: $('pc'),
      pushCount: $('uc'),
      panel: $('panel'),
      message: $('m') as HTMLTextAreaElement,
      selectAll: $('all') as HTMLInputElement,
      files: $('f'),
      commit: $('c') as HTMLButtonElement,
    },
    { repoRoot: () => root, refresh, report: fb },
  );
  return { ga, refresh, $, fb, openOutput };
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
const typeMsg = (el: HTMLElement, v: string) => {
  (el as HTMLTextAreaElement).value = v;
  el.dispatchEvent(new Event('input'));
};
const btn = (el: HTMLElement) => el as HTMLButtonElement;
const box = (el: HTMLElement) => el as HTMLInputElement;
const shown = (el: HTMLElement) => !el.classList.contains('hidden');
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('GitActions header + commit panel (0.4.1)', () => {
  beforeEach(() => {
    gitCommit.mockReset();
    gitPull.mockReset();
    gitPush.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('Commit icon opens the panel with the message focused; Esc closes it', () => {
    const { ga, $ } = make();
    ga.setChanges(changes('a.md'));
    expect($('panel').hidden).toBe(true);
    $('tog').click();
    expect($('panel').hidden).toBe(false);
    expect($('tog').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe($('m'));
    $('m').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect($('panel').hidden).toBe(true);
    expect(document.activeElement).toBe($('tog'));
  });

  it('Commit button is disabled while the message is empty or no file is ticked', () => {
    const { ga, $ } = make();
    ga.setChanges(changes('a.md', 'b.md'));
    $('tog').click();
    expect(btn($('c')).disabled).toBe(true);
    typeMsg($('m'), 'Msg');
    expect(btn($('c')).disabled).toBe(false);
    expect(box($('all')).checked).toBe(true);
    box($('all')).checked = false;
    $('all').dispatchEvent(new Event('change'));
    expect($('f').querySelectorAll('input:checked')).toHaveLength(0);
    expect(btn($('c')).disabled).toBe(true);
    box($('all')).checked = true;
    $('all').dispatchEvent(new Event('change'));
    expect($('f').querySelectorAll('input:checked')).toHaveLength(2);
    expect(btn($('c')).disabled).toBe(false);
  });

  it('every file is ticked by default; unticking one makes select-all indeterminate and commits only the rest', async () => {
    gitCommit.mockResolvedValue({ summary: '', output: '', commits: null, target: null });
    const { ga, $ } = make();
    ga.setChanges(changes('a.md', 'b.md'));
    $('tog').click();
    const b = $('f').querySelector<HTMLInputElement>('input[data-path="b.md"]')!;
    expect(b.checked).toBe(true);
    b.checked = false;
    b.dispatchEvent(new Event('change', { bubbles: true }));
    expect(box($('all')).indeterminate).toBe(true);
    expect($('c').textContent).toBe('Commit 1 of 2');
    typeMsg($('m'), 'Only a');
    $('c').click();
    await flush();
    expect(gitCommit).toHaveBeenCalledWith('/repo', 'Only a', ['a.md']);
  });

  it('⌘/Ctrl+Enter commits all, then the panel closes, the message clears and the status bar says so, then fades', async () => {
    vi.useFakeTimers();
    gitCommit.mockResolvedValue({ summary: '[main abc1234] Msg', output: '[main abc1234] Msg\n 1 file changed', commits: null, target: null });
    const { ga, $, refresh, fb } = make();
    ga.setChanges(changes('a.md', 'b.md'));
    $('tog').click();
    typeMsg($('m'), 'Msg');
    $('m').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(gitCommit).toHaveBeenCalledWith('/repo', 'Msg', null);
    expect(($('m') as HTMLTextAreaElement).value).toBe('');
    expect($('panel').hidden).toBe(true);
    expect(refresh).toHaveBeenCalled();
    expect(shown($('st'))).toBe(true);
    expect($('st').dataset.state).toBe('ok');
    expect($('st').textContent).toBe('Committed abc1234: Msg');
    expect(fb.log.all()[fb.log.all().length - 1]?.output).toContain('1 file changed');
    vi.advanceTimersByTime(STATUS_FADE_MS + 500);
    expect(shown($('st'))).toBe(false);
  });

  it('an empty message via the keyboard is blocked without calling git', async () => {
    const { ga, $ } = make();
    ga.setChanges(changes('a.md'));
    $('tog').click();
    typeMsg($('m'), '   ');
    await ga.commit();
    expect(gitCommit).not.toHaveBeenCalled();
    expect($('st').dataset.state).toBe('error');
    expect($('st').textContent).toBe('Write a commit message first.');
    expect($('panel').hidden).toBe(false);
  });

  it('a failed commit keeps the panel open with the message', async () => {
    gitCommit.mockRejectedValue({ kind: 'hook_failed', message: 'A hook stopped the commit.', detail: 'lint' });
    const { ga, $ } = make();
    ga.setChanges(changes('a.md'));
    $('tog').click();
    typeMsg($('m'), 'Msg');
    await ga.commit();
    expect($('panel').hidden).toBe(false);
    expect(($('m') as HTMLTextAreaElement).value).toBe('Msg');
    expect($('st').textContent).toBe('A hook stopped the commit.');
  });

  it('Pull / Push spin while running, with a status-bar spinner, then a sticky error and the full output in the Git tab', async () => {
    let reject!: (e: unknown) => void;
    gitPush.mockReturnValue(new Promise((_, r) => (reject = r)));
    const { ga, $, refresh, fb, openOutput } = make();
    ga.setBranch(branch({ ahead: 1 }));
    $('push').click();
    expect($('st').dataset.state).toBe('running');
    expect($('st').textContent).toBe('Pushing…');
    expect($('push').classList.contains('is-busy')).toBe(true);
    expect($('push').getAttribute('aria-busy')).toBe('true');
    expect(btn($('pull')).disabled).toBe(true);
    reject({ kind: 'rejected', message: 'The remote rejected the push.', detail: '! [rejected] main -> main (fetch first)' });
    await flush();
    expect($('push').classList.contains('is-busy')).toBe(false);
    expect($('st').dataset.state).toBe('error');
    expect($('st').textContent).toBe('The remote rejected the push.');
    expect($('out').querySelector('pre')?.textContent).toContain('fetch first');
    expect(fb.log.all()).toHaveLength(1);
    expect(refresh).toHaveBeenCalled();
    expect(openOutput).not.toHaveBeenCalled();
  });

  it('an error stays in the status bar until clicked; the click opens the Git tab', async () => {
    vi.useFakeTimers();
    gitPull.mockRejectedValue({ kind: 'conflict', message: 'Pull stopped on a conflict.', detail: 'CONFLICT' });
    const { ga, $, openOutput } = make();
    ga.setBranch(branch({ behind: 1 }));
    await ga.pull();
    vi.advanceTimersByTime(STATUS_FADE_MS * 10);
    expect(shown($('st'))).toBe(true);
    expect($('st').dataset.state).toBe('error');
    $('st').click();
    expect(openOutput).toHaveBeenCalledTimes(1);
    expect(shown($('st'))).toBe(false);
  });

  it('pull and push report how many commits moved and where', async () => {
    gitPull.mockResolvedValue({ summary: 'Updating', output: 'Updating 1..3\nFast-forward', commits: 3, target: 'origin/main' });
    gitPush.mockResolvedValue({ summary: 'To x', output: 'To x\n  a..b  HEAD -> main', commits: 2, target: 'origin/main' });
    const { ga, $, fb } = make();
    ga.setBranch(branch({ behind: 3, ahead: 2 }));
    await ga.pull();
    expect($('st').textContent).toBe('Pulled 3 commits from origin/main');
    await ga.push();
    expect($('st').textContent).toBe('Pushed 2 commits to origin/main');
    expect(fb.log.all().map((e) => e.command)).toEqual(['git pull --no-edit', 'git push (never forced)']);
    expect($('out').querySelectorAll('.git-output-entry')).toHaveLength(2);
  });

  it('shows behind/ahead counts only above 0 and greys out without an upstream', () => {
    const { ga, $ } = make();
    ga.setBranch(branch({ ahead: 2, behind: 3 }));
    expect($('uc').textContent).toBe('2');
    expect($('uc').hidden).toBe(false);
    expect($('pc').textContent).toBe('3');
    expect($('push').getAttribute('aria-label')).toBe('Push, 2 ahead');
    expect(btn($('push')).disabled).toBe(false);
    ga.setBranch(branch());
    expect($('uc').hidden).toBe(true);
    expect($('pc').hidden).toBe(true);
    ga.setBranch(branch({ has_upstream: false, ahead: 4 }));
    expect(btn($('push')).disabled).toBe(true);
    expect(btn($('pull')).disabled).toBe(true);
    expect($('push').title).toContain('no upstream');
    expect($('uc').hidden).toBe(true);
  });

  it('pull calls git and refreshes; without an upstream it does nothing', async () => {
    gitPull.mockResolvedValue({ summary: 'Fast-forward', output: 'Fast-forward', commits: 1, target: 'origin/main' });
    const { ga, refresh } = make();
    ga.setBranch(branch({ has_upstream: false }));
    await ga.pull();
    expect(gitPull).not.toHaveBeenCalled();
    ga.setBranch(branch({ behind: 1 }));
    await ga.pull();
    expect(gitPull).toHaveBeenCalledWith('/repo');
    expect(refresh).toHaveBeenCalled();
  });

  it('hides the header icons without a repo', () => {
    const { $ } = make(null);
    expect($('acts').hidden).toBe(true);
    const r = make();
    expect(r.$('acts').hidden).toBe(false);
  });
});
