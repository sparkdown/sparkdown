import type { EventCallback } from '@tauri-apps/api/event';
import type { EventBus } from './events';
import type { FileTree } from './file-tree';
import { ACTIONS, EVENTS, MENU } from './event-names';
import { isMacOS } from './utils';

/** The views the activity bar can show in the sidebar. */
export type SidebarView = 'files' | 'changes' | 'search';

export const SIDEBAR_VIEWS: readonly SidebarView[] = ['files', 'changes', 'search'];

/** A persisted (or otherwise untrusted) value as a view; unknown → Files. */
export function parseSidebarView(value: unknown): SidebarView {
  return SIDEBAR_VIEWS.includes(value as SidebarView) ? (value as SidebarView) : 'files';
}

/** Label and shortcut letter (with Cmd/Ctrl+Shift) per view. */
const VIEW_INFO: Record<SidebarView, { label: string; key: string }> = {
  files: { label: 'Files', key: 'E' },
  changes: { label: 'Changes', key: 'G' },
  search: { label: 'Search in files', key: 'F' },
};

const MENU_FOR_VIEW: Record<SidebarView, string> = {
  files: MENU.SHOW_FILES,
  changes: MENU.SHOW_CHANGES,
  search: MENU.SEARCH_IN_FILES,
};

/** The view's accelerator ("CmdOrCtrl+Shift+E"), as in menu.rs. */
export function viewAccelerator(view: SidebarView): string {
  return `CmdOrCtrl+Shift+${VIEW_INFO[view].key}`;
}

/** "⌘⇧E" on macOS, "Ctrl+Shift+E" elsewhere. */
export function viewShortcutLabel(view: SidebarView): string {
  const key = VIEW_INFO[view].key;
  return isMacOS() ? `⌘⇧${key}` : `Ctrl+Shift+${key}`;
}

export interface ActivityBarDeps {
  bus: EventBus;
  /** Sidebar visibility lives on the file tree (config: sidebar_visible). */
  sidebar: Pick<FileTree, 'isVisible' | 'setVisible'>;
  /** The sidebar now shows `view`, or nothing (null: the sidebar closed). */
  onViewChange(view: SidebarView | null): void;
  /** The user asked for `view` (click or shortcut): move focus into it. */
  focusView(view: SidebarView): void;
  /** True if keyboard focus is inside `view`. */
  hasFocus(view: SidebarView): boolean;
  saveConfigSoon(): void;
  listenTauri<T>(event: string, handler: EventCallback<T>): void;
}

/**
 * The activity bar left of the sidebar (docs/ui-revamp, decision 1): Files,
 * Changes (with a count badge) and Search in files, plus Remote and Settings
 * at the bottom. Clicking a view opens the sidebar on it; clicking the active
 * view closes the sidebar. The sidebar toggle (⌘⇧B, View → Toggle
 * Sidebar) keeps working: it opens the sidebar on the last view.
 */
export class ActivityBar {
  private view: SidebarView;
  private changeCount = 0;
  private wasVisible: boolean;

  constructor(
    private readonly deps: ActivityBarDeps,
    initialView: SidebarView,
  ) {
    this.view = initialView;
    this.wasVisible = deps.sidebar.isVisible();
  }

  init(): void {
    const bar = document.getElementById('activity-bar');
    for (const btn of bar?.querySelectorAll<HTMLElement>('[data-view]') ?? []) {
      const view = parseSidebarView(btn.dataset.view);
      btn.addEventListener('click', () => this.request(view, 'click'));
    }
    document
      .getElementById('act-remote')
      ?.addEventListener('click', () => this.deps.bus.emit(ACTIONS.OPEN_REMOTE));
    document
      .getElementById('act-settings')
      ?.addEventListener('click', () => this.deps.bus.emit(ACTIONS.SHOW_SETTINGS));
    const settings = document.getElementById('act-settings');
    if (settings) settings.title = `Settings (${isMacOS() ? '⌘,' : 'Ctrl+,'})`;

    this.deps.bus.on(ACTIONS.SHOW_SIDEBAR_VIEW, ({ view }) => this.request(view, 'click'));
    // The sidebar toggle, Open Folder (ensureVisible) and the activity bar
    // all end here: re-render, and load the view if the sidebar just opened.
    this.deps.bus.on(EVENTS.SIDEBAR_TOGGLED, ({ visible }) => {
      const changed = visible !== this.wasVisible;
      this.wasVisible = visible;
      this.render();
      if (changed) this.deps.onViewChange(visible ? this.view : null);
    });

    // macOS: the native View menu owns these accelerators (they fire even
    // while the terminal has focus). Windows/Linux have no menu bar, so the
    // keys are handled here, in the capture phase: before CodeMirror (which
    // binds Shift+Mod+G to "find previous") and before the terminal.
    for (const view of SIDEBAR_VIEWS) {
      this.deps.listenTauri(MENU_FOR_VIEW[view], () => this.request(view, 'shortcut'));
    }
    window.addEventListener('keydown', (e) => this.onKeydown(e), true);

    this.render();
    if (this.deps.sidebar.isVisible()) this.deps.onViewChange(this.view);
  }

  getView(): SidebarView {
    return this.view;
  }

  /** Badge on Changes: files not yet reviewed (0 hides it). */
  setChangeCount(count: number): void {
    this.changeCount = Math.max(0, count);
    this.render();
  }

  /**
   * A view was asked for. Click semantics: open the sidebar on it, or close
   * the sidebar if it already shows that view. A shortcut for a view that is
   * showing but not focused moves focus into it instead of closing.
   */
  request(view: SidebarView, source: 'click' | 'shortcut'): void {
    const visible = this.deps.sidebar.isVisible();
    if (visible && view === this.view) {
      if (source === 'shortcut' && !this.deps.hasFocus(view)) {
        this.deps.focusView(view);
        return;
      }
      this.deps.sidebar.setVisible(false);
      return;
    }
    const changed = view !== this.view;
    this.view = view;
    if (!visible) {
      // SIDEBAR_TOGGLED re-renders and calls onViewChange.
      this.deps.sidebar.setVisible(true);
    } else {
      this.render();
      this.deps.onViewChange(view);
    }
    if (view === 'search') this.deps.focusView(view);
    if (changed) this.deps.saveConfigSoon();
  }

  private onKeydown(e: KeyboardEvent): void {
    if (isMacOS()) return; // the native menu handles these (see init)
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    const view = SIDEBAR_VIEWS.find((v) => VIEW_INFO[v].key.toLowerCase() === key);
    if (!view) return;
    // Ctrl+Shift+E is also "split down" while a terminal pane has focus
    // (Windows/Linux pane keys, terminal.ts). The focused context wins, as in
    // VS Code: let the terminal have it. Files stays reachable from the
    // activity bar, the palette and the View menu.
    const target = e.target as Element | null;
    if (key === 'e' && target?.closest?.('#terminal-host')) return;
    e.preventDefault();
    e.stopPropagation();
    this.request(view, 'shortcut');
  }

  /** Sync buttons (pressed state, tooltips, badge) and the sidebar sections. */
  private render(): void {
    const visible = this.deps.sidebar.isVisible();
    for (const view of SIDEBAR_VIEWS) {
      const active = visible && view === this.view;
      const btn = document.querySelector<HTMLElement>(`#activity-bar [data-view="${view}"]`);
      if (btn) {
        btn.setAttribute('aria-pressed', String(active));
        const { label } = VIEW_INFO[view];
        const shortcut = viewShortcutLabel(view);
        if (view === 'changes' && this.changeCount > 0) {
          const files = `${this.changeCount} ${this.changeCount === 1 ? 'file' : 'files'} to review`;
          btn.title = `${label} (${shortcut}) — ${files}`;
          btn.setAttribute('aria-label', `${label}, ${files}`);
        } else {
          btn.title = `${label} (${shortcut})`;
          btn.setAttribute('aria-label', label);
        }
      }
      const section = document.getElementById(`sidebar-${view}`);
      if (section) section.hidden = view !== this.view;
    }
    const badge = document.getElementById('changes-badge');
    if (badge) {
      badge.hidden = this.changeCount === 0;
      badge.textContent = this.changeCount > 99 ? '99+' : String(this.changeCount);
    }
    document.getElementById('sidebar')?.setAttribute('aria-label', VIEW_INFO[this.view].label);
  }
}
