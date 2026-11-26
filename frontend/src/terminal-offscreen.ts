/**
 * Output for a terminal that is out of view (inactive tab, collapsed panel,
 * minimized window) is held briefly and handed to xterm in larger pieces.
 *
 * xterm already skips painting a pane that is out of view, but each write
 * still scrolls the buffer, and every scroll makes xterm's DOM renderer
 * redraw all rows of the pane, measuring glyph widths against a zero-size
 * element. A pane that receives many small batches while out of view
 * therefore costs a full redraw per batch. Coalescing the batches turns
 * that into one redraw per flush.
 *
 * Nothing is dropped: held bytes are written in arrival order, at the latest
 * after `maxDelayMs` (so bells, OSC notifications and replies to terminal
 * queries are late by at most that), as soon as `maxBytes` are held (the
 * backend stops sending at 1 MiB unacked, so this keeps it flowing), and
 * right away when the pane is shown again.
 */

export const OFFSCREEN_MAX_BYTES = 512 * 1024;
export const OFFSCREEN_MAX_DELAY_MS = 250;

/** Writes bytes to xterm; `done` runs once xterm has parsed them. */
export type WriteBytes = (bytes: Uint8Array, done: () => void) => void;

interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class OffscreenOutput {
  private held: Uint8Array[] = [];
  private heldBytes = 0;
  private timer: unknown = null;
  private visible = true;

  constructor(
    private readonly write: WriteBytes,
    /** Ack `n` parsed bytes to the backend. */
    private readonly ack: (n: number) => void,
    private readonly maxBytes = OFFSCREEN_MAX_BYTES,
    private readonly maxDelayMs = OFFSCREEN_MAX_DELAY_MS,
    private readonly timers: Timers = realTimers,
  ) {}

  get isVisible(): boolean {
    return this.visible;
  }

  /** Bytes waiting to be written (0 while visible). */
  get pendingBytes(): number {
    return this.heldBytes;
  }

  /** One batch of pty output, in arrival order. */
  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (this.visible) {
      this.writeNow(bytes);
      return;
    }
    this.held.push(bytes);
    this.heldBytes += bytes.length;
    if (this.heldBytes >= this.maxBytes) this.flush();
    else if (this.timer === null) this.timer = this.timers.set(() => this.flush(), this.maxDelayMs);
  }

  /** Showing the pane writes everything held before any later output. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) this.flush();
  }

  /** Write everything held now, as one batch. */
  flush(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    if (this.heldBytes === 0) return;
    const parts = this.held;
    const all = parts.length === 1 ? parts[0] : new Uint8Array(this.heldBytes);
    if (parts.length > 1) {
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.length;
      }
    }
    this.held = [];
    this.heldBytes = 0;
    this.writeNow(all);
  }

  /** Stop the timer and drop held bytes (the pane is closing). */
  dispose(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.held = [];
    this.heldBytes = 0;
  }

  private writeNow(bytes: Uint8Array): void {
    const n = bytes.length;
    this.write(bytes, () => this.ack(n));
  }
}

/**
 * Report whether `el` is in view: it intersects the viewport (not inside a
 * `display: none` tab or collapsed panel) and the window itself is shown.
 * Returns a function that stops watching.
 */
export function watchInView(el: HTMLElement, onChange: (inView: boolean) => void): () => void {
  let intersecting = true;
  let last = true;
  const emit = () => {
    const now = intersecting && document.visibilityState !== 'hidden';
    if (now !== last) {
      last = now;
      onChange(now);
    }
  };
  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      intersecting = e.isIntersecting ?? e.intersectionRatio > 0;
      emit();
    }, { threshold: 0 });
    io.observe(el);
  }
  document.addEventListener('visibilitychange', emit);
  emit();
  return () => {
    io?.disconnect();
    document.removeEventListener('visibilitychange', emit);
  };
}
