import { describe, it, expect } from 'vitest';
import {
  alignHunkRows,
  firstChangedLine,
  nearestHeading,
  parseDiffLayout,
  parseHunkHeader,
  renderUnifiedDiff,
  summarizeDiff
} from '../changes-view';
import type { DiffHunk } from '../meat';

/**
 * Tests for the dependency-free unified-diff renderer. It must classify each
 * line (hunk / add / del / context), drop the file-header preamble, and escape
 * HTML so diff content can't inject markup.
 */
describe('renderUnifiedDiff', () => {
  it('shows a friendly message for an empty diff', () => {
    expect(renderUnifiedDiff('')).toContain('No textual changes');
    expect(renderUnifiedDiff('   \n  ')).toContain('No textual changes');
  });

  it('classifies added, removed, context, and hunk lines', () => {
    const diff = ['@@ -1,3 +1,3 @@', ' context', '-removed', '+added'].join('\n');
    const html = renderUnifiedDiff(diff);
    expect(html).toContain('diff-hunk');
    expect(html).toContain('diff-context');
    expect(html).toContain('diff-del');
    expect(html).toContain('diff-add');
  });

  it('labels a re-indented hunk "whitespace only" in Reading and not in Full', () => {
    const diff = [
      '@@ -1,2 +1,2 @@',
      ' def run(job):',
      '-        start(job)',
      '+    start(job)',
      '@@ -20 +20 @@',
      '-return 1',
      '+return 2',
    ].join('\n');
    const reading = renderUnifiedDiff(diff);
    expect(reading.match(/diff-hunk-note/g)).toHaveLength(1);
    expect(reading).toContain('whitespace only');
    expect(reading).toContain('start(job)');
    const full = renderUnifiedDiff(diff, { reading: false });
    expect(full).not.toContain('diff-hunk-note');
  });

  it('drops the git file-header preamble', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      'index 123..456 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      '+hello',
    ].join('\n');
    const html = renderUnifiedDiff(diff);
    expect(html).not.toContain('diff --git');
    expect(html).not.toContain('index 123');
    expect(html).not.toContain('--- a/x.ts');
    expect(html).not.toContain('+++ b/x.ts');
    expect(html).toContain('hello');
  });

  it('shows direction characters in a hunk header as visible markers', () => {
    const diff = ['@@ -1 +1 @@ fn a\u202Eb()', '-x', '+y'].join('\n');
    const html = renderUnifiedDiff(diff);
    expect(html).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/);
    expect(html).toContain('&lt;U+202E&gt;');
  });

  it('escapes HTML in diff content (no injection)', () => {
    const diff = ['@@ -1 +1 @@', '+<script>alert(1)</script>'].join('\n');
    const html = renderUnifiedDiff(diff);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('notes when the reading diff has nothing to fold (Reading == Full)', () => {
    const substantive = ['@@ -1 +1 @@', '-old()', '+new()'].join('\n');
    expect(renderUnifiedDiff(substantive, { reading: true })).toContain('diff-note');
    expect(renderUnifiedDiff(substantive, { reading: false })).not.toContain('diff-note');
  });

  it('folds import-only hunks behind a placeholder in reading mode', () => {
    const diff = [
      '@@ -1 +1 @@',
      "+import { x } from './x';",
      '@@ -10 +10 @@',
      '-old()',
      '+new()',
    ].join('\n');
    const reading = renderUnifiedDiff(diff, { reading: true });
    expect(reading).toContain('diff-omitted');
    expect(reading).not.toContain('import { x }');
    const full = renderUnifiedDiff(diff, { reading: false });
    expect(full).not.toContain('diff-omitted');
    expect(full).toContain('import { x }');
  });

  it('does not misclassify the +++/--- headers as add/del lines', () => {
    // The +++ and --- header lines start with + / - but must be dropped,
    // not rendered as additions/deletions.
    const diff = ['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-old', '+new'].join('\n');
    const html = renderUnifiedDiff(diff);
    // Exactly one add and one del line (the real change), not three.
    expect((html.match(/diff-add/g) || []).length).toBe(1);
    expect((html.match(/diff-del/g) || []).length).toBe(1);
  });

  it('keeps hunk-body lines whose content starts with "-- " or "++ "', () => {
    // git emits a removed `-- comment` line as `--- comment` in the hunk
    // body and an added `++ marker` line as `+++ marker`. These must NOT be
    // treated as file-header preamble — they are real content and have to
    // show up in both Reading and Full mode and be counted in the summary.
    const diff = [
      'diff --git a/x.sql b/x.sql',
      '--- a/x.sql',
      '+++ b/x.sql',
      '@@ -1,3 +1,3 @@',
      ' SELECT 1;',
      '--- DROP TABLE users;',
      '+++ added marker',
      ' keep',
    ].join('\n');
    const full = renderUnifiedDiff(diff, { reading: false });
    expect(full).toContain('DROP TABLE users;');
    expect(full).toContain('added marker');
    expect((full.match(/diff-del/g) || []).length).toBe(1);
    expect((full.match(/diff-add/g) || []).length).toBe(1);
    // The file-header `--- a/x.sql` / `+++ b/x.sql` preamble is still dropped.
    expect(full).not.toContain('a/x.sql');
    expect(full).not.toContain('b/x.sql');
    const reading = renderUnifiedDiff(diff, { reading: true });
    expect(reading).toContain('DROP TABLE users;');
    expect(reading).toContain('added marker');
    expect(summarizeDiff(diff)).toEqual({ hunks: 1, adds: 1, dels: 1, firstLine: 2 });
  });
});

describe('hunk helpers (open in editor, hunk labels)', () => {
  it('parses hunk headers with and without counts and context', () => {
    expect(parseHunkHeader('@@ -10,6 +12,8 @@ fn main() {')).toEqual({
      oldStart: 10,
      newStart: 12,
      context: 'fn main() {',
    });
    expect(parseHunkHeader('@@ -1 +1 @@')).toEqual({ oldStart: 1, newStart: 1, context: '' });
    expect(parseHunkHeader('not a header')).toBeNull();
  });

  it('maps a hunk to the new-file line of its first change', () => {
    // Three context lines, then the change: line 12 + 3 = 15.
    expect(
      firstChangedLine({ header: '@@ -10,7 +12,8 @@', lines: [' a', ' b', ' c', '-x', '+y', ' d'] }),
    ).toBe(15);
    // Added at the top.
    expect(firstChangedLine({ header: '@@ -0,0 +1,2 @@', lines: ['+a', '+b'] })).toBe(1);
    // Pure deletion: the line that now sits where the removed lines were.
    expect(firstChangedLine({ header: '@@ -5,3 +5,1 @@', lines: [' keep', '-x', '-y'] })).toBe(6);
    // Whole file deleted: never below 1.
    expect(firstChangedLine({ header: '@@ -1,2 +0,0 @@', lines: ['-a', '-b'] })).toBe(1);
    expect(firstChangedLine({ header: '', lines: ['+a'] })).toBe(1);
  });

  it('finds the nearest markdown heading, skipping fenced code', () => {
    const md = ['# Title', '', '## Tools', 'text', '```sh', '# not a heading', '```', 'more'].join('\n');
    expect(nearestHeading(md, 1)).toBe('# Title');
    expect(nearestHeading(md, 4)).toBe('## Tools');
    expect(nearestHeading(md, 8)).toBe('## Tools');
    expect(nearestHeading('plain\ntext', 2)).toBeNull();
    expect(nearestHeading('### Closed ###\nx', 2)).toBe('### Closed');
  });

  it('labels hunks by heading (markdown) or @@ context, with Open in editor', () => {
    const diff = ['@@ -2,2 +2,3 @@ ctx()', ' ## Tools', '-old', '+new', '+more'].join('\n');
    const md = '# T\n## Tools\nnew\nmore';
    const html = renderUnifiedDiff(diff, { markdown: md, reading: false });
    expect(html).toContain('## Tools · line 3');
    expect(html).toContain('data-line="3"');
    expect(html).toContain('Open in editor');
    const code = renderUnifiedDiff(diff, { reading: false });
    expect(code).toContain('ctx() · line 3');
    const noLink = renderUnifiedDiff(diff, { reading: false, openInEditor: false });
    expect(noLink).not.toContain('Open in editor');
  });

  it('summarizes hunks, counts and the first changed line', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
      '@@ -9 +9,2 @@',
      '+c',
      '+d',
      '',
    ].join('\n');
    expect(summarizeDiff(diff)).toEqual({ hunks: 2, adds: 3, dels: 1, firstLine: 2 });
    expect(summarizeDiff('')).toEqual({ hunks: 0, adds: 0, dels: 0, firstLine: 1 });
  });
});


describe('parseDiffLayout', () => {
  it('treats only "split" as side-by-side; everything else is inline', () => {
    expect(parseDiffLayout('split')).toBe('split');
    expect(parseDiffLayout('inline')).toBe('inline');
    expect(parseDiffLayout(undefined)).toBe('inline');
    expect(parseDiffLayout('stacked')).toBe('inline');
    expect(parseDiffLayout(null)).toBe('inline');
  });
});

describe('alignHunkRows', () => {
  const hunk = (header: string, lines: string[]): DiffHunk => ({ header, lines });

  it('puts context on both sides with matching line numbers', () => {
    const rows = alignHunkRows(
      hunk('@@ -10,3 +12,3 @@', [' a', '-x', '+y', ' b']),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      left: { line: ' a', lineNo: 10 },
      right: { line: ' a', lineNo: 12 },
      openLine: 12,
    });
    expect(rows[1]).toEqual({
      left: { line: '-x', lineNo: 11 },
      right: { line: '+y', lineNo: 13 },
      openLine: 13,
    });
    expect(rows[2]).toEqual({
      left: { line: ' b', lineNo: 12 },
      right: { line: ' b', lineNo: 14 },
      openLine: 14,
    });
  });

  it('zips a run of removals and additions, leaving empty cells for leftovers', () => {
    const rows = alignHunkRows(
      hunk('@@ -1,4 +1,3 @@', ['-a', '-b', '-c', '+A', '+B']),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].left.line).toBe('-a');
    expect(rows[0].right.line).toBe('+A');
    expect(rows[0].openLine).toBe(1);
    expect(rows[1].left.line).toBe('-b');
    expect(rows[1].right.line).toBe('+B');
    expect(rows[2].left.line).toBe('-c');
    expect(rows[2].right.line).toBeNull();
    expect(rows[2].openLine).toBe(3);
  });

  it('aligns leftover additions opposite an empty left cell', () => {
    const rows = alignHunkRows(hunk('@@ -9 +9,2 @@', ['+c', '+d']));
    expect(rows).toEqual([
      {
        left: { line: null, lineNo: null },
        right: { line: '+c', lineNo: 9 },
        openLine: 9,
      },
      {
        left: { line: null, lineNo: null },
        right: { line: '+d', lineNo: 10 },
        openLine: 10,
      },
    ]);
  });

  it('points a pure deletion at the new-file line that now sits there', () => {
    const rows = alignHunkRows(
      hunk('@@ -5,3 +5,1 @@', [' keep', '-x', '-y']),
    );
    expect(rows[0].openLine).toBe(5);
    expect(rows[1].left.line).toBe('-x');
    expect(rows[1].right.line).toBeNull();
    expect(rows[1].openLine).toBe(6);
    expect(rows[2].left.line).toBe('-y');
    expect(rows[2].openLine).toBe(6);
  });

  it('attaches a no-newline marker to the side it follows', () => {
    const rows = alignHunkRows(
      hunk('@@ -1 +1 @@', ['-old', '\\ No newline at end of file', '+new']),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].left.meta).toBe('\\ No newline at end of file');
    expect(rows[0].right.line).toBe('+new');
    expect(rows[0].right.meta).toBeUndefined();
  });
});

describe('renderUnifiedDiff side-by-side layout', () => {
  const diff = [
    'diff --git a/x.ts b/x.ts',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,3 +1,3 @@',
    ' context',
    '-removed',
    '+added',
  ].join('\n');

  it('aligns added and removed lines in the same row, with context on both sides', () => {
    const html = renderUnifiedDiff(diff, { reading: false, layout: 'split' });
    expect(html).toContain('diff-layout-split');
    expect(html).toContain('diff-split-row');
    // One row has both the removal and the addition.
    expect(html).toMatch(/diff-del[\s\S]*removed[\s\S]*diff-add[\s\S]*added/);
    expect(html).toContain('context');
    // File-header preamble is still dropped.
    expect(html).not.toContain('diff --git');
    expect((html.match(/diff-add/g) || []).length).toBe(1);
    expect((html.match(/diff-del/g) || []).length).toBe(1);
    // Context appears twice (left and right); left context is skipped by find.
    expect((html.match(/data-find-skip/g) || []).length).toBeGreaterThan(0);
  });

  it('keeps meat folding and the Open in editor control in split layout', () => {
    const mixed = [
      '@@ -1 +1 @@',
      "+import { x } from './x';",
      '@@ -10 +10 @@',
      '-old()',
      '+new()',
    ].join('\n');
    const reading = renderUnifiedDiff(mixed, { reading: true, layout: 'split' });
    expect(reading).toContain('diff-omitted');
    expect(reading).not.toContain('import { x }');
    expect(reading).toContain('diff-split-row');
    expect(reading).toContain('new()');
    expect(reading).toContain('Open in editor');
    expect(reading).toContain('data-line="10"');
    const full = renderUnifiedDiff(mixed, { reading: false, layout: 'split' });
    expect(full).not.toContain('diff-omitted');
    expect(full).toContain('import { x }');
  });

  it('escapes markup in split-layout content and drops Open in editor when asked', () => {
    const html = renderUnifiedDiff(['@@ -1 +1 @@', '+<script>alert(1)</script>'].join('\n'), {
      reading: false,
      layout: 'split',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    const noLink = renderUnifiedDiff(diff, {
      reading: false,
      layout: 'split',
      openInEditor: false,
    });
    expect(noLink).not.toContain('Open in editor');
    expect(noLink).not.toContain('diff-open-line');
  });

  it('renders an empty cell opposite a leftover added or removed line', () => {
    const leftover = ['@@ -1,2 +1 @@', '-a', '-b', '+A'].join('\n');
    const html = renderUnifiedDiff(leftover, { reading: false, layout: 'split' });
    expect(html).toContain('diff-blank');
    expect((html.match(/diff-del/g) || []).length).toBe(2);
    expect((html.match(/diff-add/g) || []).length).toBe(1);
  });

  it('still renders the inline layout when layout is omitted or inline', () => {
    const inline = renderUnifiedDiff(diff, { reading: false, layout: 'inline' });
    const def = renderUnifiedDiff(diff, { reading: false });
    expect(inline).not.toContain('diff-split-row');
    expect(inline).not.toContain('diff-layout-split');
    expect(def).toBe(inline);
  });
});
