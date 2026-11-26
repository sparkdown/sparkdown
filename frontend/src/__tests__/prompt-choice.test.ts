import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), open: vi.fn(), save: vi.fn() }));
import { promptChoice } from '../app/documents';

const unsaved = { yes: 'Save', no: "Don't Save", cancel: 'Cancel' };
const conflict = { yes: 'Overwrite', no: 'Reload', cancel: 'Cancel' };

describe('promptChoice', () => {
  it('reads the clicked button from its label, as the dialog plugin answers', () => {
    expect(promptChoice('Save', unsaved)).toBe('Yes');
    expect(promptChoice("Don't Save", unsaved)).toBe('No');
    expect(promptChoice('Cancel', unsaved)).toBe('Cancel');
    expect(promptChoice('Overwrite', conflict)).toBe('Yes');
    expect(promptChoice('Reload', conflict)).toBe('No');
  });

  it('accepts the standard answer names too', () => {
    expect(promptChoice('Yes', unsaved)).toBe('Yes');
    expect(promptChoice('No', unsaved)).toBe('No');
  });

  it('answers Cancel for a closed dialog or anything unknown', () => {
    for (const r of [undefined, null, '', 'Ok', 'save', 'Reload', 42]) {
      expect(promptChoice(r, unsaved)).toBe('Cancel');
    }
  });
});
