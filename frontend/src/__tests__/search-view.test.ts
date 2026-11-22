// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// A plain function, not vi.fn(): the spy would report the rejection as unhandled.
const backend = vi.hoisted(() => ({
  calls: [] as unknown[][],
  error: '' as unknown,
}));
vi.mock('../api', () => ({
  api: {
    searchInFiles: async (...args: unknown[]) => {
      backend.calls.push(args);
      throw backend.error;
    },
  },
}));

import { SearchView } from '../search-view';

/** Search `query` with the regex toggle on; the backend fails with `error`.
 *  Returns the text of the status line. */
async function searchFor(query: string, error: unknown): Promise<string> {
  document.body.innerHTML =
    '<input id="search-input"><button id="search-regex-btn"></button>' +
    '<div id="search-status" hidden></div><div id="search-results"></div>';
  const view = new SearchView({ openAt: vi.fn(), includeHidden: () => false });
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
