// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

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

import { PreviewPane } from '../preview';
import { EventBus } from '../events';
import { WikiIndex, wikiRenderFor } from '../wiki-links';

function setup(files: string[], activeRel = 'notes/Today.md') {
  const pane = new PreviewPane(new EventBus());
  const container = document.createElement('div');
  document.body.appendChild(container);
  pane.init(container);
  let index = new WikiIndex(files);
  pane.setWikiResolver((target) => wikiRenderFor(target, index, activeRel));
  pane.setBaseDir('/w/notes');
  pane.setWorkspaceRoot('/w');
  pane.setRenderMode(`/w/${activeRel}`);
  const opened: string[] = [];
  const created: string[] = [];
  pane.setOpenFileHandler((p) => opened.push(p));
  pane.setCreateFileHandler((p) => created.push(p));
  return {
    pane,
    container,
    opened,
    created,
    setFiles: (next: string[]) => {
      index = new WikiIndex(next);
    },
  };
}

describe('preview wiki links', () => {
  it('renders [[name]] and [[name|label]] as links to the resolved file', async () => {
    const { pane, container } = setup(['notes/Today.md', 'projects/Plan.md', 'Home.md']);
    await pane.renderImmediateForExport('See [[Plan]] and [[Home|the start page]].');
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a.wiki-link'));
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Plan', '../projects/Plan.md'],
      ['the start page', '../Home.md'],
    ]);
    expect(links.some((a) => a.classList.contains('wiki-link-missing'))).toBe(false);
  });

  it('marks unresolved links and keeps links in code literal', async () => {
    const { pane, container } = setup(['notes/Today.md']);
    await pane.renderImmediateForExport('[[Nowhere]] `[[Code]]`\n\n```\n[[Fenced]]\n```\n\n[[../up]]');
    const missing = container.querySelector('a.wiki-link-missing')!;
    expect(missing.textContent).toBe('Nowhere');
    expect(missing.getAttribute('title')).toBe('Create notes/Nowhere.md');
    expect(container.querySelector('code')!.textContent).toBe('[[Code]]');
    expect(container.querySelector('pre')!.textContent).toContain('[[Fenced]]');
    const invalid = container.querySelector('span.wiki-link-missing')!;
    expect(invalid.textContent).toBe('../up');
  });

  it('escapes labels', async () => {
    const { pane, container } = setup(['notes/Today.md']);
    await pane.renderImmediateForExport('[[Note|<img src=x onerror=alert(1)>]]');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a.wiki-link')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('opens a resolved target and creates a missing one on click', async () => {
    const { pane, container, opened, created } = setup(['notes/Today.md', 'projects/Plan.md']);
    await pane.renderImmediateForExport('[[Plan]] [[Fresh Idea]] [[drafts/Later]]');
    const [plan, fresh, later] = Array.from(container.querySelectorAll<HTMLAnchorElement>('a.wiki-link'));
    plan.click();
    fresh.click();
    later.click();
    expect(opened).toEqual(['/w/projects/Plan.md']);
    expect(created).toEqual(['/w/notes/Fresh Idea.md', '/w/drafts/Later.md']);
  });

  it('re-renders links when the file list changes', async () => {
    const { pane, container, setFiles } = setup(['notes/Today.md']);
    pane.setVisible(true);
    await pane.renderImmediateForExport('Plan: [[Plan]]');
    expect(container.querySelector('a.wiki-link-missing')).not.toBeNull();
    setFiles(['notes/Today.md', 'notes/Plan.md']);
    pane.refreshWikiLinks();
    await vi.waitFor(() => {
      expect(container.querySelector('a.wiki-link-missing')).toBeNull();
    });
    expect(container.querySelector('a.wiki-link')!.getAttribute('href')).toBe('./Plan.md');
  });
});
