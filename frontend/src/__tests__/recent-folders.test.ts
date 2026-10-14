import { describe, it, expect, vi, beforeEach } from 'vitest';

const windowNumbersFor = vi.fn();
vi.mock('../api', () => ({ api: { windowNumbersFor: (s: string[]) => windowNumbersFor(s) } }));
const mac = { value: false };
vi.mock('../utils', async (orig) => ({ ...(await orig<object>()), isMacOS: () => mac.value }));

import {
  markRecents,
  recentFolderCommands,
  recentName,
  wantsNewWindow,
  newWindowClickLabel,
  RecentFolderCommands,
} from '../app/recent-folders';
import { CommandRegistry } from '../commands';

describe('recent folders across windows (#66)', () => {
  beforeEach(() => {
    windowNumbersFor.mockReset();
    mac.value = false;
  });

  it('marks recents with the window that has them open', async () => {
    windowNumbersFor.mockResolvedValue([2, null]);
    expect(await markRecents(['/a', 'ssh://h/b'])).toEqual([
      { spec: '/a', window: 2 },
      { spec: 'ssh://h/b', window: null },
    ]);
  });

  it('treats a failed lookup as "not open" and skips an empty list', async () => {
    windowNumbersFor.mockRejectedValue(new Error('x'));
    expect(await markRecents(['/a'])).toEqual([{ spec: '/a', window: null }]);
    expect(await markRecents([])).toEqual([]);
    expect(windowNumbersFor).toHaveBeenCalledTimes(1);
  });

  it('uses Cmd on macOS and Ctrl elsewhere as the new-window modifier', () => {
    expect(wantsNewWindow({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(wantsNewWindow({ metaKey: true, ctrlKey: false })).toBe(false);
    expect(newWindowClickLabel()).toBe('Ctrl+Click');
    mac.value = true;
    expect(wantsNewWindow({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(wantsNewWindow({ metaKey: false, ctrlKey: true })).toBe(false);
    expect(newWindowClickLabel()).toBe('⌘ Click');
  });

  it('names local and remote recents', () => {
    expect(recentName('/home/me/proj/')).toBe('proj');
    expect(recentName('ssh://box/srv/site')).toBe('site (box)');
  });

  it('palette commands say which window has the folder and open it', () => {
    const open = vi.fn();
    const cmds = recentFolderCommands(
      [
        { spec: '/a/p1', window: 1 },
        { spec: '/a/p2', window: null },
      ],
      open,
    );
    expect(cmds.map((c) => c.title)).toEqual(['Open recent: p1 — open in window 1', 'Open recent: p2']);
    cmds[0].run();
    expect(open).toHaveBeenCalledWith('/a/p1');
  });

  it('refresh replaces the previous recent commands', async () => {
    const reg = new CommandRegistry();
    let recents = ['/x/one', '/x/two'];
    windowNumbersFor.mockImplementation(async (s: string[]) => s.map(() => null));
    const rc = new RecentFolderCommands(reg, () => recents, vi.fn());
    await rc.refresh();
    expect(reg.list()).toHaveLength(2);
    recents = ['/x/three'];
    await rc.refresh();
    expect(reg.list().map((c) => c.title)).toEqual(['Open recent: three']);
  });
});
