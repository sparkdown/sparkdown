/**
 * Wiki links: `[[Note]]`, `[[folder/Note]]` and `[[Note|label]]`.
 *
 * Pure helpers shared by the preview (rendering), the app controller
 * (backlinks, creating a missing note) and the tests. Every path here is
 * relative to the workspace root and `/`-separated, the same form the file
 * index (`api.listWorkspaceFiles`) returns.
 *
 * Resolution rules:
 * - `[[Note]]` matches a markdown file whose name without extension is
 *   `Note` (ignoring case) anywhere in the workspace. Several matches:
 *   the one in the linking file's folder wins, then the shallowest path,
 *   then alphabetical order.
 * - `[[Note.md]]` / `[[diagram.svg]]` (a name with an extension) match that
 *   exact file name anywhere, with the same tie-break.
 * - `[[folder/Note]]` is a path: first relative to the linking file's
 *   folder, then relative to the workspace root (`.md` / `.markdown` are
 *   tried when no extension matches).
 * - `#heading` after the target is ignored for resolution.
 * - A missing note is created next to the linking file (`[[Note]]`) or at
 *   that path under the workspace root (`[[folder/Note]]`), with `.md`
 *   added when the name has no markdown extension.
 */

/** One `[[...]]` occurrence. `label` falls back to the raw target text. */
export interface WikiLink {
  target: string;
  label: string;
}

/** Anchored match used by the markdown tokenizer. */
export const WIKI_LINK_AT_START = /^\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/;
const WIKI_LINK_GLOBAL = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;

const MD_EXT = /\.(md|markdown|mkd)$/i;
/** Characters that can't appear in a portable file name. */
const BAD_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/;

export function toWikiLink(target: string, label: string | undefined): WikiLink {
  const t = target.trim();
  const l = label?.trim();
  return { target: t, label: l ? l : t };
}

/** Every wiki link in `text`, skipping ones inside inline code spans. */
export function extractWikiLinks(text: string): WikiLink[] {
  const plain = text.replace(/(`+)[^`]*?\1/g, (m) => ' '.repeat(m.length));
  const out: WikiLink[] = [];
  for (const m of plain.matchAll(WIKI_LINK_GLOBAL)) {
    const link = toWikiLink(m[1], m[2]);
    if (link.target) out.push(link);
  }
  return out;
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

function baseOf(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

function joinRel(dir: string, rel: string): string {
  return dir ? `${dir}/${rel}` : rel;
}

/** Lookup tables over the workspace file list. */
export class WikiIndex {
  /** lower-cased stem of markdown files -> paths */
  private readonly byStem = new Map<string, string[]>();
  /** lower-cased file name (with extension) -> paths */
  private readonly byName = new Map<string, string[]>();
  /** lower-cased full path -> path */
  private readonly byPath = new Map<string, string>();

  constructor(files: readonly string[]) {
    for (const rel of files) {
      const name = baseOf(rel).toLowerCase();
      this.byPath.set(rel.toLowerCase(), rel);
      push(this.byName, name, rel);
      if (MD_EXT.test(name)) push(this.byStem, name.replace(MD_EXT, ''), rel);
    }
  }

  stem(lower: string): string[] {
    return this.byStem.get(lower) ?? [];
  }

  name(lower: string): string[] {
    return this.byName.get(lower) ?? [];
  }

  path(lower: string): string | undefined {
    return this.byPath.get(lower);
  }
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export type WikiResolution =
  | { kind: 'found'; rel: string }
  | { kind: 'missing'; rel: string }
  | { kind: 'invalid' };

/** Drop `#heading`, normalize `\` to `/`, refuse paths that leave the root
 *  or names a file system can't hold. Returns null when invalid. */
export function normalizeWikiTarget(target: string): string | null {
  const t = target.replace(/#.*$/, '').trim().replace(/\\/g, '/');
  if (!t || t.startsWith('/') || BAD_NAME_CHARS.test(t)) return null;
  const segs = t.split('/');
  if (segs.some((s) => s.trim() === '' || s === '.' || s === '..')) return null;
  return segs.map((s) => s.trim()).join('/');
}

function pickBest(candidates: readonly string[], fromDir: string): string {
  return [...candidates].sort((a, b) => {
    const sa = dirOf(a) === fromDir ? 0 : 1;
    const sb = dirOf(b) === fromDir ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const da = a.split('/').length;
    const db = b.split('/').length;
    if (da !== db) return da - db;
    return a < b ? -1 : a > b ? 1 : 0;
  })[0];
}

function withMdExt(rel: string): string {
  return MD_EXT.test(rel) ? rel : `${rel}.md`;
}

/**
 * Resolve `target` (as written inside `[[...]]`) for the file at `fromRel`
 * (root-relative; '' or a bare name for a file at the root).
 */
export function resolveWikiTarget(target: string, index: WikiIndex, fromRel: string): WikiResolution {
  const t = normalizeWikiTarget(target);
  if (t === null) return { kind: 'invalid' };
  const fromDir = dirOf(fromRel);
  if (!t.includes('/')) {
    const lower = t.toLowerCase();
    const hits = index.stem(lower).length > 0 ? index.stem(lower) : index.name(lower);
    if (hits.length > 0) return { kind: 'found', rel: pickBest(hits, fromDir) };
    return { kind: 'missing', rel: joinRel(fromDir, withMdExt(t)) };
  }
  for (const base of fromDir ? [joinRel(fromDir, t), t] : [t]) {
    const lower = base.toLowerCase();
    const hit = index.path(lower) ?? index.path(`${lower}.md`) ?? index.path(`${lower}.markdown`);
    if (hit) return { kind: 'found', rel: hit };
  }
  return { kind: 'missing', rel: withMdExt(t) };
}

/** Percent-encoded relative href from the file `fromRel` to `toRel`. */
export function relativeHref(fromRel: string, toRel: string): string {
  const from = dirOf(fromRel).split('/').filter(Boolean);
  const to = toRel.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const up = from.slice(common).map(() => '..');
  const parts = [...up, ...to.slice(common).map(encodeURIComponent)];
  return up.length === 0 ? `./${parts.join('/')}` : parts.join('/');
}

/** How the preview should render one wiki link. */
export type WikiRender =
  | { kind: 'link'; href: string; missing: boolean; title: string }
  | { kind: 'text'; title: string };

export function wikiRenderFor(target: string, index: WikiIndex | null, fromRel: string): WikiRender {
  if (index === null) {
    // No index (no folder open, or the list is still loading): point at the
    // note next to the file without checking that it exists.
    const t = normalizeWikiTarget(target);
    if (t === null) return { kind: 'text', title: 'Not a valid note name' };
    return { kind: 'link', href: relativeHref('', withMdExt(t)), missing: false, title: withMdExt(t) };
  }
  const r = resolveWikiTarget(target, index, fromRel);
  if (r.kind === 'invalid') return { kind: 'text', title: 'Not a valid note name' };
  return {
    kind: 'link',
    href: relativeHref(fromRel, r.rel),
    missing: r.kind === 'missing',
    title: r.kind === 'missing' ? `Create ${r.rel}` : r.rel,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A search pattern (regex) that finds every line that might hold a wiki
 * link to `targetRel`: `[[`, then anything on the line up to the stem.
 * Over-matches on purpose; `findBacklinks` filters with the real resolver.
 */
export function backlinkQuery(targetRel: string): string {
  const stem = baseOf(targetRel).replace(MD_EXT, '');
  return `\\[\\[[^\\]\\n]*${escapeRegex(stem)}`;
}

export interface BacklinkHit {
  /** Root-relative path of the linking file. */
  rel: string;
  /** The search result's absolute path (what openFile needs). */
  path: string;
  line: number;
  preview: string;
}

export interface BacklinkSource {
  rel: string | null;
  path: string;
  line: number;
  preview: string;
}

/** Keep the search hits whose wiki links resolve to `targetRel`. */
export function findBacklinks(
  hits: readonly BacklinkSource[],
  index: WikiIndex,
  targetRel: string,
): BacklinkHit[] {
  const out: BacklinkHit[] = [];
  for (const h of hits) {
    if (h.rel === null || h.rel === targetRel || !MD_EXT.test(h.rel)) continue;
    const links = extractWikiLinks(h.preview);
    const points = links.some((l) => {
      const r = resolveWikiTarget(l.target, index, h.rel!);
      return r.kind === 'found' && r.rel === targetRel;
    });
    if (points) out.push({ rel: h.rel, path: h.path, line: h.line, preview: h.preview });
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.line - b.line));
  return out;
}
