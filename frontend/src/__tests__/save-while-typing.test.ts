// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const disk = new Map<string, string>();
let beforeRead: (() => void) | null = null;
let beforeWrite: (() => void) | null = null;
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
      beforeWrite?.();
      await Promise.resolve();
      disk.set(path, content);
    }),
  },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: (...args: unknown[]) => (saveDialogMock as (...a: unknown[]) => unknown)(...args),
  message: (...args: unknown[]) => (messageMock as (...a: unknown[]) => unknown)(...args),
}));

import { DocumentController } from '../app/documents';
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
    messageMock.mockClear();
    saveDialogMock.mockReset();
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

  it('keeps the tab dirty and the baseline equal to the disk when typing lands during the write', async () => {
    const { docs, tabs, type } = setup('base');
    type('base UI');
    beforeWrite = () => type('base UI test');
    expect(await docs.save()).toBe(false);
    expect(disk.get(PATH)).toBe('base UI');
    const tab = tabs.activeTab()!;
    expect(tab.modified).toBe(true);
    expect(tab.content).toBe('base UI test');
    // What is on disk is our own write, so it is the baseline.
    expect(tab.savedContent).toBe('base UI');
  });

  it('a second save after a mid-write keystroke does not ask about a disk conflict', async () => {
    const { docs, tabs, type } = setup('base');
    type('base UI');
    beforeWrite = () => type('base UI test');
    await docs.save();
    beforeWrite = null;
    expect(await docs.save()).toBe(true);
    expect(messageMock).not.toHaveBeenCalled();
    expect(disk.get(PATH)).toBe('base UI test');
    expect(tabs.activeTab()?.modified).toBe(false);
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
