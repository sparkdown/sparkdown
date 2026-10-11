import { EditorState, Extension, Compartment, Prec, Text } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  placeholder,
  type KeyBinding,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  syntaxHighlighting,
  bracketMatching,
  HighlightStyle,
  codeFolding,
  foldGutter,
  foldKeymap,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { search, searchKeymap, openSearchPanel, gotoLine as gotoLinePrompt } from '@codemirror/search';

/** CodeMirror's search keys minus Mod-Shift-g (find previous): ⌘⇧G /
 *  Ctrl+Shift+G opens the Changes view. CodeMirror consumed it first, so
 *  on macOS the native View-menu accelerator never fired while the editor
 *  had focus. Find previous stays on Shift-F3 and Shift-Enter in the panel. */
export const editorSearchKeymap: readonly KeyBinding[] = searchKeymap.map((b) =>
  b.key === 'Mod-g' ? { ...b, shift: undefined } : b,
);
import { EventBus } from './events';
import { scrollElementToRatio, scrollElementToTop, createScrollState, headingSourceLines } from './utils';
import { TIMING } from './constants';
import { getLanguageFor } from './file-types';
import { EVENTS, ACTIONS } from './event-names';
import { createSearchPanel } from './search-panel';
import { shortcutFor } from './shortcuts';

/**
 * Fold-gutter marker. CodeMirror's default glyph (⌄) sits low in its font box
 * and reads as bottom-aligned; a chevron SVG (rotated for the open state) has
 * identical geometry in both states and centers cleanly with the line number.
 */
function makeFoldMarker(open: boolean): HTMLElement {
  const span = document.createElement('span');
  span.className = 'sd-fold-marker';
  span.innerHTML =
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  // Chevron points right when collapsed; rotate 90° to point down when open.
  if (open) span.style.transform = 'rotate(90deg)';
  return span;
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14px',
    backgroundColor: 'var(--editor-bg)',
    color: 'var(--editor-fg)',
  },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    caretColor: 'var(--editor-caret)',
    // Top padding clears the floating md-toolbar; collapses to a small gap
    // when there's no toolbar (non-markdown files). See Toolbar.setFileType.
    padding: 'var(--editor-top-pad, 44px) 0 8px 0',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--editor-gutter-bg)',
    color: 'var(--editor-gutter-fg)',
    border: 'none',
    minWidth: '40px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--editor-active-line-gutter)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--editor-active-line)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--editor-selection) !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--editor-selection) !important',
  },
  '&.cm-focused .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--editor-selection) !important',
  },
  '.cm-content ::selection': {
    backgroundColor: 'var(--editor-selection) !important',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--editor-caret)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--panel-bg)',
    color: 'var(--fg)',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid var(--border)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--editor-search-match)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--editor-search-match-selected)',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
});

export class EditorManager {
  private view!: EditorView;
  private bus: EventBus;
  private wordWrap: boolean;
  private wrapCompartment = new Compartment();
  private langCompartment = new Compartment();
  /** Editable / read-only: off while the editor is not on screen (Diff,
   *  Preview-only, welcome) so stray keys can't edit a hidden buffer. */
  private inputCompartment = new Compartment();
  private inputEnabled = true;
  private states = new Map<string, EditorState>();

  constructor(bus: EventBus, wordWrap: boolean) {
    this.bus = bus;
    this.wordWrap = wordWrap;
  }

  init(container: HTMLElement): void {
    const state = EditorState.create({ doc: '', extensions: this.buildExtensions() });
    this.view = new EditorView({ state, parent: container });

    // Custom scrollbar — replaces native scrollbar to avoid WebKit+CM bug
    // where dragging the native scrollbar corrupts CM's mouse state.
    this.initCustomScrollbar(container);

    const mdToolbar = document.getElementById('md-toolbar');
    this.view.scrollDOM.addEventListener('scroll', () => {
      const scrollTop = this.view.scrollDOM.scrollTop;

      if (mdToolbar) {
        mdToolbar.classList.toggle('floating', scrollTop > 10);
      }

      if (this.scrollState.ignore) return;
      const now = Date.now();
      if (now - this._lastScrollEmit < TIMING.SCROLL_THROTTLE_MS) return;
      this._lastScrollEmit = now;
      const { scrollHeight, clientHeight } = this.view.scrollDOM;
      const maxScroll = scrollHeight - clientHeight;
      if (maxScroll <= 0) return;
      const ratio = Math.max(0, Math.min(1, scrollTop / maxScroll));
      this.bus.emit(EVENTS.SCROLL_SYNC, { scrollRatio: ratio });
    }, { passive: true });
  }

  private initCustomScrollbar(container: HTMLElement): void {
    // Create scrollbar elements
    const track = document.createElement('div');
    track.className = 'cm-custom-scrollbar-track';
    const thumb = document.createElement('div');
    thumb.className = 'cm-custom-scrollbar-thumb';
    track.appendChild(thumb);
    container.appendChild(track);

    const scroller = this.view.scrollDOM;
    let isDragging = false;
    let dragStartY = 0;
    let dragStartScrollTop = 0;

    const updateThumb = () => {
      const { scrollTop, scrollHeight, clientHeight } = scroller;
      if (scrollHeight <= clientHeight) {
        track.style.display = 'none';
        return;
      }
      track.style.display = '';
      const trackHeight = track.clientHeight;
      const thumbHeight = Math.max(24, (clientHeight / scrollHeight) * trackHeight);
      const maxThumbTop = trackHeight - thumbHeight;
      const thumbTop = (scrollTop / (scrollHeight - clientHeight)) * maxThumbTop;
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.top = `${thumbTop}px`;
    };

    // Sync thumb position with CM scroll
    scroller.addEventListener('scroll', updateThumb, { passive: true });

    // Also update on content changes (scroll height may change)
    const observer = new ResizeObserver(updateThumb);
    observer.observe(scroller);

    // Initial update
    requestAnimationFrame(updateThumb);

    // Thumb drag
    thumb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isDragging = true;
      dragStartY = e.clientY;
      dragStartScrollTop = scroller.scrollTop;
      thumb.classList.add('active');
      document.body.style.userSelect = 'none';

      const onMove = (ev: MouseEvent) => {
        if (!isDragging) return;
        const dy = ev.clientY - dragStartY;
        const { scrollHeight, clientHeight } = scroller;
        const trackHeight = track.clientHeight;
        const thumbHeight = Math.max(24, (clientHeight / scrollHeight) * trackHeight);
        const maxThumbTop = trackHeight - thumbHeight;
        const scrollRange = scrollHeight - clientHeight;
        const scrollDelta = (dy / maxThumbTop) * scrollRange;
        scroller.scrollTop = dragStartScrollTop + scrollDelta;
      };

      const onUp = () => {
        isDragging = false;
        thumb.classList.remove('active');
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Click on track to jump
    track.addEventListener('mousedown', (e) => {
      if (e.target === thumb) return;
      e.preventDefault();
      const trackRect = track.getBoundingClientRect();
      const clickRatio = (e.clientY - trackRect.top) / trackRect.height;
      const { scrollHeight, clientHeight } = scroller;
      scroller.scrollTop = clickRatio * (scrollHeight - clientHeight);
    });
  }

  private buildExtensions(path: string | null = null): Extension[] {
    // Custom highlight style using CSS variables for light/dark theme support
    const customHighlight = HighlightStyle.define([
      { tag: tags.meta, color: 'var(--syn-meta)' },
      { tag: tags.link, color: 'var(--preview-link)', textDecoration: 'underline' },
      { tag: tags.url, color: 'var(--preview-link)' },
      // Markdown prose: tinted headings (scaled h1/h2), colored quotes and
      // list markers — so a document reads structured in the editor too.
      { tag: tags.heading, fontWeight: '650', color: 'var(--md-heading)' },
      { tag: tags.heading1, fontWeight: '700', fontSize: '1.35em', color: 'var(--md-heading)' },
      { tag: tags.heading2, fontWeight: '650', fontSize: '1.15em', color: 'var(--md-heading)' },
      { tag: tags.quote, color: 'var(--md-quote)', fontStyle: 'italic' },
      // Dim the markdown marks (list bullets `-`/`1.`, `#`, `>`, `*`, backticks)
      // via processingInstruction, but do NOT color tags.list — that spans the
      // whole list including its text, which should read as regular body color.
      { tag: tags.processingInstruction, color: 'var(--md-quote)' },
      { tag: tags.emphasis, fontStyle: 'italic' },
      { tag: tags.strong, fontWeight: 'bold' },
      { tag: tags.strikethrough, textDecoration: 'line-through' },
      { tag: tags.keyword, color: 'var(--syn-keyword)' },
      { tag: [tags.atom, tags.bool, tags.contentSeparator, tags.labelName], color: 'var(--syn-atom)' },
      { tag: [tags.literal, tags.inserted], color: 'var(--syn-number)' },
      { tag: [tags.number], color: 'var(--syn-number)' },
      { tag: [tags.string, tags.deleted], color: 'var(--syn-string)' },
      { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: 'var(--syn-regexp)' },
      { tag: tags.definition(tags.variableName), color: 'var(--syn-variable-def)' },
      { tag: tags.local(tags.variableName), color: 'var(--syn-variable-local)' },
      { tag: [tags.typeName, tags.namespace], color: 'var(--syn-type)' },
      { tag: tags.className, color: 'var(--syn-class)' },
      { tag: [tags.special(tags.variableName), tags.macroName], color: 'var(--syn-special)' },
      { tag: tags.definition(tags.propertyName), color: 'var(--syn-property-def)' },
      { tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
      { tag: tags.monospace, fontFamily: 'var(--font-mono)', color: 'var(--md-code-fg)' },
      { tag: tags.invalid, color: 'var(--syn-invalid)' },
    ]);

    return [
      lineNumbers(),
      highlightActiveLine(),
      bracketMatching(),
      history(),
      // Quiet empty-state hint for a fresh buffer (styled in editor.css).
      // The shortcuts-dialog key for this platform (⌘⇧H / Ctrl+Shift+H).
      placeholder(editorPlaceholder()),
      // Code folding for HTML/XML/SVG elements, JSON objects/arrays, JS/CSS
      // blocks, and markdown sections. The gutter arrows reveal on hover only
      // (see editor.css) so the gutter stays clean for prose.
      codeFolding(),
      foldGutter({ markerDOM: makeFoldMarker }),
      this.langCompartment.of(getLanguageFor(path)),
      syntaxHighlighting(customHighlight),
      editorTheme,
      search({ top: false, createPanel: createSearchPanel }),
      // Editor-formatting shortcuts, at highest precedence so they win over
      // defaultKeymap's Mod-i (selectParentSyntax) and, on macOS, Ctrl-b
      // (cursorCharLeft) — otherwise Cmd+I would select the parent syntax node
      // and then italicize all of it. Returning true marks the key handled, so
      // CodeMirror calls preventDefault; the global ShortcutManager then skips
      // it (it bails on e.defaultPrevented) and can't double-fire.
      Prec.highest(
        keymap.of([
          { key: 'Mod-b', run: () => { this.bus.emit(ACTIONS.BOLD); return true; } },
          { key: 'Mod-i', run: () => { this.bus.emit(ACTIONS.ITALIC); return true; } },
        ]),
      ),
      keymap.of([...defaultKeymap, ...historyKeymap, ...editorSearchKeymap, ...foldKeymap]),
      this.wrapCompartment.of(
        this.wordWrap ? EditorView.lineWrapping : []
      ),
      this.inputCompartment.of(this.inputExtension()),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          this.bus.emit(EVENTS.CONTENT_CHANGED, {
            content: update.state.doc.toString(),
          });
        }
        if (update.selectionSet || update.docChanged) {
          const pos = update.state.selection.main.head;
          const line = update.state.doc.lineAt(pos);
          const { from, to } = update.state.selection.main;
          this.bus.emit(EVENTS.CURSOR_CHANGED, {
            line: line.number,
            column: pos - line.from + 1,
            chars: update.state.doc.length,
            selectedChars: from === to ? 0 : to - from,
          });
        }
      }),
    ];
  }

  private scrollState = createScrollState();
  private _lastScrollEmit = 0;

  scrollToRatio(ratio: number): void {
    scrollElementToRatio(this.view.scrollDOM, ratio, this.scrollState);
  }

  /**
   * Pixel offsets (document coords) of the given source lines, for the
   * scroll-sync landmark map. CodeMirror's lineBlockAt gives exact geometry
   * even for lines outside the rendered viewport.
   */
  headingOffsets(lines: number[]): number[] {
    const doc = this.view.state.doc;
    return lines.map((n) => {
      const clamped = Math.max(1, Math.min(doc.lines, n));
      return this.view.lineBlockAt(doc.line(clamped).from).top;
    });
  }

  scrollMetrics(): { scrollTop: number; maxScroll: number } {
    const dom = this.view.scrollDOM;
    return {
      scrollTop: dom.scrollTop,
      maxScroll: Math.max(0, dom.scrollHeight - dom.clientHeight),
    };
  }

  scrollToTop(top: number): void {
    scrollElementToTop(this.view.scrollDOM, top, this.scrollState);
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  /** Text of the primary selection ('' when it is empty). */
  getSelectionText(): string {
    const { from, to } = this.view.state.selection.main;
    return from === to ? '' : this.view.state.sliceDoc(from, to);
  }

  /** 1-based line of the cursor (selection head). */
  getCursorLine(): number {
    return this.view.state.doc.lineAt(this.view.state.selection.main.head).number;
  }

  /**
   * Replace the whole document as one undoable edit (an agent's buffer edit
   * via MCP). Goes through dispatch so docChanged fires and the tab turns
   * dirty; the user can ⌘Z it. Keeps the cursor line where possible.
   */
  replaceAll(content: string): void {
    const state = this.view.state;
    const line = state.doc.lineAt(state.selection.main.head).number;
    this.view.dispatch({
      changes: { from: 0, to: state.doc.length, insert: content },
    });
    const doc = this.view.state.doc;
    const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
    this.view.dispatch({ selection: { anchor: target.from } });
  }

  /** Load a fresh document via setState — fires no docChanged event. */
  loadFresh(content: string, path: string | null): void {
    const state = EditorState.create({
      doc: content,
      extensions: this.buildExtensions(path),
    });
    this.view.setState(state);
  }

  // Word counting and heading-line scanning are O(document): expensive to run
  // on every keystroke / scroll tick over a large file. CodeMirror's doc is an
  // immutable value that changes identity only on edit, so cache both keyed on
  // that identity — repeated calls between edits reuse the result.
  private wordCountCache: { doc: Text; count: number } | null = null;
  private headingLinesCache: { doc: Text; lines: number[] } | null = null;

  getWordCount(): number {
    const doc = this.view.state.doc;
    if (this.wordCountCache?.doc === doc) return this.wordCountCache.count;
    const trimmed = doc.toString().trim();
    // Guard the empty/whitespace-only case: "".split(/\s+/) yields [""],
    // which would miscount as 1 word.
    const count = trimmed === '' ? 0 : trimmed.split(/\s+/).length;
    this.wordCountCache = { doc, count };
    return count;
  }

  /**
   * Source line numbers of ATX headings (see utils.headingSourceLines), cached
   * per document version. Scroll-sync calls this on every scroll tick; without
   * the cache each tick re-serialized and re-split the whole document.
   */
  headingSourceLines(): number[] {
    const doc = this.view.state.doc;
    if (this.headingLinesCache?.doc === doc) return this.headingLinesCache.lines;
    const lines = headingSourceLines(doc.toString());
    this.headingLinesCache = { doc, lines };
    return lines;
  }

  /** CodeMirror document length (newlines count as 1). */
  getCharCount(): number {
    return this.view.state.doc.length;
  }

  /** Length of the primary selection, or 0 when the caret is empty. */
  getSelectedCharCount(): number {
    const { from, to } = this.view.state.selection.main;
    return from === to ? 0 : to - from;
  }

  getLineCount(): number {
    return this.view.state.doc.lines;
  }

  wrapSelection(before: string, after: string): void {
    if (!this.inputEnabled) return;
    const { from, to } = this.view.state.selection.main;
    const selected = this.view.state.sliceDoc(from, to);
    this.view.dispatch({
      changes: { from, to, insert: `${before}${selected}${after}` },
      selection: { anchor: from + before.length, head: to + before.length },
    });
    this.view.focus();
  }

  insertAtCursor(text: string): void {
    if (!this.inputEnabled) return;
    const pos = this.view.state.selection.main.head;
    this.view.dispatch({ changes: { from: pos, insert: text } });
    this.view.focus();
  }

  insertLinePrefix(prefix: string): void {
    if (!this.inputEnabled) return;
    const pos = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(pos);
    this.view.dispatch({
      changes: { from: line.from, insert: prefix },
    });
    this.view.focus();
  }

  openSearch(): void {
    openSearchPanel(this.view);
  }

  toggleWordWrap(): void {
    this.wordWrap = !this.wordWrap;
    this.view.dispatch({
      effects: this.wrapCompartment.reconfigure(
        this.wordWrap ? EditorView.lineWrapping : []
      ),
    });
    this.bus.emit(EVENTS.WORD_WRAP_CHANGED, { enabled: this.wordWrap });
  }

  isWordWrapEnabled(): boolean {
    return this.wordWrap;
  }

  /** Switch editor language mode based on file extension */
  setLanguageForFile(path: string | null): void {
    this.view.dispatch({
      effects: this.langCompartment.reconfigure(getLanguageFor(path)),
    });
  }

  /** Move the cursor to `line` (and 1-based `column`, clamped) and center it. */
  gotoLine(line: number, column = 1): void {
    const doc = this.view.state.doc;
    const clampedLine = Math.max(1, Math.min(line, doc.lines));
    const lineInfo = doc.line(clampedLine);
    const pos = lineInfo.from + Math.max(0, Math.min(column - 1, lineInfo.length));
    this.view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    this.focus();
  }

  /** CodeMirror's go-to-line prompt (also on ⌘⌥G / Ctrl+Alt+G). */
  openGotoLine(): void {
    gotoLinePrompt(this.view);
  }

  /** Focus the editor — a no-op while input is off (it is not on screen). */
  focus(): void {
    if (!this.inputEnabled) return;
    this.view.focus();
  }

  /**
   * Let the editor take user input, or not. Off makes the view read-only and
   * non-editable (so no key, paste or IME input reaches the buffer) and
   * blurs it; programmatic updates (disk reloads, agent edits) still apply.
   * The setting sticks across tab switches (restoreStateFor re-applies it).
   */
  setInputEnabled(enabled: boolean): void {
    if (enabled !== this.inputEnabled) {
      this.inputEnabled = enabled;
      this.syncInputFacet();
    }
    if (!enabled && this.view.hasFocus) this.view.contentDOM.blur();
  }

  isInputEnabled(): boolean {
    return this.inputEnabled;
  }

  private inputExtension(): Extension {
    return [
      EditorView.editable.of(this.inputEnabled),
      EditorState.readOnly.of(!this.inputEnabled),
    ];
  }

  /** Make the current state's editable facet match inputEnabled. */
  private syncInputFacet(): void {
    if (this.view.state.facet(EditorView.editable) === this.inputEnabled) return;
    this.view.dispatch({ effects: this.inputCompartment.reconfigure(this.inputExtension()) });
  }

  /** Retain full EditorStates (undo history, cursor, folds) for at most this
   *  many background tabs. Tab *content* lives in TabManager regardless —
   *  eviction only costs history/cursor on tabs untouched the longest. */
  private static readonly MAX_CACHED_STATES = 20;

  saveStateFor(tabId: string): void {
    // Re-insert to make this the most recently used entry (Map preserves
    // insertion order), then evict from the least recently used end.
    this.states.delete(tabId);
    this.states.set(tabId, this.view.state);
    while (this.states.size > EditorManager.MAX_CACHED_STATES) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
  }

  restoreStateFor(tabId: string): boolean {
    const state = this.states.get(tabId);
    if (!state) return false;
    // Refresh recency so hot tabs survive eviction.
    this.states.delete(tabId);
    this.states.set(tabId, state);
    this.view.setState(state);
    // A cached state carries the input setting of when it was saved.
    this.syncInputFacet();
    return true;
  }

  forgetState(tabId: string): void {
    this.states.delete(tabId);
  }

  /**
   * Adopt `text` as the document via a transaction rather than setState, so the
   * undo history survives and the cursor/scroll position is kept — used when a
   * clean tab's file changes on disk (reload-from-disk) and we shouldn't yank
   * the reader's place or throw away their undo stack. Selection offsets are
   * clamped to the new length; scroll is restored after the doc swap. Fires
   * docChanged, so the app recomputes preview/TOC/modified as usual.
   */
  replaceContentPreservingView(text: string): void {
    const state = this.view.state;
    if (state.doc.toString() === text) return;
    const { anchor, head } = state.selection.main;
    const scrollTop = this.view.scrollDOM.scrollTop;
    this.view.dispatch({
      changes: { from: 0, to: state.doc.length, insert: text },
      selection: {
        anchor: Math.min(anchor, text.length),
        head: Math.min(head, text.length),
      },
      scrollIntoView: false,
    });
    // The whole-doc replacement resets the scroller; put the reader back.
    this.view.scrollDOM.scrollTop = scrollTop;
  }
}

/** Empty-buffer hint. Names the real shortcuts-dialog key for this platform
 *  (it used to say "⌘/" everywhere, which was never bound). */
export function editorPlaceholder(mac?: boolean): string {
  return `Start writing…  (${shortcutFor(ACTIONS.SHOW_SHORTCUTS, mac)} for shortcuts)`;
}
