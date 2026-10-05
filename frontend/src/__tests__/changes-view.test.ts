import { describe, it, expect } from 'vitest';
import {
  renderUnifiedDiff,
  firstChangedLine,
  nearestHeading,
  parseHunkHeader,
  summarizeDiff,
} from '../changes-view';

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
