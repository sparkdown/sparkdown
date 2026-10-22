/**
 * The webview's own right-click menu (Reload, Back, Inspect, Save As…) is
 * not part of SparkDown: block it everywhere except where text is edited
 * (text inputs, textareas, contenteditable, the CodeMirror editor and the
 * terminal's input), which keep the native Cut / Copy / Paste menu. Our own
 * menus (explorer, tabs…) call preventDefault themselves and show
 * .sd-ctxmenu instead.
 */
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'password', 'tel', 'number']);

export function keepsNativeMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('.cm-editor, textarea, [contenteditable=""], [contenteditable="true"]')) return true;
  const input = target.closest('input');
  return !!input && TEXT_INPUT_TYPES.has((input.getAttribute('type') || '').toLowerCase());
}

export function installContextMenuGuard(doc: Document = document): void {
  doc.addEventListener('contextmenu', (e) => {
    if (!keepsNativeMenu(e.target)) e.preventDefault();
  });
}
