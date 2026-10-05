/**
 * Shared drag-to-resize wiring for panel gutters (sidebar, editor/preview,
 * terminal drawer). The dark margin between rounded panels is the hit-target
 * (no accent-bar chrome). Suppresses text selection behind the handle for the
 * duration of the drag — welcome copy and editor content used to highlight
 * while the terminal gutter was pulled.
 */
export type ResizeDragHandlers = {
  /** Capture start geometry; runs synchronously on primary-button mousedown. */
  onStart?: (e: MouseEvent) => void;
  /** Called on each mousemove while dragging. */
  onMove: (e: MouseEvent) => void;
  /** Called once on mouseup after listeners are cleared. */
  onEnd?: () => void;
  /** Cursor applied to body for the drag (e.g. col-resize / row-resize). */
  cursor: string;
};

/**
 * Attach mousedown→drag→mouseup on a resize handle. Returns an unsubscribe
 * that removes the mousedown listener (tests / teardown).
 */
export function attachResizeDrag(
  handle: HTMLElement,
  handlers: ResizeDragHandlers,
): () => void {
  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    // Stop the browser from starting a text selection on the mousedown that
    // begins the drag (welcome tagline was a frequent victim).
    e.preventDefault();
    handlers.onStart?.(e);

    const onMove = (ev: MouseEvent) => {
      ev.preventDefault();
      handlers.onMove(ev);
    };
    const onSelectStart = (ev: Event) => {
      ev.preventDefault();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('selectstart', onSelectStart);
      document.body.classList.remove('is-resizing');
      handle.classList.remove('is-active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handlers.onEnd?.();
    };

    document.body.classList.add('is-resizing');
    handle.classList.add('is-active');
    document.body.style.cursor = handlers.cursor;
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('selectstart', onSelectStart);
  };

  handle.addEventListener('mousedown', onMouseDown);
  return () => handle.removeEventListener('mousedown', onMouseDown);
}
