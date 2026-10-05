import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isMarkdownFile,
  isHtmlFile,
  isPreviewable,
  stripMarkdownExt,
  slugifyHeading,
  dirname,
  basename,
  parentDir,
  escapeHtml,
  debounce,
  mapLineToY,
  mapYToLine,
  headingSourceLines,
  buildScrollMap,
  isAbsolutePath,
  normalizePathForCompare,
  toRelativePath,
  joinPath,
  isUnderRoot,
  type SyncPoint,
} from '../utils';

describe('isMarkdownFile', () => {
  it('treats null/empty (untitled buffers) as markdown', () => {
    expect(isMarkdownFile(null)).toBe(true);
    expect(isMarkdownFile('')).toBe(true);
  });

  it('matches .md/.markdown/.mkd case-insensitively', () => {
    expect(isMarkdownFile('notes.md')).toBe(true);
    expect(isMarkdownFile('/a/b/README.MARKDOWN')).toBe(true);
    expect(isMarkdownFile('x.MkD')).toBe(true);
  });

  it('rejects non-markdown extensions', () => {
    expect(isMarkdownFile('index.html')).toBe(false);
    expect(isMarkdownFile('script.ts')).toBe(false);
    expect(isMarkdownFile('archive.md.zip')).toBe(false);
  });
});

describe('isHtmlFile', () => {
  it('matches .html and .htm case-insensitively', () => {
    expect(isHtmlFile('page.html')).toBe(true);
    expect(isHtmlFile('page.htm')).toBe(true);
    expect(isHtmlFile('/x/Y/INDEX.HTML')).toBe(true);
  });

  it('is false for null and non-html paths', () => {
    expect(isHtmlFile(null)).toBe(false);
    expect(isHtmlFile('notes.md')).toBe(false);
    expect(isHtmlFile('a.html.bak')).toBe(false);
  });
});

describe('isPreviewable', () => {
  it('covers markdown (incl. untitled) and html', () => {
    expect(isPreviewable(null)).toBe(true);
    expect(isPreviewable('a.md')).toBe(true);
    expect(isPreviewable('a.html')).toBe(true);
  });

  it('is false for other text/code files', () => {
    expect(isPreviewable('a.ts')).toBe(false);
    expect(isPreviewable('a.json')).toBe(false);
  });
});

describe('stripMarkdownExt', () => {
  it('replaces only a trailing markdown extension', () => {
    expect(stripMarkdownExt('notes.md', '.html')).toBe('notes.html');
    expect(stripMarkdownExt('/a/b/readme.markdown', '.html')).toBe('/a/b/readme.html');
  });

  it('leaves non-markdown paths unchanged', () => {
    expect(stripMarkdownExt('script.ts', '.html')).toBe('script.ts');
  });
});

describe('slugifyHeading', () => {
  it('lowercases and collapses non-word runs to single dashes', () => {
    expect(slugifyHeading('Hello World')).toBe('hello-world');
    expect(slugifyHeading('Foo: Bar / Baz')).toBe('foo-bar-baz');
  });

  it('keeps underscores (word chars) and turns leading/trailing junk into dashes', () => {
    expect(slugifyHeading('snake_case')).toBe('snake_case');
    expect(slugifyHeading('## Heading!')).toBe('-heading-');
  });
});

describe('dirname', () => {
  it('returns the parent path segment', () => {
    expect(dirname('/a/b/c.md')).toBe('/a/b');
    expect(dirname('a/b/c.md')).toBe('a/b');
  });

  it('handles backslashes (Windows paths)', () => {
    expect(dirname('a\\b\\c.md')).toBe('a\\b');
  });

  it('returns empty string when there is no parent above root', () => {
    expect(dirname('file.md')).toBe('');
    expect(dirname('/file.md')).toBe(''); // separator at index 0
  });
});

describe('basename', () => {
  it('returns the final path segment', () => {
    expect(basename('/a/b/c.md')).toBe('c.md');
    expect(basename('a\\b\\c.md')).toBe('c.md');
  });

  it('returns the whole string when there is no separator', () => {
    expect(basename('file.md')).toBe('file.md');
  });
});

describe('parentDir', () => {
  it('returns the parent directory', () => {
    expect(parentDir('/Users/alice/project')).toBe('/Users/alice');
  });

  it('returns "/" for a top-level entry', () => {
    expect(parentDir('/Users')).toBe('/');
  });

  it('returns null at the filesystem root', () => {
    expect(parentDir('/')).toBeNull();
  });

  it('ignores trailing slashes', () => {
    expect(parentDir('/Users/alice/')).toBe('/Users');
  });

  it('returns null for a relative single segment or empty string', () => {
    expect(parentDir('sparkdown')).toBeNull();
    expect(parentDir('')).toBeNull();
  });
});

describe('escapeHtml', () => {
  it('escapes &, <, >, and "', () => {
    expect(escapeHtml('<a href="x">Tom & Jerry</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;'
    );
  });

  it('escapes ampersands before other entities (no double-escaping)', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('plain text')).toBe('plain text');
  });
});

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.restoreAllMocks());

  it('invokes once after the delay with the latest args', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('a');
    debounced('b');
    debounced('c');
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('resets the timer on each call (trailing edge)', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(60);
    debounced();
    vi.advanceTimersByTime(60); // 120ms total, but only 60ms since last call
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(40);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel() drops a pending call and later calls still work', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('a');
    debounced.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();

    debounced.cancel(); // no-op with nothing pending
    debounced('b');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('b');
  });
});

describe('scroll-sync line/pixel mapping', () => {
  const points: SyncPoint[] = [
    { line: 1, y: 0 },
    { line: 10, y: 300 },
    { line: 20, y: 400 },
    { line: 40, y: 1000 },
  ];

  it('mapLineToY interpolates between sync points', () => {
    expect(mapLineToY(points, 1)).toBe(0);
    expect(mapLineToY(points, 5.5)).toBe(150); // halfway 1→10 ≈ half of 0→300
    expect(mapLineToY(points, 15)).toBe(350);
    expect(mapLineToY(points, 40)).toBe(1000);
  });

  it('mapLineToY clamps outside the range', () => {
    expect(mapLineToY(points, 0)).toBe(0);
    expect(mapLineToY(points, 999)).toBe(1000);
  });

  it('mapYToLine is the inverse within the range', () => {
    for (const line of [1, 5.5, 10, 15, 20, 30, 40]) {
      expect(mapYToLine(points, mapLineToY(points, line))).toBeCloseTo(line, 5);
    }
  });

  it('handles duplicate coordinates without dividing by zero', () => {
    const dup: SyncPoint[] = [
      { line: 1, y: 0 },
      { line: 5, y: 100 },
      { line: 9, y: 100 }, // two headings at the same pixel
    ];
    expect(mapLineToY(dup, 7)).toBe(100);
    expect(Number.isFinite(mapYToLine(dup, 100))).toBe(true);
  });

  it('empty points fall back to line 1 / y 0', () => {
    expect(mapLineToY([], 10)).toBe(0);
    expect(mapYToLine([], 500)).toBe(1);
  });
});

describe('buildScrollMap', () => {
  it('pins endpoints at (0,0) and (srcMax,dstMax)', () => {
    const map = buildScrollMap([100, 500], [80, 300], 1000, 600);
    expect(mapLineToY(map, 0)).toBe(0);
    expect(mapLineToY(map, 1000)).toBe(600);
  });

  it('maps through landmarks between the endpoints', () => {
    const map = buildScrollMap([100, 500], [80, 300], 1000, 600);
    expect(mapLineToY(map, 100)).toBe(80);
    expect(mapLineToY(map, 500)).toBe(300);
    expect(mapLineToY(map, 300)).toBe(190); // halfway 100→500 ≈ halfway 80→300
  });

  it('is monotone even when pane densities differ wildly', () => {
    // Landmarks where the source pane is much denser than the target in one
    // section and much sparser in the next — the shape that reversed the
    // old anchor-based sync.
    const map = buildScrollMap([50, 900, 950], [400, 450, 900], 1000, 1000);
    let prev = -1;
    for (let s = 0; s <= 1000; s += 10) {
      const y = mapLineToY(map, s);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });

  it('drops out-of-order landmarks instead of folding backwards', () => {
    // A dst offset lower than its predecessor (bad geometry) is skipped.
    const map = buildScrollMap([100, 200, 300], [50, 40, 200], 1000, 500);
    let prev = -1;
    for (let s = 0; s <= 1000; s += 25) {
      const y = mapLineToY(map, s);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });

  it('clamps landmark offsets beyond the scrollable range', () => {
    // Landmarks near the doc end can exceed maxScroll (they sit in the last
    // viewport). They must clamp, keeping the map within bounds.
    const map = buildScrollMap([100, 990], [80, 590], 800, 500);
    expect(mapLineToY(map, 800)).toBe(500);
    for (let s = 0; s <= 800; s += 50) {
      expect(mapLineToY(map, s)).toBeLessThanOrEqual(500);
    }
  });

  it('degenerates gracefully with no landmarks', () => {
    const map = buildScrollMap([], [], 1000, 500);
    expect(mapLineToY(map, 0)).toBe(0);
    expect(mapLineToY(map, 500)).toBe(250);
    expect(mapLineToY(map, 1000)).toBe(500);
  });
});

describe('headingSourceLines', () => {
  it('finds ATX headings with 1-based line numbers', () => {
    expect(headingSourceLines('# One\n\ntext\n\n## Two\n')).toEqual([1, 5]);
  });

  it('skips headings inside fenced code blocks', () => {
    const md = '# Real\n\n```\n# not a heading\n```\n\n## Also real\n';
    expect(headingSourceLines(md)).toEqual([1, 7]);
  });

  it('handles tilde fences and up-to-3-space indents', () => {
    const md = '~~~\n# fenced\n~~~\n   ## indented heading\n';
    expect(headingSourceLines(md)).toEqual([4]);
  });

  it('requires whitespace after the hashes (not #hashtag)', () => {
    expect(headingSourceLines('#nospace\n# yes\n')).toEqual([2]);
  });
});

// --- path normalization (Windows-safe path handling, finding #2) -----------

describe('isAbsolutePath', () => {
  it('recognizes POSIX, Windows drive, and UNC absolute paths', () => {
    expect(isAbsolutePath('/repo/a.md')).toBe(true);
    expect(isAbsolutePath('C:\\repo\\a.md')).toBe(true);
    expect(isAbsolutePath('c:/repo/a.md')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share\\a.md')).toBe(true);
  });

  it('treats relative paths as not absolute', () => {
    expect(isAbsolutePath('src/a.md')).toBe(false);
    expect(isAbsolutePath('./a.md')).toBe(false);
    expect(isAbsolutePath('a.md')).toBe(false);
  });
});

describe('normalizePathForCompare', () => {
  it('unifies separators and lowercases the drive letter', () => {
    expect(normalizePathForCompare('C:\\Repo\\src\\a.md')).toBe('c:/Repo/src/a.md');
    expect(normalizePathForCompare('c:/repo/a.md')).toBe('c:/repo/a.md');
  });

  it('collapses duplicate separators and drops a trailing slash', () => {
    expect(normalizePathForCompare('/repo//src/')).toBe('/repo/src');
    expect(normalizePathForCompare('C:\\repo\\')).toBe('c:/repo');
  });

  it('makes mixed-separator joins compare equal to the native path', () => {
    // A bad join produced "C:\repo/src/a.md"; the tree reports "C:\repo\src\a.md".
    expect(normalizePathForCompare('C:\\repo/src/a.md')).toBe(
      normalizePathForCompare('C:\\repo\\src\\a.md'),
    );
  });

  it('keeps the bare POSIX root as "/"', () => {
    expect(normalizePathForCompare('/')).toBe('/');
  });
});

describe('toRelativePath', () => {
  it('strips a POSIX root', () => {
    expect(toRelativePath('/repo/src/a.md', '/repo')).toBe('src/a.md');
  });

  it('strips a Windows root and returns forward slashes (git form)', () => {
    expect(toRelativePath('C:\\repo\\src\\a.md', 'C:\\repo')).toBe('src/a.md');
    // git top-level uses forward slashes even when the abs path uses backslashes.
    expect(toRelativePath('C:\\repo\\src\\a.md', 'c:/repo')).toBe('src/a.md');
  });

  it('returns null when the path is outside the root', () => {
    expect(toRelativePath('/other/a.md', '/repo')).toBeNull();
    expect(toRelativePath('C:\\other\\a.md', 'C:\\repo')).toBeNull();
  });

  it('passes relative and empty inputs through', () => {
    expect(toRelativePath('src/a.md', '/repo')).toBe('src/a.md');
    expect(toRelativePath(null, '/repo')).toBeNull();
  });
});

describe('joinPath', () => {
  it('joins with the root separator (POSIX)', () => {
    expect(joinPath('/repo', 'src/a.md')).toBe('/repo/src/a.md');
  });

  it('joins onto a Windows root as backslashes, matching native tree paths', () => {
    expect(joinPath('C:\\repo', 'src/a.md')).toBe('C:\\repo\\src\\a.md');
    expect(joinPath('C:\\repo\\', 'src/a.md')).toBe('C:\\repo\\src\\a.md');
  });

  it('leaves an already-absolute rel untouched', () => {
    expect(joinPath('/repo', '/abs/a.md')).toBe('/abs/a.md');
    expect(joinPath('C:\\repo', 'D:\\a.md')).toBe('D:\\a.md');
  });
});

describe('isUnderRoot (Windows)', () => {
  it('matches nested Windows paths regardless of separator or drive case', () => {
    expect(isUnderRoot('C:\\repo\\src\\a.md', 'C:\\repo')).toBe(true);
    expect(isUnderRoot('c:/repo/src/a.md', 'C:\\repo')).toBe(true);
    expect(isUnderRoot('C:\\repo', 'c:/repo')).toBe(true);
  });

  it('does not match a Windows sibling prefix', () => {
    expect(isUnderRoot('C:\\repo-old\\a.md', 'C:\\repo')).toBe(false);
  });
});
