import { describe, expect, it } from 'vitest';
import { changesFileList } from '../file-list-changes';
import type { FsChange } from '../api';

const change = (path: string, kind: string): FsChange => ({ path, kind });

describe('changesFileList', () => {
  it('is false for content writes only', () => {
    expect(changesFileList([change('/r/a.md', 'modify'), change('/r/b.md', 'modify')])).toBe(false);
  });

  it('is true for a create, remove or rename', () => {
    expect(changesFileList([change('/r/a.md', 'modify'), change('/r/new.md', 'create')])).toBe(true);
    expect(changesFileList([change('/r/old.md', 'remove')])).toBe(true);
  });

  it('is true when a .gitignore is written, at any depth', () => {
    expect(changesFileList([change('/r/.gitignore', 'modify')])).toBe(true);
    expect(changesFileList([change('/r/docs/.gitignore', 'modify')])).toBe(true);
  });

  it('is false for an empty batch', () => {
    expect(changesFileList([])).toBe(false);
  });
});
