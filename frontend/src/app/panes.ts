import { message } from '@tauri-apps/plugin-dialog';
import type { PreviewPane } from '../preview';
import type { Tab } from '../tabs';
import { PreviewSearch } from '../preview-search';
import { EVENTS } from '../event-names';
import type { ViewMode } from '../view-mode';
import { isMarkdownFile, isPreviewable, buildScrollMap, mapLineToY } from '../utils';
import type { AppContext } from './context';
import { syncEditorInput } from './editor-gate';

/** What the pane controller needs from its siblings. */
export interface PaneDeps {
  /** Script trust for the active framed file (html-scripts.ts). */
  scriptsAllowedForActive(): boolean;
  applyScriptsPolicy(): void;
  /** Follow a local link clicked in the preview. */
  openFile(path: string): void;
  /** Find in the diff pane when it is on screen; false when it is not. */
  openDiffFind(): boolean;
}

/**
 * The editor/preview split: the lazily-loaded preview pane, the pane layout
 * of the active document's view (Edit / Split / Preview — see
 * ViewModeController, which decides the view), editor↔preview scroll sync,
 * and which pane Cmd+F targets.
 */
export class PaneController {
  private pane: PreviewPane | null = null;
  private previewLoading: Promise<PreviewPane> | null = null;
  /** The pane layout on screen. Diff lays out like Split underneath (the
   *  diff pane covers both); only Edit and Preview hide a pane. */
  private view: ViewMode = 'split';
  private previewSearch: PreviewSearch | null = null;
  // Which pane Cmd+F should target. Set on focus/click within each pane.
  private lastFocusedPane: 'editor' | 'preview' = 'editor';

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: PaneDeps,
  ) {}

  /** The preview pane, or null until something first needed it. */
  get preview(): PreviewPane | null {
    return this.pane;
  }

  /** The preview pane is part of the layout (Split or Preview). */
  isPreviewVisible(): boolean {
    return this.view === 'split' || this.view === 'preview';
  }

  isEditorVisible(): boolean {
    return this.view !== 'preview';
  }

  registerScrollSync(): void {
    // Directional sync lock. Programmatic scrolls are echo-suppressed for
    // only two frames, but momentum scrolling outlasts that — so the pane
    // being synced would fire its own sync back and the two panes fight
    // (visible as jitter). Whichever pane the user is actively scrolling
    // owns the sync; the other pane's events are ignored until the owner
    // has been quiet for a beat.
    let syncOwner: 'editor' | 'preview' | null = null;
    let syncOwnerUntil = 0;
    const claimSync = (who: 'editor' | 'preview'): boolean => {
      const now = performance.now();
      if (syncOwner && syncOwner !== who && now < syncOwnerUntil) return false;
      syncOwner = who;
      syncOwnerUntil = now + 250;
      return true;
    };

    this.ctx.bus.on(EVENTS.SCROLL_SYNC, (data) => {
      if (!this.pane || !claimSync('editor')) return;
      this.syncScroll('editor', data.scrollRatio);
    });

    this.ctx.bus.on(EVENTS.PREVIEW_SCROLL, (data) => {
      if (!claimSync('preview')) return;
      this.syncScroll('preview', data.scrollRatio);
    });
  }

  /**
   * Track which pane (editor vs preview) most recently had focus, so Cmd+F /
   * the Find menu opens search in that pane. We also intercept Cmd+F at the
   * document level — but only route it to the preview when the preview is the
   * active pane; otherwise we let it fall through to CodeMirror's own handler.
   */
  initPaneFocusTracking(): void {
    const previewContainer = document.getElementById('preview-container');
    const editorArea = document.getElementById('editor-container');
    // Track last-clicked pane as a hint. For the iframe (HTML/SVG preview), a
    // click moves focus INTO the iframe so document.activeElement becomes the
    // <iframe> — openFind() reads that directly, which is more reliable than
    // these listeners (the sandboxed iframe doesn't forward its own events).
    previewContainer?.addEventListener('mousedown', () => { this.lastFocusedPane = 'preview'; });
    editorArea?.addEventListener('mousedown', () => { this.lastFocusedPane = 'editor'; });
    editorArea?.addEventListener('focusin', () => { this.lastFocusedPane = 'editor'; });
  }

  /**
   * Find (⌘F via the native menu accelerator, which fires regardless of which
   * pane/iframe has focus). Route to the preview when it's the active surface:
   * either the preview iframe currently holds focus (activeElement), or the
   * last click was in the preview pane.
   */
  openFind(): void {
    // Diff covers the editor/preview split: find searches the diff.
    if (this.deps.openDiffFind()) return;
    const active = document.activeElement;
    const inPreviewIframe = active instanceof HTMLIFrameElement
      && !!active.closest('#preview-container');
    // Preview-only has no editor to search: find goes to the preview.
    const wantPreview =
      this.isPreviewVisible() &&
      (inPreviewIframe || this.lastFocusedPane === 'preview' || !this.isEditorVisible());
    if (wantPreview) {
      void this.openPreviewFind();
    } else {
      this.ctx.editor.openSearch();
    }
  }

  /** Open find-only search over the current preview surface. */
  private async openPreviewFind(): Promise<void> {
    const preview = this.pane ?? await this.loadPreview();
    const root = preview.getSearchRoot();
    if (!root) {
      // Scripts-on HTML preview is cross-origin and can't be searched.
      await message('Find is unavailable while JavaScript is enabled in the HTML preview.', {
        title: 'Find in Preview',
        kind: 'info',
      });
      return;
    }
    const container = document.getElementById('preview-container');
    if (!container) return;
    if (!this.previewSearch) this.previewSearch = new PreviewSearch(container);
    this.previewSearch.open(root);
  }

  /**
   * Content-anchored scroll sync: heading landmarks pair the editor's line
   * geometry with the preview's rendered h1–h6 offsets into a monotone
   * scrollTop→scrollTop map (endpoints pinned, so top and bottom coincide
   * exactly). Interpolating a monotone map can never scroll the target pane
   * opposite to the source. Falls back to proportional sync when heading
   * pairing isn't possible (no headings, setext/quoted headings, mismatch).
   */
  private syncScroll(from: 'editor' | 'preview', ratio: number): void {
    const target = from === 'editor' ? this.pane : this.ctx.editor;
    if (!target) return;

    const sourceLines = this.ctx.editor.headingSourceLines();
    const previewOffsets =
      sourceLines.length > 0 ? this.pane?.headingOffsets(sourceLines.length) : null;
    if (!previewOffsets || !this.pane) {
      target.scrollToRatio(ratio);
      return;
    }
    const editorOffsets = this.ctx.editor.headingOffsets(sourceLines);
    const ed = this.ctx.editor.scrollMetrics();
    const pv = this.pane.scrollMetrics();
    if (ed.maxScroll <= 0 || pv.maxScroll <= 0) {
      target.scrollToRatio(ratio);
      return;
    }

    if (from === 'editor') {
      const map = buildScrollMap(editorOffsets, previewOffsets, ed.maxScroll, pv.maxScroll);
      this.pane.scrollToTop(mapLineToY(map, ed.scrollTop));
    } else {
      const map = buildScrollMap(previewOffsets, editorOffsets, pv.maxScroll, ed.maxScroll);
      this.ctx.editor.scrollToTop(mapLineToY(map, pv.scrollTop));
    }
  }

  loadPreview(): Promise<PreviewPane> {
    if (this.pane) return Promise.resolve(this.pane);
    if (this.previewLoading) return this.previewLoading;
    this.previewLoading = import('../preview').then(({ PreviewPane }) => {
      const p = new PreviewPane(this.ctx.bus);
      p.init(document.getElementById('preview-pane')!);
      p.initReverseScroll();
      p.setVisible(this.isPreviewVisible());
      p.setAllowScripts(this.deps.scriptsAllowedForActive());
      p.setDiagramsEnabled(this.ctx.config.enable_diagrams);
      // Focus + Cmd+F inside the preview iframe don't reach the parent doc;
      // forward them so pane-targeting and preview find work for HTML/SVG.
      p.setFrameCallbacks(
        () => { this.lastFocusedPane = 'preview'; },
        () => { this.lastFocusedPane = 'preview'; void this.openPreviewFind(); },
      );
      p.setOpenFileHandler((path) => { void this.deps.openFile(path); });
      // Remote tabs' images come over SSH, never from local asset:// paths.
      p.setOriginResolver(() => {
        const tab = this.ctx.tabs.activeTab();
        return tab ? tab.origin : this.ctx.tabs.getOrigin();
      });
      if (this.ctx.baseDir) p.setBaseDir(this.ctx.baseDir);
      this.pane = p;
      return p;
    });
    return this.previewLoading;
  }

  async renderPreview(content: string): Promise<void> {
    const p = this.pane ?? await this.loadPreview();
    p.setRenderMode(this.ctx.tabs.activeTab()?.path ?? null);
    p.render(content);
  }

  /** Re-render mermaid diagrams for a theme switch (only when some are shown). */
  rerenderForTheme(theme: 'light' | 'dark'): void {
    const content = this.ctx.editor.getContent();
    if (this.ctx.config.enable_diagrams && content.includes('```mermaid')) {
      if (this.pane) {
        this.pane.notifyThemeChanged(theme);
        void this.pane.rerenderForTheme(content);
      } else {
        void this.loadPreview().then((p) => {
          p.notifyThemeChanged(theme);
          void p.rerenderForTheme(content);
        });
      }
    }
  }

  /**
   * Lay the panes out for `view` (ViewModeController has already coerced it
   * to what the active file supports). Diff keeps the split underneath; the
   * diff pane covers the whole editor area. Showing the preview re-renders
   * it so it never shows another document's stale DOM.
   */
  applyView(view: ViewMode): void {
    if (this.layout(view)) {
      const tab = this.ctx.tabs.activeTab();
      if (tab && isPreviewable(tab.path)) void this.renderPreview(this.ctx.editor.getContent());
    }
  }

  /** Apply the pane layout; true when the preview just became visible. */
  private layout(view: ViewMode): boolean {
    const wasPreviewVisible = this.isPreviewVisible();
    this.view = view === 'diff' ? 'split' : view;
    const previewShown = this.isPreviewVisible();
    document.getElementById('preview-container')?.classList.toggle('hidden', !previewShown);
    this.pane?.setVisible(previewShown);
    document.getElementById('editor-container')?.classList.toggle('hidden', !this.isEditorVisible());
    // The drag-to-resize handle only makes sense with both panes shown.
    document.getElementById('resize-handle')?.classList.toggle('hidden', this.view !== 'split');
    if (!this.isEditorVisible()) this.lastFocusedPane = 'preview';
    // Preview-only hides the editor pane: it must not keep taking keys.
    syncEditorInput(this.ctx.editor);
    return previewShown && !wasPreviewVisible;
  }

  /**
   * Tab switch: refresh the outline, render the preview for a previewable
   * file, lay the panes out for the tab's view, and re-derive script trust.
   */
  applyPreviewForTab(tab: Tab, view: ViewMode): void {
    // TOC is markdown-specific; always refresh it so a non-markdown tab clears
    // any outline left over from a previously-open markdown file.
    this.ctx.toc.update(isMarkdownFile(tab.path) ? tab.content : '');
    this.layout(view);
    if (isPreviewable(tab.path)) {
      void this.renderPreview(tab.content);
    }
    // Re-derive script trust for the now-active file: a downloaded .html the
    // user never trusted must have scripts off even if the previous tab did.
    this.deps.applyScriptsPolicy();
  }

  /** Point relative links in the preview at `dir`. */
  setBaseDir(dir: string): void {
    this.pane?.setBaseDir(dir);
  }

  /** Close the preview-search widget; its highlights belong to the old
   *  document and its search root is about to be replaced. */
  closeSearch(): void {
    this.previewSearch?.close();
  }

  /** Focus the editor and make it Cmd+F's target. */
  focusEditor(): void {
    this.ctx.editor.focus();
    this.lastFocusedPane = 'editor';
  }
}
