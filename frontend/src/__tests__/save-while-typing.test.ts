// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const disk = new Map<string, string>();
let beforeRead: (() => void) | null = null;
let beforeWrite: (() => void) | null = null;
/** Every text written, in order. */
const writes: string[] = [];
/** The 1-based write that fails, or 0. */
let failWrite = 0;
/** Like the backend's per-file limiter (commands.rs): when > 0, a write to a
 *  file within this many ms of the previous write to it was asked for is
 *  refused. */
let intervalMs = 0;
const askedAt = new Map<string, number>();
/** How long each write takes, in ms (0: a microtask). */
let writeMs = 0;
const messageMock = vi.fn(async () => 'Yes');
const saveDialogMock = vi.fn(async (): Promise<string | null> => null);

vi.mock('../api', () => ({
  api: {
    readFile: vi.fn(async (path: string) => {
      const snapshot = disk.get(path) ?? '';
      beforeRead?.();
      await Promise.resolve();
      return snapshot;
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      if (intervalMs > 0) {
        const last = askedAt.get(path);
        if (last !== undefined && Date.now() - last < intervalMs) {
          throw new Error('Rate limit exceeded, please try again shortly');
        }
        askedAt.set(path, Date.now());
      }
      if (writeMs > 0) await new Promise((r) => setTimeout(r, writeMs));
      writes.push(content);
      const n = writes.length;
      beforeWrite?.();
      await Promise.resolve();
      if (failWrite === n) throw new Error('disk full');
      disk.set(path, content);
    }),
  },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: (...args: unknown[]) => (saveDialogMock as (...a: unknown[]) => unknown)(...args),
  message: (...args: unknown[]) => (messageMock as (...a: unknown[]) => unknown)(...args),
}));

import { DocumentController, WRITE_INTERVAL_MS } from '../app/documents';
import { TabManager } from '../tabs';
import { EventBus } from '../events';

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const PATH = '/p/note.md';

/** A save controller wired to a real TabManager and a fake editor whose text
 *  `type()` changes the way a keystroke does (editor first, then the tab). */
function setup(initial: string, path: string | null = PATH) {
  document.body.innerHTML = '';
  const bus = new EventBus();
  const tabs = new TabManager(bus);
  const container = document.createElement('div');
  document.body.appendChild(container);
  tabs.init(container);
  if (path) disk.set(path, initial);
  tabs.openTab(path, initial);
  let text = initial;
  const editor = { getContent: () => text };
  const fileTree = { getSaveDir: () => '/p' };
  const ctx = { tabs, editor, fileTree } as never;
  const docs = new DocumentController(ctx, {} as never);
  const type = (next: string) => {
    text = next;
    tabs.updateContent(next);
    tabs.refreshModified();
  };
  return { docs, tabs, type };
}

describe('save while the user keeps typing', () => {
  beforeEach(() => {
    disk.clear();
    beforeRead = null;
    beforeWrite = null;
    writes.length = 0;
    failWrite = 0;
    intervalMs = 0;
    writeMs = 0;
    askedAt.clear();
    messageMock.mockClear();
    saveDialogMock.mockReset();
  });

  it('the follow-up write after a quick first write is not refused by the per-file interval', async () => {
    // A large file: typing lands during the first write, which still ends
    // within the backend's interval. The follow-up used to start right away,
    // was refused, and the tab stayed modified with the typed text not on disk.
    intervalMs = WRITE_INTERVAL_MS;
    writeMs = 10;
    const { docs, tabs, type } = setup('base');
    type('base UI');
    beforeWrite = () => {
      if (writes.length !== 1) return;
      type('base UI test');
      // Keys typed after the first write ends, while the follow-up waits.
      setTimeout(() => type('base UI test 2'), writeMs + 15);
    };
    expect(await docs.save()).toBe(true);
    expect(writes).toEqual(['base UI', 'base UI test 2']);
    expect(disk.get(PATH)).toBe('base UI test 2');
    expect(tabs.activeTab()?.modified).toBe(false);
    expect(messageMock).not.toHaveBeenCalled();
  });

  it('writes the text as it is when the disk write starts', async () => {
    const { docs, tabs, type } = setup('base');
    type('base UI');
    // Keystrokes that land while the pre-save disk check is in flight.
    beforeRead = () => type('base UI test');
    expect(await docs.save()).toBe(true);
    expect(disk.get(PATH)).toBe('base UI test');
    expect(tabs.activeTab()?.modified).toBe(false);
  });

  it('typing during the write leads to exactly one more write with the final text', async () => {
    const { docs, tabs, type } = setup('base');
    type('base UI');
    beforeWrite = () => {
      if (writes.length === 1) type('base UI test');
    };
    expect(await docs.save()).toBe(true);
    expect(writes).toEqual(['base UI', 'base UI test']);
    expect(disk.get(PATH)).toBe('base UI test');
    const tab = tabs.activeTab()!;
    expect(tab.modified).toBe(false);
    expect(tab.savedContent).toBe('base UI test');
    expect(messageMock).not.toHaveBeenCalled();
  });

  it('no typing during the write means no extra write', async () => {
    const { docs, type } = setup('base');
    type('base UI');
    expect(await docs.save()).toBe(true);
    expect(writes).toEqual(['base UI']);
  });

  it('several changes during the write still give exactly one extra write', async () => {
    const { docs, tabs, type } = setup('base');
    type('base UI');
    beforeWrite = () => {
      if (writes.length !== 1) return;
      type('base UI t');
      type('base UI te');
      type('base UI test');
    };
    expect(await docs.save()).toBe(true);
    expect(writes).toEqual(['base UI', 'base UI test']);
    expect(tabs.activeTab()?.modified).toBe(false);
  });

  it('typing that is undone during the write leaves the tab saved without an extra write', async () => {
    const { docs, tabs, type } = setup('base');
    type('base UI');
    beforeWrite = () => {
      if (writes.length !== 1) return;
      type('base UI!');
      type('base UI');
    };
    expect(await docs.save()).toBe(true);
    expect(writes).toEqual(['base UI']);
    expect(tabs.activeTab()?.modified).toBe(false);
  });

  it('keeps writing until the buffer matches what was last written', async () => {
    const { docs, tabs, type } = setup('base');
    type('base UI');
    beforeWrite = () => {
      if (writes.length === 1) type('base UI test');
      else if (writes.length === 2) type('base UI test 2');
    };
    expect(await docs.save()).toBe(true);
    expect(writes).toEqual(['base UI', 'base UI test', 'base UI test 2']);
    expect(disk.get(PATH)).toBe('base UI test 2');
    const tab = tabs.activeTab()!;
    expect(tab.modified).toBe(false);
    expect(tab.content).toBe('base UI test 2');
    expect(tab.savedContent).toBe('base UI test 2');
    expect(messageMock).not.toHaveBeenCalled();
  });

  it('writes keys that land just after the first write ends', async () => {
    // A fast first write can finish before a burst typed right after Ctrl+S.
    // The follow-up used to run only when keys landed during the write, so
    // those later keys stayed off disk until the next Save.
    writeMs = 0;
    const { docs, tabs, type } = setup('base');
    type('base UI');
    beforeWrite = () => {
      if (writes.length !== 1) return;
      setTimeout(() => type('base UI test'), 10);
    };
    expect(await docs.save()).toBe(true);
    expect(writes).toEqual(['base UI', 'base UI test']);
    expect(disk.get(PATH)).toBe('base UI test');
    expect(tabs.activeTab()?.modified).toBe(false);
    expect(messageMock).not.toHaveBeenCalled();
  });

  it('retries a follow-up write that was asked for too soon', async () => {
    // Backend interval is longer than the frontend wait, so the first
    // follow-up is turned down; a further wait then lands the buffer.
    intervalMs = WRITE_INTERVAL_MS * 2;
    const { docs, tabs, type } = setup('base');
    type('base UI');
    beforeWrite = () => {
      if (writes.length === 1) type('base UI test');
    };
    expect(await docs.save()).toBe(true);
    expect(disk.get(PATH)).toBe('base UI test');
    expect(tabs.activeTab()?.modified).toBe(false);
    expect(messageMock).not.toHaveBeenCalled();
  });

  it('a failed follow-up write is reported like any failed save and the tab stays dirty', async () => {
    const { docs, tabs, type } = setup('base');
    type('base UI');
    beforeWrite = () => {
      if (writes.length === 1) type('base UI test');
    };
    failWrite = 2;
    expect(await docs.save()).toBe(false);
    expect(writes).toEqual(['base UI', 'base UI test']);
    expect(disk.get(PATH)).toBe('base UI');
    expect(messageMock).toHaveBeenCalledTimes(1);
    expect(String((messageMock.mock.calls[0] as unknown[])[0])).toContain('Could not save');
    const tab = tabs.activeTab()!;
    expect(tab.modified).toBe(true);
    expect(tab.savedContent).toBe('base UI');
  });

  it('a second save after a mid-write keystroke does not ask about a disk conflict', async () => {
    const { docs, tabs, type } = setup('base');
    type('base UI');
    beforeWrite = () => {
      if (writes.length === 1) type('base UI test');
      else if (writes.length === 2) type('base UI test 2');
    };
    await docs.save();
    beforeWrite = null;
    expect(await docs.save()).toBe(true);
    expect(messageMock).not.toHaveBeenCalled();
    expect(disk.get(PATH)).toBe('base UI test 2');
    expect(tabs.activeTab()?.modified).toBe(false);
  });

  it('no follow-up write when the tab was closed during the write', async () => {
    const { docs, tabs, type } = setup('base');
    type('base UI');
    const id = tabs.activeTab()!.id;
    beforeWrite = () => {
      if (writes.length !== 1) return;
      type('base UI test');
      tabs.closeTab(id);
    };
    expect(await docs.save()).toBe(false);
    expect(writes).toEqual(['base UI']);
  });

  it('no follow-up write when the tab no longer belongs to the active session', async () => {
    const { docs, tabs, type } = setup('base');
    type('base UI');
    beforeWrite = () => {
      if (writes.length !== 1) return;
      type('base UI test');
      tabs.setOrigin('devbox');
    };
    expect(await docs.save()).toBe(false);
    expect(writes).toEqual(['base UI']);
    expect(tabs.getAllTabs()[0].modified).toBe(true);
  });

  it('Save As binds the tab to the new file even when typing lands during the write', async () => {
    const { docs, tabs, type } = setup('', null);
    type('draft');
    saveDialogMock.mockResolvedValueOnce('/p/new.md');
    beforeWrite = () => type('draft more');
    expect(await docs.save()).toBe(false);
    expect(disk.get('/p/new.md')).toBe('draft');
    const tab = tabs.activeTab()!;
    expect(tab.path).toBe('/p/new.md');
    expect(tab.modified).toBe(true);
    expect(tab.savedContent).toBe('draft');
    beforeWrite = null;
    expect(await docs.save()).toBe(true);
    expect(disk.get('/p/new.md')).toBe('draft more');
    expect(tabs.activeTab()?.modified).toBe(false);
  });
});

describe('afterWrite follow-up', () => {
  beforeEach(() => {
    disk.clear();
    beforeRead = null;
    beforeWrite = null;
    messageMock.mockClear();
  });

  it('runs after a successful save and does not fail the save when it throws', async () => {
    const afterWrite = vi.fn(() => { throw new Error('hook boom'); });
    document.body.innerHTML = '';
    const bus = new EventBus();
    const tabs = new TabManager(bus);
    const container = document.createElement('div');
    document.body.appendChild(container);
    tabs.init(container);
    disk.set(PATH, 'base');
    tabs.openTab(PATH, 'base');
    tabs.updateContent('changed');
    tabs.refreshModified();
    const editor = { getContent: () => 'changed' };
    const fileTree = { getSaveDir: () => '/p' };
    const ctx = { tabs, editor, fileTree } as never;
    const docs = new DocumentController(ctx, { afterWrite } as never);
    expect(await docs.save()).toBe(true);
    expect(disk.get(PATH)).toBe('changed');
    expect(afterWrite).toHaveBeenCalledWith(PATH);
    expect(tabs.activeTab()?.modified).toBe(false);
  });

  it('runs once, after the last write, when typing lands during the save', async () => {
    writes.length = 0;
    const seen: string[][] = [];
    const afterWrite = vi.fn(() => { seen.push([...writes]); });
    document.body.innerHTML = '';
    const bus = new EventBus();
    const tabs = new TabManager(bus);
    const container = document.createElement('div');
    document.body.appendChild(container);
    tabs.init(container);
    disk.set(PATH, 'base');
    tabs.openTab(PATH, 'base');
    let text = 'base UI';
    tabs.updateContent(text);
    tabs.refreshModified();
    const editor = { getContent: () => text };
    const fileTree = { getSaveDir: () => '/p' };
    const ctx = { tabs, editor, fileTree } as never;
    const docs = new DocumentController(ctx, { afterWrite } as never);
    beforeWrite = () => {
      if (writes.length !== 1) return;
      text = 'base UI test';
      tabs.updateContent(text);
      tabs.refreshModified();
    };
    expect(await docs.save()).toBe(true);
    expect(writes).toEqual(['base UI', 'base UI test']);
    expect(afterWrite).toHaveBeenCalledTimes(1);
    expect(afterWrite).toHaveBeenCalledWith(PATH);
    expect(seen).toEqual([['base UI', 'base UI test']]);
  });

  it('runs once for a save with no typing during the write', async () => {
    writes.length = 0;
    const afterWrite = vi.fn();
    document.body.innerHTML = '';
    const bus = new EventBus();
    const tabs = new TabManager(bus);
    const container = document.createElement('div');
    document.body.appendChild(container);
    tabs.init(container);
    disk.set(PATH, 'base');
    tabs.openTab(PATH, 'base');
    tabs.updateContent('changed');
    tabs.refreshModified();
    const editor = { getContent: () => 'changed' };
    const fileTree = { getSaveDir: () => '/p' };
    const ctx = { tabs, editor, fileTree } as never;
    const docs = new DocumentController(ctx, { afterWrite } as never);
    expect(await docs.save()).toBe(true);
    expect(writes).toEqual(['changed']);
    expect(afterWrite).toHaveBeenCalledTimes(1);
  });
});
