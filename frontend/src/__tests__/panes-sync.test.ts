// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn() }));

import { PaneController } from '../app/panes';
import { EventBus } from '../events';
import { EVENTS } from '../event-names';
import type { AppContext } from '../app/context';

/** Editor and preview fakes with fixed geometry: both panes scroll 0..1000,
 *  editor lines are 10px apart, the preview's blocks are 20px per line. */
function harness() {
  const bus = new EventBus();
  let editorTop = 0;
  let previewTop = 0;
  const editor = {
    scrollMetrics: () => ({ scrollTop: editorTop, maxScroll: 1000 }),
    lineOffsets: vi.fn((lines: number[]) => lines.map((l) => (l - 1) * 10)),
    headingSourceLines: () => [],
    scrollToTop: vi.fn((t: number) => { editorTop = t; }),
    scrollToRatio: vi.fn(),
    revealLine: vi.fn(),
  };
  const anchors = { lines: [1, 11, 21], offsets: [0, 200, 400] };
  const pane = {
    sourceAnchors: () => anchors,
    headingOffsets: () => null,
    scrollMetrics: () => ({ scrollTop: previewTop, maxScroll: 1000 }),
    scrollToTop: vi.fn((t: number) => { previewTop = t; }),
    scrollToRatio: vi.fn(),
  };
  const ctx = { bus, editor } as unknown as AppContext;
  const panes = new PaneController(ctx, {
    scriptsAllowedForActive: () => false,
    applyScriptsPolicy: () => {},
    openFile: () => {},
    openDiffFind: () => false,
    resolveWikiLink: () => ({ kind: 'text', title: '' }),
    createWikiNote: () => {},
    workspaceRootChanged: () => {},
  });
  (panes as unknown as { pane: unknown }).pane = pane;
  panes.registerScrollSync();
  return {
    bus, editor, pane, panes,
    setEditorTop: (t: number) => { editorTop = t; },
    setPreviewTop: (t: number) => { previewTop = t; },
  };
}

describe('source-anchored scroll sync', () => {
  let now = 0;
  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  it('aligns the same source block in the preview when the editor scrolls', () => {
    const h = harness();
    h.setEditorTop(100); // line 11 at the top of the editor
    h.bus.emit(EVENTS.SCROLL_SYNC, { scrollRatio: 0.1 });
    expect(h.pane.scrollToTop).toHaveBeenLastCalledWith(200);
  });

  it('aligns the same source block in the editor when the preview scrolls', () => {
    const h = harness();
    h.setPreviewTop(400); // block from line 21 at the top of the preview
    h.bus.emit(EVENTS.PREVIEW_SCROLL, { scrollRatio: 0.4 });
    expect(h.editor.scrollToTop).toHaveBeenLastCalledWith(200);
  });

  it('ignores the other pane while one pane owns the sync', () => {
    const h = harness();
    h.setEditorTop(100);
    h.bus.emit(EVENTS.SCROLL_SYNC, { scrollRatio: 0.1 });
    now += 100;
    h.bus.emit(EVENTS.PREVIEW_SCROLL, { scrollRatio: 0.2 });
    expect(h.editor.scrollToTop).not.toHaveBeenCalled();
    now += 300;
    h.bus.emit(EVENTS.PREVIEW_SCROLL, { scrollRatio: 0.2 });
    expect(h.editor.scrollToTop).toHaveBeenCalled();
  });

  it('a preview click moves the editor and keeps the preview still', () => {
    const h = harness();
    const reveal = (h.panes as unknown as { revealSourceLine(l: number, t: number): void }).revealSourceLine.bind(h.panes);
    reveal(21, 40);
    expect(h.editor.revealLine).toHaveBeenCalledWith(21, 40);
    // The editor's resulting scroll must not drag the preview along.
    h.bus.emit(EVENTS.SCROLL_SYNC, { scrollRatio: 0.2 });
    expect(h.pane.scrollToTop).not.toHaveBeenCalled();
  });

  it('a preview click with the editor hidden only moves the cursor', () => {
    const h = harness();
    (h.panes as unknown as { view: string }).view = 'preview';
    (h.panes as unknown as { revealSourceLine(l: number, t: number): void }).revealSourceLine(3, 40);
    expect(h.editor.revealLine).toHaveBeenCalledWith(3, null);
  });
});
