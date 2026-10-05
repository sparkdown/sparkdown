import type { EventBus } from './events';
import { ACTIONS } from './event-names';
import { isMacOS } from './utils';
import { VIEW_LABELS, VIEW_MODES, type ViewAvailability, type ViewMode } from './view-mode';

const HINTS: Record<ViewMode, string> = {
  edit: 'Edit only',
  split: 'Edit and preview',
  preview: 'Preview only',
  diff: 'Changes in this file',
};

const UNAVAILABLE: Record<ViewMode, string> = {
  edit: '',
  split: 'No preview for this file type',
  preview: 'No preview for this file type',
  diff: 'No git changes in this file',
};

/**
 * The title bar's per-document view control: `Edit | Split | Preview | Diff`
 * (⌘1–⌘4). A segmented group of toggle buttons; the pressed one is the active
 * tab's view, views the document can't show are disabled, and the whole
 * control hides while no document is open. Clicks go out on the bus as
 * ACTIONS.SET_VIEW_MODE; ViewModeController owns the state.
 */
export class ViewControl {
  private root: HTMLElement | null = null;
  private buttons = new Map<ViewMode, HTMLButtonElement>();

  constructor(private readonly bus: EventBus) {}

  init(root: HTMLElement | null): void {
    this.root = root;
    if (!root) return;
    const mod = isMacOS() ? '⌘' : 'Ctrl+';
    for (const btn of root.querySelectorAll<HTMLButtonElement>('button[data-view]')) {
      const mode = btn.dataset.view as ViewMode;
      if (!VIEW_MODES.includes(mode)) continue;
      btn.type = 'button';
      if (!btn.textContent?.trim()) btn.textContent = VIEW_LABELS[mode];
      btn.dataset.hint = `${HINTS[mode]} (${mod}${VIEW_MODES.indexOf(mode) + 1})`;
      btn.title = btn.dataset.hint;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (btn.getAttribute('aria-disabled') === 'true') return;
        this.bus.emit(ACTIONS.SET_VIEW_MODE, { mode });
      });
      this.buttons.set(mode, btn);
    }
  }

  /** Show `mode` as pressed and disable what isn't available; null hides
   *  the control (no document open). */
  render(mode: ViewMode | null, available: ViewAvailability | null): void {
    if (!this.root) return;
    this.root.hidden = mode === null;
    for (const [m, btn] of this.buttons) {
      const pressed = m === mode;
      // The pressed view stays enabled even if it just became unavailable
      // (a diff whose file was committed): it is what is on screen.
      const enabled = pressed || !!available?.[m];
      btn.setAttribute('aria-pressed', String(pressed));
      // aria-disabled (not `disabled`) so the tooltip still says why.
      btn.setAttribute('aria-disabled', String(!enabled));
      btn.title = enabled ? (btn.dataset.hint ?? '') : UNAVAILABLE[m];
    }
  }
}
