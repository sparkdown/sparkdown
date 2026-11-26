// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api', () => ({
  api: {
    setHtmlPreview: vi.fn(async () => {}),
    allowPreviewAssets: vi.fn(async () => [true]),
    openExternal: vi.fn(async () => {}),
  },
}));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

import { marked } from 'marked';
import { PreviewPane } from '../preview';
import { EventBus } from '../events';
import { tokenLineRanges } from '../preview-source-map';

async function setup(md: string): Promise<{ pane: PreviewPane; container: HTMLElement; render: (md: string) => Promise<void> }> {
  const pane = new PreviewPane(new EventBus());
  const container = document.createElement('div');
  document.body.appendChild(container);
  pane.init(container);
  pane.setDiagramsEnabled(false);
  pane.setRenderMode('notes.md');
  const render = (m: string) => pane.renderImmediateForExport(m);
  await render(md);
  return { pane, container, render };
}

/** First source line of the element matching `selector` (nth match). */
function lineOf(pane: PreviewPane, container: HTMLElement, selector: string, nth = 0): number | null {
  const el = container.querySelectorAll(selector)[nth];
  if (!el) throw new Error(`no ${selector}[${nth}]`);
  return pane.sourceRangeOf(el)?.start ?? null;
}

describe('tokenLineRanges', () => {
  it('gives each top-level token its inclusive source range', () => {
    const md = '# Title\n\npara one\nstill one\n\n- a\n- b\n';
    const ranges = tokenLineRanges(md, marked.lexer(md));
    const byType = marked.lexer(md).map((t, i) => [t.type, ranges[i]]);
    expect(byType.filter(([t]) => t !== 'space')).toEqual([
      ['heading', { start: 1, end: 1 }],
      ['paragraph', { start: 3, end: 4 }],
      ['list', { start: 6, end: 7 }],
    ]);
  });

  it('handles CRLF line endings', () => {
    const md = 'a\r\n\r\nb\r\n';
    const tokens = marked.lexer(md);
    const ranges = tokenLineRanges(md, tokens);
    const para = tokens.map((t, i) => [t.type, ranges[i]]).filter(([t]) => t === 'paragraph');
    expect(para).toEqual([['paragraph', { start: 1, end: 1 }], ['paragraph', { start: 3, end: 3 }]]);
  });
});

describe('preview source ranges', () => {
  const doc = [
    '# Title', //1
    '', //2
    'First paragraph', //3
    'continues here.', //4
    '', //5
    '- one', //6
    '- two', //7
    '  wrapped', //8
    '- three', //9
    '', //10
    '```mermaid', //11
    'graph TD; A-->B', //12
    '```', //13
    '', //14
    '![pic](pic.png)', //15
    '', //16
    '| a | b |', //17
    '|---|---|', //18
    '| 1 | 2 |', //19
    '', //20
    '```js', //21
    'let x = 1;', //22
    '```', //23
    '', //24
    '## Next', //25
  ].join('\n');

  it('maps headings, paragraphs, list items, diagrams, images, tables and code', async () => {
    const { pane, container } = await setup(doc);
    expect(lineOf(pane, container, 'h1')).toBe(1);
    expect(pane.sourceRangeOf(container.querySelector('p')!)).toEqual({ start: 3, end: 4 });
    expect(lineOf(pane, container, 'ul')).toBe(6);
    expect(lineOf(pane, container, 'li', 1)).toBe(7);
    expect(pane.sourceRangeOf(container.querySelectorAll('li')[1])).toEqual({ start: 7, end: 8 });
    expect(lineOf(pane, container, 'li', 2)).toBe(9);
    expect(pane.sourceRangeOf(container.querySelector('.mermaid')!)).toEqual({ start: 11, end: 13 });
    expect(lineOf(pane, container, 'img')).toBe(15);
    expect(lineOf(pane, container, 'td')).toBe(17);
    expect(lineOf(pane, container, 'pre code')).toBe(21);
    expect(lineOf(pane, container, 'h2')).toBe(25);
  });

  it('keeps the rendered markup free of mapping attributes', async () => {
    const { container } = await setup(doc);
    expect(container.innerHTML).not.toMatch(/data-s|sd-/);
  });

  it('maps every heading-delimited segment, including ones resolving reference links', async () => {
    const md = 'See [docs][d].\n\n# A\n\ntext a\n\n# B\n\nuses [docs][d]\n\n[d]: https://example.com\n\n# C\n\nlast\n';
    const { pane, container } = await setup(md);
    expect(lineOf(pane, container, 'h1', 0)).toBe(3);
    expect(lineOf(pane, container, 'h1', 1)).toBe(7);
    expect(lineOf(pane, container, 'p', 2)).toBe(9);
    expect(lineOf(pane, container, 'h1', 2)).toBe(13);
    expect(lineOf(pane, container, 'p', 3)).toBe(15);
  });

  it('moves reused blocks when lines are added above them', async () => {
    const paras = Array.from({ length: 120 }, (_, i) => `para ${i}`).join('\n\n');
    const { pane, container, render } = await setup(paras);
    const last = container.querySelectorAll('p')[119];
    expect(pane.sourceRangeOf(last)?.start).toBe(239);
    // Grow the first paragraph by two lines: same token count, so every
    // later chunk's DOM is reused and only its start line moves.
    await render(paras.replace('para 0', 'para 0\nmore\nand more'));
    expect(container.querySelectorAll('p')[119]).toBe(last);
    expect(pane.sourceRangeOf(last)?.start).toBe(241);
  });

  it('updates ranges when only blank lines change', async () => {
    const { pane, container, render } = await setup('a\n\nb\n');
    expect(lineOf(pane, container, 'p', 1)).toBe(3);
    await render('a\n\n\n\nb\n');
    expect(lineOf(pane, container, 'p', 1)).toBe(5);
  });

  it('maps blocks around raw HTML without guessing at the HTML itself', async () => {
    const { pane, container } = await setup('before\n\n<div class="x">\n<b>raw</b>\n</div>\n\nafter\n');
    expect(lineOf(pane, container, 'p', 0)).toBe(1);
    expect(lineOf(pane, container, 'p', 1)).toBe(7);
  });

  it('lists anchors in source order', async () => {
    const { pane } = await setup(doc);
    const anchors = pane.sourceAnchors();
    expect(anchors).not.toBeNull();
    expect(anchors!.lines).toEqual([1, 3, 6, 6, 7, 9, 11, 15, 17, 21, 25]);
    expect(anchors!.offsets).toHaveLength(anchors!.lines.length);
  });

  it('has no anchors for an HTML preview', async () => {
    const { pane } = await setup('# x');
    pane.setRenderMode('page.html');
    await pane.renderImmediateForExport('<p>hi</p>');
    expect(pane.sourceAnchors()).toBeNull();
  });
});

describe('click in preview', () => {
  let pane: PreviewPane;
  let container: HTMLElement;
  const onClick = vi.fn();

  beforeEach(async () => {
    onClick.mockReset();
    window.getSelection()?.removeAllRanges();
    ({ pane, container } = await setup('# Head\n\nSome [link](https://example.com) text\n\n- [ ] task\n- item\n'));
    pane.setSourceClickHandler(onClick);
  });

  const click = (el: Element, init: MouseEventInit = {}) =>
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, ...init }));

  it('reports the clicked block\'s first source line', () => {
    click(container.querySelector('h1')!);
    expect(onClick).toHaveBeenCalledWith(1, expect.any(Number));
    click(container.querySelectorAll('li')[1]);
    expect(onClick).toHaveBeenLastCalledWith(6, expect.any(Number));
  });

  it('leaves links, controls, modified and double clicks alone', () => {
    click(container.querySelector('a')!);
    const box = container.querySelector('input');
    if (box) click(box);
    const p = container.querySelector('p')!;
    click(p, { metaKey: true });
    click(p, { ctrlKey: true });
    click(p, { shiftKey: true });
    click(p, { detail: 2 });
    click(p, { button: 1 });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not fire when the click ends a text selection', () => {
    const p = container.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()!.addRange(range);
    click(p);
    expect(onClick).not.toHaveBeenCalled();
  });
});
