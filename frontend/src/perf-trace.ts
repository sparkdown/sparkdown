/**
 * Opt-in performance tracing for diagnosing real-app latency (the vitest
 * bench harness runs in jsdom, which has no layout/paint — the costs that
 * dominate a real WebKit webview).
 *
 * Enable by creating the marker file, launch the app, then read the trace:
 *
 *   touch /tmp/sparkdown-trace-enable
 *   open -a SparkDown /tmp/perf-test-large.md
 *   cat /tmp/sparkdown-trace.log
 *
 * Spans are buffered in memory and flushed (debounced) to the trace file.
 * When the marker file is absent, every call here is a no-op.
 */
import { api } from './api';

const MARKER = '/tmp/sparkdown-trace-enable';
const TRACE_FILE = '/tmp/sparkdown-trace.log';

let enabled = false;
let buffer: string[] = [];
let flushTimer: number | null = null;
const t0 = performance.now();

export async function initPerfTrace(): Promise<void> {
  try {
    await api.readFile(MARKER);
    enabled = true;
    trace('trace-start', 0);
  } catch {
    enabled = false;
  }
}

/** Record a completed span. Durations in ms. */
export function trace(name: string, durationMs: number, detail?: string): void {
  if (!enabled) return;
  const at = (performance.now() - t0).toFixed(1);
  buffer.push(
    `+${at}ms ${name} ${durationMs.toFixed(1)}ms${detail ? ` (${detail})` : ''}`,
  );
  scheduleFlush();
}

/** Start a span; call the returned function to record it. */
export function span(name: string, detail?: string): () => void {
  if (!enabled) return () => {};
  const start = performance.now();
  return () => trace(name, performance.now() - start, detail);
}

/**
 * Measure the layout+paint flush that follows synchronous DOM work: a forced
 * layout read captures style/layout, and a double-rAF brackets the first
 * frame actually presented after `label`'s DOM changes.
 */
export function traceNextPaint(label: string, container?: HTMLElement): void {
  if (!enabled) return;
  const start = performance.now();
  if (container) {
    void container.offsetHeight; // force style+layout now
    trace(`${label}:forced-layout`, performance.now() - start);
  }
  const beforeRaf = performance.now();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      trace(`${label}:first-frame-presented`, performance.now() - beforeRaf);
    });
  });
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 500);
}

async function flush(): Promise<void> {
  if (!enabled || buffer.length === 0) return;
  const lines = buffer;
  buffer = [];
  try {
    let existing = '';
    try {
      existing = await api.readFile(TRACE_FILE);
    } catch {
      // first write
    }
    await api.writeFile(TRACE_FILE, existing + lines.join('\n') + '\n');
  } catch {
    // tracing must never break the app; drop the lines
  }
}
