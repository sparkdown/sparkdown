import { api, type GitActionError, type GitBranchStatus, type GitChange } from './api';
import { escapeHtml } from './utils';

/**
 * Commit / Pull / Push for the Changes view (#122, header icons since 0.4.1).
 *
 * The Changes header carries icon buttons: Commit (✓), Pull (↓ + behind
 * count), Push (↑ + ahead count), then Refresh. Commit opens a compact panel
 * under the header: a message (autofocused; ⌘/Ctrl+Enter commits, Esc
 * closes), the changed files with checkboxes (all ticked, plus select-all)
 * and a Commit button that stays disabled until there is a message and a
 * file. The panel closes after a successful commit. Pull / Push spin while
 * running and end with a short inline toast. Without an upstream they are
 * greyed out with a tooltip saying why.
 *
 * Every action runs only on a click, through the core's separate write
 * runner (the user's own git config, credentials, SSH agent, signing and
 * hooks; never an interactive prompt, never a force-push). Errors arrive
 * typed (`GitActionError.kind`): one clear sentence plus git's output under
 * "Details". After each action the view refreshes.
 */
export interface GitActionsDom {
  /** The header icon group (hidden without a repo). */
  actions: HTMLElement;
  commitToggle: HTMLButtonElement;
  pull: HTMLButtonElement;
  push: HTMLButtonElement;
  pullCount: HTMLElement;
  pushCount: HTMLElement;
  panel: HTMLElement;
  message: HTMLTextAreaElement;
  selectAll: HTMLInputElement;
  files: HTMLElement;
  commit: HTMLButtonElement;
  status: HTMLElement;
}

export interface GitActionsOptions {
  /** Repo top level the change paths are relative to (null = no repo). */
  repoRoot(): string | null;
  /** Called after every action (success or failure) to refresh Changes. */
  refresh(): Promise<void> | void;
}

type Busy = 'commit' | 'pull' | 'push' | null;

/** How long a toast stays up: success is short; an error stays longer and
 *  never hides while its Details are open. */
export const TOAST_MS = { ok: 4000, error: 10000 } as const;

function isGitActionError(e: unknown): e is GitActionError {
  return !!e && typeof e === 'object' && typeof (e as GitActionError).kind === 'string';
}

export class GitActions {
  private changes: GitChange[] = [];
  /** Paths the user unticked (so new changes are included by default). */
  private excluded = new Set<string>();
  private branch: GitBranchStatus | null = null;
  private busy: Busy = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dom: GitActionsDom,
    private readonly opts: GitActionsOptions,
  ) {
    dom.commitToggle.addEventListener('click', () => (this.isPanelOpen() ? this.closePanel() : this.openPanel()));
    dom.commit.addEventListener('click', () => void this.commit());
    dom.pull.addEventListener('click', () => void this.pull());
    dom.push.addEventListener('click', () => void this.push());
    dom.message.addEventListener('input', () => this.sync());
    dom.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closePanel(true);
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target === dom.message) {
        e.preventDefault();
        e.stopPropagation();
        void this.commit();
      }
    });
    dom.selectAll.addEventListener('change', () => {
      if (dom.selectAll.checked) this.excluded.clear();
      else for (const c of this.changes) this.excluded.add(c.path);
      this.renderFiles();
      this.sync();
    });
    dom.files.addEventListener('change', (e) => {
      const box = e.target as HTMLInputElement;
      const path = box.dataset.path;
      if (path === undefined) return;
      if (box.checked) this.excluded.delete(path);
      else this.excluded.add(path);
      this.sync();
    });
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
    this.sync();
  }

  /** The paths a Commit would include. */
  selected(): string[] {
    return this.changes.filter((c) => !this.excluded.has(c.path)).map((c) => c.path);
  }

  isPanelOpen(): boolean {
    return !this.dom.panel.hidden;
  }

  openPanel(): void {
    if (!this.opts.repoRoot()) return;
    this.dom.panel.hidden = false;
    this.dom.commitToggle.setAttribute('aria-expanded', 'true');
    this.render();
    this.dom.message.focus();
  }

  closePanel(refocus = false): void {
    this.dom.panel.hidden = true;
    this.dom.commitToggle.setAttribute('aria-expanded', 'false');
    if (refocus) this.dom.commitToggle.focus();
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
      this.closePanel();
    });
  }

  async pull(): Promise<void> {
    const root = this.opts.repoRoot();
    if (root && this.canSync()) await this.run('pull', () => api.gitPull(root));
  }

  async push(): Promise<void> {
    const root = this.opts.repoRoot();
    if (root && this.canSync()) await this.run('push', () => api.gitPush(root));
  }

  private canSync(): boolean {
    const b = this.branch;
    return !!b?.branch && !b.detached && b.has_upstream;
  }

  private async run(
    what: Exclude<Busy, null>,
    call: () => Promise<{ summary: string }>,
    onOk?: () => void,
  ): Promise<void> {
    if (this.busy) return;
    this.busy = what;
    this.hideToast();
    this.sync();
    try {
      const r = await call();
      onOk?.();
      const done = what === 'commit' ? 'Committed' : what === 'pull' ? 'Pulled' : 'Pushed';
      this.showToast(r.summary ? `${done}: ${r.summary}` : done);
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

  private hideToast(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.dom.status.hidden = true;
  }

  private armToast(ms: number): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      // Keep an error up while its Details are open; check again later.
      if (this.dom.status.querySelector('details[open]')) this.armToast(ms);
      else this.dom.status.hidden = true;
    }, ms);
  }

  private showToast(msg: string): void {
    const el = this.dom.status;
    el.hidden = false;
    el.dataset.tone = 'ok';
    el.dataset.kind = '';
    el.setAttribute('role', 'status');
    el.innerHTML = escapeHtml(msg);
    this.armToast(TOAST_MS.ok);
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
    this.armToast(TOAST_MS.error);
  }

  /** Enable / disable buttons, tooltips and counts without rebuilding lists. */
  private sync(): void {
    const d = this.dom;
    const busy = this.busy !== null;
    const n = this.selected().length;
    const total = this.changes.length;
    const hasMsg = !!d.message.value.trim();
    d.commit.disabled = busy || n === 0 || !hasMsg;
    d.commit.textContent =
      this.busy === 'commit' ? 'Committing…' : n === total ? 'Commit' : `Commit ${n} of ${total}`;
    d.commit.title = !hasMsg ? 'Write a commit message first' : n === 0 ? 'Select at least one file' : '';
    d.selectAll.checked = total > 0 && n === total;
    d.selectAll.indeterminate = n > 0 && n < total;
    d.selectAll.disabled = busy || total === 0;
    setBusy(d.commitToggle, this.busy === 'commit');
    d.commitToggle.disabled = busy || (total === 0 && !this.isPanelOpen());
    d.commitToggle.title = total === 0 ? 'Nothing to commit' : 'Commit…';

    const b = this.branch;
    const canSync = this.canSync();
    const why = !b?.branch
      ? 'No branch'
      : b.detached
        ? 'HEAD is detached'
        : !b.has_upstream
          ? `${b.branch} has no upstream branch, so there is nothing to pull from or push to`
          : '';
    d.pull.disabled = busy || !canSync;
    d.push.disabled = busy || !canSync;
    setBusy(d.pull, this.busy === 'pull');
    setBusy(d.push, this.busy === 'push');
    const behind = canSync ? b!.behind : 0;
    const ahead = canSync ? b!.ahead : 0;
    d.pull.title = why || `Pull ${b?.branch} from its upstream${behind ? ` (${behind} behind)` : ''}`;
    d.push.title = why || `Push ${b?.branch} to its upstream${ahead ? ` (${ahead} ahead)` : ''}, never forced`;
    d.pull.setAttribute('aria-label', behind ? `Pull, ${behind} behind` : 'Pull');
    d.push.setAttribute('aria-label', ahead ? `Push, ${ahead} ahead` : 'Push');
    d.pullCount.hidden = behind === 0;
    d.pullCount.textContent = behind ? String(behind) : '';
    d.pushCount.hidden = ahead === 0;
    d.pushCount.textContent = ahead ? String(ahead) : '';
  }

  private renderFiles(): void {
    this.dom.files.innerHTML = this.changes
      .map(
        (c) =>
          `<label class="git-file" title="${escapeHtml(c.path)}"><input type="checkbox" data-path="${escapeHtml(c.path)}"${this.excluded.has(c.path) ? '' : ' checked'} /> <span>${escapeHtml(c.path)}</span></label>`,
      )
      .join('');
  }

  private render(): void {
    const root = this.opts.repoRoot();
    this.dom.actions.hidden = !root;
    if (!root) {
      this.closePanel();
      this.hideToast();
    }
    this.renderFiles();
    this.sync();
  }
}

function setBusy(btn: HTMLElement, on: boolean): void {
  btn.classList.toggle('is-busy', on);
  if (on) btn.setAttribute('aria-busy', 'true');
  else btn.removeAttribute('aria-busy');
}
