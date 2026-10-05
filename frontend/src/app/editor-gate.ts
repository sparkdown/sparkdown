import type { EditorManager } from '../editor';

/**
 * The editor takes input only while it is on screen. The buffer stays loaded
 * under the diff pane (Diff), beside a hidden editor pane (Preview-only) and
 * under the welcome screen, and a focused hidden CodeMirror would otherwise
 * take keystrokes and silently edit the document.
 *
 * Reads the layout from the DOM (#editor-area hidden: Diff / welcome;
 * #editor-container hidden: Preview-only), so every place that changes it
 * calls this afterwards: it makes the hidden part `inert` + aria-hidden and
 * turns the editor's input off (read-only, blurred) or back on.
 */
export function syncEditorInput(editor: Pick<EditorManager, 'setInputEnabled'>): void {
  const area = document.getElementById('editor-area');
  const container = document.getElementById('editor-container');
  const areaHidden = !area || area.classList.contains('hidden');
  const editorHidden = areaHidden || !container || container.classList.contains('hidden');
  setInert(area, areaHidden);
  setInert(container, editorHidden);
  editor.setInputEnabled(!editorHidden);
}

function setInert(el: HTMLElement | null, inert: boolean): void {
  if (!el) return;
  el.toggleAttribute('inert', inert);
  if (inert) el.setAttribute('aria-hidden', 'true');
  else el.removeAttribute('aria-hidden');
}
