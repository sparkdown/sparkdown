import type { EventBus } from './events';
import { EVENTS } from './event-names';

/**
 * The chrome focus mode hides: everything around the editor/preview card.
 * The terminal drawer counts as chrome except in the terminals-only layout,
 * where the terminals are the content.
 */
const CHROME = '#activity-bar, #sidebar, #sidebar-resize-handle, #status-bar, #terminal-panel, #terminal-resize-handle';

/** Open UI that owns Escape while it is shown. */
const OVERLAYS = '[role="dialog"], .sd-ctxmenu, .cm-tooltip-autocomplete';

/** The class on <html> that the focus-mode CSS keys off. */
export const FOCUS_MODE_CLASS = 'focus-mode';

export interface FocusModeDeps {
  bus: EventBus;
  /** Move keyboard focus to the editor (or preview) pane. */
  focusContent(): void;
}

/**
 * Focus mode: hides the sidebar, activity bar, tab strip, status bar and
 * terminal drawer so only the document is left, and Escape or the toggle
 * brings them back.
 *
 * It only adds a class to <html>; it never changes the sidebar, terminal,
 * split or view state underneath, so leaving it shows exactly the layout
 * from before. Actions that would change hidden chrome (Toggle Sidebar,
 * Toggle Terminal, the activity bar views) leave focus mode first, and so
 * does keyboard focus landing in hidden chrome. Not persisted: each launch
 * starts with the normal layout.
 */
export class FocusMode {
  private active = false;
  /** An overlay was open when the current Escape started (capture phase). */
  private overlayAtKeydown = false;

  constructor(
    private readonly deps: FocusModeDeps,
    private readonly root: HTMLElement = document.documentElement,
  ) {}

  init(): void {
    // Capture: note whether a dialog, context menu or completion list is
    // open before its own Escape handler closes it. Bubble: act only if
    // nothing else used the Escape.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.overlayAtKeydown = !!document.querySelector(OVERLAYS);
    }, true);
    document.addEventListener('keydown', (e) => this.onKeydown(e));
    document.addEventListener('focusin', (e) => this.onFocusIn(e));
  }

  isActive(): boolean {
    return this.active;
  }

  toggle(): void {
    if (this.active) this.exit();
    else this.enter();
  }

  enter(): void {
    if (this.active) return;
    this.set(true);
    // Focus left inside the sidebar or terminal would type into hidden UI.
    const focused = document.activeElement;
    if (focused instanceof Element && this.inHiddenChrome(focused)) this.deps.focusContent();
  }

  /** Leave focus mode. True if it was on (the caller's key press is used up). */
  exit(): boolean {
    if (!this.active) return false;
    this.set(false);
    return true;
  }

  private set(on: boolean): void {
    this.active = on;
    this.root.classList.toggle(FOCUS_MODE_CLASS, on);
    this.deps.bus.emit(EVENTS.FOCUS_MODE_CHANGED, { active: on });
  }

  /** True for an element inside chrome that focus mode is hiding. */
  private inHiddenChrome(el: Element): boolean {
    const chrome = el.closest(CHROME);
    if (!chrome) return false;
    const terminalsOnly = document.getElementById('center-column')?.classList.contains('terminals-only');
    return !(terminalsOnly && (chrome.id === 'terminal-panel' || chrome.id === 'terminal-resize-handle'));
  }

  private onKeydown(e: KeyboardEvent): void {
    if (!this.active || e.key !== 'Escape' || e.isComposing) return;
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    // Escape closes an open dialog, menu or find bar first.
    if (this.overlayAtKeydown || document.querySelector(OVERLAYS)) return;
    const target = e.target as Element | null;
    if (target?.closest?.('input, textarea, select, .cm-panels')) return;
    e.preventDefault();
    this.exit();
  }

  private onFocusIn(e: FocusEvent): void {
    if (!this.active) return;
    const target = e.target;
    if (target instanceof Element && this.inHiddenChrome(target)) this.exit();
  }
}
