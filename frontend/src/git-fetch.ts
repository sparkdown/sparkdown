/**
 * Background fetch (#175): keep the Pull behind count current.
 *
 * Nothing else in the app runs `git fetch`, so after a push from elsewhere
 * the remote-tracking ref (and the ↓ count read from it) stays stale. This
 * runs a quiet fetch of the current branch's upstream:
 *
 * - when the window gains focus,
 * - every {@link FETCH_INTERVAL_MS} while it stays focused (the timer stops
 *   on blur),
 * - once right after a rejected push, so the behind count shows next to the
 *   "pull first" error.
 *
 * At most one fetch is in flight per window (the core also refuses a second
 * one), and a focus burst within {@link MIN_GAP_MS} of the last fetch is
 * skipped. It is off when the setting is off, outside a repo, without an
 * upstream, and in remote (SSH) sessions. Failures stay silent: a remote
 * that needs credentials is simply skipped (the core never prompts).
 */
export const FETCH_INTERVAL_MS = 5 * 60 * 1000;
/** Focus events closer than this to the last fetch don't fetch again. */
export const MIN_GAP_MS = 30 * 1000;

export interface BackgroundFetchOptions {
  /** Settings → Git → "Fetch in the background". */
  enabled(): boolean;
  /** Repo top level, or null without a repo. */
  repoRoot(): string | null;
  /** Remote (SSH) session: never fetch. */
  isRemote(): boolean;
  /** The branch tracks an upstream (nothing to fetch otherwise). */
  hasUpstream(): boolean;
  fetch(root: string): Promise<unknown>;
  /** A fetch finished (ok): refresh the branch's ahead/behind. */
  onFetched(): Promise<void> | void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
}

export class BackgroundFetcher {
  private inFlight: Promise<boolean> | null = null;
  private timer: unknown = null;
  private lastFetched: number | null = null;
  private lastAttempt: number | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: BackgroundFetchOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** When the last fetch succeeded (ms epoch), for the Pull tooltip. */
  lastFetchedAt(): number | null {
    return this.lastFetched;
  }

  /** The window gained (true) or lost (false) focus. */
  setFocused(focused: boolean): void {
    if (!focused) {
      this.stopTimer();
      return;
    }
    if (!this.timer) {
      const set = this.opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
      this.timer = set(() => void this.run(), FETCH_INTERVAL_MS);
    }
    const last = this.lastAttempt;
    if (last === null || this.now() - last >= MIN_GAP_MS) void this.run();
  }

  /** A push was rejected (the remote has commits we don't): fetch now. */
  afterRejectedPush(): Promise<boolean> {
    return this.run();
  }

  dispose(): void {
    this.stopTimer();
  }

  /** Fetch if allowed. Resolves true when a fetch ran and succeeded. */
  run(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const root = this.opts.repoRoot();
    if (!root || !this.opts.enabled() || this.opts.isRemote() || !this.opts.hasUpstream()) {
      return Promise.resolve(false);
    }
    this.lastAttempt = this.now();
    const p = (async () => {
      // Yield first, so `inFlight` is set before the finally below can run
      // (even when fetch throws synchronously).
      await Promise.resolve();
      try {
        try {
          const r = await this.opts.fetch(root);
          if (r === 'busy') return false;
          this.lastFetched = this.now();
        } catch {
          return false; // quiet: auth / network failures are skipped
        }
        try {
          await this.opts.onFetched();
        } catch {
          // the branch refresh shows its own state
        }
        return true;
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = p;
    return p;
  }

  private stopTimer(): void {
    if (this.timer) (this.opts.clearInterval ?? ((id) => clearInterval(id as number)))(this.timer);
    this.timer = null;
  }
}

/** "last fetched just now / 1 min ago / N min ago / N h ago". */
export function fetchedAgo(at: number | null, now: number = Date.now()): string | null {
  if (at === null) return null;
  const min = Math.floor((now - at) / 60000);
  if (min < 1) return 'last fetched just now';
  if (min < 60) return `last fetched ${min} min ago`;
  return `last fetched ${Math.floor(min / 60)} h ago`;
}
