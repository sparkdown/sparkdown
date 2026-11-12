import { formatShortcut } from './shortcuts';

/**
 * Find-only search for the preview pane. Mirrors the editor's floating widget
 * (bottom-right, compact) but searches rendered content rather than source, so
 * there is no replace. Works on:
 *  - the markdown preview (a <div> in this document), and
 *  - the HTML/SVG preview iframe when it is same-origin readable (scripts-off
 *    srcdoc with allow-same-origin). The scripts-on htmlpreview:// origin is
 *    cross-origin and cannot be searched — open() reports that and bails.
 *
 * Matching walks text nodes and wraps hits in <mark class="sd-phit">, tracking
 * the active hit for prev/next and scroll-into-view. Marks are cleared on close
 * and before each re-search so they never persist into the rendered output.
 */
// Bounds on the per-keystroke search work. These exist to keep a very large
// document from freezing the single-threaded webview when the user types a
// short query into preview find.
//   - MIN_QUERY_LENGTH: don't search until the user has typed enough to make
//     the match count tractable. A single common character on a megabyte-scale
//     document can produce millions of hits.
//   - MAX_HITS: hard cap on the number of <mark> elements created in one run.
//     When reached, we stop walking and report "<cap>+ results".
const MIN_QUERY_LENGTH = 2;
const MAX_HITS = 2000;

export class PreviewSearch {
  private host: HTMLElement;          // where the widget mounts (preview-container)
  private dom: HTMLElement | null = null;
  private input!: HTMLInputElement;
  private count!: HTMLElement;
  private root: Document | HTMLElement | null = null; // searched container
  private hits: HTMLElement[] = [];
  private active = -1;
  private caseSensitive = false;
  // True when the last run() stopped because it hit MAX_HITS. Used only to
  // render the count label as "<cap>+" so the user knows results are capped.
  private truncated = false;

  constructor(
    host: HTMLElement,
    private readonly placeholder = 'Find in preview',
  ) {
    this.host = host;
  }

  /**
   * Open the widget against a search root. `root` is the markdown <div> or an
   * iframe's contentDocument. Returns false if the root can't be searched.
   */
  open(root: Document | HTMLElement | null): boolean {
    if (!root) return false;
    this.root = root;
    if (!this.dom) this.build();
    this.dom!.style.display = 'flex';
    this.input.focus();
    this.input.select();
    if (this.input.value) this.run();
    return true;
  }

  close(): void {
    this.clearMarks();
    this.hits = [];
    this.active = -1;
    if (this.dom) this.dom.style.display = 'none';
  }

  isOpen(): boolean {
    return !!this.dom && this.dom.style.display !== 'none';
  }

  // --- build widget --------------------------------------------------------
  private build(): void {
    const dom = document.createElement('div');
    dom.className = 'sd-find sd-find-preview'; // reuse editor widget styling
    const fields = document.createElement('div');
    fields.className = 'sd-find-fields';
    const row = document.createElement('div');
    row.className = 'sd-find-row';

    const wrap = document.createElement('div');
    wrap.className = 'sd-find-inputwrap';
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.placeholder = this.placeholder;
    this.input.className = 'sd-find-input';
    this.input.spellcheck = false;
    const tools = document.createElement('div');
    tools.className = 'sd-find-intools';
    const caseBtn = document.createElement('button');
    caseBtn.className = 'sd-find-mini';
    caseBtn.textContent = 'Aa';
    caseBtn.title = 'Match case';
    caseBtn.type = 'button';
    tools.appendChild(caseBtn);
    wrap.append(this.input, tools);

    this.count = document.createElement('span');
    this.count.className = 'sd-find-count';

    const prev = iconBtn(`Previous (${formatShortcut('Shift+Enter')})`, '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg>');
    const next = iconBtn('Next (⏎)', '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/></svg>');
    const closeB = iconBtn('Close (Esc)', '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>');

    row.append(wrap, this.count, prev, next, closeB);
    fields.appendChild(row);
    dom.appendChild(fields);
    this.host.appendChild(dom);
    this.dom = dom;

    this.input.addEventListener('input', () => this.run());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? this.step(-1) : this.step(1); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    prev.onclick = () => this.step(-1);
    next.onclick = () => this.step(1);
    closeB.onclick = () => this.close();
    caseBtn.onclick = () => { this.caseSensitive = !this.caseSensitive; caseBtn.classList.toggle('active', this.caseSensitive); this.run(); };
  }

  // --- search --------------------------------------------------------------
  private searchRootEl(): HTMLElement | null {
    if (!this.root) return null;
    // Use nodeType, not `instanceof Document`: an iframe's document belongs to
    // a different realm, so cross-realm instanceof checks fail.
    if (this.root.nodeType === 9 /* DOCUMENT_NODE */) {
      return (this.root as Document).body;
    }
    return this.root as HTMLElement;
  }

  private clearMarks(): void {
    const el = this.searchRootEl();
    if (!el) return;
    // Collect affected parents first, then normalize each one exactly once.
    // normalize() walks the parent's whole child list, so calling it per mark
    // is O(k^2) when k marks share a parent (a single large paragraph).
    const parents = new Set<Node>();
    for (const mark of Array.from(el.querySelectorAll('mark.sd-phit'))) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(mark.ownerDocument.createTextNode(mark.textContent || ''), mark);
      parents.add(parent);
    }
    for (const parent of parents) (parent as Element | Document).normalize();
  }

  private run(): void {
    this.clearMarks();
    this.hits = [];
    this.active = -1;
    this.opacityCache = new Map();
    const query = this.input.value;
    const el = this.searchRootEl();
    if (!query || !el) { this.updateCount(); return; }

    const needle = this.caseSensitive ? query : query.toLowerCase();
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        // Only count visibly rendered text — match what the user sees. Skips
        // <head> content (title/style/script), display:none, hidden, etc.
        // Walk ancestors so a hidden container excludes its descendants too.
        for (let a: HTMLElement | null = p; a && a !== el.parentElement; a = a.parentElement) {
          const tag = a.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'HEAD' || tag === 'TITLE' || tag === 'NOSCRIPT') {
            return NodeFilter.FILTER_REJECT;
          }
          const cs = win?.getComputedStyle(a);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) {
            return NodeFilter.FILTER_REJECT;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    // Require a minimum query length. One character on a multi-megabyte
    // document produces an unbounded number of marks and can freeze the
    // webview. Empty state is reported by updateCount().
    if (query.length < MIN_QUERY_LENGTH) { this.updateCount(); return; }

    const textNodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) textNodes.push(n as Text);

    // Walk nodes and create <mark>s, stopping as soon as we hit MAX_HITS.
    this.truncated = false;
    outer: for (const textNode of textNodes) {
      const text = textNode.nodeValue || '';
      const hay = this.caseSensitive ? text : text.toLowerCase();
      let idx = hay.indexOf(needle);
      if (idx === -1) continue;

      // Split the text node into [before][mark][after] for each match.
      let current = textNode;
      let offsetBase = 0;
      while (idx !== -1) {
        if (this.hits.length >= MAX_HITS) { this.truncated = true; break outer; }
        const matchStart = idx - offsetBase;
        const after = current.splitText(matchStart);
        const matchNode = after.splitText(needle.length);
        const mark = doc.createElement('mark');
        mark.className = 'sd-phit';
        // Inline styles so highlighting also works inside the iframe document,
        // which doesn't share the app's stylesheet.
        mark.style.cssText = 'background:#f5c518;color:#000;border-radius:2px;';
        mark.textContent = after.nodeValue;
        after.parentNode!.replaceChild(mark, after);
        this.hits.push(mark as HTMLElement);
        current = matchNode;
        offsetBase = idx + needle.length;
        const rest = this.caseSensitive ? (current.nodeValue || '') : (current.nodeValue || '').toLowerCase();
        const nextRel = rest.indexOf(needle);
        idx = nextRel === -1 ? -1 : offsetBase + nextRel;
      }
    }

    // Drop matches that aren't actually rendered. An element hidden via
    // collapsed accordions/tabs (max-height:0, clip, zero-size, off-screen,
    // opacity:0) still lives in the DOM and passes the display/visibility
    // filter — but it has no painted geometry. Check each mark's real layout
    // box, which is what the browser's own "find in page" effectively does.
    //
    // Two performance notes:
    //  - Partition in a single pass: assign to `visible` or `rejected`
    //    directly rather than filtering twice (previously the second pass
    //    used `visible.includes(m)`, which is O(n^2)).
    //  - Collect each rejected mark's parent in a Set and call normalize()
    //    once per parent at the end instead of once per mark (also O(n^2)
    //    when many marks share a parent).
    const visible: HTMLElement[] = [];
    const rejectedParents = new Set<Node>();
    for (const m of this.hits) {
      if (this.isRendered(m)) {
        visible.push(m);
      } else {
        const parent = m.parentNode;
        if (parent) {
          parent.replaceChild(m.ownerDocument.createTextNode(m.textContent || ''), m);
          rejectedParents.add(parent);
        }
      }
    }
    for (const parent of rejectedParents) (parent as Element | Document).normalize();
    this.hits = visible;

    if (this.hits.length) this.setActive(0);
    this.updateCount();
  }

  /**
   * True if the element has a painted box and isn't hidden by opacity.
   *
   * getBoundingClientRect() is cheaper than getClientRects() for the common
   * case (we only need to know if the mark has any painted area) and we also
   * cap the ancestor opacity walk via a per-run cache so a deeply nested
   * document doesn't pay the same getComputedStyle() cost over and over.
   * The hit cap in run() bounds how often this can be called in total.
   */
  private isRendered(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const win = el.ownerDocument.defaultView;
    if (!win) return true;
    // Walk ancestors for opacity:0 (doesn't zero the box but hides content).
    // Cache per ancestor across the current run so sibling marks under the
    // same subtree don't re-read computed style for every shared ancestor.
    const cache = this.opacityCache;
    for (let a: HTMLElement | null = el; a; a = a.parentElement) {
      const cached = cache.get(a);
      if (cached === true) return false; // ancestor already known-hidden
      if (cached === false) continue;    // ancestor already known-visible
      const cs = win.getComputedStyle(a);
      const hidden = parseFloat(cs.opacity) === 0;
      cache.set(a, hidden);
      if (hidden) return false;
    }
    return true;
  }

  // Per-run cache: ancestor -> isOpacityZero. Reset at the start of each run.
  private opacityCache: Map<HTMLElement, boolean> = new Map();

  private step(dir: number): void {
    if (!this.hits.length) return;
    this.setActive((this.active + dir + this.hits.length) % this.hits.length);
  }

  private setActive(i: number): void {
    if (this.active >= 0 && this.hits[this.active]) {
      const prev = this.hits[this.active];
      prev.classList.remove('sd-phit-active');
      prev.style.background = '#f5c518'; // back to normal-hit color
    }
    this.active = i;
    const hit = this.hits[i];
    if (hit) {
      hit.classList.add('sd-phit-active');
      hit.style.background = '#ff9632'; // active match — distinct from others
      hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    this.updateCount();
  }

  private updateCount(): void {
    if (!this.input.value) { this.count.textContent = ''; this.count.classList.remove('sd-find-noresults'); return; }
    if (this.input.value.length < MIN_QUERY_LENGTH) {
      this.count.textContent = `Type ≥${MIN_QUERY_LENGTH} chars`;
      this.count.classList.remove('sd-find-noresults');
      return;
    }
    if (!this.hits.length) { this.count.textContent = 'No results'; this.count.classList.add('sd-find-noresults'); return; }
    this.count.classList.remove('sd-find-noresults');
    const total = this.truncated ? `${this.hits.length}+` : `${this.hits.length}`;
    this.count.textContent = `${this.active + 1} of ${total}`;
  }
}

function iconBtn(title: string, svg: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sd-find-icon';
  b.title = title;
  b.innerHTML = svg;
  b.type = 'button';
  return b;
}
