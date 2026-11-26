// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { WikiLinks, type WikiLinkDeps } from '../app/wiki-links';
import type { SearchMatch } from '../api';

function match(path: string, line: number, preview: string): SearchMatch {
  return { path, line, column: 1, preview, match_start: 0, match_end: 2 };
}

function setup(overrides: Partial<WikiLinkDeps> = {}) {
  const panel = document.createElement('div');
  panel.className = 'wiki-backlinks hidden';
  let active: string | null = '/w/notes/Ideas.md';
  const files = ['notes/Ideas.md', 'Home.md', 'projects/Plan.md', 'notes/deep/Ideas.md', 'notes/deep/x.md'];
  const deps: WikiLinkDeps = {
    root: () => '/w',
    origin: () => null,
    activePath: () => active,
    showHidden: () => false,
    listFiles: vi.fn(async () => ({ files, truncated: false })),
    search: vi.fn(async () => ({
      matches: [
        match('/w/Home.md', 4, 'start at [[Ideas]]'),
        match('/w/projects/Plan.md', 2, 'see [[notes/Ideas|ideas]]'),
        match('/w/notes/deep/x.md', 1, '[[Ideas]]'),
      ],
      truncated: false,
    })),
    onIndexChanged: vi.fn(),
    openAt: vi.fn(),
    createEntry: vi.fn(async (parent: string, name: string) => `${parent}/${name}`),
    openFile: vi.fn(),
    showError: vi.fn(),
    ...overrides,
  };
  const wiki = new WikiLinks(deps, panel);
  return { wiki, deps, panel, setActive: (p: string | null) => (active = p) };
}

describe('WikiLinks backlinks', () => {
  it('lists the files that link to the active note and opens one at its line', async () => {
    const { wiki, deps, panel } = setup();
    await wiki.refreshBacklinks();
    expect(deps.search).toHaveBeenCalledWith('/w', expect.stringContaining('Ideas'), false);
    expect(panel.classList.contains('hidden')).toBe(false);
    const header = panel.querySelector<HTMLButtonElement>('.wiki-backlinks-header')!;
    expect(header.textContent).toContain('Linked from 2 files');
    header.click();
    const rows = Array.from(panel.querySelectorAll<HTMLButtonElement>('.wiki-backlink'));
    expect(rows.map((r) => r.querySelector('.wiki-backlink-file')!.textContent)).toEqual([
      'Home.md',
      'projects/Plan.md',
    ]);
    rows[1].click();
    expect(deps.openAt).toHaveBeenCalledWith('/w/projects/Plan.md', 2);
  });

  it('hides the list when nothing links here or the file is not markdown', async () => {
    const { wiki, panel, setActive } = setup({ search: vi.fn(async () => ({ matches: [], truncated: false })) });
    await wiki.refreshBacklinks();
    expect(panel.classList.contains('hidden')).toBe(true);
    setActive('/w/script.sh');
    await wiki.refreshBacklinks();
    expect(panel.classList.contains('hidden')).toBe(true);
  });

  it('notes when the search stopped at its limit', async () => {
    const { wiki, panel } = setup({
      search: vi.fn(async () => ({ matches: [match('/w/Home.md', 1, '[[Ideas]]')], truncated: true })),
    });
    await wiki.refreshBacklinks();
    expect(panel.textContent).toContain('Linked from 1 file (search stopped at its limit)');
  });

  it('loads the file list once and reloads it after invalidateIndex', async () => {
    const { wiki, deps } = setup();
    await wiki.ensureIndex();
    await wiki.ensureIndex();
    expect(deps.listFiles).toHaveBeenCalledTimes(1);
    expect(wiki.resolve('Plan')).toMatchObject({ kind: 'link', href: '../projects/Plan.md', missing: false });
    wiki.invalidateIndex();
    await wiki.ensureIndex();
    expect(deps.listFiles).toHaveBeenCalledTimes(2);
    expect(deps.onIndexChanged).toHaveBeenCalled();
  });
});

describe('WikiLinks create', () => {
  it('creates missing folders and the note, then opens it', async () => {
    const createEntry = vi.fn(async (parent: string, name: string, isDir: boolean) => {
      if (isDir && name === 'drafts') throw new Error('“drafts” already exists');
      return `${parent}/${name}`;
    });
    const { wiki, deps } = setup({ createEntry });
    await wiki.createAndOpen('/w/drafts/2026/Later.md');
    expect(createEntry.mock.calls).toEqual([
      ['/w', 'drafts', true],
      ['/w/drafts', '2026', true],
      ['/w/drafts/2026', 'Later.md', false],
    ]);
    expect(deps.openFile).toHaveBeenCalledWith('/w/drafts/2026/Later.md');
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it('opens a note that appeared in the meantime', async () => {
    const createEntry = vi.fn(async () => {
      throw new Error('“Later.md” already exists');
    });
    const { wiki, deps } = setup({ createEntry });
    await wiki.createAndOpen('/w/Later.md');
    expect(deps.openFile).toHaveBeenCalledWith('/w/Later.md');
  });

  it('reports other errors and opens nothing', async () => {
    const { wiki, deps } = setup({
      createEntry: vi.fn(async () => {
        throw new Error('Permission denied');
      }),
    });
    await wiki.createAndOpen('/w/x.md');
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
    expect(deps.openFile).not.toHaveBeenCalled();
  });

  it('refuses paths outside the folder', async () => {
    const { wiki, deps } = setup();
    await wiki.createAndOpen('/elsewhere/x.md');
    expect(deps.createEntry).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalled();
  });
});
