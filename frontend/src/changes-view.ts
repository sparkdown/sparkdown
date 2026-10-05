import { api, type ChangeStat, type GitChange } from './api';
import { escapeHtml } from './utils';
import {
  partitionChanges,
  noiseReasonLabel,
  abridgeHunks,
  parseHunks,
  type DiffHunk,
  type NoiseReason,
} from './meat';
import { ReviewState, workspaceId } from './review-state';

/** How a row was activated: show its diff, or open it in the editor. */
export type OpenHow = 'diff' | 'editor';

export interface ChangesViewOptions {
  /** Machine the repo lives on (null = local): part of the review key. */
  origin?(): string | null;
  /** Pending (not yet reviewed) files in the queue changed. */
  onPending?(pending: number, total: number): void;
  /** Any reviewed mark or the selection changed (diff header re-sync). */
  onReviewChange?(): void;
  /** Reviewed marks store (tests inject one with a fake persistence). */
  review?: ReviewState;
}

/** Outcome of one status + stats load. */
type LoadResult = 'ok' | 'stale' | 'error' | 'no-root' | 'no-repo';

const STATUS_LETTER: Record<GitChange['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

const CHECK_SVG =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
const CARET_SVG =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

/** More files than this: the meter is one continuous bar, not segments. */
const MAX_METER_SEGMENTS = 48;

/**
 * Changes view — the review queue (docs/ui-revamp, item 7): "what did my
 * agent just change, and what have I read?" Lists the git working-tree
 * changes with a per-file reviewed checkbox, +/− counts and a progress
 * meter; "Worth reading" first, generated/vendored files folded into a
 * collapsed "Probably noise" group (the meat heuristic).
 *
 * The queue (counts, meter, badge) is the "Worth reading" group; when only
 * noise changed, the noise files are the queue. Reviewed marks are keyed by
 * path + change fingerprint (review-state.ts), so a file that changes again
 * after review is pending again. Read-only; git-backed; refreshed by the
 * filesystem watcher.
 */
export class ChangesView {
  private listEl: HTMLElement;
  private root: string | null = null;
  /** The repo's top-level dir from the last git status. Change paths are
   *  relative to this — NOT to `root`, which may be a subdirectory of the
   *  repo (the sidebar re-roots to an opened file's parent). */
  private repoRoot: string | null = null;
  private onOpen: (path: string, status: GitChange['status'], how: OpenHow) => void;
  private lastChanges: GitChange[] = [];
  private stats = new Map<string, ChangeStat>();
  /** path → fingerprint of the current change (review key). */
  private prints = new Map<string, string>();
  /** The selected row (the file the diff pane follows). */
  private current: string | null = null;
  /** Whether the collapsed "noise" group is expanded. Off by default so the
   *  list reads as a "meat" (reading) view; the user opts into the full list. */
  private showNoise = false;
  private lastLoad: LoadResult = 'no-root';
  readonly review: ReviewState;

  private onStatus: (changes: GitChange[]) => void;
  private readonly opts: ChangesViewOptions;
  /** Bumped every time the root changes. A refresh captures it before its
   *  async gitStatus and drops the result if the root moved on meanwhile, so a
   *  slow status for folder A can't overwrite folder B after an A→B switch. */
  private generation = 0;

  constructor(
    listEl: HTMLElement,
    onOpen: (path: string, status: GitChange['status'], how: OpenHow) => void,
    onStatus: (changes: GitChange[]) => void = () => {},
    opts: ChangesViewOptions = {},
  ) {
    this.listEl = listEl;
    this.onOpen = onOpen;
    this.onStatus = onStatus;
    this.opts = opts;
    this.review = opts.review ?? new ReviewState();
    this.listEl.setAttribute('role', 'listbox');
    this.listEl.setAttribute('aria-label', 'Changed files');
    this.listEl.tabIndex = 0;
    this.listEl.addEventListener('click', (e) => this.onClick(e));
    this.listEl.addEventListener('keydown', (e) => {
      if (this.handleKey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }

  setRoot(root: string | null): void {
    if (root === this.root) return;
    this.root = root;
    this.generation++;
  }

  /** Re-query git status and re-render the list. Safe to call frequently. */
  async refresh(): Promise<void> {
    const result = await this.load();
    if (result === 'stale') return;
    this.render();
  }

  /**
   * Refresh the status, stats and pending count (for the badge) without
   * touching the list DOM — cheap enough to run from the watcher even when
   * the Changes panel isn't visible.
   */
  async refreshCount(): Promise<void> {
    await this.load();
  }

  /** git status → numstat/fingerprints → reviewed marks → callbacks. */
  private async load(): Promise<LoadResult> {
    const root = this.root;
    if (!root) {
      this.setChanges(null, [], []);
      return (this.lastLoad = 'no-root');
    }
    const gen = this.generation;
    let status;
    try {
      status = await api.gitStatus(root);
    } catch {
      if (gen !== this.generation) return 'stale'; // root moved on
      this.setChanges(null, [], []);
      return (this.lastLoad = 'error');
    }
    if (gen !== this.generation) return 'stale'; // root moved on
    if (!status.is_repo) {
      this.setChanges(null, [], []);
      return (this.lastLoad = 'no-repo');
    }
    const repoRoot = status.top_level ?? root;
    let stats: ChangeStat[] | null = null;
    if (status.changes.length > 0) {
      try {
        stats = await api.gitChangeStats(repoRoot, status.changes);
      } catch {
        stats = null; // counts unknown; keep the old fingerprints
      }
      if (gen !== this.generation) return 'stale';
    }
    const origin = this.opts.origin?.() ?? null;
    try {
      await this.review.setWorkspace(workspaceId(origin, repoRoot));
    } catch {
      // Marks unavailable: everything reads as pending.
    }
    if (gen !== this.generation) return 'stale';
    this.setChanges(status.top_level, status.changes, stats);
    return (this.lastLoad = 'ok');
  }

  /** Apply a load: stats, fingerprints, reconcile marks, fire callbacks. */
  private setChanges(
    repoRoot: string | null,
    changes: GitChange[],
    stats: ChangeStat[] | null,
  ): void {
    this.repoRoot = repoRoot;
    this.lastChanges = changes;
    const prevPrints = this.prints;
    this.stats = new Map();
    this.prints = new Map();
    for (const s of stats ?? []) this.stats.set(s.path, s);
    for (const c of changes) {
      const fp =
        this.stats.get(c.path)?.fingerprint ??
        (stats === null ? prevPrints.get(c.path) : undefined) ??
        `${c.status}:unknown`;
      this.prints.set(c.path, fp);
    }
    // Only a load with real fingerprints may drop marks: a failed stats call
    // must not reset the review.
    if (stats !== null || changes.length === 0) {
      if (repoRoot) this.review.reconcile(this.prints);
    }
    if (this.current && !this.prints.has(this.current)) this.current = null;
    this.onStatus(changes);
    this.emitPending();
  }

  private emitPending(): void {
    const queue = this.queueFiles();
    const pending = queue.filter((c) => !this.isReviewed(c.path)).length;
    this.opts.onPending?.(pending, queue.length);
  }

  /** The repo top-level dir change paths are relative to (null off-repo). */
  getRepoRoot(): string | null {
    return this.repoRoot;
  }

  /** Whether `path` is currently untracked (governs how to fetch its diff). */
  isUntracked(path: string): boolean {
    return this.lastChanges.some((c) => c.path === path && c.status === 'untracked');
  }

  // --- Queue model --------------------------------------------------------

  /** A changed file by repo-relative path. */
  change(path: string): GitChange | undefined {
    return this.lastChanges.find((c) => c.path === path);
  }

  /** Line counts for `path` (null when unknown). */
  statFor(path: string): ChangeStat | null {
    return this.stats.get(path) ?? null;
  }

  isReviewed(path: string): boolean {
    const fp = this.prints.get(path);
    return fp !== undefined && this.review.isReviewed(path, fp);
  }

  hasChanges(): boolean {
    return this.lastChanges.length > 0;
  }

  getCurrent(): string | null {
    return this.current;
  }

  /** The groups in display order: pending first, reviewed after, each
   *  keeping git's order. */
  groups(): { meat: GitChange[]; noise: Array<GitChange & { reason: NoiseReason }> } {
    const { meat, noise } = partitionChanges(this.lastChanges);
    const byReview = <T extends GitChange>(list: T[]): T[] => [
      ...list.filter((c) => !this.isReviewed(c.path)),
      ...list.filter((c) => this.isReviewed(c.path)),
    ];
    return { meat: byReview(meat), noise: byReview(noise) };
  }

  /** The files the counts, meter and badge are about. */
  private queueFiles(): GitChange[] {
    const { meat, noise } = this.groups();
    return meat.length > 0 ? meat : noise;
  }

  /** Files j/k walk through: the visible rows (noise only when expanded,
   *  or when the selection is inside it). */
  navOrder(): GitChange[] {
    const { meat, noise } = this.groups();
    const inNoise = this.current !== null && noise.some((c) => c.path === this.current);
    return this.showNoise || inNoise || meat.length === 0 ? [...meat, ...noise] : meat;
  }

  /** Select `path` (no open). Re-renders the selection only. */
  select(path: string | null): void {
    if (path !== null && !this.prints.has(path)) return;
    if (this.current === path) return;
    this.current = path;
    this.syncSelection();
    this.opts.onReviewChange?.();
  }

  /** Where the queue would start: the current file, else the first pending,
   *  else the first file. */
  startFile(): string | null {
    if (this.current) return this.current;
    const order = this.navOrder();
    return (order.find((c) => !this.isReviewed(c.path)) ?? order[0])?.path ?? null;
  }

  /** Move the selection by `delta` rows from `from` (default: the current
   *  file) and open it. Returns the new path, or null at either end. */
  move(delta: 1 | -1, from: string | null = this.current): string | null {
    const order = this.navOrder();
    if (order.length === 0) return null;
    const idx = from ? order.findIndex((c) => c.path === from) : -1;
    const next = idx === -1 ? (delta === 1 ? 0 : order.length - 1) : idx + delta;
    const target = order[next];
    if (!target) return null;
    this.select(target.path);
    this.onOpen(target.path, target.status, 'diff');
    return target.path;
  }

  /** Set the reviewed mark of `path` (default: the current file). */
  setReviewed(path: string | null, reviewed: boolean): void {
    if (!path) return;
    const fp = this.prints.get(path);
    if (fp === undefined) return;
    this.review.set(path, fp, reviewed);
    this.afterReviewChange();
  }

  toggleReviewed(path: string | null = this.current): void {
    if (!path) return;
    this.setReviewed(path, !this.isReviewed(path));
  }

  /**
   * Space: mark `path` (default: current) reviewed and open the next pending
   * file after it in the queue (wrapping), or stay put when none is left.
   * Returns the file opened next, or null.
   */
  markReviewedAndNext(path: string | null = this.current): string | null {
    const target = path ?? this.startFile();
    if (!target) return null;
    const order = this.navOrder();
    const idx = order.findIndex((c) => c.path === target);
    const rotated = idx === -1 ? order : [...order.slice(idx + 1), ...order.slice(0, idx)];
    const next = rotated.find((c) => c.path !== target && !this.isReviewed(c.path)) ?? null;
    this.setReviewed(target, true);
    if (!next) {
      this.select(target);
      return null;
    }
    this.select(next.path);
    this.onOpen(next.path, next.status, 'diff');
    return next.path;
  }

  /** Mark every changed file reviewed (Changes: Mark all as reviewed). */
  markAllReviewed(): void {
    for (const c of this.lastChanges) {
      const fp = this.prints.get(c.path);
      if (fp !== undefined) this.review.set(c.path, fp, true);
    }
    this.afterReviewChange();
  }

  /** Drop every mark (Changes: Reset review). */
  resetReview(): void {
    this.review.clear();
    this.afterReviewChange();
  }

  private afterReviewChange(): void {
    if (this.lastLoad === 'ok' && this.lastChanges.length > 0) this.renderList();
    this.emitPending();
    this.opts.onReviewChange?.();
  }

  /** Open `path` (default: current) as a diff or in the editor. */
  open(how: OpenHow, path: string | null = this.current ?? this.startFile()): void {
    const c = path ? this.change(path) : undefined;
    if (!c) return;
    this.select(c.path);
    this.onOpen(c.path, c.status, how);
  }

  /**
   * Review keys (the list and the diff pane; never the editor/terminal):
   * ↓/↑ move and open (j/k also work, vim-style, but are not advertised),
   * Space toggles: a pending file is marked reviewed and the next pending
   * one opens; a reviewed file goes back to pending and stays selected.
   * Enter opens the diff, Shift+Enter opens the editor at the first changed
   * line. Returns true when the key was handled.
   */
  handleKey(e: KeyboardEvent, opts: { enter?: boolean } = {}): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const t = e.target as HTMLElement | null;
    if (t && (t.closest?.('input, textarea, select, [contenteditable="true"]') || t.isContentEditable))
      return false;
    if (t && t !== this.listEl && t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter'))
      return false; // let a focused button activate itself
    if (!this.hasChanges()) return false;
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        if (e.shiftKey) return false;
        this.move(1);
        return true;
      case 'k':
      case 'ArrowUp':
        if (e.shiftKey) return false;
        this.move(-1);
        return true;
      case ' ': {
        const cur = this.current ?? this.startFile();
        if (cur && this.isReviewed(cur)) this.setReviewed(cur, false);
        else this.markReviewedAndNext();
        return true;
      }
      case 'Enter':
        if (opts.enter === false && !e.shiftKey) return false;
        this.open(e.shiftKey ? 'editor' : 'diff');
        return true;
      default:
        return false;
    }
  }

  // --- Rendering ----------------------------------------------------------

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest('.changes-noise-toggle')) {
      this.showNoise = !this.showNoise;
      this.renderList();
      return;
    }
    const row = target.closest<HTMLElement>('.change-row');
    const path = row?.dataset.path;
    if (!row || !path) return;
    if (target.closest('.change-check')) {
      this.toggleReviewed(path);
      return;
    }
    this.select(path);
    this.onOpen(path, row.dataset.status as GitChange['status'], 'diff');
  }

  private render(): void {
    switch (this.lastLoad) {
      case 'no-root':
        return this.renderEmpty('Open a folder to see changes.');
      case 'error':
        return this.renderEmpty('Could not read git status.');
      case 'no-repo':
        return this.renderEmpty('This folder is not a git repository.');
      default:
        if (this.lastChanges.length === 0)
          return this.renderEmpty('No changes. Working tree is clean.');
        this.renderList();
    }
  }

  private renderEmpty(msg: string): void {
    this.listEl.removeAttribute('aria-activedescendant');
    this.listEl.innerHTML = `<div class="changes-empty">${escapeHtml(msg)}</div>`;
  }

  private renderList(): void {
    const { meat, noise } = this.groups();
    const queue = meat.length > 0 ? meat : noise;
    const reviewed = queue.filter((c) => this.isReviewed(c.path)).length;
    const parts: string[] = [this.renderSummary(queue, reviewed)];

    if (meat.length > 0) {
      const left = meat.length - meat.filter((c) => this.isReviewed(c.path)).length;
      parts.push(
        `<div class="changes-group-h">Worth reading <span class="changes-group-count">${left === 0 ? 'all reviewed' : `${left} left`}</span></div>`,
      );
      parts.push(meat.map((c) => this.renderRow(c)).join(''));
    } else if (noise.length > 0) {
      parts.push(
        `<div class="changes-empty changes-empty-inline">Only generated / dependency files changed.</div>`,
      );
    }

    if (noise.length > 0) {
      const open = this.showNoise || meat.length === 0;
      parts.push(
        `<button type="button" class="changes-noise-toggle changes-group-h" aria-expanded="${open}" title="${escapeHtml(summarizeNoise(noise))}">` +
          `<span class="changes-noise-caret${open ? ' open' : ''}">${CARET_SVG}</span>` +
          `<span class="changes-noise-label">Probably noise</span>` +
          `<span class="changes-group-count">${noise.length}</span>` +
          `</button>`,
      );
      if (open) {
        parts.push(
          `<div class="changes-noise-group">${noise.map((c) => this.renderRow(c, true)).join('')}</div>`,
        );
      }
    }
    this.listEl.innerHTML = parts.join('');
    this.syncSelection();
  }

  /** "3 / 7 reviewed", the meter, the key hints. */
  private renderSummary(queue: GitChange[], reviewed: number): string {
    const total = queue.length;
    const pending = total - reviewed;
    const again = this.review.changedAgainCount();
    const sub =
      pending === 0
        ? 'All caught up'
        : again > 0
          ? `${again} changed again since you reviewed ${again === 1 ? 'it' : 'them'}`
          : 'Changed since you last looked';
    const currentPending =
      this.current !== null &&
      queue.some((c) => c.path === this.current) &&
      !this.isReviewed(this.current);
    let meter: string;
    if (total <= MAX_METER_SEGMENTS) {
      const segs: string[] = [];
      for (let i = 0; i < reviewed; i++) segs.push('<i class="done"></i>');
      if (currentPending) segs.push('<i class="now"></i>');
      const rest = pending - (currentPending ? 1 : 0);
      for (let i = 0; i < rest; i++) segs.push('<i></i>');
      meter = segs.join('');
    } else {
      // Too many files for readable segments: one proportional bar.
      const now = currentPending ? 1 : 0;
      meter =
        `<i class="done" style="flex:${reviewed}"></i>` +
        (now ? `<i class="now" style="flex:1"></i>` : '') +
        `<i style="flex:${pending - now}"></i>`;
    }
    return (
      `<div class="changes-review">` +
      `<div class="changes-review-top"><strong>${reviewed}<span> / ${total} reviewed</span></strong></div>` +
      `<small class="changes-review-sub">${escapeHtml(sub)}</small>` +
      `<div class="changes-meter" role="progressbar" aria-label="Reviewed files" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${reviewed}">${meter}</div>` +
      `<div class="changes-keys" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Space</kbd> reviewed</span><span><kbd>↩</kbd> open</span></div>` +
      `</div>`
    );
  }

  /** One file row. `noise` rows are shorter and recessive. */
  private renderRow(c: GitChange, noise = false): string {
    const reviewed = this.isReviewed(c.path);
    const again = !reviewed && this.review.isChangedAgain(c.path);
    const name = c.path.split('/').pop() ?? c.path;
    const dir = c.path.slice(0, c.path.length - name.length).replace(/\/$/, '');
    const stat = this.stats.get(c.path);
    let counts = '';
    if (stat?.binary) counts = '<span class="change-bin">bin</span>';
    else if (stat) {
      const adds = stat.adds ?? 0;
      const dels = stat.dels ?? 0;
      counts =
        (adds > 0 ? `<span class="change-adds">+${adds}</span>` : '') +
        (adds > 0 && dels > 0 ? ' ' : '') +
        (dels > 0 ? `<span class="change-dels">−${dels}</span>` : '');
    }
    const cls = [
      'change-row',
      noise ? 'change-row-noise' : '',
      reviewed ? 'reviewed' : '',
      again ? 'changed-again' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const title = again ? `${c.path} — changed since you reviewed it` : c.path;
    return (
      `<div class="${cls}" role="option" aria-selected="false" data-path="${escapeHtml(c.path)}" data-status="${c.status}" title="${escapeHtml(title)}">` +
      `<span class="change-check" role="checkbox" aria-checked="${reviewed}" aria-label="Reviewed" title="${reviewed ? 'Mark as pending' : 'Mark reviewed (Space)'}">${reviewed ? CHECK_SVG : ''}</span>` +
      `<span class="change-badge change-${c.status}">${STATUS_LETTER[c.status]}</span>` +
      `<span class="change-file"><b class="change-name">${escapeHtml(name)}</b>` +
      (dir ? `<em class="change-dir">${escapeHtml(dir)}</em>` : '') +
      `</span>` +
      `<span class="change-counts">${counts}</span>` +
      `</div>`
    );
  }

  /** Reflect `current` on the rows (and the meter's "now" segment). */
  private syncSelection(): void {
    let activeId: string | null = null;
    const rows = this.listEl.querySelectorAll<HTMLElement>('.change-row');
    rows.forEach((el, i) => {
      const on = el.dataset.path === this.current;
      el.classList.toggle('current', on);
      el.setAttribute('aria-selected', String(on));
      el.id = `change-row-${i}`;
      if (on) {
        activeId = el.id;
        el.scrollIntoView?.({ block: 'nearest' });
      }
    });
    if (activeId) this.listEl.setAttribute('aria-activedescendant', activeId);
    else this.listEl.removeAttribute('aria-activedescendant');
    // The meter's "now" segment tracks the selection.
    const summary = this.listEl.querySelector('.changes-review');
    if (summary && this.lastLoad === 'ok') {
      const { meat, noise } = this.groups();
      const queue = meat.length > 0 ? meat : noise;
      const reviewed = queue.filter((c) => this.isReviewed(c.path)).length;
      const tmp = document.createElement('div');
      tmp.innerHTML = this.renderSummary(queue, reviewed);
      const fresh = tmp.firstElementChild;
      if (fresh) summary.replaceWith(fresh);
    }
  }
}

/** A compact reason summary for the noise group header, e.g.
 *  "dependency, lockfile" — the distinct reasons, most common first. */
function summarizeNoise(noise: ReadonlyArray<{ reason: NoiseReason }>): string {
  const counts = new Map<NoiseReason, number>();
  for (const n of noise) counts.set(n.reason, (counts.get(n.reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason]) => noiseReasonLabel(reason))
    .join(', ');
}

// --- Diff rendering ---------------------------------------------------------

/** Is this line part of git's file-header preamble (dropped from the render —
 *  the panel already names the file)? */
function isPreamble(line: string): boolean {
  return (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('similarity ') ||
    line.startsWith('rename ')
  );
}

/** Render one diff body line (add / del / context) to HTML. The +/− marker
 *  sits in its own gutter span; the text keeps its indentation. */
function renderDiffLine(line: string): string {
  let cls = 'diff-context';
  let mark = ' ';
  if (line.startsWith('+')) {
    cls = 'diff-add';
    mark = '+';
  } else if (line.startsWith('-')) {
    cls = 'diff-del';
    mark = '−';
  } else if (line.startsWith('\\')) {
    // "\ No newline at end of file"
    return `<div class="diff-line diff-meta">${escapeHtml(line)}</div>`;
  }
  const text = line.slice(1);
  return (
    `<div class="diff-line ${cls}"><span class="diff-mark" aria-hidden="true">${mark}</span>` +
    `<span class="diff-text">${escapeHtml(text) || '&nbsp;'}</span></div>`
  );
}

/** `@@ -a,b +c,d @@ context` → its parts; null for a non-header. */
export function parseHunkHeader(
  header: string,
): { oldStart: number; newStart: number; context: string } | null {
  const m = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@+ ?(.*)$/.exec(header);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]), context: m[3].trim() };
}

/**
 * The new-file line "Open in editor" jumps to for a hunk: its first added
 * line, or, for a pure deletion, the line that now sits where the removed
 * lines were. Context lines before the first change count; removed lines do
 * not (they are not in the new file). Always ≥ 1.
 */
export function firstChangedLine(hunk: DiffHunk): number {
  const h = parseHunkHeader(hunk.header);
  if (!h) return 1;
  let line = h.newStart;
  for (const l of hunk.lines) {
    if (l.startsWith('+') || l.startsWith('-')) break;
    if (!l.startsWith('\\')) line++;
  }
  return Math.max(1, line);
}

/**
 * The nearest markdown heading at or above `line` (1-based) in `content`,
 * e.g. "## Tools"; headings inside fenced code blocks don't count. Null when
 * there is none.
 */
export function nearestHeading(content: string, line: number): string | null {
  const lines = content.split('\n');
  let fence: string | null = null;
  let found: string | null = null;
  const last = Math.min(line, lines.length);
  for (let i = 0; i < last; i++) {
    const l = lines[i].replace(/\r$/, '');
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) found = `${h[1]} ${h[2]}`;
  }
  if (found && found.length > 72) found = `${found.slice(0, 71)}…`;
  return found;
}

/** What a diff looks like at a glance (for the diff header). */
export interface DiffSummary {
  hunks: number;
  adds: number;
  dels: number;
  /** New-file line of the first change (Shift+Enter target). */
  firstLine: number;
}

export function summarizeDiff(diff: string): DiffSummary {
  const body = diff.split('\n').filter((l) => !isPreamble(l));
  const hunks = parseHunks(body).filter((h) => h.header);
  let adds = 0;
  let dels = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) adds++;
      else if (l.startsWith('-')) dels++;
    }
  }
  return { hunks: hunks.length, adds, dels, firstLine: hunks[0] ? firstChangedLine(hunks[0]) : 1 };
}

export interface RenderDiffOptions {
  /** Reading (meat-abridged, the default) vs full verbatim. */
  reading?: boolean;
  /** Markdown file content (new side): hunk labels use its nearest heading. */
  markdown?: string | null;
  /** Show "Open in editor" per hunk (false for a deleted file). */
  openInEditor?: boolean;
}

/** One hunk as a box: a header (heading or @@ context · line N, plus
 *  "Open in editor") and its lines. */
function renderHunk(hunk: DiffHunk, opts: RenderDiffOptions): string {
  const out: string[] = ['<section class="diff-hunk">'];
  if (hunk.header) {
    const h = parseHunkHeader(hunk.header);
    const line = firstChangedLine(hunk);
    let label = hunk.header;
    if (h) {
      const heading = opts.markdown != null ? nearestHeading(opts.markdown, line) : null;
      const where = heading ?? (h.context || null);
      label = where ? `${where} · line ${line}` : `line ${line}`;
    }
    out.push(
      `<div class="diff-hunk-head"><span class="diff-hunk-label" title="${escapeHtml(hunk.header)}">${escapeHtml(label)}</span>` +
        (opts.openInEditor !== false && h
          ? `<button type="button" class="diff-open-line" data-line="${line}">Open in editor</button>`
          : '') +
        `</div>`,
    );
  }
  for (const line of hunk.lines) out.push(renderDiffLine(line));
  out.push('</section>');
  return out.join('');
}

/**
 * Render a unified-diff string to styled HTML: one box per hunk (header with
 * the nearest heading / @@ context and an "Open in editor" link), then its
 * added/removed/context lines. Kept dependency-free — a small line
 * classifier is all a diff needs, and it keeps the bundle tiny.
 *
 * When `reading` is true (the default — the "meat" reading diff), import-only
 * and whitespace-only hunks are folded away behind a placeholder so only
 * substantive changes show; pass `reading: false` for the full, verbatim diff.
 */
export function renderUnifiedDiff(diff: string, opts: RenderDiffOptions = {}): string {
  const reading = opts.reading ?? true;
  if (!diff.trim()) {
    return '<div class="diff-empty">No textual changes (binary file or identical).</div>';
  }
  const body = diff.split('\n').filter((l) => !isPreamble(l));
  // A trailing newline in git's output is not a context line.
  if (body.length > 0 && body[body.length - 1] === '') body.pop();
  const hunks = parseHunks(body);

  if (!reading) {
    return `<div class="diff">${hunks.map((h) => renderHunk(h, opts)).join('')}</div>`;
  }

  const parts = abridgeHunks(hunks);
  const anyHunks = parts.some((p) => p.kind === 'hunk');
  const anyOmitted = parts.some((p) => p.kind === 'omitted');
  const out: string[] = ['<div class="diff">'];
  // When every hunk is substantive there's nothing to fold, and Reading
  // renders identically to Full — say so, or the toggle looks broken.
  if (anyHunks && !anyOmitted) {
    out.push(
      '<div class="diff-note">Nothing to fold — every change here is substantive, so Reading matches Full.</div>',
    );
  }
  for (const part of parts) {
    if (part.kind === 'hunk') {
      out.push(renderHunk(part.hunk, opts));
    } else {
      const label =
        part.reason === 'import'
          ? `${part.count} import-only ${plural(part.count, 'hunk')} folded`
          : `${part.count} formatting-only ${plural(part.count, 'hunk')} folded`;
      out.push(
        `<div class="diff-omitted" title="Switch to Full to see these">${escapeHtml(label)} — switch to Full to see ${part.count === 1 ? 'it' : 'them'}</div>`,
      );
    }
  }
  // Everything was folded away — tell the reader it's all boilerplate rather
  // than showing a blank pane.
  if (!anyHunks) {
    out.push(
      '<div class="diff-empty">Only imports / formatting changed. Switch to Full to see them.</div>',
    );
  }
  out.push('</div>');
  return out.join('');
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
