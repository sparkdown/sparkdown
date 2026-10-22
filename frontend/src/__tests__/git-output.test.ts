// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitFeedback, STATUS_FADE_MS, successMessage } from '../git-output';

const res = (o: Partial<{ summary: string; output: string; commits: number | null; target: string | null }> = {}) => ({
  summary: '',
  output: '',
  commits: null,
  target: null,
  ...o,
});

describe('successMessage', () => {
  it('names the commit and how many commits moved', () => {
    expect(successMessage('commit', res({ summary: '[main 1a2b3c4] Fix it' }))).toBe('Committed 1a2b3c4: Fix it');
    expect(successMessage('commit', res({ summary: '[main (root-commit) 1a2b3c4] First' }))).toBe('Committed 1a2b3c4: First');
    expect(successMessage('push', res({ commits: 2, target: 'origin/main' }))).toBe('Pushed 2 commits to origin/main');
    expect(successMessage('push', res({ commits: 1, target: 'origin/main' }))).toBe('Pushed 1 commit to origin/main');
    expect(successMessage('pull', res({ commits: 3 }))).toBe('Pulled 3 commits');
    expect(successMessage('pull', res({ commits: 0, target: 'origin/main' }))).toBe('Already up to date from origin/main');
    expect(successMessage('push', res({ commits: 0, target: 'origin/main' }))).toBe('Nothing to push to origin/main');
  });
});

describe('GitFeedback', () => {
  afterEach(() => vi.useRealTimers());
  function make() {
    document.body.innerHTML = `<button id="st" class="hidden"><span class="status-git-label"></span></button><div id="out" tabindex="0"></div><input id="ed" />`;
    const open = vi.fn();
    const fb = new GitFeedback({ status: document.getElementById('st'), output: document.getElementById('out') }, open);
    return { fb, open, st: document.getElementById('st')!, out: document.getElementById('out')! };
  }

  it('success fades after about five seconds', () => {
    vi.useFakeTimers();
    const { fb, st } = make();
    fb.start('push');
    expect(st.textContent).toBe('Pushing…');
    fb.done('push', res({ commits: 2, target: 'origin/main', output: 'To remote' }));
    vi.advanceTimersByTime(STATUS_FADE_MS - 100);
    expect(st.classList.contains('hidden')).toBe(false);
    vi.advanceTimersByTime(600);
    expect(st.classList.contains('hidden')).toBe(true);
  });

  it('keeps every run in the log and never moves focus', () => {
    const { fb, out } = make();
    const ed = document.getElementById('ed')!;
    ed.focus();
    fb.start('commit');
    fb.done('commit', res({ summary: '[main abc1234] A', output: '[main abc1234] A' }));
    fb.start('pull');
    fb.fail('pull', { kind: 'conflict', message: 'Conflict.', detail: 'CONFLICT (content)' });
    expect(fb.log.all().map((e) => e.state)).toEqual(['ok', 'error']);
    expect(out.textContent).toContain('CONFLICT (content)');
    expect(out.textContent).toContain('$ git commit');
    expect(document.activeElement).toBe(ed);
  });

  it('escapes git output', () => {
    const { fb, out } = make();
    fb.start('push');
    fb.fail('push', { kind: 'other', message: 'x', detail: '<img src=x onerror=alert(1)>' });
    expect(out.querySelector('img')).toBeNull();
  });
});
