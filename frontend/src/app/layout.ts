import { getCurrentWindow } from '@tauri-apps/api/window';
import type { FileTree } from '../file-tree';
import type { Titlebar } from '../titlebar';
import { LAYOUT } from '../constants';
import { attachResizeDrag } from '../resize-drag';

/**
 * Window chrome and pane-size plumbing that has no state of its own: the
 * editor/preview split handle, the sidebar width handle and title bar window
 * dragging. (The terminal drawer's height handle
 * lives with the terminal in cockpit.ts.)
 */

/** Drag-to-resize the editor/preview split. */
export function initResizeHandle(): void {
  const handle = document.getElementById('resize-handle');
  const editorContainer = document.getElementById('editor-container');
  const editorArea = document.getElementById('editor-area');
  if (!handle || !editorContainer || !editorArea) return;

  let startX = 0;
  let startWidth = 0;

  attachResizeDrag(handle, {
    cursor: 'col-resize',
    onStart: (e) => {
      startX = e.clientX;
      startWidth = editorContainer.clientWidth;
    },
    onMove: (e) => {
      const dx = e.clientX - startX;
      const newWidth = Math.max(200, Math.min(startWidth + dx, editorArea.clientWidth - 200));
      editorContainer.style.width = `${newWidth}px`;
      editorContainer.style.flex = 'none';
    },
  });
}

/** Drag-to-resize the explorer sidebar width (persisted via sidebar_width). */
export function initSidebarResize(fileTree: FileTree, onEnd: () => void): void {
  const handle = document.getElementById('sidebar-resize-handle');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;

  let startX = 0;
  let startWidth = 0;

  attachResizeDrag(handle, {
    cursor: 'col-resize',
    onStart: (e) => {
      startX = e.clientX;
      startWidth = fileTree.getWidth() || sidebar.getBoundingClientRect().width;
    },
    onMove: (e) => {
      const dx = e.clientX - startX;
      const max = Math.min(
        LAYOUT.SIDEBAR_MAX_PX,
        Math.max(LAYOUT.SIDEBAR_MIN_PX, window.innerWidth - 320),
      );
      const width = Math.max(LAYOUT.SIDEBAR_MIN_PX, Math.min(startWidth + dx, max));
      fileTree.setWidth(width);
    },
    onEnd,
  });
}

export function initToolbarDrag(titlebar: Titlebar): void {
  const toolbar = document.getElementById('toolbar');
  if (!toolbar) return;

  toolbar.addEventListener('mousedown', (e) => {
    const target = e.target as HTMLElement;
    // Interactive toolbar contents must handle their own clicks; everything
    // else (bare toolbar chrome AND the empty area of the tab strip) drags
    // the window. Only an actual tab card intercepts — so the wide empty
    // stretch where tabs would be stays draggable.
    if (
      target.closest('button') ||
      target.closest('.view-seg') ||
      target.closest('.toolbar-separator') ||
      target.closest('.tab')
    )
      return;
    // detail > 1 is the 2nd+ click of a double/triple-click. Starting a drag
    // here would steal the gesture from the dblclick → Zoom/maximize handler.
    if (e.detail > 1) return;
    e.preventDefault();
    getCurrentWindow().startDragging();
  });
  toolbar.addEventListener('dblclick', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('.view-seg') || target.closest('.tab')) return;
    void titlebar.onChromeDoubleClick();
  });
}
