import { api, type GitActionError, type GitBranchStatus, type GitChange } from './api';
import { escapeHtml } from './utils';

/**
 * Commit / Pull / Push for the Changes view (#122).
 *
 * A message box + Commit button (with an optional per-file selection), and
 * Pull / Push for the current branch with its ahead/behind counts. Every
 * action runs only on a click, through the core's separate write runner
 * (the user's own git config, credentials, SSH agent, signing and hooks;
 * never an interactive prompt, never a force-push). Errors arrive typed
 * (`GitActionError.kind`) and are shown as one clear sentence plus git's
 * output under "Details". After each action the view refreshes.
 */
export interface GitActionsDom {
  root: HTMLElement;
  message: HTMLTextAreaElement;
  commit: HTMLButtonElement;
  pull: HTMLButtonElement;
  push: HTMLButtonElement;
  sync: HTMLElement;
  files: HTMLElement;
  status: HTMLElement;
}

export interface GitActionsOptions {
  /** Repo top level the change paths are relative to (null = no repo). */
  repoRoot(): string | null;
  /** Called after every action (success or failure) to refresh Changes. */
  refresh(): Promise<void> | void;
}

type Busy = 'commit' | 'pull' | 'push' | null;

export function isGitActionError(e: unknown): e is GitActionError {
  return !!e && typeof e === 'object' && typeof (e as GitActionError).kind === 'string';
}

export class GitActions {
  private changes: GitChange[] = [];
  /** Paths the user unticked (so new changes are included by default). */
  private excluded = new Set<string>();
  private branch: GitBranchStatus | null = null;
  private busy: Busy = null;
  private chooseOpen = false;

  constructor(
    private readonly dom: GitActionsDom,
    private readonly opts: GitActionsOptions,
  ) {
    dom.commit.addEventListener('click', () => void this.commit());
    dom.pull.addEventListener('click', () => void this.pull());
    dom.push.addEventListener('click', () => void this.push());
    dom.message.addEventListener('input', () => this.sync());
    dom.message.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        void this.commit();
      }
    });
    dom.files.addEventListener('change', (e) => {
      const box = e.target as HTMLInputElement;
      const path = box.dataset.path;
      if (path === undefined) return;
      if (box.checked) this.excluded.delete(path);
      else this.excluded.add(path);
      this.sync();
    });
    dom.files.addEventListener('toggle', (e) => {
      this.chooseOpen = (e.target as HTMLDetailsElement).open;
    }, true);
    this.render();
  }

  /** The latest working-tree changes (files only, no nested repos). */
  setChanges(changes: GitChange[]): void {
    this.changes = changes.filter((c) => !c.is_dir);
    const live = new Set(this.changes.map((c) => c.path));
    for (const p of [...this.excluded]) if (!live.has(p)) this.excluded.delete(p);
    this.render();
  }

  setBranch(status: GitBranchStatus | null): void {
    this.branch = status;
    this.render();
  }

  /** The paths a Commit would include. */
  selected(): string[] {
    return this.changes.filter((c) => !this.excluded.has(c.path)).map((c) => c.path);
  }

  async commit(): Promise<void> {
    const root = this.opts.repoRoot();
    if (!root || this.busy) return;
    const message = this.dom.message.value;
    if (!message.trim()) {
      this.showError({ kind: 'empty_message', message: 'Write a commit message first.', detail: '' });
      this.dom.message.focus();
      return;
    }
    const paths = this.selected();
    if (paths.length === 0) {
      this.showError({ kind: 'nothing_to_commit', message: 'Select at least one file to commit.', detail: '' });
      return;
    }
    // Every change ticked: commit all (lets git pick up anything the view
    // hasn't caught yet, the same as `git commit -a` plus new files).
    const all = this.excluded.size === 0;
    await this.run('commit', () => api.gitCommit(root, message, all ? null : paths), () => {
      this.dom.message.value = '';
      this.excluded.clear();
    });
  }

  async pull(): Promise<void> {
    const root = this.opts.repoRoot();
    if (root) await this.run('pull', () => api.gitPull(root));
  }

  async push(): Promise<void> {
    const root = this.opts.repoRoot();
    if (root) await this.run('push', () => api.gitPush(root));
  }

  private async run(
    what: Exclude<Busy, null>,
    call: () => Promise<{ summary: string }>,
    onOk?: () => void,
  ): Promise<void> {
    if (this.busy) return;
    this.busy = what;
    this.showStatus(`${what === 'commit' ? 'Committing' : what === 'pull' ? 'Pulling' : 'Pushing'}…`, 'busy');
    this.sync();
    try {
      const r = await call();
      onOk?.();
      const done = what === 'commit' ? 'Committed' : what === 'pull' ? 'Pulled' : 'Pushed';
      this.showStatus(r.summary ? `${done}: ${r.summary}` : done, 'ok');
    } catch (e) {
      this.showError(
        isGitActionError(e) ? e : { kind: 'other', message: 'Git reported an error.', detail: String(e) },
      );
    } finally {
      this.busy = null;
      this.render();
      try {
        await this.opts.refresh();
      } catch {
        // The refresh shows its own error state.
      }
    }
  }

  private showStatus(msg: string, tone: 'ok' | 'busy'): void {
    const el = this.dom.status;
    el.hidden = false;
    el.dataset.tone = tone;
    el.dataset.kind = '';
    el.setAttribute('role', 'status');
    el.innerHTML = escapeHtml(msg);
  }

  private showError(e: GitActionError): void {
    const el = this.dom.status;
    el.hidden = false;
    el.dataset.tone = 'error';
    el.dataset.kind = e.kind;
    el.setAttribute('role', 'alert');
    el.innerHTML =
      `<span class="git-error-msg">${escapeHtml(e.message)}</span>` +
      (e.detail
        ? `<details class="git-error-detail"><summary>Details</summary><pre>${escapeHtml(e.detail)}</pre></details>`
        : '');
  }

  /** Enable / disable buttons and labels without rebuilding the lists. */
  private sync(): void {
    const d = this.dom;
    const busy = this.busy !== null;
    const n = this.selected().length;
    d.commit.disabled = busy || n === 0;
    d.commit.textContent =
      this.busy === 'commit' ? 'Committing…' : n === this.changes.length ? 'Commit' : `Commit ${n} of ${this.changes.length}`;
    d.commit.title = d.message.value.trim() ? '' : 'Write a commit message first';
    const b = this.branch;
    const canSync = !!b?.branch && !b.detached && b.has_upstream;
    const why = !b?.branch
      ? 'No branch'
      : b.detached
        ? 'HEAD is detached'
        : !b.has_upstream
          ? `${b.branch} has no upstream`
          : '';
    d.pull.disabled = busy || !canSync;
    d.push.disabled = busy || !canSync;
    d.pull.title = why || `Pull ${b?.branch} from its upstream`;
    d.push.title = why || `Push ${b?.branch} to its upstream (never forced)`;
    d.pull.textContent = this.busy === 'pull' ? 'Pulling…' : canSync && b!.behind > 0 ? `Pull ↓${b!.behind}` : 'Pull';
    d.push.textContent = this.busy === 'push' ? 'Pushing…' : canSync && b!.ahead > 0 ? `Push ↑${b!.ahead}` : 'Push';
  }

  private render(): void {
    const d = this.dom;
    const root = this.opts.repoRoot();
    d.root.hidden = !root;
    const b = this.branch;
    d.sync.innerHTML = !b?.branch
      ? ''
      : `<span class="git-branch">${escapeHtml(b.branch)}</span>` +
        (b.detached
          ? `<span class="git-ab">detached</span>`
          : b.has_upstream
            ? `<span class="git-ab" title="ahead / behind its upstream">↑${b.ahead} ↓${b.behind}</span>`
            : `<span class="git-ab">no upstream</span>`);
    if (this.changes.length === 0) {
      d.files.innerHTML = '';
    } else {
      const rows = this.changes
        .map(
          (c) =>
            `<label class="git-file"><input type="checkbox" data-path="${escapeHtml(c.path)}"${this.excluded.has(c.path) ? '' : ' checked'} /> <span>${escapeHtml(c.path)}</span></label>`,
        )
        .join('');
      d.files.innerHTML =
        `<details class="git-files"${this.chooseOpen ? ' open' : ''}><summary>Choose files</summary>${rows}</details>`;
    }
    this.sync();
  }
}
