/**
 * Pure matchers for clickable tokens in terminal output: http(s) URLs and
 * file-path-like tokens. Kept free of xterm so unit tests don't need a
 * terminal instance. The pane maps these matches onto buffer ranges
 * (including wrap groups) and opens URLs only on an explicit click.
 */

/** Path-like tokens: optional ./, a slashed path with an extension, or a
 *  bare dotted filename. Conservative so ordinary prose stays unlinkable. */
export const PATH_RE =
  /(?:\.\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|(?:\.\/)?[\w.-]+\.[A-Za-z0-9]{1,8}/g;

/** http/https URLs. Trailing punctuation is stripped after the match. */
export const URL_RE = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

export type TerminalLinkKind = 'url' | 'path';

export interface TerminalLinkMatch {
  kind: TerminalLinkKind;
  /** Text to open / display (URL with trailing punctuation already stripped). */
  text: string;
  /** Inclusive start index in the scanned string. */
  start: number;
  /** Exclusive end index in the scanned string. */
  end: number;
}

/**
 * Strip trailing punctuation that is usually outside the URL in prose
 * ("see https://x.dev/a." / "(https://x.dev/a)"). A closing paren stays when
 * it balances one inside the URL, e.g. https://en.wikipedia.org/wiki/A_(b).
 */
export function trimUrlMatch(raw: string): string {
  let s = raw;
  for (;;) {
    const last = s[s.length - 1];
    if (last === undefined) return s;
    if (last === ')') {
      const opens = s.split('(').length - 1;
      const closes = s.split(')').length - 1;
      if (closes <= opens) return s;
    } else if (!/[.,;:!?'\]]/.test(last)) {
      return s;
    }
    s = s.slice(0, -1);
  }
}

/**
 * True only for http/https with a non-empty host. Rejects javascript:,
 * file:, custom schemes, and malformed input. Used both by the matcher and
 * as a last-chance guard before openExternal.
 */
export function isSafeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return !!u.hostname;
  } catch {
    return false;
  }
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Find URL and path links in a single (possibly wrap-joined) line of terminal
 * text. URLs win over overlapping path matches so `https://…/file.ts` is not
 * also offered as a local path.
 */
export function findTerminalLinks(text: string): TerminalLinkMatch[] {
  const urls: TerminalLinkMatch[] = [];
  for (const m of text.matchAll(URL_RE)) {
    if (m.index === undefined) continue;
    const trimmed = trimUrlMatch(m[0]);
    if (!trimmed || !isSafeHttpUrl(trimmed)) continue;
    urls.push({
      kind: 'url',
      text: trimmed,
      start: m.index,
      end: m.index + trimmed.length,
    });
  }

  const paths: TerminalLinkMatch[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    if (m.index === undefined) continue;
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    if (urls.some((u) => overlaps(start, end, u.start, u.end))) continue;
    paths.push({ kind: 'path', text: raw, start, end });
  }

  return [...urls, ...paths].sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Map a [start, end) index in a wrap-joined string onto an xterm link range.
 * `lineLengths` is the length of each physical buffer line in the wrap group;
 * `startLine` is the 0-based buffer line of the group's first line. Ranges are
 * 1-based and end-inclusive, matching xterm's ILink.range.
 */
export function indexToLinkRange(
  start: number,
  end: number,
  startLine: number,
  lineLengths: number[],
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const at = (index: number, asInclusiveEnd: boolean): { x: number; y: number } => {
    const target = asInclusiveEnd ? Math.max(0, index - 1) : Math.max(0, index);
    let offset = 0;
    for (let i = 0; i < lineLengths.length; i++) {
      const len = lineLengths[i] ?? 0;
      const last = i === lineLengths.length - 1;
      if (target < offset + len || last) {
        const col0 = len <= 0 ? 0 : Math.min(target - offset, len - 1);
        return { x: col0 + 1, y: startLine + i + 1 };
      }
      offset += len;
    }
    return { x: 1, y: startLine + 1 };
  };

  return { start: at(start, false), end: at(end, true) };
}

/** The slice of xterm's buffer API the wrap-group reader needs. */
export interface LinkBuffer {
  getLine(y: number):
    | { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string }
    | undefined;
}

/** Cap on rows joined for one logical line, so a huge wrapped blob stays cheap. */
export const MAX_WRAP_ROWS = 32;

/**
 * Links touching buffer row `y0` (0-based), matched across the soft-wrapped
 * group that row belongs to so a URL or path broken by the terminal width
 * is still one link. Ranges are xterm ILink ranges (1-based, end inclusive).
 * Column mapping assumes one UTF-16 unit per cell (wide glyphs may shift
 * the underline but never the activated text).
 */
export function linksForBufferRow(
  buffer: LinkBuffer,
  y0: number,
): Array<TerminalLinkMatch & { range: ReturnType<typeof indexToLinkRange> }> {
  const row = buffer.getLine(y0);
  if (!row) return [];
  let first = y0;
  while (first > 0 && y0 - first < MAX_WRAP_ROWS && buffer.getLine(first)?.isWrapped) first--;
  const texts: string[] = [];
  for (let y = first; texts.length < MAX_WRAP_ROWS; y++) {
    const line = buffer.getLine(y);
    if (!line || (y > first && !line.isWrapped)) break;
    texts.push(line.translateToString(false));
  }
  // Only the group's last row has real trailing blanks to drop.
  const lastIdx = texts.length - 1;
  texts[lastIdx] = texts[lastIdx]!.trimEnd();
  const lengths = texts.map((t) => t.length);
  const rowIdx = y0 - first;
  const rowStart = lengths.slice(0, rowIdx).reduce((a, b) => a + b, 0);
  const rowEnd = rowStart + (lengths[rowIdx] ?? 0);
  return findTerminalLinks(texts.join(''))
    .filter((m) => m.start < rowEnd && m.end > rowStart)
    .map((m) => ({ ...m, range: indexToLinkRange(m.start, m.end, first, lengths) }));
}
