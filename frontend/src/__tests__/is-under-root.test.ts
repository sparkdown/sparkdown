import { describe, it, expect } from 'vitest';
import { isUnderRoot } from '../utils';

describe('isUnderRoot', () => {
  it('treats the root itself as under the root', () => {
    expect(isUnderRoot('/proj', '/proj')).toBe(true);
  });

  it('matches nested files and dirs', () => {
    expect(isUnderRoot('/proj/src/app.ts', '/proj')).toBe(true);
    expect(isUnderRoot('/proj/src', '/proj')).toBe(true);
  });

  it('does not match a sibling prefix (e.g. /proj-old)', () => {
    expect(isUnderRoot('/proj-old/a.md', '/proj')).toBe(false);
    expect(isUnderRoot('/other/a.md', '/proj')).toBe(false);
  });

  it("rejects any input still containing a '.' or '..' segment", () => {
    // Regression: a string-prefix check would accept this path because it
    // starts with '/proj/', but the '..' escapes the root.
    expect(isUnderRoot('/proj/sub/../../etc/hosts', '/proj')).toBe(false);
    expect(isUnderRoot('/proj/./a.md', '/proj')).toBe(false);
    expect(isUnderRoot('/proj/..', '/proj')).toBe(false);
  });
});
