import { marked, type Tokens, type RendererObject } from 'marked';
import DOMPurify from 'dompurify';
import { convertFileSrc } from '@tauri-apps/api/core';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import bash from 'highlight.js/lib/languages/bash';
import { MermaidLoader } from './mermaid-loader';
import { EventBus } from './events';
import { api } from './api';
import { span, traceNextPaint } from './perf-trace';
import {
  slugifyHeading,
  scrollElementToRatio,
  scrollElementToTop,
  createScrollState,
  debounce,
  escapeHtml,
  isFramedFile,
  isSvgFile,
} from './utils';
import { TIMING } from './constants';
import { EVENTS } from './event-names';
import { isTextFile } from './file-types';
import { PreviewImageResolver, resolveAgainst, resolveImagePath } from './preview-images';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);

/**
 * Comment marker joined between per-block HTML strings so block boundaries
 * survive a single innerHTML pass. stripMarkersAndCount() removes the markers
 * and returns how many top-level nodes each block produced — one innerHTML
 * for N blocks instead of N template probes.
 */
const MARKDOWN_TAGS = ["a","blockquote","br","code","del","div","em","h1","h2","h3","h4","h5","h6","hr","img","input","li","ol","p","pre","span","strong","table","tbody","td","th","thead","tr","ul"];
const MARKDOWN_ATTRS = ["alt","checked","class","disabled","href","id","rel","src","target","title","type"];
const SAFE_URL = /^(?:https?:|mailto:|tel:|asset:|data:image\/(?:gif|jpe?g|png|webp);|[\/?#]|\.\.?\/|[^:]*$)/i;
/**
 * Namespace prefix for every id/name in rendered markdown. A bare heading id
 * like `terminal-panel` or `status-bar` would DOM-clobber a real app element:
 * the preview pane precedes #terminal-panel/#status-bar in index.html, so
 * getElementById would find the rendered heading first (breaking toggleTerminal
 * and misplacing the remote chip). DOMPurify's SANITIZE_NAMED_PROPS applies
 * this prefix to id/name attributes; the hook below applies the matching prefix
 * to in-document `#anchor` hrefs so `[x](#heading)` still resolves, and
 * scrollToId() tolerates ids given with or without it.
 */
const USER_CONTENT_PREFIX = 'user-content-';
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName !== "href" && data.attrName !== "src") return;
  const value = data.attrValue.trim();
  if (!SAFE_URL.test(value)) {
    data.keepAttr = false;
    return;
  }
  // Pure "#fragment" hrefs point at a heading id, which is prefixed on render.
  // Prefix the fragment to match, so anchor links still scroll (in the live
  // preview and in exported standalone HTML alike).
  if (
    data.attrName === "href" &&
    value.length > 1 &&
    value[0] === "#" &&
    !value.startsWith("#" + USER_CONTENT_PREFIX)
  ) {
    data.attrValue = "#" + USER_CONTENT_PREFIX + value.slice(1);
  }
});
export function sanitizeMarkdownHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: MARKDOWN_TAGS,
    ALLOWED_ATTR: MARKDOWN_ATTRS,
    ALLOW_DATA_ATTR: false,
    // Prefix id/name with user-content- to block DOM clobbering (see above).
    SANITIZE_NAMED_PROPS: true,
  });
}
const BLOCK_MARKER = '<!--sd-block-->';

/** What a clicked preview link should do. Never "navigate the app window". */
export type PreviewLinkAction =
  | { kind: 'anchor'; id: string }
  | { kind: 'file'; path: string }
  | { kind: 'external'; url: string }
  | { kind: 'ignore' };

const EXTERNAL_SCHEME = /^(?:https?|mailto):/i;
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Classify a preview link's raw `href`. Pure, so the rules are unit-tested:
 * - `#id` scrolls within the preview;
 * - relative / absolute / `file:` paths to openable text files open in a tab
 *   (relative ones resolve against `baseDir`, the current file's directory);
 * - `http:` / `https:` / `mailto:` open in the system browser;
 * - anything else (javascript:, asset:, data:, `//host`, non-text files) is
 *   ignored.
 */
export function classifyPreviewLink(rawHref: string | null, baseDir: string | null): PreviewLinkAction {
  const href = (rawHref ?? '').trim();
  if (href === '') return { kind: 'ignore' };
  if (href.startsWith('#')) {
    const id = safeDecode(href.slice(1));
    return id ? { kind: 'anchor', id } : { kind: 'ignore' };
  }
  if (EXTERNAL_SCHEME.test(href)) return { kind: 'external', url: href };

  let path: string;
  const scheme = URL_SCHEME.exec(href);
  if (scheme && scheme[1].length > 1) {
    if (scheme[1].toLowerCase() !== 'file') return { kind: 'ignore' };
    try {
      path = safeDecode(new URL(href).pathname);
    } catch {
      return { kind: 'ignore' };
    }
  } else {
    if (href.startsWith('//')) return { kind: 'ignore' }; // protocol-relative
    // Drop ?query / #fragment; decode %20 etc. into a filesystem path.
    path = safeDecode(href.replace(/[?#].*$/, ''));
    if (path === '') return { kind: 'ignore' };
    const isAbsolute = path.startsWith('/') || /^[a-z]:[\\/]/i.test(path);
    if (!isAbsolute) {
      if (!baseDir) return { kind: 'ignore' };
      path = resolveAgainst(baseDir, path);
    }
  }
  return isTextFile(path) ? { kind: 'file', path } : { kind: 'ignore' };
}

/**
 * Split markdown at top-level ATX headings that follow a blank line (outside
 * fenced code). Such a heading always starts a fresh block in CommonMark, so
 * lexing each segment independently yields the same token stream as lexing
 * the whole document — but sidesteps marked's superlinear scaling on large
 * inputs under JavaScriptCore. Segments concatenate back to the input.
 */
function segmentAtHeadings(md: string): { segments: string[]; defsPrefix: string } {
  const lines = md.split('\n');
  const segs: string[] = [];
  const defs: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fm) {
      const ch = fm[1][0];
      fence = fence === null ? ch : ch === fence ? null : fence;
    } else if (fence === null) {
      if (
        /^#{1,6}\s/.test(line) &&
        (i === 0 || lines[i - 1].trim() === '') &&
        cur.length > 0
      ) {
        segs.push(cur.join('\n') + '\n');
        cur = [];
      }
      // Reference-link definitions are resolved inline within one lexer
      // call, so a [use][r] in one segment can't see [r]: defined in a
      // later one. Collect single-line defs for prepending to every segment.
      if (/^ {0,3}\[[^\]]+\]:\s+\S/.test(line)) defs.push(line);
    }
    cur.push(line);
  }
  segs.push(cur.join('\n'));
  return {
    segments: segs,
    defsPrefix: defs.length > 0 ? defs.join('\n') + '\n\n' : '',
  };
}

function stripMarkersAndCount(root: ParentNode, blockCount: number): number[] {
  const counts: number[] = [];
  let run = 0;
  const toRemove: Node[] = [];
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.COMMENT_NODE && node.nodeValue === 'sd-block') {
      counts.push(run);
      run = 0;
      toRemove.push(node);
    } else {
      run++;
    }
  }
  counts.push(run);
  for (const node of toRemove) node.parentNode?.removeChild(node);
  // Guard: a block whose HTML contained a literal marker would desync counts.
  while (counts.length < blockCount) counts.push(0);
  counts.length = blockCount;
  return counts;
}

export class PreviewPane {
  private container!: HTMLElement;
  private bus: EventBus;
  private mermaidLoader = new MermaidLoader();
  private diagramsEnabled = true;
  private visible = true;
  private currentBaseDir: string | null = null;
  private lastRendered: string | null = null;
  private framedMode = false;
  private svgMode = false;
  private allowScripts = false;
  private htmlRenderSeq = 0;
  /** Bumped per HTML render; a slower (async image) render must not win. */
  private htmlAssetSeq = 0;
  private images = new PreviewImageResolver();
  /** Machine of the document being previewed: null = local, else SSH host. */
  private originResolver: () => string | null = () => null;
  /** Origin the current DOM was rendered for. */
  private renderedOrigin: string | null = null;
  private scrollState = createScrollState();
  private renderDebounced = debounce((c: string) => { void this.renderImmediate(c); }, TIMING.PREVIEW_RENDER_MS);
  // Invoked on interaction inside the (same-origin) preview iframe — its events
  // don't bubble to the parent document. onFrameFocus marks the preview active;
  // onFrameFind opens preview search on Cmd/Ctrl+F.
  private onFrameFocus: (() => void) | null = null;
  private onFrameFind: (() => void) | null = null;
  // Opens a local file clicked in the preview (wired to App.openFile).
  private onOpenFile: ((path: string) => void) | null = null;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  init(container: HTMLElement): void {
    this.container = container;
    this.configureMarked();
    this.interceptLinks();
  }

  /** Register how a clicked local-file link is opened (normally App.openFile). */
  setOpenFileHandler(handler: (path: string) => void): void {
    this.onOpenFile = handler;
  }

  /**
   * Links in rendered markdown must never navigate the app window: that would
   * replace the whole editor UI (losing unsaved buffers) with whatever page
   * the document points at. Capture-phase so nothing downstream sees the
   * click first; every <a> click (primary, middle, modified) is cancelled
   * and then routed per classifyPreviewLink().
   */
  private interceptLinks(): void {
    const findLink = (e: Event): Element | null => {
      const target = e.target as Element | null;
      const link = target?.closest?.('a') ?? null;
      return link && this.container.contains(link) ? link : null;
    };
    this.container.addEventListener('click', (e) => {
      const link = findLink(e);
      if (!link) return;
      e.preventDefault();
      const href = link.getAttribute('href') ?? link.getAttribute('xlink:href');
      this.handleLink(classifyPreviewLink(href, this.currentBaseDir));
    }, true);
    // Middle-click / other buttons: WebKit may open or navigate; just block.
    this.container.addEventListener('auxclick', (e) => {
      if (findLink(e)) e.preventDefault();
    }, true);
  }

  private handleLink(action: PreviewLinkAction): void {
    switch (action.kind) {
      case 'anchor':
        this.scrollToId(action.id);
        return;
      case 'file':
        this.onOpenFile?.(action.path);
        return;
      case 'external':
        api.openExternal(action.url).catch((err) => {
          console.error('Failed to open link:', err);
        });
        return;
      case 'ignore':
        return;
    }
  }

  private configureMarked(): void {
    const hlCache = new Map<string, string>();
    const HL_CACHE_MAX = 256;
    const highlightCached = (lang: string, code: string): string => {
      const key = `${lang}\0${code}`;
      const cached = hlCache.get(key);
      if (cached !== undefined) return cached;
      const value = hljs.highlight(code, { language: lang }).value;
      if (hlCache.size >= HL_CACHE_MAX) {
        const firstKey = hlCache.keys().next().value;
        if (firstKey !== undefined) hlCache.delete(firstKey);
      }
      hlCache.set(key, value);
      return value;
    };
    const renderer: RendererObject = {
      heading(token: Tokens.Heading): string {
        const id = slugifyHeading(token.text);
        // Parse inline tokens so emphasis/links/code inside headings render.
        const content = this.parser.parseInline(token.tokens);
        return `<h${token.depth} id="${id}">${content}</h${token.depth}>`;
      },
      code(this: void, token: Tokens.Code): string {
        const lang = token.lang || '';
        const code = token.text;
        if (lang === 'mermaid') {
          return `<div class="mermaid">${escapeHtml(code)}</div>`;
        }
        const highlighted =
          lang && hljs.getLanguage(lang)
            ? highlightCached(lang, code)
            : escapeHtml(code);
        // Escape lang — it comes straight from the fence info string.
        return `<pre><code class="hljs language-${escapeHtml(lang)}">${highlighted}</code></pre>`;
      },
    };
    marked.use({ renderer, gfm: true, breaks: false });
  }

  render(markdownContent: string): void {
    this.renderDebounced(markdownContent);
  }

  async renderImmediateForExport(markdownContent: string): Promise<void> {
    this.lastRendered = null;
    const wasVisible = this.visible;
    this.visible = true;
    try {
      await this.renderImmediate(markdownContent);
    } finally {
      this.visible = wasVisible;
    }
  }

  /**
   * Select how the next render interprets its content. HTML and SVG files are
   * framed verbatim; everything else is parsed as markdown. Resets the dedup
   * cache so switching mode on identical content still re-renders.
   */
  setRenderMode(path: string | null): void {
    const framed = isFramedFile(path);
    const svg = isSvgFile(path);
    if (framed !== this.framedMode || svg !== this.svgMode) {
      this.framedMode = framed;
      this.svgMode = svg;
      this.lastRendered = null;
      // Framed mode replaces the container's children with an iframe, so the
      // incremental block cache no longer describes the DOM.
      this.prevBlocks = [];
      this.prevNodeCounts = [];
    }
  }

  /**
   * Enable/disable script execution in the HTML-preview iframe. Off by default;
   * scripts only run for HTML files when the user opts in via the View menu.
   * Re-renders so the change takes effect on the current document immediately.
   */
  setAllowScripts(allow: boolean): void {
    if (allow === this.allowScripts) return;
    this.allowScripts = allow;
    if (this.framedMode && this.lastRendered !== null) {
      const content = this.lastRendered;
      this.lastRendered = null;
      void this.renderImmediate(content);
    }
  }

  setDiagramsEnabled(enabled: boolean): void {
    this.diagramsEnabled = enabled;
  }

  isAllowScripts(): boolean {
    return this.allowScripts;
  }

  private async renderImmediate(content: string): Promise<void> {
    if (!this.visible) return;
    const origin = this.originResolver();
    if (content === this.lastRendered && origin === this.renderedOrigin) return;
    if (origin !== this.renderedOrigin) {
      // Same text on another machine: reused DOM nodes hold images resolved
      // against the old machine. Force a full rebuild.
      this.renderedOrigin = origin;
      this.prevBlocks = [];
      this.prevNodeCounts = [];
    }
    this.lastRendered = content;
    this.invalidateSyncMap();

    if (this.framedMode) {
      // Drop the markdown padding so the iframe sits flush with the pane.
      this.container.classList.add('html-mode');
      await this.renderHtmlPreview(content);
      return;
    }
    this.container.classList.remove('html-mode');

    if (content.trim() === '') {
      this.renderEmptyState();
      return;
    }

    const endRender = span('render-markdown', `${(content.length / 1024).toFixed(0)}KB`);
    this.renderMarkdownIncremental(content);
    endRender();
    traceNextPaint('preview', this.container);

    // Detect pending diagrams from the DOM, not the code() render hook: the
    // hook doesn't fire for chunk-cache hits, but unprocessed .mermaid divs
    // (no data-processed) are visible here regardless of how they rendered.
    const pendingMermaid =
      this.container.querySelector('.mermaid:not([data-processed])') !== null;
    if (pendingMermaid && this.diagramsEnabled) {
      await this.mermaidLoader.ensureLoaded();
      await this.mermaidLoader.renderAll(this.container);
    }
  }

  /**
   * Block-level incremental render. A keystroke usually changes one block in
   * the document, but `innerHTML = fullHtml` rebuilds the entire DOM — profiled
   * at ~280 ms for a 660 KB document, ALL of it DOM construction (parsing is
   * ~20 ms). Instead: lex into top-level blocks, render each block's HTML,
   * and only replace the DOM nodes whose HTML actually changed (matched by
   * common prefix/suffix against the previous render).
   *
   * Each top-level markdown token renders to a contiguous run of child nodes;
   * we track the per-block node counts so blocks can be located and spliced.
   */
  private prevBlocks: string[] = [];
  private prevNodeCounts: number[] = [];
  /** raw chunk source -> rendered HTML, carried across renders. */
  private chunkCache = new Map<string, string>();

  private renderMarkdownIncremental(content: string): void {
    const endLexOnly = span('lexer-only');
    // marked's lexer is superlinear in JavaScriptCore (WebKit): ~80 ms for a
    // 66 KB doc but ~6.3 s for 656 KB — each block match re-slices the whole
    // remaining source. Lexing per heading-delimited segment is safe (a
    // blank-line-preceded top-level ATX heading always terminates the block
    // before it) and restores linear cost: 6.3 s -> ~150 ms, same tokens.
    const { segments, defsPrefix } = segmentAtHeadings(content);
    const tokens: ReturnType<typeof marked.lexer> =
      [] as unknown as ReturnType<typeof marked.lexer>;
    const links: Record<string, unknown> = {};
    // Count tokens the defs-prefix itself produces so they can be dropped
    // from each segment's stream (defs render nothing, but duplicating them
    // per segment would bloat the token list).
    const prefixTokenCount = defsPrefix ? marked.lexer(defsPrefix).length : 0;
    for (const seg of segments) {
      // Prepend doc-wide reference definitions: marked resolves [use][ref]
      // during lexing, so each segment must see all definitions.
      const segTokens = marked.lexer(defsPrefix + seg);
      for (let i = prefixTokenCount; i < segTokens.length; i++) {
        tokens.push(segTokens[i]);
      }
      Object.assign(links, segTokens.links);
    }
    tokens.links = links as ReturnType<typeof marked.lexer>['links'];
    endLexOnly();
    const endLex = span('parse-chunks');

    // Group top-level tokens into chunks. Chunk granularity balances two
    // costs: marked.parser() has per-call overhead (~0.2 ms), so one call
    // per token is 30x slower than one pass; but one chunk per document
    // means any edit rebuilds everything. ~32 tokens per chunk keeps full
    // parses within ~2x of a single pass while an edit re-parses only the
    // chunk it touched (whose HTML is memoized by raw source otherwise).
    const CHUNK_TOKENS = 32;
    const nextCache = new Map<string, string>();
    const blocks: string[] = [];
    for (let i = 0; i < tokens.length; i += CHUNK_TOKENS) {
      const slice = tokens.slice(i, i + CHUNK_TOKENS);
      const raw = slice.map((t) => t.raw).join('');
      let html: string | undefined = this.chunkCache.get(raw) ?? nextCache.get(raw);
      if (html === undefined) {
        const chunk = slice as unknown as Parameters<typeof marked.parser>[0] & {
          links: typeof links;
        };
        chunk.links = links;
        html = marked.parser(chunk) ?? '';
      }
      nextCache.set(raw, html);
      blocks.push(html);
    }
    // Entries not reused this render are dropped — cache size tracks the
    // current document, so it can't grow unbounded across files.
    this.chunkCache = nextCache;
    endLex();

    // Bail to a full rebuild on first render or when the container was
    // repurposed (html-mode iframe cleared it).
    if (this.prevBlocks.length === 0 || this.container.children.length === 0) {
      const endDom = span('dom-full-rebuild', `${blocks.length} chunks`);
      this.replaceAllBlocks(blocks);
      endDom();
      return;
    }

    // Match unchanged blocks from both ends; splice only the middle.
    const prev = this.prevBlocks;
    let start = 0;
    const maxStart = Math.min(prev.length, blocks.length);
    while (start < maxStart && prev[start] === blocks[start]) start++;
    let endOld = prev.length;
    let endNew = blocks.length;
    while (endOld > start && endNew > start && prev[endOld - 1] === blocks[endNew - 1]) {
      endOld--;
      endNew--;
    }

    if (start === endOld && start === endNew) return; // identical

    // Locate the DOM range covered by old blocks [start, endOld).
    const nodes = Array.from(this.container.childNodes);
    const counts = this.prevNodeCounts;
    let nodeStart = 0;
    for (let i = 0; i < start; i++) nodeStart += counts[i];
    let nodeEnd = nodeStart;
    for (let i = start; i < endOld; i++) nodeEnd += counts[i];

    // Render the replacement blocks into a fragment (one DOM construction,
    // per-block node counts recovered from marker comments).
    const scratch = document.createElement('template');
    scratch.innerHTML = blocks.slice(start, endNew).map(sanitizeMarkdownHtml).join(BLOCK_MARKER);
    const newCounts = stripMarkersAndCount(scratch.content, endNew - start);

    const anchor = nodes[nodeEnd] ?? null;
    for (let i = nodeStart; i < nodeEnd; i++) nodes[i].remove();
    const inserted = Array.from(scratch.content.childNodes);
    this.container.insertBefore(scratch.content, anchor);

    this.prevBlocks = blocks;
    this.prevNodeCounts = [...counts.slice(0, start), ...newCounts, ...counts.slice(endOld)];

    this.resolveLocalImages(inserted);
  }

  private renderEmptyState(): void {
    this.prevBlocks = [];
    this.prevNodeCounts = [];
    this.chunkCache.clear();
    this.container.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'preview-empty-state';
    empty.textContent = 'Open a markdown file to preview';
    this.container.appendChild(empty);
  }

  private replaceAllBlocks(blocks: string[]): void {
    this.container.innerHTML = blocks.map(sanitizeMarkdownHtml).join(BLOCK_MARKER);
    this.prevNodeCounts = stripMarkersAndCount(this.container, blocks.length);
    this.prevBlocks = blocks;
    // A full rebuild (tab switch, reopen) refetches remote images, so an
    // image edited on the host shows up; keystroke renders reuse the cache.
    this.images.resetRemoteCache();
    this.resolveLocalImages();
  }

  /**
   * Render an HTML document in an iframe so its own styles render faithfully
   * without leaking into (or inheriting from) the app chrome. Relative asset
   * references are rewritten through the asset protocol so local images and
   * stylesheets resolve against the file's directory.
   *
   * Two modes:
   * - Scripts OFF (default): `srcdoc` + `sandbox` (no `allow-scripts`). The
   *   document inherits the app's strict CSP and cannot execute scripts — safe
   *   for opening arbitrary HTML.
   * - Scripts ON (opt-in): the document is served from the `htmlpreview://`
   *   custom protocol, giving it its own origin and no CSP, so its inline
   *   scripts run. A `srcdoc` document can't do this because srcdoc inherits
   *   the embedder's CSP, which forbids inline scripts.
   */
  private async renderHtmlPreview(content: string): Promise<void> {
    // SVG is wrapped in a host document that centres it; HTML is framed as-is
    // (with relative asset references rewritten through the asset protocol).
    const seq = ++this.htmlAssetSeq;
    const resolved = this.svgMode
      ? this.wrapSvgDocument(content)
      : await this.rewriteHtmlAssets(content);
    // Remote images are fetched over SSH; a newer render may have finished
    // while this one waited. Only the latest may reach the frame.
    if (seq !== this.htmlAssetSeq) return;

    if (this.allowScripts) {
      await this.renderHtmlWithScripts(resolved);
      return;
    }

    let frame = this.ensureFrame('srcdoc');
    frame.removeAttribute('src');
    frame.srcdoc = resolved;
  }

  /**
   * Forward interaction inside the same-origin preview iframe to the app:
   * clicking/focusing marks the preview as the active pane, and Cmd/Ctrl+F
   * opens preview find. Neither would otherwise reach the parent document.
   */
  private attachFrameEvents(frame: HTMLIFrameElement): void {
    let fdoc: Document | null = null;
    try {
      fdoc = frame.contentDocument;
    } catch {
      return; // cross-origin (scripts on) — not reachable
    }
    if (!fdoc) return;
    const markFocus = () => this.onFrameFocus?.();
    fdoc.addEventListener('mousedown', markFocus);
    fdoc.addEventListener('focusin', markFocus);
    fdoc.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'f' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.onFrameFind?.();
      }
      // The shortcuts dialog uses Cmd+Shift+H via the native Help menu, which
      // fires regardless of focus — no need to forward it out of the iframe.
    });
  }

  /** Register callbacks fired on focus / Cmd+F inside the preview iframe. */
  setFrameCallbacks(onFocus: () => void, onFind: () => void): void {
    this.onFrameFocus = onFocus;
    this.onFrameFind = onFind;
  }

  /**
   * Wrap raw SVG markup in a minimal host document that centres it and lets it
   * scale to fit the pane, mirroring how a browser tab renders a .svg file.
   */
  private wrapSvgDocument(svg: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">` +
      `<style>html,body{margin:0;height:100%;}` +
      `body{display:flex;align-items:center;justify-content:center;}` +
      `svg{max-width:100%;max-height:100%;}</style></head>` +
      `<body>${svg}</body></html>`;
  }

  /** Serve the document from the custom protocol (own origin) so scripts run. */
  private async renderHtmlWithScripts(resolved: string): Promise<void> {
    await api.setHtmlPreview(resolved);
    const frame = this.ensureFrame('scripts');
    frame.removeAttribute('srcdoc');
    // Cache-bust so live edits reload even though the path is constant.
    frame.src = `htmlpreview://localhost/?v=${++this.htmlRenderSeq}`;
  }

  /**
   * Get the preview iframe, recreating it when the mode changes. The `sandbox`
   * attribute is only read on navigation and the two modes use different
   * origins, so a stale frame must be replaced rather than reused.
   */
  private ensureFrame(mode: 'srcdoc' | 'scripts'): HTMLIFrameElement {
    let frame = this.container.querySelector<HTMLIFrameElement>('iframe.html-preview-frame');
    if (!frame || frame.dataset.mode !== mode) {
      this.container.innerHTML = '';
      frame = document.createElement('iframe');
      frame.className = 'html-preview-frame';
      frame.dataset.mode = mode;
      // srcdoc mode: sandbox WITHOUT allow-scripts (no script execution), but
      // WITH allow-same-origin so the parent can read the framed DOM for
      // preview search. allow-same-origin alone does not enable scripts.
      if (mode === 'srcdoc') frame.setAttribute('sandbox', 'allow-same-origin');
      // scripts mode: allow the document's own scripts, but withhold
      // allow-top-navigation (no `top.location = phishing-site` window
      // takeover) and allow-same-origin (keeps it a null-origin, so it can't
      // reach the htmlpreview:// origin's storage). This blocks UI redress;
      // file confidentiality is enforced by origin isolation + asset CORS,
      // not by the (network-permissive) CSP. Not set for srcdoc.
      else frame.setAttribute('sandbox', 'allow-scripts');
      // Forward focus + Cmd/Ctrl+F from inside the same-origin doc on every
      // load (srcdoc-mode only; the scripts-mode origin is cross-origin). Set
      // once on creation, not via {once:true}, so it survives re-renders.
      if (mode === 'srcdoc') {
        frame.addEventListener('load', () => this.attachFrameEvents(frame!));
      }
      this.container.appendChild(frame);
    }
    return frame;
  }

  /**
   * Rewrite relative src/href attributes of an HTML document. Local: images
   * get a per-file asset grant (see PreviewImageResolver); scripts and
   * stylesheets use the asset protocol under the existing directory grants.
   * Remote: images are inlined as data: URLs fetched over SSH, and nothing
   * is pointed at asset:// — that would load a same-named LOCAL file.
   */
  private async rewriteHtmlAssets(htmlContent: string): Promise<string> {
    const baseDir = this.currentBaseDir;
    const origin = this.originResolver();
    if (!baseDir && origin === null) return htmlContent;
    const doc = new DOMParser().parseFromString(htmlContent, 'text/html');
    const jobs: Promise<void>[] = [];
    doc.querySelectorAll('img[src]').forEach((el) => {
      const path = resolveImagePath(el.getAttribute('src') ?? '', baseDir);
      if (!path) return;
      if (origin !== null) {
        el.removeAttribute('src');
        jobs.push(this.images.remoteUrl(origin, path).then((url) => {
          if (url) el.setAttribute('src', url);
        }));
      } else {
        jobs.push(this.images.localUrl(path).then((url) => el.setAttribute('src', url)));
      }
    });
    if (origin === null && baseDir) {
      const resolve = (el: Element, attr: string) => {
        const val = el.getAttribute(attr);
        if (!val || /^(data:|https?:|asset:|#|mailto:|\/\/)/i.test(val)) return;
        const abs = val.startsWith('/') ? val : `${baseDir}/${val}`;
        el.setAttribute(attr, convertFileSrc(abs));
      };
      doc.querySelectorAll('script[src]').forEach((el) => resolve(el, 'src'));
      doc.querySelectorAll('link[href]').forEach((el) => resolve(el, 'href'));
    }
    await Promise.all(jobs);
    return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
  }

  /** Rewrite file-referencing image srcs; scoped to `scope` nodes when
   *  provided (incremental renders), otherwise the whole container. The
   *  URLs are set asynchronously (see PreviewImageResolver). */
  private resolveLocalImages(scope?: Node[]): void {
    const images: HTMLImageElement[] = scope
      ? scope.flatMap((n) => {
          if (!(n instanceof HTMLElement)) return [];
          const found = Array.from(n.querySelectorAll<HTMLImageElement>('img'));
          if (n instanceof HTMLImageElement) found.push(n);
          return found;
        })
      : Array.from(this.container.querySelectorAll<HTMLImageElement>('img'));
    if (images.length === 0) return;
    void this.images.resolve(images, this.currentBaseDir, this.originResolver());
  }

  /** Tell the pane which machine the previewed document lives on (the
   *  active tab's origin): null = local, otherwise the SSH host alias. */
  setOriginResolver(resolver: () => string | null): void {
    this.originResolver = resolver;
  }

  /** Settles once every pending image URL has been applied (tests). */
  whenImagesResolved(): Promise<void> {
    return this.images.idle();
  }

  setBaseDir(dir: string | null): void {
    if (dir === this.currentBaseDir) return;
    this.currentBaseDir = dir;
    this.images.resetRemoteCache();
    // Relative image srcs resolve against the base dir, but the incremental
    // renderer reuses DOM nodes whose block HTML is unchanged — and their
    // <img> src was already rewritten against the OLD dir. Two files in
    // different folders that both start with `![logo](logo.png)` would
    // otherwise keep the first folder's resolved image. Drop the caches so the
    // next render is a full rebuild and every image re-resolves against `dir`.
    this.lastRendered = null;
    this.prevBlocks = [];
    this.prevNodeCounts = [];
  }

  scrollToRatio(ratio: number): void {
    if (!this.container) return;
    scrollElementToRatio(this.container, ratio, this.scrollState);
  }

  /**
   * Rendered pixel offsets of the pane's top-level h1–h6 elements, in the
   * same DOM order the source headings appear. Returns null when the count
   * doesn't match `expectedCount` (setext headings, quoted headings, raw
   * HTML would desync positional pairing) — callers fall back to
   * proportional sync. Cached per rendered content.
   */
  private headingOffsetsCache: { content: string; offsets: number[] | null } | null = null;

  private invalidateSyncMap(): void {
    this.headingOffsetsCache = null;
  }

  headingOffsets(expectedCount: number): number[] | null {
    if (this.framedMode || !this.container) return null;
    const content = this.lastRendered ?? '';
    if (this.headingOffsetsCache?.content === content) {
      const cached = this.headingOffsetsCache.offsets;
      return cached && cached.length === expectedCount ? cached : null;
    }
    const rendered = this.container.querySelectorAll<HTMLElement>(
      ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6',
    );
    const offsets = Array.from(rendered, (el) => el.offsetTop);
    this.headingOffsetsCache = { content, offsets };
    return offsets.length === expectedCount && offsets.length > 0 ? offsets : null;
  }

  scrollMetrics(): { scrollTop: number; maxScroll: number } {
    return {
      scrollTop: this.container?.scrollTop ?? 0,
      maxScroll: this.container
        ? Math.max(0, this.container.scrollHeight - this.container.clientHeight)
        : 0,
    };
  }

  scrollToTop(top: number): void {
    if (!this.container) return;
    scrollElementToTop(this.container, top, this.scrollState);
  }

  initReverseScroll(): void {
    let lastEmit = 0;
    this.container.addEventListener('scroll', () => {
      if (this.scrollState.ignore) return;
      const now = Date.now();
      if (now - lastEmit < TIMING.SCROLL_THROTTLE_MS) return;
      lastEmit = now;
      const { scrollTop, scrollHeight, clientHeight } = this.container;
      const maxScroll = scrollHeight - clientHeight;
      if (maxScroll <= 0) return;
      const ratio = Math.max(0, Math.min(1, scrollTop / maxScroll));
      this.bus.emit(EVENTS.PREVIEW_SCROLL, { scrollRatio: ratio });
    });
  }

  scrollToId(id: string): void {
    // Rendered heading ids are namespaced (USER_CONTENT_PREFIX). TOC entries
    // and anchor hrefs may arrive either bare (`heading`) or already prefixed
    // (`user-content-heading`); normalize before looking the element up.
    const target = id.startsWith(USER_CONTENT_PREFIX) ? id : USER_CONTENT_PREFIX + id;
    const el = this.container.querySelector(`[id="${CSS.escape(target)}"]`);
    // scrollIntoView is missing in some non-browser DOMs (jsdom).
    if (el) el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }

  /**
   * The element/document to run preview search over:
   * - markdown: this container <div>
   * - HTML/SVG (scripts off): the iframe's contentDocument (same-origin readable)
   * - HTML/SVG (scripts on): null — the htmlpreview:// origin is cross-origin
   *   and cannot be searched from the parent.
   */
  getSearchRoot(): Document | HTMLElement | null {
    if (!this.framedMode) return this.container;
    const frame = this.container.querySelector<HTMLIFrameElement>('iframe.html-preview-frame');
    if (!frame) return null;
    try {
      return frame.contentDocument ?? null;
    } catch {
      return null; // cross-origin (scripts enabled)
    }
  }

  /** Whether the preview currently has a searchable surface. */
  canSearch(): boolean {
    return this.getSearchRoot() !== null;
  }

  toggle(): void {
    this.setVisible(!this.visible);
    this.bus.emit(EVENTS.PREVIEW_TOGGLED, { visible: this.visible });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    const previewContainer = this.container.parentElement;
    const resizeHandle = document.getElementById('resize-handle');
    previewContainer?.classList.toggle('hidden', !visible);
    resizeHandle?.classList.toggle('hidden', !visible);
  }

  isVisible(): boolean {
    return this.visible;
  }

  getRenderedHtml(): string {
    // Clone so we can rewrite img src back to original relative paths
    // without disturbing the live preview.
    const clone = this.container.cloneNode(true) as HTMLElement;
    for (const img of clone.querySelectorAll<HTMLImageElement>('img')) {
      const original = img.dataset.originalSrc;
      if (original) {
        img.setAttribute('src', original);
        delete img.dataset.originalSrc;
      }
    }
    return clone.innerHTML;
  }

  notifyThemeChanged(theme: 'light' | 'dark'): void {
    this.mermaidLoader.updateTheme(theme);
  }

  /**
   * Re-render the current markdown after a theme change so Mermaid diagrams
   * pick up the new theme. A plain render() would no-op: the content is
   * unchanged (renderImmediate returns early on `content === lastRendered`) and
   * the incremental renderer keeps unchanged blocks, so already-processed
   * diagrams keep their stale theme. Clearing the caches forces a full rebuild
   * from the markdown source, which mints fresh `.mermaid` divs (no
   * data-processed); renderImmediate then re-runs Mermaid with the theme that
   * notifyThemeChanged() just applied. No-op for framed (HTML/SVG) previews.
   */
  async rerenderForTheme(markdownContent: string): Promise<void> {
    if (this.framedMode) return;
    this.lastRendered = null;
    this.prevBlocks = [];
    this.prevNodeCounts = [];
    await this.renderImmediate(markdownContent);
  }
}
