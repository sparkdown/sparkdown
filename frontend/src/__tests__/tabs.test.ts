// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { TabManager } from '../tabs';
import { EventBus } from '../events';
import { EVENTS } from '../event-names';

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function setup() {
  const bus = new EventBus();
  const events: Array<{ type: string; data: any }> = [];
  // Record every bus event so we can assert on emissions.
  for (const type of Object.values(EVENTS)) {
    bus.on(type as any, (data: any) => events.push({ type: type as string, data }));
  }
  const tabs = new TabManager(bus);
  const container = document.createElement('div');
  document.body.appendChild(container);
  tabs.init(container);
  return { tabs, bus, events, container };
}

describe('TabManager', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('opens a tab, makes it active, and renders a tab element', () => {
    const { tabs, container } = setup();
    tabs.openTab('/a/notes.md', 'hello');

    const active = tabs.activeTab();
    expect(active?.path).toBe('/a/notes.md');
    expect(active?.title).toBe('notes.md');
    expect(active?.modified).toBe(false);
    expect(container.querySelectorAll('.tab')).toHaveLength(1);
  });

  it('titles a pathless buffer "Untitled"', () => {
    const { tabs } = setup();
    tabs.openTab(null, '');
    expect(tabs.activeTab()?.title).toBe('Untitled');
  });

  it('dedupes by path: re-opening an open file switches instead of duplicating', () => {
    const { tabs, container } = setup();
    tabs.openTab('/a/one.md', '1');
    tabs.openTab('/a/two.md', '2');
    expect(container.querySelectorAll('.tab')).toHaveLength(2);

    tabs.openTab('/a/one.md', 'ignored');
    expect(container.querySelectorAll('.tab')).toHaveLength(2);
    expect(tabs.activeTab()?.path).toBe('/a/one.md');
  });

  it('allows multiple untitled (pathless) tabs', () => {
    const { tabs, container } = setup();
    tabs.openTab(null, '');
    tabs.openTab(null, '');
    expect(container.querySelectorAll('.tab')).toHaveLength(2);
  });

  it('emits TAB_SWITCHED on open and TAB_SAVE_STATE for the previous tab', () => {
    const { tabs, events } = setup();
    tabs.openTab('/a/one.md', '1');
    tabs.openTab('/a/two.md', '2');

    const switched = events.filter((e) => e.type === EVENTS.TAB_SWITCHED);
    expect(switched).toHaveLength(2);
    // Switching away from tab one persists its state first.
    const saveState = events.filter((e) => e.type === EVENTS.TAB_SAVE_STATE);
    expect(saveState).toHaveLength(1);
  });

  it('emits TAB_SAVE_STATE before TAB_SWITCHED when re-activating the same tab', () => {
    // Regression: the switch handler restores the editor from the saved
    // snapshot, so re-activating without saving first (e.g. clicking the
    // active file's Changes row) rolled back edits made since the last
    // real tab switch.
    const { tabs, events } = setup();
    tabs.openTab('/a/one.md', '1');
    events.length = 0;

    tabs.switchTo(tabs.activeTab()!.id);

    const types = events.map((e) => e.type);
    const saveIdx = types.indexOf(EVENTS.TAB_SAVE_STATE);
    const switchIdx = types.indexOf(EVENTS.TAB_SWITCHED);
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(switchIdx).toBeGreaterThan(saveIdx);
    expect(events[saveIdx].data.tabId).toBe(tabs.activeTab()!.id);
  });

  it('tracks modified state and clears it on save', () => {
    const { tabs, events } = setup();
    tabs.openTab('/a/one.md', '1');

    tabs.updateContent('1 edited');
    tabs.refreshModified();
    expect(tabs.activeTab()?.modified).toBe(true);
    expect(tabs.getModifiedTabs()).toHaveLength(1);

    tabs.markSaved();
    expect(tabs.activeTab()?.modified).toBe(false);
    expect(tabs.getModifiedTabs()).toHaveLength(0);
    expect(events.some((e) => e.type === EVENTS.TAB_SAVED)).toBe(true);
  });

  it('clears the dirty flag when content is edited back to the saved baseline', () => {
    const { tabs } = setup();
    tabs.openTab('/a/one.md', 'original');

    tabs.updateContent('original + edit');
    tabs.refreshModified();
    expect(tabs.activeTab()?.modified).toBe(true);

    // Undo back to the saved content.
    tabs.updateContent('original');
    tabs.refreshModified();
    expect(tabs.activeTab()?.modified).toBe(false);
    expect(tabs.getModifiedTabs()).toHaveLength(0);
  });
  it("scopes markSaved and setPathFor to the captured tab and content", () => {
    const { tabs } = setup();
    tabs.openTab("/a/one.md", "one");
    const first = tabs.activeTab()!;
    tabs.openTab(null, "two");
    const second = tabs.activeTab()!;
    tabs.setContentFor(first.id, "edited one");
    expect(tabs.markSaved(first.id, "stale")).toBe(false);
    expect(tabs.getTab(first.id)?.modified).toBe(false);
    expect(tabs.setPathFor(first.id, "/a/saved.md")).toBe(true);
    expect(tabs.getTab(first.id)?.path).toBe("/a/saved.md");
    expect(tabs.activeTab()?.id).toBe(second.id);
  });


  it('getOpenPaths returns only tabs with a path, in order', () => {
    const { tabs } = setup();
    tabs.openTab('/a/one.md', '');
    tabs.openTab(null, '');
    tabs.openTab('/a/two.md', '');
    expect(tabs.getOpenPaths()).toEqual(['/a/one.md', '/a/two.md']);
  });

  it('setPath updates path and title of the active tab', () => {
    const { tabs } = setup();
    tabs.openTab(null, '');
    tabs.setPath('/a/saved.md');
    expect(tabs.activeTab()?.path).toBe('/a/saved.md');
    expect(tabs.activeTab()?.title).toBe('saved.md');
  });

  it('switchNext / switchPrev wrap around', () => {
    const { tabs } = setup();
    tabs.openTab('/a/1.md', '');
    tabs.openTab('/a/2.md', '');
    tabs.openTab('/a/3.md', ''); // active = 3 (index 2)

    tabs.switchNext(); // wraps to index 0
    expect(tabs.activeTab()?.path).toBe('/a/1.md');

    tabs.switchPrev(); // wraps back to index 2
    expect(tabs.activeTab()?.path).toBe('/a/3.md');
  });

  it('switchNext is a no-op with fewer than two tabs', () => {
    const { tabs } = setup();
    tabs.openTab('/a/1.md', '');
    tabs.switchNext();
    expect(tabs.activeTab()?.path).toBe('/a/1.md');
  });

  it('closing the active middle tab selects a neighbor', () => {
    const { tabs, container } = setup();
    tabs.openTab('/a/1.md', '');
    tabs.openTab('/a/2.md', '');
    tabs.openTab('/a/3.md', '');

    // Make tab 2 active, then close it.
    tabs.switchNext(); // 3 -> 1
    tabs.switchNext(); // 1 -> 2
    expect(tabs.activeTab()?.path).toBe('/a/2.md');

    const id2 = tabs.activeTab()!.id;
    tabs.closeTab(id2);

    expect(container.querySelectorAll('.tab')).toHaveLength(2);
    // index min(1, len-1=1) -> the tab now at index 1 ('/a/3.md')
    expect(tabs.activeTab()?.path).toBe('/a/3.md');
  });

  it('emits ALL_TABS_CLOSED when the last tab is removed', () => {
    const { tabs, events } = setup();
    tabs.openTab('/a/1.md', '');
    const id = tabs.activeTab()!.id;

    tabs.closeTab(id);

    expect(tabs.activeTab()).toBeNull();
    expect(events.some((e) => e.type === EVENTS.ALL_TABS_CLOSED)).toBe(true);
  });

  it('closeCurrent on a modified tab asks for confirmation instead of closing', () => {
    const { tabs, events, container } = setup();
    tabs.openTab('/a/1.md', '');
    tabs.updateContent('now dirty');
    tabs.refreshModified();

    tabs.closeCurrent();

    // Still open; a confirm was requested.
    expect(container.querySelectorAll('.tab')).toHaveLength(1);
    const confirm = events.filter((e) => e.type === EVENTS.CONFIRM_CLOSE_TAB);
    expect(confirm).toHaveLength(1);
    expect(confirm[0].data.tabId).toBe(tabs.activeTab()!.id);
  });

  it('closeCurrent on a clean tab removes it directly', () => {
    const { tabs, container } = setup();
    tabs.openTab('/a/1.md', '');
    tabs.closeCurrent();
    expect(container.querySelectorAll('.tab')).toHaveLength(0);
  });

  it('tags overflow edges and mounts strip chevrons', () => {
    const strip = document.createElement('div');
    strip.className = 'tab-strip';
    const container = document.createElement('div');
    strip.appendChild(container);
    document.body.appendChild(strip);

    const tabs = new TabManager(new EventBus());
    tabs.init(container);
    expect(strip.querySelectorAll('.tab-scroll-btn')).toHaveLength(2);

    let scrollLeft = 0;
    Object.defineProperty(container, 'clientWidth', { configurable: true, get: () => 200 });
    Object.defineProperty(container, 'scrollWidth', { configurable: true, get: () => 500 });
    Object.defineProperty(container, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (v: number) => { scrollLeft = v; },
    });

    tabs.syncOverflow();
    expect(container.classList.contains('overflow-right')).toBe(true);
    expect(container.classList.contains('overflow-left')).toBe(false);
    expect(strip.classList.contains('overflow-right')).toBe(true);

    scrollLeft = 120;
    tabs.syncOverflow();
    expect(container.classList.contains('overflow-left')).toBe(true);
    expect(container.classList.contains('overflow-right')).toBe(true);

    scrollLeft = 300;
    tabs.syncOverflow();
    expect(container.classList.contains('overflow-left')).toBe(true);
    expect(container.classList.contains('overflow-right')).toBe(false);
  });

  it('turns a vertical wheel over an overflowing strip into a horizontal pan', () => {
    const { container } = setup();
    let scrollLeft = 0;
    Object.defineProperty(container, 'clientWidth', { configurable: true, get: () => 200 });
    Object.defineProperty(container, 'scrollWidth', { configurable: true, get: () => 500 });
    Object.defineProperty(container, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (v: number) => { scrollLeft = v; },
    });

    const ev = new WheelEvent('wheel', { deltaY: 40, deltaX: 0, bubbles: true, cancelable: true });
    container.dispatchEvent(ev);
    expect(scrollLeft).toBe(40);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('shows a floating label only when the tab title is truncated', () => {
    const tabs = new TabManager(new EventBus());
    const bar = document.createElement('div');
    document.body.appendChild(bar);
    tabs.init(bar);
    tabs.openTab('/docs/very-long-architecture-notes.md', '');

    const title = bar.querySelector('.tab-title') as HTMLElement;
    Object.defineProperty(title, 'scrollWidth', { configurable: true, get: () => 220 });
    Object.defineProperty(title, 'clientWidth', { configurable: true, get: () => 70 });

    title.dispatchEvent(new MouseEvent('mouseenter'));
    const tip = document.querySelector('.tab-tip');
    expect(tip?.textContent).toBe('very-long-architecture-notes.md');

    title.dispatchEvent(new MouseEvent('mouseleave'));
    expect(document.querySelector('.tab-tip')).toBeNull();
  });

  it('does not show a label when the title fits', () => {
    document.body.innerHTML = '';
    const bar = document.createElement('div');
    document.body.appendChild(bar);
    const tabs = new TabManager(new EventBus());
    tabs.init(bar);
    tabs.openTab('/a/short.md', '');

    const title = bar.querySelector('.tab-title') as HTMLElement;
    Object.defineProperty(title, 'scrollWidth', { configurable: true, get: () => 40 });
    Object.defineProperty(title, 'clientWidth', { configurable: true, get: () => 40 });

    title.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelector('.tab-tip')).toBeNull();
  });

  // --- path matching is separator-insensitive (finding #2) ------------------

  it('findByPath matches across separator style and drive case', () => {
    const { tabs } = setup();
    tabs.openTab('C:\\repo\\a.md', 'x');
    expect(tabs.findByPath('c:/repo/a.md')?.title).toBe('a.md');
    expect(tabs.findByPath('C:\\repo\\a.md')?.title).toBe('a.md');
    expect(tabs.findByPath('C:\\repo\\other.md')).toBeNull();
  });

  it('findByPath and openTab dedupe only within one origin', () => {
    const { tabs, container } = setup();
    tabs.openTab('/srv/a.md', 'local');
    tabs.setOrigin('dev');
    expect(tabs.findByPath('/srv/a.md')).toBeNull();
    expect(tabs.findByPath('/srv/a.md', null)?.content).toBe('local');
    tabs.openTab('/srv/a.md', 'remote');
    expect(container.querySelectorAll('.tab')).toHaveLength(2);
    expect(tabs.findByPath('/srv/a.md')?.content).toBe('remote');
    // Re-opening on the host switches to the host tab, not the local one.
    tabs.openTab('/srv/a.md', 'again');
    expect(container.querySelectorAll('.tab')).toHaveLength(2);
    expect(tabs.activeTab()?.origin).toBe('dev');
  });

  it('dedupes a mixed-separator reopen instead of opening a duplicate tab', () => {
    const { tabs, container } = setup();
    // Opened via the tree (native backslashes)...
    tabs.openTab('C:\\repo\\a.md', 'x');
    // ...reopened via a git-relative join (forward slashes): same file.
    tabs.openTab('C:/repo/a.md', 'ignored');
    expect(container.querySelectorAll('.tab')).toHaveLength(1);
  });

  // --- closing the active tab must not re-cache its editor state (finding #6) -

  it('does not emit TAB_SAVE_STATE for the tab being closed', () => {
    const { tabs, events } = setup();
    tabs.openTab('/a/1.md', '');
    tabs.openTab('/a/2.md', '');
    const activeId = tabs.activeTab()!.id; // '/a/2.md'

    events.length = 0; // ignore the open/switch churn
    tabs.closeTab(activeId);

    // TAB_CLOSED forgets the editor state; switching to the neighbour must not
    // re-save (re-cache) the just-closed tab's state (LRU pollution).
    const savedForClosed = events.filter(
      (e) => e.type === EVENTS.TAB_SAVE_STATE && e.data.tabId === activeId,
    );
    expect(savedForClosed).toHaveLength(0);
    expect(events.some((e) => e.type === EVENTS.TAB_CLOSED && e.data.tabId === activeId)).toBe(true);
    expect(tabs.activeTab()?.path).toBe('/a/1.md');
  });
});
