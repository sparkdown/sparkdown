import { describe, it, expect } from 'vitest';
import {
  findTerminalLinks,
  indexToLinkRange,
  isSafeHttpUrl,
  linksForBufferRow,
  trimUrlMatch,
  type LinkBuffer,
} from '../terminal-links';

/** A fake xterm buffer: rows of text, `wrapped` marks soft-wrapped rows. */
function buffer(rows: Array<string | { text: string; wrapped: true }>): LinkBuffer {
  return {
    getLine(y) {
      const r = rows[y];
      if (r === undefined) return undefined;
      const text = typeof r === 'string' ? r : r.text;
      const isWrapped = typeof r !== 'string';
      return { isWrapped, translateToString: (trim) => (trim ? text.trimEnd() : text) };
    },
  };
}

describe('isSafeHttpUrl', () => {
  it('accepts http and https with a host only', () => {
    expect(isSafeHttpUrl('https://sparkdown.dev/docs')).toBe(true);
    expect(isSafeHttpUrl('http://localhost:5173/')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeHttpUrl('vscode://open')).toBe(false);
    expect(isSafeHttpUrl('https://')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });
});

describe('trimUrlMatch', () => {
  it('drops prose punctuation but keeps balanced parens', () => {
    expect(trimUrlMatch('https://x.dev/a.')).toBe('https://x.dev/a');
    expect(trimUrlMatch('https://x.dev/a),')).toBe('https://x.dev/a');
    expect(trimUrlMatch('https://en.wikipedia.org/wiki/A_(b)')).toBe(
      'https://en.wikipedia.org/wiki/A_(b)',
    );
    expect(trimUrlMatch('https://en.wikipedia.org/wiki/A_(b)).')).toBe(
      'https://en.wikipedia.org/wiki/A_(b)',
    );
  });
});

describe('findTerminalLinks', () => {
  it('finds URLs and paths without offering a path inside a URL', () => {
    const text = 'Edited src/app.ts, see https://github.com/o/r/blob/main/src/app.ts.';
    const links = findTerminalLinks(text);
    expect(links.map((l) => [l.kind, l.text])).toEqual([
      ['path', 'src/app.ts'],
      ['url', 'https://github.com/o/r/blob/main/src/app.ts'],
    ]);
    const url = links[1]!;
    expect(text.slice(url.start, url.end)).toBe(url.text);
  });

  it('never yields non-http schemes as URLs', () => {
    const links = findTerminalLinks('run javascript:alert(1) or file:///tmp/x.txt');
    expect(links.some((l) => l.kind === 'url')).toBe(false);
  });

  it('keeps plain path links (path-link behaviour unchanged)', () => {
    expect(findTerminalLinks('./build/out.js and README.md').map((l) => l.text)).toEqual([
      './build/out.js',
      'README.md',
    ]);
  });
});

describe('indexToLinkRange', () => {
  it('maps a single-row match to a 1-based, end-inclusive range', () => {
    expect(indexToLinkRange(4, 9, 2, [20])).toEqual({
      start: { x: 5, y: 3 },
      end: { x: 9, y: 3 },
    });
  });

  it('maps a match across a wrap to both rows', () => {
    expect(indexToLinkRange(8, 14, 0, [10, 10])).toEqual({
      start: { x: 9, y: 1 },
      end: { x: 4, y: 2 },
    });
  });
});

describe('linksForBufferRow', () => {
  it('reads the requested row (0-based) and returns its links', () => {
    const links = linksForBufferRow(buffer(['first.md', 'open src/a.ts']), 1);
    expect(links).toHaveLength(1);
    expect(links[0]!.text).toBe('src/a.ts');
    expect(links[0]!.range).toEqual({ start: { x: 6, y: 2 }, end: { x: 13, y: 2 } });
  });

  it('joins soft-wrapped rows so a split URL is one link on each row', () => {
    const rows = ['go https://x.dev/', { text: 'docs/a.md now', wrapped: true as const }];
    const buf = buffer(rows);
    for (const y of [0, 1]) {
      const urls = linksForBufferRow(buf, y).filter((l) => l.kind === 'url');
      expect(urls.map((l) => l.text)).toEqual(['https://x.dev/docs/a.md']);
      expect(urls[0]!.range).toEqual({ start: { x: 4, y: 1 }, end: { x: 9, y: 2 } });
    }
    // The path inside the URL is not offered separately.
    expect(linksForBufferRow(buf, 1).some((l) => l.kind === 'path')).toBe(false);
  });

  it('returns nothing for a missing row', () => {
    expect(linksForBufferRow(buffer([]), 0)).toEqual([]);
  });
});
