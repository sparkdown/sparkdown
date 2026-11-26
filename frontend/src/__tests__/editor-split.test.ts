// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { initResizeHandle, setEditorSplit } from '../app/layout';

/** jsdom has no layout: give the area and handle the widths the drag reads. */
function mount(areaWidth: number, editorWidth: number) {
  document.body.innerHTML = `
    <div id="editor-area">
      <div id="editor-container"></div>
      <div id="resize-handle"></div>
      <div id="preview-container"></div>
    </div>`;
  const $ = (id: string) => document.getElementById(id)!;
  Object.defineProperty($('editor-area'), 'clientWidth', { configurable: true, value: areaWidth });
  Object.defineProperty($('resize-handle'), 'offsetWidth', { configurable: true, value: 5 });
  Object.defineProperty($('editor-container'), 'clientWidth', { configurable: true, value: editorWidth });
  initResizeHandle();
  return { editor: $('editor-container'), preview: $('preview-container'), handle: $('resize-handle') };
}

function drag(handle: HTMLElement, from: number, to: number): void {
  handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: from, bubbles: true, cancelable: true }));
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: to, bubbles: true }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

/** [editor, preview] flex grow factors. */
const grow = (editor: HTMLElement, preview: HTMLElement) =>
  [parseFloat(editor.style.flexGrow), parseFloat(preview.style.flexGrow)];

describe('editor/preview split', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('a drag sets a share of the width, not a pixel width', () => {
    // 895px area - 5px handle = 890px for the two panes; 445 → 295.
    const { editor, preview, handle } = mount(895, 445);
    drag(handle, 450, 300);
    expect(editor.style.width).toBe('');
    const [e, p] = grow(editor, preview);
    expect(e / (e + p)).toBeCloseTo(295 / 890, 6);
    expect(editor.style.flexBasis).toBe('0px');
    expect(preview.style.flexBasis).toBe('0px');
  });

  it('the same share gives back the same pixels at the same width (leaving focus mode)', () => {
    const { editor, preview, handle } = mount(895, 445);
    drag(handle, 450, 300);
    const [e, p] = grow(editor, preview);
    // Flex hands the 890px out by grow factor: the editor gets its 295px back.
    expect((890 * e) / (e + p)).toBe(295);
    // A wider area (focus mode hides the sidebar) keeps the proportion.
    expect((1183 * e) / (e + p)).toBeCloseTo(1183 * (295 / 890), 6);
  });

  it('a pane shown alone still fills the area (each grow factor is at least 1)', () => {
    const { editor, preview, handle } = mount(895, 445);
    for (const to of [-10_000, 10_000]) {
      drag(handle, 450, to);
      const [e, p] = grow(editor, preview);
      expect(e).toBeGreaterThanOrEqual(1);
      expect(p).toBeGreaterThanOrEqual(1);
    }
    // The drag keeps 200px for each pane.
    drag(handle, 450, -10_000);
    const [e, p] = grow(editor, preview);
    expect((890 * e) / (e + p)).toBe(200);
  });

  it('setEditorSplit keeps both factors at least 1 at the extremes', () => {
    const { editor, preview } = mount(895, 445);
    for (const [a, b] of [[0, 890], [890, 0], [-3, 7]] as const) {
      setEditorSplit(editor, preview, a, b);
      const [e, p] = grow(editor, preview);
      expect(e).toBeGreaterThanOrEqual(1);
      expect(p).toBeGreaterThanOrEqual(1);
    }
  });
});
