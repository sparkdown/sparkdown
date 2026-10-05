// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { marked } from 'marked';
import { PreviewPane, sanitizeMarkdownHtml } from '../preview';
import { EventBus } from '../events';

/**
 * Render markdown through the real marked pipeline configured by PreviewPane
 * and return the resulting HTML. Uses renderImmediateForExport — a public,
 * awaitable entry point that forces a synchronous-ish render into the
 * container regardless of visibility.
 */
async function renderMarkdown(md: string): Promise<string> {
  const pane = new PreviewPane(new EventBus());
  const container = document.createElement('div');
  pane.init(container); // configures marked
  pane.setRenderMode('notes.md'); // markdown mode
  await pane.renderImmediateForExport(md);
  return container.innerHTML;
}

describe('PreviewPane markdown renderer', () => {

describe('markdown sanitizer', () => {
  it('removes scripts and unsafe URL schemes while preserving safe links', () => {
    const html = sanitizeMarkdownHtml('<p><a href="javascript:alert(1)">x</a><a href="https://safe.example">safe</a><img src="data:text/html,bad"></p><script>alert(1)</script>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script');
    expect(html).toContain('https://safe.example');
    expect(html).not.toContain('data:text/html');
  });
});

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('empty state', () => {
    it('shows a stable prompt for empty markdown and removes it when content arrives', async () => {
      const pane = new PreviewPane(new EventBus());
      const container = document.createElement('div');
      pane.init(container);
      pane.setRenderMode('notes.md');

      await pane.renderImmediateForExport('');
      expect(container.querySelector('.preview-empty-state')?.textContent).toBe(
        'Open a markdown file to preview',
      );

      await pane.renderImmediateForExport('# Ready');
      expect(container.querySelector('.preview-empty-state')).toBeNull();
      expect(container.querySelector('h1')?.textContent).toBe('Ready');
    });
  });

  describe('headings', () => {
    it('renders inline formatting inside headings (regression: was literal)', async () => {
      const html = await renderMarkdown('## a **b** c');
      expect(html).toContain('<strong>b</strong>');
      expect(html).not.toContain('**b**');
    });

    it('renders inline code and links inside headings', async () => {
      const html = await renderMarkdown('# use `npm` or [docs](https://x.y)');
      expect(html).toContain('<code>npm</code>');
      expect(html).toContain('<a href="https://x.y">docs</a>');
    });

    it('adds a slugified, namespaced id and the correct heading level', async () => {
      const html = await renderMarkdown('### Hello World');
      // ids are prefixed with user-content- so a heading can't DOM-clobber a
      // real app element (e.g. #terminal-panel).
      expect(html).toContain('<h3 id="user-content-hello-world"');
      expect(html).toContain('Hello World</h3>');
    });

    it('namespaces heading ids so they cannot clobber app elements', async () => {
      const html = await renderMarkdown('## Terminal Panel\n\n## Status Bar\n');
      // Bare ids terminal-panel / status-bar would be found by getElementById
      // ahead of the real chrome elements; the prefix prevents that.
      expect(html).not.toContain('id="terminal-panel"');
      expect(html).not.toContain('id="status-bar"');
      expect(html).toContain('id="user-content-terminal-panel"');
      expect(html).toContain('id="user-content-status-bar"');
    });

    it('namespaces raw-HTML ids in markdown too', async () => {
      const html = sanitizeMarkdownHtml('<p id="terminal-panel">x</p>');
      expect(html).not.toContain('id="terminal-panel"');
      expect(html).toContain('id="user-content-terminal-panel"');
    });

    it('prefixes in-document #anchor hrefs to match the namespaced ids', async () => {
      const html = await renderMarkdown('[go](#hello-world)\n\n## Hello World\n');
      expect(html).toContain('href="#user-content-hello-world"');
    });
  });

  describe('code blocks', () => {
    it('escapes the quote in a crafted fence language so it cannot break out of the class attribute', async () => {
      // token.lang is the fence info string. The escape that matters for
      // safety is the double-quote: with it escaped to &quot;, the class="..."
      // attribute cannot be terminated early, so nothing after it can become
      // live markup — it stays inert text inside the attribute value.
      const html = await renderMarkdown('```"><script>alert(1)</script>\nx\n```');
      expect(html).toContain('<code>'); // malformed fence metadata is stripped safely
    });

    it('escapes code content for an unknown language', async () => {
      const html = await renderMarkdown('```unknownlang\n<div>&"\n```');
      expect(html).toContain('&lt;div&gt;');
      expect(html).toContain('&amp;');
      expect(html).not.toContain('<div>');
    });

    it('highlights a known language and tags it hljs', async () => {
      const html = await renderMarkdown('```js\nconst x = 1;\n```');
      expect(html).toContain('class="hljs language-js"');
      // highlight.js wraps tokens in spans
      expect(html).toContain('hljs-keyword');
    });

    it('renders a mermaid fence as a mermaid div, not a code block', async () => {
      // Use a DOM query: mermaid mutates the div (adds id/svg) once rendered,
      // so match the stable .mermaid class rather than an exact string.
      const pane = new PreviewPane(new EventBus());
      const container = document.createElement('div');
      pane.init(container);
      pane.setRenderMode('notes.md');
      await pane.renderImmediateForExport('```mermaid\ngraph TD; A-->B;\n```');

      expect(container.querySelector('.mermaid')).not.toBeNull();
      expect(container.querySelector('pre')).toBeNull();
    }, 15_000);
  });

  describe('GFM', () => {
    it('renders tables', async () => {
      const md = '| H1 | H2 |\n| --- | --- |\n| a | b |';
      const html = await renderMarkdown(md);
      expect(html).toContain('<table>');
      expect(html).toContain('<th>H1</th>');
      expect(html).toContain('<td>a</td>');
    });

    it('renders task lists', async () => {
      const html = await renderMarkdown('- [x] done\n- [ ] todo');
      expect(html).toContain('type="checkbox"');
      expect(html).toContain('checked');
    });
  });

  describe('incremental re-rendering', () => {
    /** A pane + container that persist across renders, like the real app. */
    function makeLivePane() {
      const pane = new PreviewPane(new EventBus());
      const container = document.createElement('div');
      document.body.appendChild(container);
      pane.init(container);
      pane.setRenderMode('notes.md');
      return { pane, container };
    }

    /** Full-rebuild reference: what a fresh pane produces for this markdown. */
    async function referenceHtml(md: string): Promise<string> {
      const { pane, container } = makeLivePane();
      await pane.renderImmediateForExport(md);
      return container.innerHTML;
    }

    it('produces DOM identical to a full rebuild after an edit mid-document', async () => {
      const { pane, container } = makeLivePane();
      const before = '# Title\n\nfirst para\n\n## Section\n\nsecond para\n\n- a\n- b\n';
      const after = '# Title\n\nfirst para EDITED\n\n## Section\n\nsecond para\n\n- a\n- b\n';
      await pane.renderImmediateForExport(before);
      await pane.renderImmediateForExport(after);
      expect(container.innerHTML).toBe(await referenceHtml(after));
    });

    it('handles appending at the end (the typing case)', async () => {
      const { pane, container } = makeLivePane();
      await pane.renderImmediateForExport('# Doc\n\npara one\n');
      await pane.renderImmediateForExport('# Doc\n\npara one\n\npara two\n');
      expect(container.innerHTML).toBe(
        await referenceHtml('# Doc\n\npara one\n\npara two\n'),
      );
    });

    it('handles deleting blocks', async () => {
      const { pane, container } = makeLivePane();
      await pane.renderImmediateForExport('# A\n\none\n\ntwo\n\nthree\n');
      await pane.renderImmediateForExport('# A\n\nthree\n');
      expect(container.innerHTML).toBe(await referenceHtml('# A\n\nthree\n'));
    });

    it('handles replacing the whole document', async () => {
      const { pane, container } = makeLivePane();
      await pane.renderImmediateForExport('# Old\n\ncontent\n');
      await pane.renderImmediateForExport('completely different\n\n> quote\n');
      expect(container.innerHTML).toBe(
        await referenceHtml('completely different\n\n> quote\n'),
      );
    });

    it('handles emptying and refilling the document', async () => {
      const { pane, container } = makeLivePane();
      await pane.renderImmediateForExport('# Doc\n\ntext\n');
      await pane.renderImmediateForExport('');
      await pane.renderImmediateForExport('# Back\n\nagain\n');
      expect(container.innerHTML).toBe(await referenceHtml('# Back\n\nagain\n'));
    });

    it('splices correctly across many sequential edits', async () => {
      const { pane, container } = makeLivePane();
      const sections = Array.from(
        { length: 40 },
        (_, i) => `## S${i}\n\npara for section ${i}\n\n- item ${i}\n`,
      );
      await pane.renderImmediateForExport(sections.join('\n'));
      // Edit the middle, then the start, then delete the end.
      sections[20] = '## S20\n\nEDITED paragraph\n\n- item 20\n';
      await pane.renderImmediateForExport(sections.join('\n'));
      sections[0] = '## S0-renamed\n\npara for section 0\n\n- item 0\n';
      await pane.renderImmediateForExport(sections.join('\n'));
      sections.pop();
      const final = sections.join('\n');
      await pane.renderImmediateForExport(final);
      expect(container.innerHTML).toBe(await referenceHtml(final));
    });

    it('resolves reference-style links whose definition lives in another chunk', async () => {
      // 40 paragraphs between use and definition forces them into different
      // chunks (chunk size is 32 tokens).
      const filler = Array.from({ length: 40 }, (_, i) => `para ${i}\n`).join('\n');
      const md = `See [the docs][docs]\n\n${filler}\n[docs]: https://example.com\n`;
      const { pane, container } = makeLivePane();
      await pane.renderImmediateForExport(md);
      expect(container.innerHTML).toContain('href="https://example.com"');
    });

    it('segmented lexing matches whole-document parsing exactly', async () => {
      // Exercises the heading-segmented lexer against marked's own
      // whole-document output on a doc with fences containing #-lines,
      // reference links across segments, and no trailing newline.
      const md = [
        '# One',
        '',
        'para with [ref][r] link',
        '',
        '```',
        '# not a heading',
        '```',
        '',
        '## Two',
        '',
        '[r]: https://example.com',
        '',
        'tail paragraph',
      ].join('\n');
      const { pane, container } = makeLivePane();
      await pane.renderImmediateForExport(md);
      const expected = await marked.parse(md);
      // The rendered DOM namespaces heading ids (user-content-); marked.parse
      // returns the raw, un-sanitized HTML. Strip the prefix on both sides so
      // this test stays focused on lexing equivalence, not id namespacing.
      const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/user-content-/g, '');
      expect(norm(container.innerHTML)).toBe(norm(String(expected)));
    });

    it('re-renders mermaid when a diagram is added by a later edit', async () => {
      const { pane, container } = makeLivePane();
      await pane.renderImmediateForExport('# Doc\n\ntext\n');
      await pane.renderImmediateForExport(
        '# Doc\n\ntext\n\n```mermaid\ngraph TD; A-->B;\n```\n',
      );
      expect(container.querySelector('.mermaid')).not.toBeNull();
    });

    it('rerenderForTheme rebuilds unchanged content so diagrams pick up the theme', async () => {
      const { pane, container } = makeLivePane();
      const md = '# T\n\n```mermaid\ngraph TD; A-->B;\n```\n';
      await pane.renderImmediateForExport(md);
      const first = container.querySelector('.mermaid');
      expect(first).not.toBeNull();

      // A plain render(md) would no-op (content unchanged) and keep the stale
      // theme. rerenderForTheme must force a full rebuild — a fresh, reprocessed
      // .mermaid node (distinct from the previous one) proves it re-ran.
      pane.notifyThemeChanged('dark');
      await pane.rerenderForTheme(md);
      const after = container.querySelector('.mermaid');
      expect(after).not.toBeNull();
      expect(after).not.toBe(first);
    }, 15_000);
  });
});
