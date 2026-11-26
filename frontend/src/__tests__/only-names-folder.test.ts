import { describe, it, expect } from 'vitest';
import { onlyNamesFolder } from '../utils';

describe('onlyNamesFolder', () => {
  it('is true only when every path names the folder', () => {
    expect(onlyNamesFolder(['/notes'], '/notes')).toBe(true);
    expect(onlyNamesFolder(['/notes/', '/notes'], '/notes')).toBe(true);
    expect(onlyNamesFolder(['C:\\notes\\'], 'C:/notes')).toBe(true);
    expect(onlyNamesFolder([], '/notes')).toBe(false);
    expect(onlyNamesFolder(['/notes', '/notes/a.md'], '/notes')).toBe(false);
    expect(onlyNamesFolder(['/notes2'], '/notes')).toBe(false);
    expect(onlyNamesFolder(['/'], '/')).toBe(true);
  });
});
