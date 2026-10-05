// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () => ({
  ...(await import('./helpers/tauri-mocks')).coreMock,
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

import { PreviewPane, classifyPreviewLink } from '../preview';
import { EventBus } from '../events';
import { invokeCalls, resetTauriMocks } from './helpers/tauri-mocks';

/** Render `md` into a fresh pane (base dir /docs) and return its parts. */
async function setup(md: string) {
  const pane = new PreviewPane(new EventBus());
  const container = document.createElement('div');
  document.body.appendChild(container);
  pane.init(container);
  pane.setRenderMode('/docs/readme.md');
  pane.setBaseDir('/docs');
  const opened: string[] = [];
  pane.setOpenFileHandler((p) => opened.push(p));
  await pane.renderImmediateForExport(md);
  return { pane, container, opened };
}

/** Dispatch a cancelable click on the first link; returns the event. */
function clickLink(container: HTMLElement, type: 'click' | 'auxclick' = 'click'): MouseEvent {
  const link = container.querySelector('a')!;
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: type === 'auxclick' ? 1 : 0 });
  link.dispatchEvent(ev);
  return ev;
}

const openExternalCalls = () => invokeCalls.filter((c) => c.cmd === 'open_external');

describe('preview link interception', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetTauriMocks();
  });

  it('scrolls to the heading for a #hash link', async () => {
    const { container, opened } = await setup('[go](#usage-notes)\n\n## Usage notes\n');
    // Heading ids are namespaced with user-content- to prevent DOM clobbering;
    // the anchor href is prefixed to match, and scrollToId normalizes both.
    const heading = container.querySelector('#user-content-usage-notes') as HTMLElement;
    heading.scrollIntoView = vi.fn();
    const ev = clickLink(container);
    expect(ev.defaultPrevented).toBe(true);
    expect(heading.scrollIntoView).toHaveBeenCalled();
    expect(opened).toEqual([]);
    expect(openExternalCalls()).toEqual([]);
  });

  it('resolves a relative markdown link against the current file directory and opens it', async () => {
    const { container, opened } = await setup('[next](../guide/other%20file.md#intro)');
    const ev = clickLink(container);
    expect(ev.defaultPrevented).toBe(true);
    expect(opened).toEqual(['/guide/other file.md']);
    expect(openExternalCalls()).toEqual([]);
  });

  it('opens http(s) and mailto links through the open_external command', async () => {
    const { container, opened } = await setup('[x](https://example.com/a?b=1)');
    const ev = clickLink(container);
    expect(ev.defaultPrevented).toBe(true);
    expect(openExternalCalls()).toEqual([
      { cmd: 'open_external', args: { url: 'https://example.com/a?b=1' } },
    ]);
    expect(opened).toEqual([]);
  });

  it('ignores javascript: links (default still prevented)', async () => {
    const { container, opened } = await setup('<a href="javascript:alert(1)">x</a>');
    // The sanitizer strips the href; force one back to test the handler itself.
    container.querySelector('a')!.setAttribute('href', 'javascript:alert(1)');
    const ev = clickLink(container);
    expect(ev.defaultPrevented).toBe(true);
    expect(opened).toEqual([]);
    expect(openExternalCalls()).toEqual([]);
  });

  it('always prevents default, including for middle-click and non-openable files', async () => {
    const { container, opened } = await setup('[bin](./app.exe)');
    expect(clickLink(container).defaultPrevented).toBe(true);
    expect(clickLink(container, 'auxclick').defaultPrevented).toBe(true);
    expect(opened).toEqual([]);
    expect(openExternalCalls()).toEqual([]);
  });

  it('handles clicks on elements nested inside a link', async () => {
    const { container, opened } = await setup('[**bold** link](notes.txt)');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    container.querySelector('a strong')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(opened).toEqual(['/docs/notes.txt']);
  });
});

describe('base directory changes', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetTauriMocks();
  });

  it('re-resolves relative images when the base dir changes (identical content)', async () => {
    const pane = new PreviewPane(new EventBus());
    const container = document.createElement('div');
    document.body.appendChild(container);
    pane.init(container);

    // Two README files in different folders, both starting with the same image.
    pane.setRenderMode('/a/readme.md');
    pane.setBaseDir('/a');
    await pane.renderImmediateForExport('![logo](logo.png)\n');
    expect(container.querySelector('img')!.getAttribute('src')).toBe(
      'asset://localhost//a/logo.png',
    );

    // Switching tabs: same markdown, different folder. The incremental renderer
    // would otherwise keep the first folder's resolved image.
    pane.setRenderMode('/b/readme.md');
    pane.setBaseDir('/b');
    await pane.renderImmediateForExport('![logo](logo.png)\n');
    expect(container.querySelector('img')!.getAttribute('src')).toBe(
      'asset://localhost//b/logo.png',
    );
  });
});

describe('classifyPreviewLink', () => {
  it.each([
    ['#sec', { kind: 'anchor', id: 'sec' }],
    ['#', { kind: 'ignore' }],
    ['mailto:a@b.c', { kind: 'external', url: 'mailto:a@b.c' }],
    ['HTTP://EXAMPLE.COM', { kind: 'external', url: 'HTTP://EXAMPLE.COM' }],
    ['other.md', { kind: 'file', path: '/docs/other.md' }],
    ['./sub/../x.md', { kind: 'file', path: '/docs/x.md' }],
    ['/abs/y.md', { kind: 'file', path: '/abs/y.md' }],
    ['file:///abs/z.md', { kind: 'file', path: '/abs/z.md' }],
    ['file:///abs/z.png', { kind: 'ignore' }],
    ['asset://localhost/x.md', { kind: 'ignore' }],
    ['javascript:alert(1)', { kind: 'ignore' }],
    ['data:text/html,x', { kind: 'ignore' }],
    ['//evil.example/x.md', { kind: 'ignore' }],
    ['', { kind: 'ignore' }],
  ])('%s', (href, expected) => {
    expect(classifyPreviewLink(href, '/docs')).toEqual(expected);
  });

  it('ignores relative links when there is no base directory', () => {
    expect(classifyPreviewLink('other.md', null)).toEqual({ kind: 'ignore' });
  });

  it('keeps Windows separators and does not climb above the drive', () => {
    expect(classifyPreviewLink('..\\..\\..\\b.md', 'C:\\docs\\a')).toEqual({
      kind: 'file',
      path: 'C:\\b.md',
    });
  });
});
