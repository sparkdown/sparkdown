/**
 * Shared modal behaviour for overlay dialogs (remote picker, remote folder,
 * settings, shortcuts):
 *
 * - the app root (`#app`) gets `inert` while a modal is open, so Tab, clicks
 *   and screen readers cannot reach CodeMirror / the terminal behind it;
 * - Tab / Shift+Tab wrap inside the dialog;
 * - on release, focus returns to the element that had it before opening.
 *
 * Modals may nest (a picker over the remote dialog): `inert` is removed only
 * when the last open modal releases.
 */

const FOCUSABLE = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[tabindex]',
  '[contenteditable="true"]',
].join(',');

let openCount = 0;

export interface ModalHandle {
  /** Undo everything trapFocus did. Safe to call more than once. */
  release(): void;
}

/** Tab-reachable elements inside `dialog`, in DOM order. */
export function focusableIn(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.tabIndex < 0) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    if (el.closest('.hidden, [hidden], [inert]')) return false;
    if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
    return true;
  });
}

/** Make `dialog` modal. Call `release()` on every close path. */
export function trapFocus(dialog: HTMLElement): ModalHandle {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const root = document.getElementById('app');
  const inertRoot = root && !root.contains(dialog) ? root : null;
  if (inertRoot) {
    openCount++;
    inertRoot.setAttribute('inert', '');
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
    const items = focusableIn(dialog);
    e.preventDefault();
    if (items.length === 0) {
      dialog.focus();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? items.indexOf(active) : -1;
    let next: number;
    if (idx < 0) next = e.shiftKey ? items.length - 1 : 0;
    else next = (idx + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  };
  dialog.addEventListener('keydown', onKeyDown);

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      dialog.removeEventListener('keydown', onKeyDown);
      if (inertRoot) {
        openCount = Math.max(0, openCount - 1);
        if (openCount === 0) inertRoot.removeAttribute('inert');
      }
      if (previous && previous.isConnected && !previous.closest('[inert]')) {
        previous.focus({ preventScroll: true });
      }
    },
  };
}

/** Test hook: reset the nesting counter. */
export function resetModalStateForTests(): void {
  openCount = 0;
}
