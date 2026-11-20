const MD_EXT_RE = /\.(md|markdown|mkd)$/i;
const HTML_EXT_RE = /\.html?$/i;
const SVG_EXT_RE = /\.svg$/i;

/** True when running on macOS — used for platform-specific window behavior. */
export function isMacOS(): boolean {
  const p = (navigator as any).userAgentData?.platform || navigator.platform || '';
  return /mac/i.test(p);
}

/** True on Linux (not Android): terminal clipboard keys follow Omarchy's
 *  universal Ctrl+V / Ctrl+C there (#130). */
export function isLinux(): boolean {
  const p = (navigator as any).userAgentData?.platform || navigator.platform || '';
  return /linux/i.test(p) && !/android/i.test(navigator.userAgent || '');
}

export function isMarkdownFile(path: string | null): boolean {
  return !path || MD_EXT_RE.test(path);
}

export function isHtmlFile(path: string | null): boolean {
  return !!path && HTML_EXT_RE.test(path);
}

export function isSvgFile(path: string | null): boolean {
  return !!path && SVG_EXT_RE.test(path);
}

/**
 * Files rendered by framing their raw markup in the preview iframe (as opposed
 * to markdown, which is parsed). HTML documents and SVG images both qualify —
 * the browser renders either one directly.
 */
export function isFramedFile(path: string | null): boolean {
  return isHtmlFile(path) || isSvgFile(path);
}

/** Files that can be shown in the preview pane (markdown rendered, HTML/SVG framed). */
export function isPreviewable(path: string | null): boolean {
  return isMarkdownFile(path) || isFramedFile(path);
}

export function stripMarkdownExt(path: string, replacement: string): string {
  return path.replace(MD_EXT_RE, replacement);
}

export function slugifyHeading(text: string): string {
  return text.toLowerCase().replace(/[^\w]+/g, '-');
}

export function dirname(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx <= 0 ? '' : path.slice(0, idx);
}

export function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx < 0 ? path : path.slice(idx + 1);
}

/**
 * The parent directory of a path, or null if it has none (filesystem root).
 * Unlike dirname(), the parent of a top-level entry like "/Users" is the root
 * "/" rather than "", and "/" itself has no parent.
 */
export function parentDir(path: string): string | null {
  const norm = path.replace(/[/\\]+$/, ''); // strip trailing slashes
  const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  if (idx < 0) return null; // no separator — relative single segment
  if (idx === 0) return norm === '' ? null : '/'; // child of root
  return norm.slice(0, idx);
}

/**
 * True when `path` is absolute: a POSIX path ("/…"), a Windows drive path
 * ("C:\…" or "C:/…"), or a UNC path ("\\server\…"). Used to decide whether a
 * path still needs resolving against a root.
 */
export function isAbsolutePath(path: string): boolean {
  return /^\//.test(path) || /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

/**
 * Canonicalize a path FOR COMPARISON ONLY (never for display or file I/O):
 * backslashes → forward slashes, collapsed duplicate separators, no trailing
 * slash, and a lowercased leading Windows drive letter. This makes
 * `C:\Repo\a.md`, `c:/repo\a.md` (mixed separators from a bad join), and
 * `C:/repo/a.md` all compare equal — the mismatch that made tree badges never
 * match and opened duplicate tabs on Windows. The drive letter is the only
 * case-folded segment; the rest keeps its case.
 */
export function normalizePathForCompare(path: string): string {
  let p = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  p = p.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  if (p.length > 1) p = p.replace(/\/$/, '');
  return p;
}

/**
 * Express `abs` relative to `root` using forward slashes — the form git and
 * the file-tree keys use. Returns null when `abs` is outside `root`, and
 * returns a relative input unchanged. Separator- and drive-case-insensitive.
 */
export function toRelativePath(abs: string | null, root: string): string | null {
  if (!abs) return null;
  if (!isAbsolutePath(abs)) return abs; // already relative
  const a = normalizePathForCompare(abs);
  const r = normalizePathForCompare(root);
  if (a === r) return '';
  const prefix = r.endsWith('/') ? r : `${r}/`;
  return a.startsWith(prefix) ? a.slice(prefix.length) : null;
}

/**
 * Join a (typically git-relative, forward-slash) `rel` onto an absolute `root`,
 * matching the separator `root` already uses so the result compares equal to
 * the native paths the OS and file tree report. An absolute `rel` is returned
 * unchanged. Drive-only roots ("C:") join with a backslash.
 */
export function joinPath(root: string, rel: string): string {
  if (isAbsolutePath(rel)) return rel;
  const sep = root.includes('\\') ? '\\' : root.includes('/') ? '/' : '\\';
  const base = root.replace(/[/\\]+$/, '');
  const cleanRel = rel.replace(/^[/\\]+/, '').replace(sep === '\\' ? /\//g : /\\/g, sep);
  return cleanRel ? `${base}${sep}${cleanRel}` : base;
}

/** True if `path` is `root` itself or a nested path under it. Separator- and
 *  drive-case-insensitive so a Windows tab switch into a subdir doesn't look
 *  like a new root (which would needlessly restart the watcher). */
export function isUnderRoot(path: string, root: string): boolean {
  const p = normalizePathForCompare(path);
  const r = normalizePathForCompare(root);
  if (p === r) return true;
  const prefix = r.endsWith('/') ? r : `${r}/`;
  return p.startsWith(prefix);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Like {@link escapeHtml}, for text placed in an attribute value that is read
 * back exactly (`data-path`). The HTML parser turns a raw CR, LF or TAB inside
 * an attribute into another character, so those are written as numeric
 * references and `dataset.*` returns the original bytes.
 */
export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

/**
 * Unicode bidirectional-override, isolate, and invisible-formatting code points
 * that can affect how text is displayed in diff and review surfaces. These
 * characters can cause the visual order to differ from the logical byte order,
 * or be invisible to the reviewer. We replace them with a visible `<U+XXXX>`
 * marker so a reviewer always sees what git actually stored, not what the bidi
 * algorithm draws. The output is plain text (angle brackets included) and must
 * still be HTML-escaped by the caller via {@link escapeHtml}.
 *
 * Rather than enumerate individual code points (and risk missing one such as
 * U+061C ARABIC LETTER MARK, which is a Bidi_Control but outside the previous
 * BMP ranges), we filter by Unicode property so the set stays in sync with
 * the Unicode database. The `u` flag also lets the class match astral code
 * points such as the Unicode tag characters U+E0000..U+E007F.
 *
 *  - \p{Bidi_Control}                 all nine bidi controls incl. U+061C
 *  - \p{Cf}                           format characters (ZWJ, ZWNJ, BOM, ...)
 *  - C0/C1 control characters, except the common visible whitespace
 *    \t \n \r which diff/preview surfaces must render literally.
 *  - \p{Default_Ignorable_Code_Point} soft hyphen, variation selectors,
 *                                     Hangul filler, tag characters, ...
 *  - U+2028, U+2029                   LINE/PARAGRAPH SEPARATOR (forced breaks
 *                                     in `white-space: pre-wrap` diff lines)
 */
const UNICODE_CONTROL_CHARS_RE =
  /[\p{Bidi_Control}\p{Cf}\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/gu;

/**
 * Replace Unicode bidi overrides and invisible formatting characters with a
 * visible `<U+XXXX>` escape so they cannot reorder or hide neighbouring text
 * in the review surfaces. HTML-escape the result before inserting into the
 * DOM; this helper deliberately returns plain text so callers keep control of
 * encoding (and so an existing `escapeHtml` in the caller still neutralises
 * the literal `<` / `>` in the marker).
 */
export function neutralizeUnicodeControls(text: string): string {
  return text.replace(UNICODE_CONTROL_CHARS_RE, (ch) => {
    // Use codePointAt so astral code points (e.g. U+E0000..U+E007F tag
    // characters, which are surrogate pairs in UTF-16) are reported as a
    // single scalar value rather than a lone surrogate.
    const cp = ch.codePointAt(0) ?? 0;
    const hex = cp.toString(16).toUpperCase().padStart(4, '0');
    return `<U+${hex}>`;
  });
}

/** True if `text` contains any Unicode bidi/invisible control character that
 *  {@link neutralizeUnicodeControls} would rewrite. */
export function hasUnicodeControls(text: string): boolean {
  UNICODE_CONTROL_CHARS_RE.lastIndex = 0;
  const found = UNICODE_CONTROL_CHARS_RE.test(text);
  UNICODE_CONTROL_CHARS_RE.lastIndex = 0;
  return found;
}

/** Convenience: neutralize Unicode controls, then HTML-escape. The common
 *  review-surface sink: diff lines and change-row file names. */
export function escapeReviewText(text: string): string {
  return escapeHtml(neutralizeUnicodeControls(text));
}

export type Debounced<T extends (...args: any[]) => void> = ((...args: Parameters<T>) => void) & {
  /** Drop a pending call, if any. */
  cancel(): void;
};

export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): Debounced<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = ((...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  }) as Debounced<T>;
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}

/**
 * Batches multiple update callbacks into a single requestAnimationFrame.
 * Calling schedule(fn) with the same key replaces the previous pending fn
 * for that key. All scheduled fns fire together on the next frame.
 */
export function createRafBatch(): {
  schedule: (key: string, fn: () => void) => void;
  cancel: (key: string) => void;
} {
  const pending = new Map<string, () => void>();
  let rafId: number | null = null;

  function flush() {
    rafId = null;
    const fns = [...pending.values()];
    pending.clear();
    for (const fn of fns) fn();
  }

  return {
    schedule(key: string, fn: () => void) {
      pending.set(key, fn);
      if (rafId === null) rafId = requestAnimationFrame(flush);
    },
    cancel(key: string) {
      pending.delete(key);
      if (pending.size === 0 && rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
  };
}

type ScrollState = { ignore: boolean; raf: number | null };

export function scrollElementToRatio(
  el: { scrollHeight: number; clientHeight: number; scrollTop: number },
  ratio: number,
  state: ScrollState
): void {
  const maxScroll = el.scrollHeight - el.clientHeight;
  if (maxScroll <= 0) return;
  const clamped = Math.max(0, Math.min(1, ratio));
  const top = clamped <= 0.002 ? 0
    : clamped >= 0.998 ? maxScroll
    : clamped * maxScroll;
  scrollElementToTop(el, top, state);
}

/** Set scrollTop while suppressing the element's own scroll handler (two
 *  frames), so programmatic sync doesn't echo back as a user scroll. */
export function scrollElementToTop(
  el: { scrollTop: number },
  top: number,
  state: ScrollState
): void {
  state.ignore = true;
  if (state.raf) cancelAnimationFrame(state.raf);
  el.scrollTop = Math.max(0, top);
  state.raf = requestAnimationFrame(() => {
    state.raf = requestAnimationFrame(() => {
      state.ignore = false;
      state.raf = null;
    });
  });
}

export function createScrollState(): ScrollState {
  return { ignore: false, raf: null };
}

/**
 * Piecewise-linear mapping between source lines and pane pixel offsets,
 * used for content-anchored scroll sync. Points must be sorted by line
 * (and correspondingly by y); both maps clamp outside the range.
 */
export type SyncPoint = { line: number; y: number };

export function mapLineToY(points: SyncPoint[], line: number): number {
  if (points.length === 0) return 0;
  if (line <= points[0].line) return points[0].y;
  const last = points[points.length - 1];
  if (line >= last.line) return last.y;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (line <= b.line) {
      const t = b.line > a.line ? (line - a.line) / (b.line - a.line) : 0;
      return a.y + t * (b.y - a.y);
    }
  }
  return last.y;
}

/**
 * Source line numbers (1-based) of ATX headings, skipping fenced code blocks.
 * Used to pair source lines with rendered h1–h6 elements for scroll sync;
 * callers must verify the count matches the rendered heading count (setext
 * headings, blockquoted headings, or raw HTML would desync it) and fall back
 * to proportional sync when it doesn't.
 */
export function headingSourceLines(md: string): number[] {
  const out: number[] = [];
  const lines = md.split('\n');
  let fence: '`' | '~' | null = null;
  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = lines[i].match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const ch = fenceMatch[1][0] as '`' | '~';
      if (!fence) fence = ch;
      else if (ch === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^ {0,3}#{1,6}\s/.test(lines[i])) out.push(i + 1);
  }
  return out;
}

/**
 * Build a monotone scrollTop→scrollTop map from paired landmark offsets
 * (heading pixel positions in each pane) with endpoints pinned at (0,0) and
 * (srcMax,dstMax). Monotonicity is enforced by construction — interpolating
 * through it can never move the target pane opposite to the source pane.
 * (An anchor-point scheme of the form y(line) − ratio·height is NOT
 * monotone when pane content densities differ, and reversed direction on
 * mixed documents.)
 */
export function buildScrollMap(
  src: number[],
  dst: number[],
  srcMax: number,
  dstMax: number,
): SyncPoint[] {
  const points: SyncPoint[] = [{ line: 0, y: 0 }];
  const n = Math.min(src.length, dst.length);
  for (let i = 0; i < n; i++) {
    const s = Math.min(Math.max(src[i], 0), srcMax);
    const d = Math.min(Math.max(dst[i], 0), dstMax);
    const prev = points[points.length - 1];
    if (s > prev.line && d >= prev.y) points.push({ line: s, y: d });
  }
  const last = points[points.length - 1];
  if (srcMax > last.line) points.push({ line: srcMax, y: dstMax });
  else last.y = dstMax;
  return points;
}

export function mapYToLine(points: SyncPoint[], y: number): number {
  if (points.length === 0) return 1;
  if (y <= points[0].y) return points[0].line;
  const last = points[points.length - 1];
  if (y >= last.y) return last.line;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (y <= b.y) {
      const t = b.y > a.y ? (y - a.y) / (b.y - a.y) : 0;
      return a.line + t * (b.line - a.line);
    }
  }
  return last.line;
}

/**
 * The defaultPath for a native Save dialog. A tab with a path keeps it. An
 * Untitled tab gets `<dir>/<name>` with an absolute dir (the explorer's
 * selected folder, else the opened root): tauri-plugin-dialog splits a
 * not-yet-existing path into directory + file name, but a bare relative
 * name has an empty parent, so no directory is set at all and each OS falls
 * back to its own last-used location (on macOS that showed the opened
 * folder's parent). With no folder open the bare name is all we have.
 */
export function defaultSavePath(tabPath: string | null | undefined, dir: string | null | undefined, name: string): string {
  if (tabPath) return tabPath;
  if (dir && isAbsolutePath(dir)) return joinPath(dir, name);
  return name;
}
