import type { Tab } from '../tabs';
import type { DefaultViewMode } from '../types/DefaultViewMode';
import { ViewControl } from '../view-control';
import {
  availableViews,
  defaultViewFromConfig,
  effectiveView,
  type ViewMode,
} from '../view-mode';
import { isPreviewable } from '../utils';
import type { AppContext } from './context';
import type { PaneController } from './panes';
import type { DiffController } from './diff';

/** What the view controller needs from its siblings. */
export interface ViewModeDeps {
  panes: Pick<PaneController, 'applyView' | 'focusEditor'>;
  diff: Pick<DiffController, 'showDiffForTab' | 'hideDiffPane' | 'hasChanges'>;
}

/**
 * The active document's view — Edit | Split | Preview | Diff — one per tab.
 * Owns the title bar control and the default view for new tabs (persisted as
 * AppConfig.default_view_mode: the last Edit / Split / Preview picked).
 * Every change goes through setViewMode, so the panes can only ever be in
 * one of the four layouts.
 */
export class ViewModeController {
  private control: ViewControl;
  private defaultMode: DefaultViewMode;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: ViewModeDeps,
  ) {
    this.control = new ViewControl(ctx.bus);
    this.defaultMode = defaultViewFromConfig(ctx.config);
    ctx.tabs.setDefaultViewMode(this.defaultMode);
  }

  init(): void {
    this.control.init(document.getElementById('view-mode'));
    this.refreshControl();
  }

  /** The view new tabs open in (persisted by the App). */
  getDefaultMode(): DefaultViewMode {
    return this.defaultMode;
  }

  /** What the active tab shows, or null with no tab. */
  current(): ViewMode | null {
    const tab = this.ctx.tabs.activeTab();
    return tab ? effectiveView(tab.viewMode, tab.path) : null;
  }

  /**
   * Switch the active tab to `mode` (control, ⌘1–⌘4, View menu). Ignored
   * when the file can't show it: no preview for its type, or Diff without
   * git changes. Picking Edit / Split / Preview also makes it the default
   * for tabs opened from now on.
   */
  setViewMode(mode: ViewMode): void {
    const tab = this.ctx.tabs.activeTab();
    if (!tab) return;
    const current = effectiveView(tab.viewMode, tab.path);
    if (mode === current) return;
    const available = availableViews(tab.path, this.deps.diff.hasChanges(tab));
    if (!available[mode]) return;
    this.ctx.tabs.setActiveViewMode(mode);
    // Only a real choice among Edit / Split / Preview (a previewable file)
    // sets the default; leaving Diff on a .rs file must not reset it to Edit.
    if (mode !== 'diff' && isPreviewable(tab.path) && mode !== this.defaultMode) {
      this.defaultMode = mode;
      this.ctx.tabs.setDefaultViewMode(mode);
      this.ctx.config.default_view_mode = mode;
      this.ctx.config.preview_visible = mode !== 'edit';
      this.ctx.saveConfigSoon();
    }
    this.applyToActive({ focus: true });
  }

  /** Old "Toggle Preview": Split ⇄ Edit (Preview-only → Edit). */
  togglePreview(): void {
    const view = this.current();
    if (view === null || view === 'diff') return;
    this.setViewMode(view === 'edit' ? 'split' : 'edit');
  }

  /** Old "Toggle Editor": Split ⇄ Preview (Edit-only → Preview). */
  toggleEditor(): void {
    const view = this.current();
    if (view === null || view === 'diff') return;
    this.setViewMode(view === 'preview' ? 'split' : 'preview');
  }

  /**
   * Lay the active tab out for its view: the diff pane over the editor area
   * for Diff, else the editor / preview panes. The buffer stays loaded
   * underneath the diff so going back to editing is instant. Called by the
   * tab-switch pipeline and after a view change.
   */
  applyToActive(opts: { focus?: boolean } = {}): void {
    const tab = this.ctx.tabs.activeTab();
    if (!tab) {
      this.refreshControl();
      return;
    }
    const view = effectiveView(tab.viewMode, tab.path);
    this.deps.panes.applyView(view);
    if (view === 'diff') {
      void this.deps.diff.showDiffForTab(tab);
    } else {
      this.deps.diff.hideDiffPane();
      if (opts.focus && view !== 'preview') this.deps.panes.focusEditor();
    }
    this.refreshControl();
  }

  /** Re-render the control: the active view, and which views are available
   *  (Diff follows the git status). */
  refreshControl(): void {
    const tab = this.ctx.tabs.activeTab();
    if (!tab) {
      this.control.render(null, null);
      return;
    }
    this.control.render(
      effectiveView(tab.viewMode, tab.path),
      availableViews(tab.path, this.deps.diff.hasChanges(tab)),
    );
  }

  /** Is `tab` showing its diff? */
  static isDiff(tab: Tab | null): boolean {
    return !!tab && effectiveView(tab.viewMode, tab.path) === 'diff';
  }
}
