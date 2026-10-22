import type { GitActionError, GitActionResult } from './api';
import { escapeHtml } from './utils';

/**
 * Git feedback outside the Changes view (0.4.1): a status-bar item and a
 * "Git" output tab in the bottom pane.
 *
 * - While an action runs the status bar shows a spinner with "Committing…",
 *   "Pulling…" or "Pushing…".
 * - Success leaves a short message ("Pushed 2 commits to origin/main") that
 *   fades after {@link STATUS_FADE_MS}.
 * - An error stays, in the warning colour, until it is clicked.
 * - Clicking the item opens the Git tab, which keeps the full output of every
 *   commit, pull and push run in this window (it lives in this window's
 *   page, so each window has its own log). Nothing ever opens or focuses the
 *   tab by itself.
 */
export type GitAction = 'commit' | 'pull' | 'push';

export const STATUS_FADE_MS = 5000;

const RUNNING: Record<GitAction, string> = {
  commit: 'Committing…',
  pull: 'Pulling…',
  push: 'Pushing…',
};

/** The command line shown in the Git tab for each action. */
const GIT_COMMAND: Record<GitAction, string> = {
  commit: 'git commit',
  pull: 'git pull --no-edit',
  push: 'git push (never forced)',
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The short status-bar line for a successful action. */
export function successMessage(what: GitAction, r: GitActionResult): string {
  if (what === 'commit') {
    // `[main 1a2b3c4] subject` → `Committed 1a2b3c4: subject`
    const m = /^\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{4,})\]\s*(.*)$/.exec(r.summary);
    return m ? `Committed ${m[1]}${m[2] ? `: ${m[2]}` : ''}` : 'Committed';
  }
  const n = r.commits;
  const to = r.target ? ` ${what === 'push' ? 'to' : 'from'} ${r.target}` : '';
  if (n === 0) return what === 'push' ? `Nothing to push${to}` : `Already up to date${to}`;
  if (n == null) return `${what === 'push' ? 'Pushed' : 'Pulled'}${to}`;
  return `${what === 'push' ? 'Pushed' : 'Pulled'} ${plural(n, 'commit')}${to}`;
}

export interface GitLogEntry {
  id: number;
  what: GitAction;
  command: string;
  at: Date;
  state: 'running' | 'ok' | 'error';
  /** The status-bar line (success or the error sentence). */
  message: string;
  /** git's full output. */
  output: string;
}

/** The Git tab's contents: every action run in this window, oldest first. */
export class GitOutputLog {
  private entries: GitLogEntry[] = [];
  private nextId = 1;

  constructor(private readonly el: HTMLElement | null) {
    this.render();
  }

  all(): readonly GitLogEntry[] {
    return this.entries;
  }

  start(what: GitAction): GitLogEntry {
    const e: GitLogEntry = {
      id: this.nextId++,
      what,
      command: GIT_COMMAND[what],
      at: new Date(),
      state: 'running',
      message: RUNNING[what],
      output: '',
    };
    this.entries.push(e);
    this.render();
    return e;
  }

  finish(e: GitLogEntry, state: 'ok' | 'error', message: string, output: string): void {
    e.state = state;
    e.message = message;
    e.output = output;
    this.render();
  }

  /** Scroll the newest entry into view (on opening the tab). */
  scrollToEnd(): void {
    if (this.el) this.el.scrollTop = this.el.scrollHeight;
  }

  private render(): void {
    const el = this.el;
    if (!el) return;
    if (this.entries.length === 0) {
      el.innerHTML =
        '<div class="git-output-empty">Output from Commit, Pull and Push in this window appears here.</div>';
      return;
    }
    el.innerHTML = this.entries
      .map((e) => {
        const time = e.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return (
          `<section class="git-output-entry" data-state="${e.state}" data-id="${e.id}">` +
          `<div class="git-output-head"><span class="git-output-time">${escapeHtml(time)}</span> ` +
          `<code class="git-output-cmd">$ ${escapeHtml(e.command)}</code> ` +
          `<span class="git-output-msg">${escapeHtml(e.message)}</span></div>` +
          (e.output ? `<pre class="git-output-text">${escapeHtml(e.output)}</pre>` : '') +
          `</section>`
        );
      })
      .join('');
    this.scrollToEnd();
  }
}

/** The status-bar item: spinner while running, fading success, sticky error. */
export class GitStatusItem {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private label: HTMLElement | null;

  constructor(
    private readonly el: HTMLElement | null,
    onClick: () => void,
  ) {
    this.label = el?.querySelector('.status-git-label') ?? null;
    el?.addEventListener('click', () => {
      onClick();
      // An error stays until clicked; clicking also dismisses success.
      this.clear();
    });
  }

  state(): 'hidden' | 'running' | 'ok' | 'error' {
    const el = this.el;
    if (!el || el.classList.contains('hidden')) return 'hidden';
    return (el.dataset.state as 'running' | 'ok' | 'error') ?? 'hidden';
  }

  running(what: GitAction): void {
    this.show('running', RUNNING[what], `${RUNNING[what]} Click to see git's output`);
  }

  ok(message: string): void {
    this.show('ok', message, `${message}. Click to see git's output`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.el?.classList.add('is-fading');
      this.timer = setTimeout(() => this.clear(), 400);
    }, STATUS_FADE_MS);
  }

  error(message: string): void {
    this.show('error', message, `${message} Click to see git's output`);
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const el = this.el;
    if (!el) return;
    el.classList.add('hidden');
    el.classList.remove('is-fading');
    delete el.dataset.state;
  }

  private show(state: 'running' | 'ok' | 'error', text: string, title: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const el = this.el;
    if (!el) return;
    el.classList.remove('hidden', 'is-fading');
    el.dataset.state = state;
    el.title = title;
    if (this.label) this.label.textContent = text;
    else el.textContent = text;
  }
}

/** What the Changes view's git actions report to. */
export interface GitReporter {
  start(what: GitAction): void;
  done(what: GitAction, r: GitActionResult): void;
  fail(what: GitAction, e: GitActionError): void;
}

/** Ties the status-bar item and the Git tab log together. */
export class GitFeedback implements GitReporter {
  readonly log: GitOutputLog;
  readonly status: GitStatusItem;
  private current: GitLogEntry | null = null;

  constructor(dom: { status: HTMLElement | null; output: HTMLElement | null }, openOutput: () => void) {
    this.log = new GitOutputLog(dom.output);
    this.status = new GitStatusItem(dom.status, () => {
      openOutput();
      this.log.scrollToEnd();
    });
  }

  start(what: GitAction): void {
    this.current = this.log.start(what);
    this.status.running(what);
  }

  done(what: GitAction, r: GitActionResult): void {
    const msg = successMessage(what, r);
    this.finish(what, 'ok', msg, r.output ?? r.summary);
    this.status.ok(msg);
  }

  fail(what: GitAction, e: GitActionError): void {
    this.finish(what, 'error', e.message, e.detail);
    this.status.error(e.message);
  }

  private finish(what: GitAction, state: 'ok' | 'error', msg: string, output: string): void {
    const entry = this.current?.what === what && this.current.state === 'running' ? this.current : this.log.start(what);
    this.log.finish(entry, state, msg, output);
    this.current = null;
  }
}
