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
