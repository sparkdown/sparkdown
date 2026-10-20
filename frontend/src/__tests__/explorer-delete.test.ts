import { describe, it, expect, vi } from 'vitest';
import { deleteEntry, deletePrompt, tabsUnder } from '../explorer-delete';

function deps() {
  const d = {
    ask: vi.fn(async (_m: string, _o: unknown) => true),
    deletePath: vi.fn(async (_p: string): Promise<'trashed' | 'deleted'> => 'trashed'),
    tabs: vi.fn(() => [
      { id: 'a', path: '/w/p/a.md', modified: false },
      { id: 'b', path: '/w/p/dir/b.md', modified: true },
      { id: 'c', path: '/w/p/dir/c.md', modified: false },
      { id: 'd', path: '/w/p/dirx/d.md', modified: false },
      { id: 'u', path: null, modified: true },
    ]),
    closeTab: vi.fn((_id: string) => {}),
    markGone: vi.fn(),
    refresh: vi.fn(),
    showError: vi.fn(),
  };
  return d;
}

describe('Explorer Delete (#121)', () => {
  it('asks first, naming the file, and Cancel changes nothing', async () => {
    const d = deps();
    d.ask.mockResolvedValue(false);
    expect(await deleteEntry({ path: '/w/p/a.md', isDir: false }, false, d)).toBe('cancelled');
    expect(d.ask).toHaveBeenCalledOnce();
    expect(String((d.ask.mock.calls[0] as unknown[])[0])).toContain('“a.md”');
    expect(d.deletePath).not.toHaveBeenCalled();
    expect(d.closeTab).not.toHaveBeenCalled();
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('moves to the trash, closes the clean tab and refreshes the tree', async () => {
    const d = deps();
    expect(await deleteEntry({ path: '/w/p/a.md', isDir: false }, false, d)).toBe('trashed');
    expect(d.deletePath).toHaveBeenCalledWith('/w/p/a.md');
    expect(d.closeTab).toHaveBeenCalledWith('a');
    expect(d.closeTab).toHaveBeenCalledTimes(1);
    expect(d.refresh).toHaveBeenCalledOnce();
  });

  it('a deleted folder closes clean tabs under it and keeps unsaved ones', async () => {
    const d = deps();
    await deleteEntry({ path: '/w/p/dir', isDir: true }, false, d);
    expect(d.closeTab.mock.calls.map((c: unknown[]) => c[0])).toEqual(['c']);
    expect(d.markGone).toHaveBeenCalledWith('b');
    expect(d.closeTab).not.toHaveBeenCalledWith('d'); // sibling prefix
  });

  it('a failed delete shows the error and touches no tab', async () => {
    const d = deps();
    d.deletePath.mockRejectedValue(new Error('no trash'));
    expect(await deleteEntry({ path: '/w/p/a.md', isDir: false }, false, d)).toBe('failed');
    expect(d.showError).toHaveBeenCalledOnce();
    expect(d.closeTab).not.toHaveBeenCalled();
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('says Trash locally and "permanently" on a remote folder', () => {
    expect(deletePrompt('/w/a.md', false, false)).toMatch(/Trash/);
    expect(deletePrompt('/w/a.md', false, false)).not.toMatch(/permanently/);
    expect(deletePrompt('/srv/a.md', false, true)).toMatch(/permanently/);
    expect(deletePrompt('/w/dir', true, false)).toMatch(/everything in it/);
  });

  it('matches paths separator- and drive-case-insensitively like the tabs do', () => {
    const t = [{ id: 'x', path: 'C:\\w\\p\\a.md', modified: false }];
    expect(tabsUnder(t, 'c:/w/p/a.md', false)).toHaveLength(1);
  });
});
