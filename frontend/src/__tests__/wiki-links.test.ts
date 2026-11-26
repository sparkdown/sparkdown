import { describe, it, expect } from 'vitest';
import {
  WikiIndex,
  backlinkQuery,
  extractWikiLinks,
  findBacklinks,
  normalizeWikiTarget,
  relativeHref,
  resolveWikiTarget,
  wikiRenderFor,
} from '../wiki-links';

const files = [
  'Home.md',
  'notes/Ideas.md',
  'notes/Home.md',
  'notes/deep/Ideas.md',
  'archive/2020/Ideas.markdown',
  'projects/Plan.md',
  'projects/sub/Plan.md',
  'assets/diagram.svg',
  'My Notes/Read Me.md',
];
const index = new WikiIndex(files);

describe('extractWikiLinks', () => {
  it('reads targets and labels, skipping code spans', () => {
    expect(extractWikiLinks('see [[Ideas]] and [[notes/Home|the home]] but not `[[Code]]`')).toEqual([
      { target: 'Ideas', label: 'Ideas' },
      { target: 'notes/Home', label: 'the home' },
    ]);
  });

  it('ignores empty or unclosed brackets', () => {
    expect(extractWikiLinks('[[ ]] [[open and [single]')).toEqual([]);
  });
});

describe('resolveWikiTarget', () => {
  it('matches a note by name without extension, ignoring case', () => {
    expect(resolveWikiTarget('plan', index, 'Home.md')).toEqual({ kind: 'found', rel: 'projects/Plan.md' });
  });

  it('prefers the linking file folder, then the shallowest path', () => {
    expect(resolveWikiTarget('Home', index, 'notes/Ideas.md')).toEqual({ kind: 'found', rel: 'notes/Home.md' });
    expect(resolveWikiTarget('Home', index, 'projects/Plan.md')).toEqual({ kind: 'found', rel: 'Home.md' });
    expect(resolveWikiTarget('Ideas', index, 'notes/deep/Ideas.md')).toEqual({
      kind: 'found',
      rel: 'notes/deep/Ideas.md',
    });
    expect(resolveWikiTarget('Ideas', index, 'Home.md')).toEqual({ kind: 'found', rel: 'notes/Ideas.md' });
  });

  it('matches an exact file name with an extension', () => {
    expect(resolveWikiTarget('diagram.svg', index, 'Home.md')).toEqual({ kind: 'found', rel: 'assets/diagram.svg' });
    expect(resolveWikiTarget('Plan.md', index, 'projects/sub/Plan.md')).toEqual({
      kind: 'found',
      rel: 'projects/sub/Plan.md',
    });
  });

  it('resolves a path against the file folder first, then the workspace root', () => {
    expect(resolveWikiTarget('sub/Plan', index, 'projects/Plan.md')).toEqual({
      kind: 'found',
      rel: 'projects/sub/Plan.md',
    });
    expect(resolveWikiTarget('notes/Ideas', index, 'projects/Plan.md')).toEqual({
      kind: 'found',
      rel: 'notes/Ideas.md',
    });
    expect(resolveWikiTarget('archive/2020/ideas', index, 'Home.md')).toEqual({
      kind: 'found',
      rel: 'archive/2020/Ideas.markdown',
    });
  });

  it('ignores a #heading part and handles spaces', () => {
    expect(resolveWikiTarget('Read Me#Setup', index, 'Home.md')).toEqual({
      kind: 'found',
      rel: 'My Notes/Read Me.md',
    });
  });

  it('places a missing note next to the file, or at the path under the root', () => {
    expect(resolveWikiTarget('New Idea', index, 'notes/Ideas.md')).toEqual({
      kind: 'missing',
      rel: 'notes/New Idea.md',
    });
    expect(resolveWikiTarget('v1.2 notes', index, 'Home.md')).toEqual({ kind: 'missing', rel: 'v1.2 notes.md' });
    expect(resolveWikiTarget('drafts/Later', index, 'notes/Ideas.md')).toEqual({
      kind: 'missing',
      rel: 'drafts/Later.md',
    });
  });

  it('refuses targets that leave the folder or are not file names', () => {
    for (const t of ['../outside', 'a/../../b', '/etc/hosts', 'C:/x', 'a//b', 'what?', '#only-heading', './x']) {
      expect(resolveWikiTarget(t, index, 'Home.md')).toEqual({ kind: 'invalid' });
    }
    expect(normalizeWikiTarget('notes\\Ideas')).toBe('notes/Ideas');
  });
});

describe('relativeHref', () => {
  it('walks up and down from the linking file, percent-encoding names', () => {
    expect(relativeHref('Home.md', 'notes/Ideas.md')).toBe('./notes/Ideas.md');
    expect(relativeHref('notes/deep/Ideas.md', 'projects/Plan.md')).toBe('../../projects/Plan.md');
    expect(relativeHref('notes/Ideas.md', 'notes/Home.md')).toBe('./Home.md');
    expect(relativeHref('Home.md', 'My Notes/Read Me.md')).toBe('./My%20Notes/Read%20Me.md');
  });
});

describe('wikiRenderFor', () => {
  it('marks missing notes and offers to create them', () => {
    expect(wikiRenderFor('Nope', index, 'notes/Ideas.md')).toEqual({
      kind: 'link',
      href: './Nope.md',
      missing: true,
      title: 'Create notes/Nope.md',
    });
  });

  it('without an index, points next to the file without a missing mark', () => {
    expect(wikiRenderFor('Some Note', null, '')).toEqual({
      kind: 'link',
      href: './Some%20Note.md',
      missing: false,
      title: 'Some Note.md',
    });
    expect(wikiRenderFor('../x', null, '').kind).toBe('text');
  });
});

describe('backlinks', () => {
  it('builds a query that finds candidate lines', () => {
    const re = new RegExp(backlinkQuery('notes/Ideas.md'), 'i');
    expect(re.test('see [[ideas]] here')).toBe(true);
    expect(re.test('see [[notes/Ideas|x]]')).toBe(true);
    expect(re.test('plain Ideas')).toBe(false);
    expect(backlinkQuery('a/v1.2 (draft).md')).toBe('\\[\\[[^\\]\\n]*v1\\.2 \\(draft\\)');
  });

  it('keeps only lines whose links resolve to the file', () => {
    const hits = findBacklinks(
      [
        { rel: 'projects/Plan.md', path: '/w/projects/Plan.md', line: 3, preview: 'see [[Ideas]]' },
        // Resolves to its own folder's Ideas, not notes/Ideas.md.
        { rel: 'notes/deep/x.md', path: '/w/notes/deep/x.md', line: 1, preview: '[[Ideas]]' },
        { rel: 'notes/Ideas.md', path: '/w/notes/Ideas.md', line: 1, preview: '[[Ideas]]' },
        { rel: 'Home.md', path: '/w/Home.md', line: 9, preview: '[[notes/Ideas|ideas]] and [[Plan]]' },
        { rel: 'code.txt', path: '/w/code.txt', line: 1, preview: '[[Ideas]]' },
        { rel: null, path: '/elsewhere/a.md', line: 1, preview: '[[Ideas]]' },
        { rel: 'Home.md', path: '/w/Home.md', line: 2, preview: '`[[Ideas]]`' },
      ],
      index,
      'notes/Ideas.md',
    );
    expect(hits.map((h) => `${h.rel}:${h.line}`)).toEqual(['Home.md:9', 'projects/Plan.md:3']);
  });

  it('indexes and resolves a large folder quickly', () => {
    const big: string[] = [];
    for (let i = 0; i < 50_000; i++) big.push(`d${i % 200}/sub${i % 7}/note-${i}.md`);
    const t0 = performance.now();
    const bigIndex = new WikiIndex(big);
    for (let i = 0; i < 2_000; i++) resolveWikiTarget(`note-${i * 13}`, bigIndex, 'd1/sub1/x.md');
    const sources = Array.from({ length: 500 }, (_, i) => ({
      rel: `d${i % 200}/sub0/note-${i}.md`,
      path: `/w/d${i % 200}/sub0/note-${i}.md`,
      line: 1,
      preview: `[[note-42]] [[note-${i}]]`,
    }));
    const found = findBacklinks(sources, bigIndex, 'd42/sub0/note-42.md');
    const elapsed = performance.now() - t0;
    expect(found.length).toBe(499);
    expect(elapsed).toBeLessThan(1500);
  });
});
