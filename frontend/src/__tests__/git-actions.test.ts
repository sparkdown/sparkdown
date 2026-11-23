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

import { GitActions, type GitActionsOptions } from '../git-actions';
import { GitFeedback, STATUS_FADE_MS } from '../git-output';
import type { GitBranchStatus, GitChange } from '../api';

function make(root: string | null = '/repo', extra: Partial<GitActionsOptions> = {}) {
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
    { repoRoot: () => root, refresh, report: fb, ...extra },
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
    expect(gitCommit).toHaveBeenCalledWith('/repo', 'Only a', ['a.md'], false);
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
    expect(gitCommit).toHaveBeenCalledWith('/repo', 'Msg', null, false);
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
    expect(gitPull).toHaveBeenCalledWith('/repo', false);
    expect(refresh).toHaveBeenCalled();
  });

  it('hides the header icons without a repo', () => {
    const { $ } = make(null);
    expect($('acts').hidden).toBe(true);
    const r = make();
    expect(r.$('acts').hidden).toBe(false);
  });
});

describe('GitActions: diverged pull and background fetch (#174, #175)', () => {
  beforeEach(() => {
    gitPull.mockReset();
    gitPush.mockReset();
  });

  it('a merge conflict is a sticky status error; clicking opens the Git tab with the full output and files', async () => {
    const { ga, $, fb, openOutput } = make();
    ga.setBranch(branch({ ahead: 1, behind: 1 }));
    gitPull.mockRejectedValue({
      kind: 'merge_conflict',
      message: 'Pull stopped on merge conflicts in 2 files. Resolve them, then commit.',
      detail: 'CONFLICT (content): Merge conflict in a.md\n\nConflicted files:\n  a.md\n  b.md',
      files: ['a.md', 'b.md'],
    });
    await ga.pull();
    expect(fb.status.state()).toBe('error');
    expect($('st').textContent).toContain('merge conflicts in 2 files');
    await new Promise((r) => setTimeout(r, STATUS_FADE_MS + 50));
    expect(fb.status.state()).toBe('error'); // persistent, no fade
    expect($('out').textContent).toContain('Conflicted files:');
    $('st').click();
    expect(openOutput).toHaveBeenCalled();
  }, STATUS_FADE_MS + 2000);

  it('a rejected push triggers one background fetch after the refresh', async () => {
    const onPushRejected = vi.fn(async () => {});
    const order: string[] = [];
    const { ga, refresh } = make('/repo', {
      onPushRejected: () => {
        order.push('fetch');
        return onPushRejected();
      },
    });
    refresh.mockImplementation(async () => {
      order.push('refresh');
    });
    ga.setBranch(branch({ ahead: 1 }));
    gitPush.mockRejectedValue({ kind: 'rejected', message: 'Pull first', detail: '' });
    await ga.push();
    expect(onPushRejected).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['refresh', 'fetch']);
  });

  it('other push failures do not fetch', async () => {
    const onPushRejected = vi.fn();
    const { ga } = make('/repo', { onPushRejected });
    ga.setBranch(branch({ ahead: 1 }));
    gitPush.mockRejectedValue({ kind: 'auth', message: 'no', detail: '' });
    await ga.push();
    expect(onPushRejected).not.toHaveBeenCalled();
  });

  it('the Pull tooltip says when the last fetch ran', () => {
    const at = Date.now() - 3 * 60000;
    const { ga, $ } = make('/repo', { lastFetched: () => at });
    ga.setBranch(branch({ behind: 2 }));
    expect($('pull').title).toBe('Pull main from its upstream (2 behind), last fetched 3 min ago');
  });
});

describe('GitActions: Pull/Push ask before running repo commands', () => {
  const confirm = {
    keys: [
      { key: 'core.fsmonitor', value: 'touch /tmp/x' },
      { key: 'filter.lfs.clean', value: 'git-lfs clean -- %f' },
    ],
    fingerprint: 'fp-1',
  };
  const done = { summary: 'Already up to date', output: 'Already up to date', commits: 0, target: 'origin/main' };

  beforeEach(() => {
    gitPull.mockReset();
    gitPush.mockReset();
  });

  it('shows the dialog, defaulting to Cancel, and Run anyway re-invokes with confirmation', async () => {
    const confirmRepoCommands = vi.fn(async () => true);
    gitPull.mockResolvedValueOnce({ summary: '', output: '', commits: null, target: null, needs_confirmation: confirm }).mockResolvedValueOnce(done);
    const remembered = vi.fn(() => undefined);
    const remember = vi.fn();
    const { ga, refresh, $ } = make('/repo', { confirmRepoCommands, rememberedRunAnyway: remembered, rememberRunAnyway: remember });
    ga.setBranch(branch());
    await ga.pull();
    expect(confirmRepoCommands).toHaveBeenCalledTimes(1);
    expect(confirmRepoCommands).toHaveBeenCalledWith(confirm.keys);
    expect(remember).toHaveBeenCalledWith('/repo', 'fp-1');
    expect(gitPull).toHaveBeenNthCalledWith(1, '/repo', false);
    expect(gitPull).toHaveBeenNthCalledWith(2, '/repo', true);
    expect(refresh).toHaveBeenCalled();
    expect($('st').textContent).toBe('Already up to date from origin/main');
  });

  it('does not remember Cancel and does not run the confirmed call', async () => {
    const confirmRepoCommands = vi.fn(async () => false);
    const remember = vi.fn();
    gitPull.mockResolvedValue({ summary: '', output: '', commits: null, target: null, needs_confirmation: confirm });
    const { ga, refresh } = make('/repo', { confirmRepoCommands, rememberRunAnyway: remember });
    ga.setBranch(branch());
    await ga.pull();
    expect(confirmRepoCommands).toHaveBeenCalledTimes(1);
    expect(remember).not.toHaveBeenCalled();
    expect(gitPull).toHaveBeenCalledTimes(1);
    expect(gitPull).toHaveBeenCalledWith('/repo', false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('remembers Run anyway and asks again when the fingerprint changes', async () => {
    const confirmRepoCommands = vi.fn(async () => true);
    const store: Record<string, string> = {};
    gitPull
      .mockResolvedValueOnce({ summary: '', output: '', commits: null, target: null, needs_confirmation: confirm })
      .mockResolvedValueOnce(done)
      .mockResolvedValueOnce({ summary: '', output: '', commits: null, target: null, needs_confirmation: confirm })
      .mockResolvedValueOnce(done)
      .mockResolvedValueOnce({
        summary: '',
        output: '',
        commits: null,
        target: null,
        needs_confirmation: { keys: confirm.keys, fingerprint: 'fp-2' },
      })
      .mockResolvedValueOnce(done);
    const { ga } = make('/repo', {
      confirmRepoCommands,
      rememberedRunAnyway: (root) => store[root],
      rememberRunAnyway: (root, fp) => {
        store[root] = fp;
      },
    });
    ga.setBranch(branch());
    await ga.pull();
    await ga.pull();
    expect(confirmRepoCommands).toHaveBeenCalledTimes(1);
    expect(gitPull.mock.calls.map((c) => c[1])).toEqual([false, true, false, true]);
    await ga.pull();
    expect(confirmRepoCommands).toHaveBeenCalledTimes(2);
    expect(store['/repo']).toBe('fp-2');
  });

  it('Push also asks and runs anyway when confirmed', async () => {
    const confirmRepoCommands = vi.fn(async () => true);
    gitPush.mockResolvedValueOnce({ summary: '', output: '', commits: null, target: null, needs_confirmation: confirm }).mockResolvedValueOnce(done);
    const { ga } = make('/repo', { confirmRepoCommands });
    ga.setBranch(branch({ ahead: 1 }));
    await ga.push();
    expect(confirmRepoCommands).toHaveBeenCalledTimes(1);
    expect(gitPush).toHaveBeenNthCalledWith(1, '/repo', false);
    expect(gitPush).toHaveBeenNthCalledWith(2, '/repo', true);
  });
});

describe('GitActions: Commit asks before running repo commands', () => {
  const confirm = {
    keys: [{ key: 'filter.lfs.clean', value: 'git-lfs clean -- %f' }],
    fingerprint: 'fp-c1',
  };
  const ask = { summary: '', output: '', commits: null, target: null, needs_confirmation: confirm };
  const done = { summary: '[main abc] msg', output: '[main abc] msg', commits: null, target: null };

  beforeEach(() => {
    gitCommit.mockReset();
  });

  function ready(extra: Partial<GitActionsOptions>) {
    const t = make('/repo', extra);
    t.ga.setChanges(changes('a.md'));
    (t.$('m') as HTMLTextAreaElement).value = 'msg';
    return t;
  }

  it('shows the dialog; Run anyway commits with confirmation and clears the message', async () => {
    const confirmRepoCommands = vi.fn(async () => true);
    const remember = vi.fn();
    gitCommit.mockResolvedValueOnce(ask).mockResolvedValueOnce(done);
    const { ga, $ } = ready({ confirmRepoCommands, rememberRunAnyway: remember });
    await ga.commit();
    expect(confirmRepoCommands).toHaveBeenCalledWith(confirm.keys);
    expect(remember).toHaveBeenCalledWith('/repo', 'fp-c1');
    expect(gitCommit.mock.calls.map((c) => c[3])).toEqual([false, true]);
    expect(($('m') as HTMLTextAreaElement).value).toBe('');
  });

  it('Cancel commits nothing, remembers nothing and keeps the message', async () => {
    const confirmRepoCommands = vi.fn(async () => false);
    const remember = vi.fn();
    gitCommit.mockResolvedValue(ask);
    const { ga, $ } = ready({ confirmRepoCommands, rememberRunAnyway: remember });
    await ga.commit();
    expect(confirmRepoCommands).toHaveBeenCalledTimes(1);
    expect(remember).not.toHaveBeenCalled();
    expect(gitCommit).toHaveBeenCalledTimes(1);
    expect(($('m') as HTMLTextAreaElement).value).toBe('msg');
  });

  it('a remembered fingerprint skips the dialog', async () => {
    const confirmRepoCommands = vi.fn(async () => true);
    gitCommit.mockResolvedValueOnce(ask).mockResolvedValueOnce(done);
    const { ga } = ready({ confirmRepoCommands, rememberedRunAnyway: () => 'fp-c1' });
    await ga.commit();
    expect(confirmRepoCommands).not.toHaveBeenCalled();
    expect(gitCommit.mock.calls.map((c) => c[3])).toEqual([false, true]);
  });

  it('a different fingerprint asks again', async () => {
    const confirmRepoCommands = vi.fn(async () => true);
    gitCommit.mockResolvedValueOnce(ask).mockResolvedValueOnce(done);
    const { ga } = ready({ confirmRepoCommands, rememberedRunAnyway: () => 'older' });
    await ga.commit();
    expect(confirmRepoCommands).toHaveBeenCalledTimes(1);
  });
});
