import { describe, it, expect } from 'vitest';
import { acceptConflictAction, acceptConflictPrompt, openHowFor } from '../accept-conflict';

describe('acceptConflictAction', () => {
  it('describes a both-modified accept clearly', () => {
    expect(acceptConflictAction('both-modified', 'ours')).toMatch(/keep our/i);
    expect(acceptConflictAction('both-modified', 'theirs')).toMatch(/keep their/i);
  });

  it('states when a delete/modify accept will delete the file', () => {
    expect(acceptConflictAction('deleted-by-them', 'theirs').toLowerCase()).toContain('delete');
    expect(acceptConflictAction('deleted-by-them', 'ours').toLowerCase()).toMatch(/keep our/);
  });
});

describe('acceptConflictPrompt', () => {
  it('names the file and warns that a copy goes to the Trash', () => {
    const { title, message, okLabel } = acceptConflictPrompt({
      path: 'README.md',
      side: 'ours',
      kind: 'both-modified',
      operation: 'merge',
    });
    expect(title).toContain('README.md');
    expect(okLabel).toBe('Accept ours');
    expect(message.toLowerCase()).toContain('trash');
  });

  it('explains the inverted ours/theirs meaning during a rebase', () => {
    const { message } = acceptConflictPrompt({
      path: 'src/app.ts',
      side: 'theirs',
      kind: 'both-modified',
      operation: 'rebase',
    });
    expect(message.toLowerCase()).toMatch(/rebase/);
    expect(message.toLowerCase()).toMatch(/rebased onto|replayed/);
  });
});

describe('openHowFor', () => {
  it('opens a conflicted file in the editor so markers are visible', () => {
    expect(openHowFor('conflicted')).toBe('editor');
    expect(openHowFor('modified')).toBe('diff');
    expect(openHowFor('untracked')).toBe('diff');
  });
});
