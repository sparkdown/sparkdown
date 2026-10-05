import { describe, it, expect } from 'vitest';
import { isTextFile } from '../file-types';

describe('isTextFile', () => {
  it('accepts known text/code/data extensions', () => {
    for (const name of [
      'a.md', 'a.markdown', 'a.mkd',
      'a.txt', 'a.csv', 'a.json',
      'a.yml', 'a.yaml',
      'a.js', 'a.ts', 'a.jsx', 'a.tsx',
      'a.html', 'a.css', 'a.svg', 'a.xml',
    ]) {
      expect(isTextFile(name), name).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isTextFile('README.MD')).toBe(true);
    expect(isTextFile('Component.TSX')).toBe(true);
  });

  it('rejects unknown / binary extensions', () => {
    for (const name of ['a.png', 'a.pdf', 'a.zip', 'a.exe', 'a']) {
      expect(isTextFile(name), name).toBe(false);
    }
  });

  it('only matches the trailing extension', () => {
    expect(isTextFile('archive.md.zip')).toBe(false);
    expect(isTextFile('notes.txt')).toBe(true);
  });
});
