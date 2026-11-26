// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// A plain function, not vi.fn(): the spy would report the rejection as unhandled.
const backend = vi.hoisted(() => ({
  calls: [] as unknown[][],
  error: '' as unknown,
  /** When set, searchInFiles returns this instead of failing. */
  results: null as unknown,
}));
const replaceBackend = vi.hoisted(() => ({
  preview: null as unknown,
  apply: null as unknown,
  undo: null as unknown,
  calls: [] as { cmd: string; args: unknown[] }[],
}));
vi.mock('../api', () => ({
  api: {
    searchInFiles: async (...args: unknown[]) => {
      backend.calls.push(args);
      if (backend.results) return backend.results;
      throw backend.error;
    },
    replacePreview: async (...args: unknown[]) => {
      replaceBackend.calls.push({ cmd: 'preview', args });
      return replaceBackend.preview;
    },
    replaceApply: async (...args: unknown[]) => {
      replaceBackend.calls.push({ cmd: 'apply', args });
      return replaceBackend.apply;
    },
    replaceUndo: async (...args: unknown[]) => {
      replaceBackend.calls.push({ cmd: 'undo', args });
      return replaceBackend.undo;
    },
  },
}));

import { SearchView } from '../search-view';
import { parseReplacement } from '../replace-plan';

// Read from disk: CSS imports are empty under vitest. Paths are relative to
// the frontend folder, where vitest runs.
const { readFileSync } = (await import('node:fs' as string)) as {
  readFileSync(p: string, enc: 'utf8'): string;
};
const sidebarCss = readFileSync('src/styles/sidebar.css', 'utf8');

/** Search `query` with the regex toggle on; the backend fails with `error`.
 *  Returns the text of the status line. */
async function searchFor(query: string, error: unknown): Promise<string> {
  document.body.innerHTML =
    '<input id="search-input"><button id="search-regex-btn"></button>' +
    '<div id="search-status" hidden></div><div id="search-results"></div>';
  const view = new SearchView({
    openAt: vi.fn(),
    includeHidden: () => false,
    isRemote: () => false,
    hasUnsavedChanges: () => false,
    unsavedFiles: () => [],
    filesWritten: async () => {},
  });
  view.init();
  view.setRoot('/proj');
  (document.getElementById('search-regex-btn') as HTMLButtonElement).click();
  (document.getElementById('search-input') as HTMLInputElement).value = query;
  backend.error = error;
  await view.run(true);
  return document.getElementById('search-status')!.textContent ?? '';
}

describe('SearchView errors', () => {
  beforeEach(() => {
    backend.calls.length = 0;
  });

  it('shows the Unicode class message as it is, without a "Search failed" prefix', async () => {
    const message = String.raw`Unicode classes like \p{..} aren't supported`;
    expect(await searchFor(String.raw`\p{L}+`, message)).toBe(message);
    expect(backend.calls[backend.calls.length - 1]).toEqual(['/proj', String.raw`\p{L}+`, false, false, true]);
  });

  it('still shows an invalid pattern message without the prefix', async () => {
    const text = await searchFor('(', 'Search failed: Invalid regex pattern: unclosed group');
    expect(text).toBe('Invalid regex pattern: unclosed group');
  });

  it('prefixes any other failure', async () => {
    expect(await searchFor('x', 'IO error: boom')).toBe('Search failed: IO error: boom');
  });
});

describe('SearchView replace', () => {
  const hit = (start: number, line: number, preview: string, ms: number, me: number, groups: (string | null)[] = []) => ({
    start,
    end: start + (me - ms),
    line,
    column: ms + 1,
    preview,
    match_start: ms,
    match_end: me,
    groups,
  });
  const preview = {
    files: [
      { path: '/proj/a.md', fingerprint: 'fa', hits: [hit(0, 1, 'cat cat', 0, 3), hit(4, 1, 'cat cat', 4, 7)] },
      { path: '/proj/notes/b.md', fingerprint: 'fb', hits: [hit(2, 1, 'a cat', 2, 5)] },
    ],
    skipped: [{ path: '/proj/old.txt', reason: 'not UTF-8 text' }],
    truncated: false,
    group_count: 0,
    group_names: [] as [string, number][],
  };

  let unsaved: Set<string>;
  let written: string[][];
  let remote: boolean;
  const $ = (id: string) => document.getElementById(id)!;
  const status = () => $('search-status').textContent ?? '';

  async function openPreview(): Promise<SearchView> {
    document.body.innerHTML =
      '<section id="sidebar-search"><input id="search-input"><button id="search-regex-btn"></button><button id="search-replace-btn"></button>' +
      '<div id="search-replace-row" hidden><input id="search-replace-input"><button id="search-replace-preview-btn"></button></div>' +
      '<div id="search-status" hidden></div><div id="search-results"></div></section><button id="elsewhere"></button>';
    const view = new SearchView({
      openAt: vi.fn(),
      includeHidden: () => false,
      isRemote: () => remote,
      hasUnsavedChanges: (p) => unsaved.has(p),
      unsavedFiles: () => [...unsaved].map((path) => ({ path, text: 'edited' })),
      filesWritten: async (paths) => void written.push(paths),
    });
    view.init();
    view.setRoot('/proj');
    ($('search-replace-btn') as HTMLButtonElement).click();
    ($('search-input') as HTMLInputElement).value = 'cat';
    ($('search-replace-input') as HTMLInputElement).value = 'dog';
    await view.preview();
    return view;
  }

  const rows = () => [...document.querySelectorAll('.replace-hit')];
  const check = (file: number, hit?: number) =>
    document.querySelector<HTMLInputElement>(
      hit === undefined
        ? `.replace-file input[data-file="${file}"]`
        : `.replace-hit input[data-file="${file}"][data-hit="${hit}"]`,
    )!;
  const toggle = (box: HTMLInputElement) => {
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const applyButton = () => document.querySelector<HTMLButtonElement>('[data-action="apply"]')!;

  beforeEach(() => {
    backend.calls.length = 0;
    backend.results = null;
    replaceBackend.calls.length = 0;
    replaceBackend.preview = preview;
    unsaved = new Set();
    written = [];
    remote = false;
  });

  it('previews every match as before and after, with skipped files listed', async () => {
    await openPreview();
    expect(replaceBackend.calls[0]).toEqual({ cmd: 'preview', args: ['/proj', 'cat', false, false, []] });
    expect(rows().map((r) => [r.querySelector('del')!.textContent, r.querySelector('ins')!.textContent])).toEqual([
      ['cat', 'dog'],
      ['cat', 'dog'],
      ['cat', 'dog'],
    ]);
    expect(applyButton().textContent).toBe('Replace 3 matches in 2 files');
    expect(document.querySelector('.replace-skipped')!.textContent).toContain('not UTF-8 text');
    expect(status()).toBe('3 matches in 2 files; 1 file skipped (listed)');
    // Typing a new replacement updates the preview without asking the backend.
    const input = $('search-replace-input') as HTMLInputElement;
    input.value = 'cow';
    input.dispatchEvent(new Event('input'));
    expect(rows()[0].querySelector('ins')!.textContent).toBe('cow');
    expect(replaceBackend.calls).toHaveLength(1);
  });

  it('sends only the selected matches and offers undo', async () => {
    const view = await openPreview();
    toggle(check(0, 1));
    toggle(check(1));
    expect(applyButton().textContent).toBe('Replace 1 match in 1 file');
    replaceBackend.apply = {
      batch_id: 7,
      files: [{ path: '/proj/a.md', status: 'done', count: 1, message: null }],
    };
    await view.apply();
    const apply = replaceBackend.calls.find((c) => c.cmd === 'apply')!;
    expect(apply.args).toEqual(['/proj', 'cat', 'dog', [{ path: '/proj/a.md', fingerprint: 'fa', ranges: [[0, 3]] }], false, false]);
    expect(written).toEqual([['/proj/a.md']]);
    expect(status()).toBe('Replaced 1 match in 1 file. 1 file left unchanged.');

    replaceBackend.undo = [{ path: '/proj/a.md', status: 'done', count: 1, message: null }];
    document.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
    await vi.waitFor(() => expect(status()).toBe('Undid the replace in 1 file.'));
    expect(replaceBackend.calls[replaceBackend.calls.length - 1]).toEqual({ cmd: 'undo', args: [7] });
    expect(written).toEqual([['/proj/a.md'], ['/proj/a.md']]);
    expect(document.querySelector('[data-action="undo"]')).toBeNull();
  });

  it('leaves files with unsaved changes out, also when they get them after the preview', async () => {
    unsaved.add('/proj/a.md');
    const view = await openPreview();
    expect(check(0).disabled).toBe(true);
    expect(document.querySelector('.replace-file')!.textContent).toContain('open with unsaved changes');
    expect(applyButton().textContent).toBe('Replace 1 match in 1 file');
    unsaved.add('/proj/notes/b.md');
    await view.apply();
    expect(replaceBackend.calls.some((c) => c.cmd === 'apply')).toBe(false);
    expect(applyButton().disabled).toBe(true);
  });

  it('reports files that changed on disk since the preview', async () => {
    const view = await openPreview();
    replaceBackend.apply = {
      batch_id: 3,
      files: [
        { path: '/proj/a.md', status: 'changed', count: 0, message: 'changed on disk since the preview' },
        { path: '/proj/notes/b.md', status: 'done', count: 1, message: null },
      ],
    };
    await view.apply();
    expect(status()).toBe('Replaced 1 match in 1 file. 2 files left unchanged.');
    const skipped = [...document.querySelectorAll('.replace-skipped')].map((r) => r.textContent);
    expect(skipped).toEqual(['a.mdskipped: changed on disk since the preview', 'old.txtskipped: not UTF-8 text']);
  });

  it('sends the unsaved tabs and lists the ones the backend skipped', async () => {
    unsaved.add('/proj/c.md');
    replaceBackend.preview = {
      ...preview,
      skipped: [...preview.skipped, { path: '/proj/c.md', reason: 'open with unsaved changes' }],
    };
    await openPreview();
    expect(replaceBackend.calls[0].args[4]).toEqual([{ path: '/proj/c.md', text: 'edited' }]);
    const skipped = [...document.querySelectorAll('.replace-skipped')].map((r) => r.textContent);
    expect(skipped).toEqual(['old.txtskipped: not UTF-8 text', 'c.mdskipped: open with unsaved changes']);
    expect(status()).toBe('3 matches in 2 files; 2 files skipped (listed)');
  });

  it('expands capture groups in regex mode, live as the replacement changes', async () => {
    replaceBackend.preview = {
      files: [
        {
          path: '/proj/a.md',
          fingerprint: 'fa',
          hits: [hit(0, 1, 'ann@ex bob@ey', 0, 6, ['ann@ex', 'ann', 'ex']), hit(7, 1, 'ann@ex bob@ey', 7, 13, ['bob@ey', 'bob', null])],
        },
      ],
      skipped: [],
      truncated: false,
      group_count: 2,
      group_names: [['host', 2]],
    };
    const view = await openPreview();
    // openPreview starts in plain-text mode: turn regex on, then preview again.
    ($('search-regex-btn') as HTMLButtonElement).click();
    const input = $('search-replace-input') as HTMLInputElement;
    input.value = '${host}:$1 $$ $';
    await view.preview();
    const ins = () => rows().map((r) => r.querySelector('ins')!.textContent);
    expect(ins()).toEqual(['ex:ann $ $', ':bob $ $']);
    input.value = '[$0]';
    input.dispatchEvent(new Event('input'));
    expect(ins()).toEqual(['[ann@ex]', '[bob@ey]']);
    input.value = '$3';
    input.dispatchEvent(new Event('input'));
    expect(status()).toBe('The replacement uses $3, but the search pattern has 2 capture groups (use $$ for a literal $)');
    expect(applyButton().disabled).toBe(true);
    expect(replaceBackend.calls[replaceBackend.calls.length - 1]).toMatchObject({ cmd: 'preview', args: ['/proj', 'cat', false, true, []] });
  });

  it('keeps the replacement literal in plain-text mode', async () => {
    const input = () => $('search-replace-input') as HTMLInputElement;
    await openPreview();
    input().value = '$1 ${x} $$';
    input().dispatchEvent(new Event('input'));
    expect(rows().map((r) => r.querySelector('ins')!.textContent)).toEqual(['$1 ${x} $$', '$1 ${x} $$', '$1 ${x} $$']);
    expect(applyButton().disabled).toBe(false);
  });

  describe('Escape', () => {
    const plain = {
      matches: [{ path: '/proj/a.md', line: 1, column: 1, preview: 'cat cat', match_start: 0, match_end: 3 }],
      truncated: false,
    };
    const esc = (el: Element) => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      return e;
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const searchInput = () => $('search-input') as HTMLInputElement;
    const plainRows = () => document.querySelectorAll('.search-hit:not(.replace-hit)').length;

    beforeEach(() => {
      backend.results = plain;
    });

    it('in the search field closes the preview and keeps the query and the plain results', async () => {
      await openPreview();
      expect(rows()).toHaveLength(3);
      searchInput().focus();
      expect(esc(searchInput()).defaultPrevented).toBe(true);
      await flush();
      expect(rows()).toHaveLength(0);
      expect(searchInput().value).toBe('cat');
      expect(backend.calls[backend.calls.length - 1]).toEqual(['/proj', 'cat', false, false, false]);
      expect(plainRows()).toBe(1);
      expect(status()).toBe('1 result in 1 file');

      // A second Escape clears the query, as without a preview.
      esc(searchInput());
      await flush();
      expect(searchInput().value).toBe('');
      expect(plainRows()).toBe(0);
    });

    it('on the Preview button or in the replace field closes the preview too', async () => {
      for (const id of ['search-replace-preview-btn', 'search-replace-input']) {
        await openPreview();
        $(id).focus();
        esc($(id));
        await flush();
        expect(rows()).toHaveLength(0);
        expect(searchInput().value).toBe('cat');
        expect(plainRows()).toBe(1);
        expect(($('search-replace-input') as HTMLInputElement).value).toBe('dog');
      }
    });

    it('on a checkbox in the list closes the preview and moves focus to the search field', async () => {
      await openPreview();
      const box = check(0);
      box.focus();
      esc(box);
      await flush();
      expect(rows()).toHaveLength(0);
      expect(document.activeElement).toBe(searchInput());
    });

    it('with nothing focused after a click in the list (WebKit) closes the preview', async () => {
      await openPreview();
      const box = check(0);
      box.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);
      esc(document.body);
      await flush();
      expect(rows()).toHaveLength(0);
      expect(searchInput().value).toBe('cat');
      expect(document.activeElement).toBe(searchInput());
    });

    it('outside the search view leaves the preview open', async () => {
      await openPreview();
      $('elsewhere').dispatchEvent(new Event('pointerdown', { bubbles: true }));
      $('elsewhere').focus();
      esc($('elsewhere'));
      (document.activeElement as HTMLElement | null)?.blur();
      esc(document.body);
      await flush();
      expect(rows()).toHaveLength(3);
    });
  });

  it('puts the reason for a skipped file on its own line, keeping the name readable', async () => {
    replaceBackend.preview = {
      ...preview,
      skipped: [...preview.skipped, { path: '/proj/c.md', reason: 'open with unsaved changes' }],
    };
    unsaved.add('/proj/a.md');
    await openPreview();
    const noted = [...document.querySelectorAll('.search-file.replace-noted')];
    expect(noted.map((r) => r.querySelector('.search-file-name')!.textContent)).toEqual(['a.md', 'old.txt', 'c.md']);
    expect(noted.map((r) => r.getAttribute('title'))).toEqual(['/proj/a.md', '/proj/old.txt', '/proj/c.md']);
    // The row wraps and the reason takes a full line of its own.
    expect(sidebarCss).toMatch(/\.search-file\.replace-noted\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(sidebarCss).toMatch(/\.replace-noted \.replace-note\s*\{[^}]*flex:\s*1 0 100%[^}]*white-space:\s*normal/);
  });

  it('is off for remote folders', async () => {
    remote = true;
    await openPreview();
    expect(replaceBackend.calls).toHaveLength(0);
    expect(status()).toBe('Replace is not available for remote folders.');
  });
});

describe('parseReplacement', () => {
  const names: [string, number][] = [['host', 2]];
  const parse = (s: string) => parseReplacement(s, true, 2, names);
  it('matches the backend rules (search/replace.rs template_parsing)', () => {
    expect(parse('a$1b')).toEqual({ pieces: ['a', 1, 'b'] });
    expect(parse('${host}$0')).toEqual({ pieces: [2, 0] });
    expect(parse('$$1')).toEqual({ pieces: ['$1'] });
    expect(parse('${}$')).toEqual({ pieces: ['${}$'] });
    expect(parse('${1}0')).toEqual({ pieces: [1, '0'] });
    expect(parse('$x $')).toEqual({ pieces: ['$x $'] });
    expect(parse('$3')).toEqual({ error: expect.stringContaining('$3') });
    expect(parse('${other}')).toEqual({ error: expect.stringContaining('${other}') });
    expect(parse('$99999999999999999999999')).toHaveProperty('error');
  });
  it('is plain text outside regex mode', () => {
    expect(parseReplacement('$1 $$', false, 0, [])).toEqual({ pieces: ['$1 $$'] });
  });
});
