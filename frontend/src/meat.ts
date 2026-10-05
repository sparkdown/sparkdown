/**
 * "meat" — heuristics that abridge an agent's changes into what a human should
 * actually review (concepts/architecture), stripping the low-value noise
 * (lockfiles, generated output, whitespace, pure imports). Inspired by
 * boldsoftware/meat's "reading diff": there, a model does the abridging; here
 * we approximate it with fully local, agent-agnostic heuristics (no vendor
 * API), which is what keeps this usable offline and true to the cockpit's
 * guardrails. A future LLM path can layer plain-English summaries on top of —
 * not instead of — these heuristics.
 *
 * KEEP IN SYNC with `src-tauri/src/meat.rs`, the Rust port used by the MCP
 * review tools (sparkdown_list_changes / sparkdown_read_diff).
 *
 * Two layers live here, both pure and unit-tested:
 *   1. classifyFile(path)     — is a changed file "meat" or "noise"?
 *   2. abridgeDiff(diffText)  — fold a unified diff to its substantive hunks.
 */

/** Why a changed file was judged noise (shown as the group's reason). */
export type NoiseReason =
  | 'lockfile'
  | 'generated'
  | 'minified'
  | 'sourcemap'
  | 'dependency'
  | 'build-output'
  | 'snapshot'
  | 'os-cruft'
  | 'binary-ish';

export interface FileVerdict {
  /** True when the file is worth reviewing; false when it's noise. */
  meat: boolean;
  /** Set when meat === false: the category of noise (for the UI label). */
  reason?: NoiseReason;
}

// Directory segments whose contents are generated/vendored, not authored.
const NOISE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
]);

// OS / editor cruft that gets committed by accident — never review-worthy.
const OS_CRUFT = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.directory']);

// Exact filenames that are lockfiles (dependency resolution output). Stored
// lowercased; the check compares against the lowercased filename so a
// capitalized lockfile (Cargo.lock, Pipfile.lock, Gemfile.lock) still matches.
const LOCKFILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'composer.lock',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'gemfile.lock',
  'go.sum',
]);

/** Split a path into lowercased segments, tolerating leading "./" and both
 *  slash styles. Lowercasing every segment (not just the filename) keeps the
 *  noise-directory check case-insensitive and in sync with meat.rs, so
 *  `Build/app.js` and `Vendor/x.go` classify like their lowercase forms. */
function segments(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .split('/')
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

/**
 * Classify a single changed file (by its repo-relative path) as review-worthy
 * ("meat") or noise. Path-only: no file contents needed, so it's cheap to run
 * over a whole git status on every watcher tick.
 */
export function classifyFile(path: string): FileVerdict {
  const segs = segments(path);
  const name = (segs[segs.length - 1] ?? path).toLowerCase();

  // Any segment in a generated/vendored directory ⇒ noise.
  for (const seg of segs.slice(0, -1)) {
    if (NOISE_DIRS.has(seg)) return { meat: false, reason: dirReason(seg) };
  }

  if (OS_CRUFT.has(name)) return { meat: false, reason: 'os-cruft' };

  if (LOCKFILES.has(name)) return { meat: false, reason: 'lockfile' };

  // Source maps and minified bundles.
  if (name.endsWith('.map')) return { meat: false, reason: 'sourcemap' };
  if (/\.min\.(js|css)$/.test(name)) return { meat: false, reason: 'minified' };

  // Test snapshots (Jest/Vitest) are regenerated, rarely read.
  if (name.endsWith('.snap')) return { meat: false, reason: 'snapshot' };

  // Common generated markers in the filename.
  if (/\.(generated|gen)\.[a-z0-9]+$/.test(name) || name.endsWith('.d.ts')) {
    return { meat: false, reason: 'generated' };
  }

  return { meat: true };
}

function dirReason(seg: string): NoiseReason {
  if (seg === 'node_modules' || seg === 'vendor') return 'dependency';
  return 'build-output';
}

/** Human label for a noise reason (used in the collapsed group header). */
export function noiseReasonLabel(reason: NoiseReason): string {
  switch (reason) {
    case 'lockfile':
      return 'lockfile';
    case 'generated':
      return 'generated';
    case 'minified':
      return 'minified';
    case 'sourcemap':
      return 'source map';
    case 'dependency':
      return 'dependency';
    case 'build-output':
      return 'build output';
    case 'snapshot':
      return 'snapshot';
    case 'os-cruft':
      return 'OS file';
    case 'binary-ish':
      return 'binary';
  }
}

/** Partition a list of changed paths into meat vs noise, preserving order. */
export function partitionChanges<T extends { path: string }>(
  changes: readonly T[],
): { meat: T[]; noise: Array<T & { reason: NoiseReason }> } {
  const meat: T[] = [];
  const noise: Array<T & { reason: NoiseReason }> = [];
  for (const c of changes) {
    const verdict = classifyFile(c.path);
    if (verdict.meat) meat.push(c);
    else noise.push({ ...c, reason: verdict.reason ?? 'generated' });
  }
  return { meat, noise };
}

// --- Diff abridging ("reading diff") --------------------------------------

/** A parsed diff hunk: its header line plus the body lines that follow it. */
export interface DiffHunk {
  header: string;
  lines: string[];
}

/** One element of an abridged diff: a hunk to render, or a placeholder
 *  standing in for hunks that were hidden as noise. */
export type AbridgedPart =
  | { kind: 'hunk'; hunk: DiffHunk }
  | { kind: 'omitted'; count: number; reason: 'import' | 'whitespace' };

const IMPORT_RE =
  /^\s*(import\b|export\s+(?:\*|\{)|from\s+['"]|const\s+\w+\s*=\s*require\()|^\s*(use\s+[\w:]+;|#include\b)/;

/** True for a changed (+/-) line that is import/use/include boilerplate. */
function isImportLine(body: string): boolean {
  return IMPORT_RE.test(body);
}

/**
 * Mark which line indices of a hunk fall inside a MULTI-LINE import statement
 * (`import {\n  a,\n} from './x';`) whose continuation lines don't match the
 * single-line IMPORT_RE. A span opens only on an import/export line with an
 * unbalanced `{` and closes when braces re-balance — so brace-less imports
 * (Python `import os`, Rust `use`) never open a span and can't swallow the
 * code lines that follow them.
 */
function importSpanLines(hunk: DiffHunk): Set<number> {
  const spans = new Set<number>();
  let depth = 0;
  hunk.lines.forEach((line, i) => {
    const body = line.slice(1); // strip the +/-/space marker
    const balance =
      (body.match(/\{/g) ?? []).length - (body.match(/\}/g) ?? []).length;
    if (depth === 0) {
      if (/^\s*(import\b|export\s+(type\s+)?\{)/.test(body) && balance > 0) {
        depth = balance;
        spans.add(i);
      }
    } else {
      spans.add(i);
      depth = Math.max(0, depth + balance);
    }
  });
  return spans;
}

/** Classify a hunk by its changed (+/-) lines only (context is ignored):
 *  - 'whitespace' when the change is whitespace-only: blank lines,
 *    reindentation, spacing inside a line, or re-wrapping (in order)
 *  - 'import' when every change is an import/use/include line (including
 *    lines inside a multi-line import statement)
 *  - 'substantive' otherwise. Pure-metadata hunks with no +/- default to
 *  'whitespace' (nothing to read). */
export function classifyHunk(
  hunk: DiffHunk,
): 'substantive' | 'import' | 'whitespace' {
  const changedIdx: number[] = [];
  hunk.lines.forEach((l, i) => {
    if (l.startsWith('+') || l.startsWith('-')) changedIdx.push(i);
  });
  if (changedIdx.length === 0) return 'whitespace';
  // Strip the +/-/space marker, then a trailing CR so `\r\n` diffs classify
  // identically to `\n` diffs (and match meat.rs, which does the same).
  const body = (i: number) => hunk.lines[i].slice(1).replace(/\r$/, '');

  // Purely blank-line additions/removals are formatting churn.
  if (changedIdx.every((i) => body(i).trim() === '')) return 'whitespace';

  // Whitespace-only: the hunk's old side (context + removed) and new side
  // (context + added) are the same text once all whitespace is dropped
  // (like `git diff -w`, plus re-wrapping one line into several). Comparing
  // whole sides keeps order: any move, even relative to context, is a real
  // change (statement order can matter), never "formatting".
  const side = (drop: string) =>
    hunk.lines
      .filter((l) => !l.startsWith(drop) && !l.startsWith('\\'))
      .map((l) => l.slice(1).replace(/\s+/g, ''))
      .join('');
  if (side('+') === side('-')) return 'whitespace';

  const spans = importSpanLines(hunk);
  if (changedIdx.every((i) => isImportLine(body(i)) || spans.has(i))) {
    return 'import';
  }

  return 'substantive';
}

/** Split a unified-diff body (already stripped of the git file-header
 *  preamble by the caller, or not — headers are simply treated as context)
 *  into hunks keyed by their `@@` headers. Lines before the first `@@` are
 *  kept in a leading headerless hunk so nothing is silently dropped. */
export function parseHunks(lines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      current = { header: line, lines: [] };
      hunks.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      // Preamble before any hunk header — keep as a headerless hunk.
      current = { header: '', lines: [line] };
      hunks.push(current);
    }
  }
  return hunks;
}

/**
 * Abridge a diff's hunks into a "reading diff": drop import-only and
 * whitespace-only hunks, replacing consecutive runs of them with a single
 * omitted-placeholder so the reader knows something was hidden (and can reveal
 * it). Substantive hunks pass through untouched. Returns the ordered parts;
 * the renderer turns them into HTML.
 */
export function abridgeHunks(hunks: DiffHunk[]): AbridgedPart[] {
  const parts: AbridgedPart[] = [];
  let run: { reason: 'import' | 'whitespace'; count: number } | null = null;
  const flush = () => {
    if (run) {
      parts.push({ kind: 'omitted', count: run.count, reason: run.reason });
      run = null;
    }
  };
  for (const hunk of hunks) {
    const kind = classifyHunk(hunk);
    if (kind === 'substantive') {
      flush();
      parts.push({ kind: 'hunk', hunk });
    } else {
      // Accumulate adjacent noise hunks; merge mixed reasons under the first.
      if (run) run.count += 1;
      else run = { reason: kind, count: 1 };
    }
  }
  flush();
  return parts;
}
