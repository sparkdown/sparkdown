// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { TabManager, type Tab } from '../tabs';
import { EventBus } from '../events';
import { EVENTS } from '../event-names';

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/** A file read the test finishes by hand. */
interface Read {
  path: string;
  resolve(content: string | null): void;
}

function setup() {
  const bus = new EventBus();
  const switched: string[] = [];
  bus.on(EVENTS.TAB_SWITCHED, (d) => switched.push(d.tab.title));
  let allClosed = 0;
  bus.on(EVENTS.ALL_TABS_CLOSED, () => allClosed++);
  const tabs = new TabManager(bus);
  const container = document.createElement('div');
  document.body.appendChild(container);
  tabs.init(container);
  const reads: Read[] = [];
  tabs.setContentLoader(
    (tab: Tab) => new Promise((resolve) => reads.push({ path: tab.path!, resolve })),
  );
  const titles = () =>
    Array.from(container.querySelectorAll('.tab .tab-title')).map((e) => e.textContent);
  const activeTitle = () => container.querySelector('.tab.active .tab-title')?.textContent ?? null;
  return { tabs, reads, switched, titles, activeTitle, allClosed: () => allClosed };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('TabManager: tabs restored without their text', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows every restored tab in order without reading any file', () => {
    const { tabs, reads, titles, activeTitle } = setup();
    for (const p of ['/n/a.md', '/n/b.md', '/n/c.md']) tabs.addUnloaded(p);
    expect(titles()).toEqual(['a.md', 'b.md', 'c.md']);
    expect(reads).toEqual([]);
    expect(activeTitle()).toBeNull();
    expect(tabs.getOpenPaths()).toEqual(['/n/a.md', '/n/b.md', '/n/c.md']);
    expect(tabs.getUnloadedTabs().map((t) => t.title)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('skips folders and paths that are already open', () => {
    const { tabs, titles } = setup();
    tabs.openTab('/n/a.md', 'A');
    expect(tabs.addUnloaded('/n/a.md')).toBeNull();
    expect(tabs.addUnloaded('/n/dir/')).toBeNull();
    expect(titles()).toEqual(['a.md']);
  });

  it('activates a tab only once its file is read, with the file as clean baseline', async () => {
    const { tabs, reads, switched, activeTitle } = setup();
    tabs.openTab('/n/open.md', 'open text');
    const id = tabs.addUnloaded('/n/b.md')!;
    switched.length = 0;

    tabs.switchTo(id);
    expect(reads.map((r) => r.path)).toEqual(['/n/b.md']);
    // Still on the old tab while the read runs: nothing sees the empty text.
    expect(activeTitle()).toBe('open.md');
    expect(switched).toEqual([]);

    reads[0].resolve('# B');
    await flush();
    expect(activeTitle()).toBe('b.md');
    expect(switched).toEqual(['b.md']);
    const tab = tabs.activeTab()!;
    expect(tab.content).toBe('# B');
    expect(tab.savedContent).toBe('# B');
    expect(tab.modified).toBe(false);
    expect(tab.unloaded).toBeUndefined();
  });

  it('reads a file once when it is asked for twice', async () => {
    const { tabs, reads } = setup();
    const id = tabs.addUnloaded('/n/b.md')!;
    const first = tabs.ensureLoaded(id);
    const second = tabs.ensureLoaded(id);
    expect(reads).toHaveLength(1);
    reads[0].resolve('B');
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(await tabs.ensureLoaded(id)).toBe(true);
    expect(reads).toHaveLength(1);
  });

  it('the latest switch wins when reads finish out of order', async () => {
    const { tabs, reads, activeTitle } = setup();
    tabs.openTab('/n/open.md', 'x');
    const b = tabs.addUnloaded('/n/b.md')!;
    const c = tabs.addUnloaded('/n/c.md')!;
    tabs.switchTo(b);
    tabs.switchTo(c);
    reads[1].resolve('C');
    await flush();
    expect(activeTitle()).toBe('c.md');
    reads[0].resolve('B');
    await flush();
    expect(activeTitle()).toBe('c.md');
    expect(tabs.getTab(b)!.content).toBe('B');
  });

  it('a switch to a loaded tab cancels a waiting one', async () => {
    const { tabs, reads, activeTitle } = setup();
    tabs.openTab('/n/a.md', 'A');
    const loaded = tabs.activeTab()!.id;
    tabs.openTab('/n/z.md', 'Z');
    const b = tabs.addUnloaded('/n/b.md')!;
    tabs.switchTo(b);
    tabs.switchTo(loaded);
    reads[0].resolve('B');
    await flush();
    expect(activeTitle()).toBe('a.md');
  });

  it('closes the tab of a file that cannot be read', async () => {
    const { tabs, reads, titles, activeTitle } = setup();
    tabs.openTab('/n/open.md', 'x');
    const gone = tabs.addUnloaded('/n/gone.md')!;
    tabs.switchTo(gone);
    reads[0].resolve(null);
    await flush();
    expect(titles()).toEqual(['open.md']);
    expect(activeTitle()).toBe('open.md');
  });

  it('a failed read with no tab left reports that all tabs closed', async () => {
    const { tabs, reads, allClosed } = setup();
    const gone = tabs.addUnloaded('/n/gone.md')!;
    tabs.switchTo(gone);
    reads[0].resolve(null);
    await flush();
    expect(tabs.getAllTabs()).toHaveLength(0);
    expect(allClosed()).toBe(1);
  });

  it('unloaded tabs never count as modified', async () => {
    const { tabs, reads } = setup();
    const id = tabs.addUnloaded('/n/b.md')!;
    expect(tabs.getModifiedTabs()).toEqual([]);
    tabs.switchTo(id);
    reads[0].resolve('B');
    await flush();
    tabs.updateContent('B edited');
    expect(tabs.refreshModified()).toBe(true);
    expect(tabs.getModifiedTabs().map((t) => t.title)).toEqual(['b.md']);
    tabs.updateContent('B');
    tabs.refreshModified();
    expect(tabs.getModifiedTabs()).toEqual([]);
  });

  it('opening the same file fills the waiting tab with the text just read', async () => {
    const { tabs, reads, titles, activeTitle } = setup();
    tabs.addUnloaded('/n/a.md');
    tabs.addUnloaded('/n/b.md');
    tabs.openTab('/n/b.md', 'from open');
    await flush();
    expect(reads).toEqual([]);
    expect(titles()).toEqual(['a.md', 'b.md']);
    expect(activeTitle()).toBe('b.md');
    expect(tabs.activeTab()!.savedContent).toBe('from open');
  });

  it('a disk reload loads the tab too', () => {
    const { tabs } = setup();
    const id = tabs.addUnloaded('/n/b.md')!;
    tabs.reloadFromDisk(id, 'disk');
    expect(tabs.getTab(id)!.unloaded).toBeUndefined();
    expect(tabs.getUnloadedTabs()).toEqual([]);
  });

  it('drops a read that the active machine changed under', async () => {
    const { tabs, reads } = setup();
    const id = tabs.addUnloaded('/n/b.md')!;
    const load = tabs.ensureLoaded(id);
    tabs.setOrigin('dev');
    reads[0].resolve('text from the other machine');
    expect(await load).toBe(false);
    expect(tabs.getTab(id)!.unloaded).toBe(true);
    expect(tabs.getTab(id)!.content).toBe('');
  });
});
