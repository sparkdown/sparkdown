/**
 * Source-line mapping for the markdown preview: which source lines each
 * rendered block came from. Built from marked's top-level tokens (whose
 * `raw` strings concatenate back to the document) and kept off the DOM in a
 * WeakMap, so exported HTML and the rendered markup stay unchanged.
 *
 * Ranges are stored relative to the render chunk they belong to, with the
 * chunk's absolute start line held in a shared, mutable ChunkRef. A chunk
 * whose DOM is reused by the incremental render only needs its ref moved
 * when lines above it are added or removed.
 */

/** Inclusive 1-based line range in the source. */
export type LineRange = { start: number; end: number };

/** Minimal shape of a marked token this module reads. */
export type SourceToken = {
  type: string;
  raw: string;
  items?: { raw: string }[];
};

/** Absolute first line of one render chunk; updated in place on re-render. */
export type ChunkRef = { start: number };

type Entry = { ref: ChunkRef; rel: number; span: number };

/** Tags a top-level token of each type renders to (one element each). */
const TOKEN_TAGS: Record<string, RegExp> = {
  heading: /^H[1-6]$/,
  paragraph: /^P$/,
  code: /^(PRE|DIV)$/,
  blockquote: /^BLOCKQUOTE$/,
  list: /^(UL|OL)$/,
  table: /^TABLE$/,
  hr: /^HR$/,
};

/** Token types that render no element at all. */
const EMPTY_TYPES = new Set(['space', 'def']);

function countNewlines(s: string, from = 0, to = s.length): number {
  let n = 0;
  for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function rangeOf(raw: string, start: number): LineRange {
  return { start, end: start + countNewlines(raw.replace(/\s+$/, '')) };
}

/**
 * Absolute source range of each top-level token, or null where the token's
 * raw text can't be located in order (never expected; it just leaves that
 * token unmapped).
 */
export function tokenLineRanges(content: string, tokens: readonly SourceToken[]): (LineRange | null)[] {
  const src = content.includes('\r') ? content.replace(/\r\n?/g, '\n') : content;
  const out: (LineRange | null)[] = [];
  let pos = 0;
  let line = 1;
  for (const t of tokens) {
    const idx = t.raw ? src.indexOf(t.raw, pos) : -1;
    if (idx < 0) {
      out.push(null);
      continue;
    }
    line += countNewlines(src, pos, idx);
    out.push(rangeOf(t.raw, line));
    line += countNewlines(t.raw);
    pos = idx + t.raw.length;
  }
  return out;
}

/** Ranges of a list's items, given the list's own range. */
function itemRanges(list: SourceToken, listStart: number): (LineRange | null)[] {
  const items = list.items ?? [];
  const out: (LineRange | null)[] = [];
  let pos = 0;
  let line = listStart;
  for (const item of items) {
    const idx = item.raw ? list.raw.indexOf(item.raw, pos) : -1;
    if (idx < 0) {
      out.push(null);
      continue;
    }
    line += countNewlines(list.raw, pos, idx);
    out.push(rangeOf(item.raw, line));
    line += countNewlines(item.raw);
    pos = idx + item.raw.length;
  }
  return out;
}

/**
 * The first line of a chunk and a signature of its tokens' relative ranges.
 * Two chunks with equal HTML but different signatures (e.g. extra blank
 * lines between blocks) must not share DOM, or reused blocks would keep
 * stale line ranges.
 */
export function chunkLayout(ranges: readonly (LineRange | null)[]): { start: number; signature: string } {
  const first = ranges.find((r) => r !== null);
  if (!first) return { start: -1, signature: '' };
  const signature = ranges
    .map((r) => (r ? `${r.start - first.start}+${r.end - r.start}` : '-'))
    .join(',');
  return { start: first.start, signature };
}

export class SourceMap {
  private entries = new WeakMap<Element, Entry>();

  /**
   * Record the source ranges of one chunk's freshly inserted nodes. Tokens
   * are paired with element nodes from the front and from the back; a token
   * whose element count isn't fixed (raw HTML, anything unexpected) stops
   * the pairing from that side, so a mismatch leaves blocks unmapped rather
   * than mapped to the wrong lines.
   */
  annotate(
    nodes: readonly Node[],
    tokens: readonly SourceToken[],
    ranges: readonly (LineRange | null)[],
    ref: ChunkRef,
  ): void {
    if (ref.start < 0) return;
    const elements = nodes.filter((n): n is Element => n.nodeType === 1);
    const blocks: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (!EMPTY_TYPES.has(tokens[i].type)) blocks.push(i);
    }
    const pair = (ti: number, el: Element): boolean => {
      const tag = TOKEN_TAGS[tokens[ti].type];
      if (!tag || !tag.test(el.tagName)) return false;
      const r = ranges[ti];
      if (r) this.set(el, ref, r);
      if (r && tokens[ti].type === 'list') this.annotateItems(el, tokens[ti], r, ref);
      return true;
    };
    let front = 0;
    while (front < blocks.length && front < elements.length && pair(blocks[front], elements[front])) front++;
    let bt = blocks.length - 1;
    let be = elements.length - 1;
    while (bt >= front && be >= front && pair(blocks[bt], elements[be])) {
      bt--;
      be--;
    }
  }

  private annotateItems(listEl: Element, list: SourceToken, r: LineRange, ref: ChunkRef): void {
    const lis = Array.from(listEl.children).filter((c) => c.tagName === 'LI');
    const ranges = itemRanges(list, r.start);
    if (lis.length !== ranges.length) return;
    lis.forEach((li, i) => {
      const ir = ranges[i];
      if (ir) this.set(li, ref, ir);
    });
  }

  private set(el: Element, ref: ChunkRef, r: LineRange): void {
    this.entries.set(el, { ref, rel: r.start - ref.start, span: r.end - r.start });
  }

  /** Absolute source range of a mapped element, or null. */
  rangeOf(el: Element): LineRange | null {
    const e = this.entries.get(el);
    if (!e) return null;
    const start = e.ref.start + e.rel;
    return { start, end: start + e.span };
  }

  /** The nearest mapped element at or above `node`, inside `root`. */
  closestMapped(node: Node | null, root: Element): Element | null {
    let cur: Node | null = node;
    while (cur && cur !== root) {
      if (cur.nodeType === 1 && this.entries.has(cur as Element)) return cur as Element;
      cur = cur.parentNode;
    }
    return null;
  }

  /** Mapped top-level blocks and list items of `root`, in document order. */
  anchors(root: Element): { el: Element; line: number }[] {
    const out: { el: Element; line: number }[] = [];
    for (const el of Array.from(root.children)) {
      const r = this.rangeOf(el);
      if (r) out.push({ el, line: r.start });
      if (el.tagName === 'UL' || el.tagName === 'OL') {
        for (const li of Array.from(el.children)) {
          const lr = this.rangeOf(li);
          if (lr) out.push({ el: li, line: lr.start });
        }
      }
    }
    return out;
  }
}
