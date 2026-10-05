import { api } from './api';

/**
 * Reviewed marks for the Changes review queue (docs/ui-revamp, item 7).
 *
 * A mark is "this path, at this change fingerprint, was reviewed". The
 * fingerprint comes from git (review.rs: content hash + status + counts), so
 * when the file changes again its fingerprint moves, the mark no longer
 * matches, and the file is pending again without any bookkeeping.
 *
 * Marks are per workspace (origin + repo root) and persist across restarts
 * through review_state_load / review_state_save (a small JSON file of its
 * own, capped in Rust). A mark whose change moved on is kept (stale): it is
 * what makes the file read as "changed again" — also after a restart —
 * until the user reviews it again. Marks for files that are no longer
 * changed are dropped on every reconcile.
 */

/** Where the marks live (Tauri commands in the app; a fake in tests). */
export interface ReviewPersistence {
  load(workspace: string): Promise<Record<string, string>>;
  save(workspace: string, entries: Record<string, string>): Promise<void>;
}

export const tauriReviewPersistence: ReviewPersistence = {
  load: (workspace) => api.reviewStateLoad(workspace),
  save: (workspace, entries) => api.reviewStateSave(workspace, entries),
};

/** Most marks kept per workspace (Rust applies the same cap). */
export const MAX_REVIEW_ENTRIES = 2000;

/** The workspace id marks are stored under: machine + repo root. */
export function workspaceId(origin: string | null, repoRoot: string): string {
  return `${origin ?? 'local'}\n${repoRoot}`;
}

export class ReviewState {
  private workspace: string | null = null;
  /** Path → the fingerprint the user reviewed. A stale mark (the file's
   *  fingerprint moved on) stays: it is the "changed again" record. */
  private marks = new Map<string, string>();
  /** Paths with a stale mark, derived by reconcile from the marks and the
   *  current fingerprints (so it survives a restart with the marks). */
  private changedAgain = new Set<string>();
  private loadGen = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(
    private readonly store: ReviewPersistence = tauriReviewPersistence,
    private readonly saveDelayMs = 250,
  ) {}

  getWorkspace(): string | null {
    return this.workspace;
  }

  /** Switch to `workspace` and load its marks. Unchanged id: no-op. A load
   *  that resolves after another switch is dropped. */
  async setWorkspace(workspace: string | null): Promise<void> {
    if (workspace === this.workspace) return;
    await this.flush();
    this.workspace = workspace;
    this.marks = new Map();
    this.changedAgain.clear();
    const gen = ++this.loadGen;
    if (!workspace) return;
    let loaded: Record<string, string> = {};
    try {
      loaded = await this.store.load(workspace);
    } catch {
      loaded = {};
    }
    if (gen !== this.loadGen) return;
    for (const [path, fp] of Object.entries(loaded ?? {})) {
      if (typeof fp === 'string') this.marks.set(path, fp);
    }
  }

  isReviewed(path: string, fingerprint: string): boolean {
    return this.marks.get(path) === fingerprint;
  }

  /** Reviewed before, changed since (shown as "changed since you looked"). */
  isChangedAgain(path: string): boolean {
    return this.changedAgain.has(path);
  }

  changedAgainCount(): number {
    return this.changedAgain.size;
  }

  /** Mark (or unmark) `path` at `fingerprint`. */
  set(path: string, fingerprint: string, reviewed: boolean): void {
    if (reviewed) {
      if (this.marks.get(path) === fingerprint) return;
      this.marks.delete(path); // re-insert: newest last, for the cap
      this.marks.set(path, fingerprint);
      while (this.marks.size > MAX_REVIEW_ENTRIES) {
        const oldest = this.marks.keys().next().value;
        if (oldest === undefined) break;
        this.marks.delete(oldest);
      }
    } else if (!this.marks.delete(path)) {
      this.changedAgain.delete(path);
      return;
    }
    this.changedAgain.delete(path);
    this.scheduleSave();
  }

  /** Drop every mark (Changes: Reset review). */
  clear(): void {
    if (this.marks.size === 0 && this.changedAgain.size === 0) return;
    this.marks.clear();
    this.changedAgain.clear();
    this.scheduleSave();
  }

  /**
   * A fresh change list (path → fingerprint) arrived: drop marks for files
   * that are no longer changed; a mark whose fingerprint moved on (the file
   * changed after review) is kept and flags the file as "changed again".
   */
  reconcile(current: ReadonlyMap<string, string>): void {
    let changed = false;
    this.changedAgain.clear();
    for (const [path, fp] of [...this.marks]) {
      const now = current.get(path);
      if (now === undefined) {
        this.marks.delete(path);
        changed = true;
      } else if (now !== fp) {
        this.changedAgain.add(path);
      }
    }
    if (changed) this.scheduleSave();
  }

  /** Files in `current` not yet reviewed at their current fingerprint. */
  pendingCount(current: ReadonlyMap<string, string>): number {
    let n = 0;
    for (const [path, fp] of current) if (!this.isReviewed(path, fp)) n++;
    return n;
  }

  /** Snapshot of the marks (tests, debugging). */
  entries(): Record<string, string> {
    return Object.fromEntries(this.marks);
  }

  /** Write pending changes now. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.workspace) return;
    this.dirty = false;
    try {
      await this.store.save(this.workspace, this.entries());
    } catch {
      // Best effort: the marks stay in memory for this session.
    }
  }

  private scheduleSave(): void {
    if (!this.workspace) return;
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), this.saveDelayMs);
  }
}
