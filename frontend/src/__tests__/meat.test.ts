import { describe, it, expect } from 'vitest';
import {
  classifyFile,
  partitionChanges,
  classifyHunk,
  parseHunks,
  abridgeHunks,
  noiseReasonLabel,
  type DiffHunk,
  type NoiseReason,
} from '../meat';
// Shared cross-language fixture (also consumed by src-tauri/src/meat.rs via
// include_str!). Imported as JSON so it needs no Node types and is not pulled
// into the app bundle.
import meatCasesFixture from '../../../src-tauri/tests-fixtures/meat-cases.json';

/**
 * Tests for the "meat" heuristics: file relevance (classifyFile /
 * partitionChanges) and the reading-diff abridger (classifyHunk / parseHunks /
 * abridgeHunks). Pure functions, no DOM.
 */

describe('classifyFile', () => {
  it('treats ordinary source files as meat', () => {
    expect(classifyFile('src/app.ts').meat).toBe(true);
    expect(classifyFile('./frontend/src/meat.ts').meat).toBe(true);
    expect(classifyFile('README.md').meat).toBe(true);
  });

  it('flags lockfiles as noise', () => {
    for (const f of [
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'Cargo.lock',
      'go.sum',
      'poetry.lock',
    ]) {
      const v = classifyFile(f);
      expect(v.meat, f).toBe(false);
      expect(v.reason, f).toBe('lockfile');
    }
  });

  it('flags files inside generated/vendored directories as noise', () => {
    expect(classifyFile('node_modules/left-pad/index.js').reason).toBe('dependency');
    expect(classifyFile('vendor/foo/bar.go').reason).toBe('dependency');
    expect(classifyFile('dist/bundle.js').reason).toBe('build-output');
    expect(classifyFile('frontend/dist/app.js').reason).toBe('build-output');
    expect(classifyFile('target/debug/thing').reason).toBe('build-output');
    expect(classifyFile('coverage/lcov.info').reason).toBe('build-output');
  });

  it('flags source maps, minified bundles, snapshots, and generated files', () => {
    expect(classifyFile('src/app.js.map').reason).toBe('sourcemap');
    expect(classifyFile('lib/vendor.min.js').reason).toBe('minified');
    expect(classifyFile('styles/site.min.css').reason).toBe('minified');
    expect(classifyFile('__tests__/x.test.ts.snap').reason).toBe('snapshot');
    expect(classifyFile('src/schema.generated.ts').reason).toBe('generated');
    expect(classifyFile('src/proto.gen.js').reason).toBe('generated');
    expect(classifyFile('types/index.d.ts').reason).toBe('generated');
  });

  it('flags OS cruft (.DS_Store, Thumbs.db) as noise', () => {
    expect(classifyFile('.DS_Store').reason).toBe('os-cruft');
    expect(classifyFile('src/.DS_Store').reason).toBe('os-cruft');
    expect(classifyFile('Thumbs.db').reason).toBe('os-cruft');
    expect(classifyFile('folder/desktop.ini').reason).toBe('os-cruft');
  });

  it('does not treat a directory merely containing a noise word elsewhere as noise', () => {
    // "distribution" is not "dist"; a segment match is exact.
    expect(classifyFile('src/distribution/logic.ts').meat).toBe(true);
    expect(classifyFile('src/building/frame.ts').meat).toBe(true);
  });

  it('handles backslash paths', () => {
    expect(classifyFile('node_modules\\pkg\\index.js').reason).toBe('dependency');
  });
});

describe('partitionChanges', () => {
  it('splits meat from noise while preserving order and attaching reasons', () => {
    const changes = [
      { path: 'src/a.ts' },
      { path: 'package-lock.json' },
      { path: 'src/b.ts' },
      { path: 'dist/out.js' },
    ];
    const { meat, noise } = partitionChanges(changes);
    expect(meat.map((c) => c.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(noise.map((c) => c.path)).toEqual(['package-lock.json', 'dist/out.js']);
    expect(noise.map((c) => c.reason)).toEqual(['lockfile', 'build-output']);
  });

  it('keeps extra fields on partitioned items', () => {
    const { meat } = partitionChanges([{ path: 'src/a.ts', status: 'modified' }]);
    expect(meat[0].status).toBe('modified');
  });
});

describe('noiseReasonLabel', () => {
  it('gives a human label for every reason', () => {
    expect(noiseReasonLabel('sourcemap')).toBe('source map');
    expect(noiseReasonLabel('build-output')).toBe('build output');
    expect(noiseReasonLabel('dependency')).toBe('dependency');
  });
});

describe('classifyHunk', () => {
  const hunk = (lines: string[]): DiffHunk => ({ header: '@@ -1 +1 @@', lines });

  it('classifies a real code change as substantive', () => {
    expect(classifyHunk(hunk([' ctx', '-const x = 1', '+const x = 2']))).toBe(
      'substantive',
    );
  });

  it('classifies pure reindentation as whitespace', () => {
    expect(classifyHunk(hunk(['-  foo()', '+    foo()']))).toBe('whitespace');
  });

  it('never folds a reorder as formatting', () => {
    // Moved lines can change behaviour (statement order), so a reorder is
    // substantive; a reordered import block is 'import'.
    expect(classifyHunk(hunk(['-a', '-b', '+b', '+a']))).toBe('substantive');
    expect(
      classifyHunk(hunk(["-import { a } from './a';", "-import { c } from './c';", "+import { c } from './c';", "+import { a } from './a';"])),
    ).toBe('import');
  });

  it('treats spacing inside a line and re-wrapping as whitespace', () => {
    expect(classifyHunk(hunk(['-f(a, b);', '+f( a, b );']))).toBe('whitespace');
    expect(classifyHunk(hunk(['-call(alpha, beta);', '+call(alpha,', '+     beta);']))).toBe('whitespace');
  });

  it('classifies import-only changes as import', () => {
    expect(
      classifyHunk(hunk(["+import { x } from './x'", "-import { y } from './y'"])),
    ).toBe('import');
    expect(classifyHunk(hunk(['+use std::io;', '+use std::fmt;']))).toBe('import');
    expect(classifyHunk(hunk(['+#include <stdio.h>']))).toBe('import');
  });

  it('classifies a multi-line import statement as import', () => {
    expect(
      classifyHunk(
        hunk([
          "+import {",
          '+  partitionChanges,',
          '+  noiseReasonLabel,',
          "+} from './meat';",
        ]),
      ),
    ).toBe('import');
  });

  it('a brace-less import does not swallow the code lines after it', () => {
    // Python-style import opens no brace span; the real code line after it
    // must keep the hunk substantive.
    expect(classifyHunk(hunk(['+import os', '+do_real_thing()']))).toBe(
      'substantive',
    );
  });

  it('classifies blank-line-only changes as whitespace', () => {
    expect(classifyHunk(hunk(['+', '+', ' ctx']))).toBe('whitespace');
    expect(classifyHunk(hunk(['-', '-']))).toBe('whitespace');
  });

  it('a hunk mixing imports and real code is substantive', () => {
    expect(
      classifyHunk(hunk(["+import x from 'x'", '+doRealThing()'])),
    ).toBe('substantive');
  });

  it('a hunk with no +/- lines is whitespace (nothing to read)', () => {
    expect(classifyHunk(hunk([' ctx1', ' ctx2']))).toBe('whitespace');
  });
});

describe('parseHunks', () => {
  it('splits body lines into hunks keyed by @@ headers', () => {
    const hunks = parseHunks([
      '@@ -1 +1 @@',
      '+a',
      '@@ -5 +5 @@',
      '-b',
      '+c',
    ]);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].header).toBe('@@ -1 +1 @@');
    expect(hunks[0].lines).toEqual(['+a']);
    expect(hunks[1].lines).toEqual(['-b', '+c']);
  });

  it('keeps pre-hunk lines in a leading headerless hunk (nothing dropped)', () => {
    const hunks = parseHunks(['stray', '@@ -1 +1 @@', '+a']);
    expect(hunks[0].header).toBe('');
    expect(hunks[0].lines).toEqual(['stray']);
    expect(hunks[1].header).toBe('@@ -1 +1 @@');
  });
});

describe('abridgeHunks', () => {
  const H = (header: string, lines: string[]): DiffHunk => ({ header, lines });

  it('passes substantive hunks through untouched', () => {
    const hunks = [H('@@ a @@', ['-x', '+y'])];
    const parts = abridgeHunks(hunks);
    expect(parts).toHaveLength(1);
    expect(parts[0].kind).toBe('hunk');
  });

  it('folds a run of import-only hunks into one omitted placeholder', () => {
    const hunks = [
      H('@@ a @@', ["+import a from 'a'"]),
      H('@@ b @@', ["+import b from 'b'"]),
    ];
    const parts = abridgeHunks(hunks);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ kind: 'omitted', count: 2, reason: 'import' });
  });

  it('folds noise but keeps substantive hunks in order', () => {
    const hunks = [
      H('@@ a @@', ["+import a from 'a'"]), // import
      H('@@ b @@', ['-real()', '+realNew()']), // substantive
      H('@@ c @@', ['-  x', '+    x']), // whitespace
      H('@@ d @@', ['-  y', '+    y']), // whitespace
    ];
    const parts = abridgeHunks(hunks);
    expect(parts.map((p) => p.kind)).toEqual(['omitted', 'hunk', 'omitted']);
    expect(parts[2]).toMatchObject({ kind: 'omitted', count: 2 });
  });

  it('returns nothing but omitted parts when a diff is all noise', () => {
    const hunks = [H('@@ a @@', ["+import a from 'a'"])];
    const parts = abridgeHunks(hunks);
    expect(parts.every((p) => p.kind === 'omitted')).toBe(true);
  });
});

describe('shared fixture (kept in sync with meat.rs)', () => {
  // The SAME cases run in src-tauri/src/meat.rs, so the Rust and TS ports can't
  // drift on case-insensitive dir matching, the import end-anchor, ASCII word
  // chars, or `\r` handling. Read at runtime (the fixture lives outside src/).
  interface FileCase {
    path: string;
    verdict: NoiseReason | null;
  }
  interface HunkCase {
    kind: 'substantive' | 'import' | 'whitespace';
    lines: string[];
  }
  const cases = meatCasesFixture as unknown as {
    files: FileCase[];
    hunks: HunkCase[];
  };

  it('classifies every fixture file the same as the Rust port', () => {
    for (const c of cases.files) {
      const v = classifyFile(c.path);
      if (c.verdict === null) {
        expect(v.meat, c.path).toBe(true);
      } else {
        expect(v.meat, c.path).toBe(false);
        expect(v.reason, c.path).toBe(c.verdict);
      }
    }
  });

  it('classifies every fixture hunk the same as the Rust port', () => {
    for (const c of cases.hunks) {
      const hunk: DiffHunk = { header: '@@ -1 +1 @@', lines: c.lines };
      expect(classifyHunk(hunk), JSON.stringify(c.lines)).toBe(c.kind);
    }
  });
});
