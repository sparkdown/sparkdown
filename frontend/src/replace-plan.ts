import type { ReplaceFileEdit, ReplacePreview, ReplaceHit } from './api';

/** One file of a replace preview, with the user's choices. */
export interface PlanFile {
  path: string;
  fingerprint: string;
  hits: ReplaceHit[];
  /** Per hit: replace it (true) or leave it. */
  selected: boolean[];
  /** Why the file can't be replaced (e.g. unsaved changes); null = it can. */
  blocked: string | null;
}

/** Same words as the backend's skipped entries (search/replace.rs). */
export const UNSAVED_REASON = 'open with unsaved changes';

/** A fresh plan from a preview: every hit selected, files with unsaved
 *  editor changes blocked. */
export function planFrom(preview: ReplacePreview, hasUnsavedChanges: (path: string) => boolean): PlanFile[] {
  return preview.files.map((f) => ({
    path: f.path,
    fingerprint: f.fingerprint,
    hits: f.hits,
    selected: f.hits.map(() => true),
    blocked: hasUnsavedChanges(f.path) ? UNSAVED_REASON : null,
  }));
}

/** Hits that will be replaced: selected, in files that are not blocked. */
export function selectedCount(plan: readonly PlanFile[]): { hits: number; files: number } {
  let hits = 0;
  let files = 0;
  for (const f of plan) {
    if (f.blocked) continue;
    const n = f.selected.filter(Boolean).length;
    hits += n;
    if (n) files++;
  }
  return { hits, files };
}

/** The edits to send to replace_apply: only selected hits of files that are
 *  not blocked, by the byte ranges the preview listed. */
export function editsFor(plan: readonly PlanFile[]): ReplaceFileEdit[] {
  const edits: ReplaceFileEdit[] = [];
  for (const f of plan) {
    if (f.blocked) continue;
    const ranges = f.hits.filter((_, i) => f.selected[i]).map((h): [number, number] => [h.start, h.end]);
    if (ranges.length) edits.push({ path: f.path, fingerprint: f.fingerprint, ranges });
  }
  return edits;
}

/** A parsed replacement: text, or a capture group number (0 = the hit). */
export type ReplacementPiece = string | number;

/**
 * Parse the replacement like the backend does (search/replace.rs Template).
 * Regex mode: `$1` (any number of digits) and `${1}` insert a capture group,
 * `${name}` a named one, `$0` the whole hit, `$$` one `$`; any other `$` is
 * kept. A literal query's replacement is plain text.
 */
export function parseReplacement(
  text: string,
  useRegex: boolean,
  groupCount: number,
  names: readonly [string, number][],
): { pieces: ReplacementPiece[] } | { error: string } {
  if (!useRegex) return { pieces: [text] };
  const pieces: ReplacementPiece[] = [];
  let lit = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('$', i);
    if (at < 0) break;
    lit += text.slice(i, at);
    const after = at + 1;
    if (text[after] === '$') {
      lit += '$';
      i = after + 1;
      continue;
    }
    let group: string | null = null;
    let next = after;
    if (text[after] === '{') {
      const end = text.indexOf('}', after + 1);
      if (end > after + 1) {
        group = text.slice(after + 1, end);
        next = end + 1;
      }
    } else {
      const digits = /^[0-9]+/.exec(text.slice(after));
      if (digits) {
        group = digits[0];
        next = after + digits[0].length;
      }
    }
    if (group === null) {
      lit += '$';
      i = after;
      continue;
    }
    let index: number;
    if (/^[0-9]+$/.test(group)) {
      index = Number(group);
      if (index > groupCount) return { error: noGroup(`$${group}`, groupCount) };
    } else {
      const named = names.find(([n]) => n === group);
      if (!named) return { error: noGroup(`\${${group}}`, groupCount) };
      index = named[1];
    }
    if (lit) pieces.push(lit);
    lit = '';
    pieces.push(index);
    i = next;
  }
  lit += text.slice(i);
  if (lit) pieces.push(lit);
  return { pieces };
}

function noGroup(reference: string, count: number): string {
  const has = count === 0 ? 'no capture groups' : count === 1 ? '1 capture group' : `${count} capture groups`;
  return `The replacement uses ${reference}, but the search pattern has ${has} (use $$ for a literal $)`;
}

/** The text that replaces `hit`. A literal query's hit has no groups, and
 *  its replacement is a single text piece. */
export function expandReplacement(pieces: readonly ReplacementPiece[], hit: ReplaceHit): string {
  return pieces.map((p) => (typeof p === 'string' ? p : (hit.groups?.[p] ?? ''))).join('');
}

/** A hit's preview split for display: text before, the matched text, text
 *  after. Ranges are in characters. */
export function splitPreview(hit: ReplaceHit): { before: string; match: string; after: string } {
  const chars = [...hit.preview];
  return {
    before: chars.slice(0, hit.match_start).join(''),
    match: chars.slice(hit.match_start, hit.match_end).join(''),
    after: chars.slice(hit.match_end).join(''),
  };
}
