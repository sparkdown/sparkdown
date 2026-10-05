import { EventBus } from './events';
import { basename, normalizePathForCompare } from './utils';
import { EVENTS } from './event-names';
import type { ViewMode } from './view-mode';
import type { DefaultViewMode } from './types/DefaultViewMode';

export interface Tab {
  id: string;
  path: string | null;
  title: string;
  content: string;
  modified: boolean;
  /** Content as of the last open/save — the baseline `modified` compares
   *  against, so undoing back to it clears the dirty flag. */
  savedContent: string;
  /** The document's view (Edit | Split | Preview | Diff), remembered per
   *  tab. Stamped from the default view when the tab opens; see
   *  view-mode.ts for how it is coerced to what the file type supports.
   *  Opening a row from the Changes panel sets 'diff'. Not persisted. */
  viewMode: ViewMode;
  /** Git-diff query context captured when a tab is opened from the Changes
   *  panel: the repo root the status was read against and git's own
   *  repo-relative path for the file. Kept verbatim so the diff query is
   *  stable even after the file tree re-roots (opening a file moves it). */
  gitDiff?: { root: string; relPath: string };
  /** The file changed on disk while this tab held unsaved edits. The
   *  user's text is kept; save() asks before it overwrites the disk. */
  diskConflict?: boolean;
  /** Machine the tab's path lives on: null = this machine, otherwise the SSH
   *  host alias of the remote session that was active when it was opened.
   *  File I/O routes by the *global* remote session, so a tab may only be
   *  read or written while its origin is the active one. */
  origin: string | null;
}

/** Tab origin of the local machine. */
export const LOCAL_ORIGIN: string | null = null;

/** Pixels the overflow chevrons nudge the strip. About one preferred tab. */
const TAB_SCROLL_STEP_PX = 140;

export class TabManager {
  private tabs: Tab[] = [];
  private activeTabId: string | null = null;
  private bus: EventBus;
  private container!: HTMLElement;
  private strip: HTMLElement | null = null;
  private tabCounter = 0;
  private elements = new Map<string, HTMLElement>();
  private overflowRaf = 0;
  private resizeObserver: ResizeObserver | null = null;
  private tip: HTMLElement | null = null;
  /** Origin stamped on new tabs (see Tab.origin). */
  private origin: string | null = LOCAL_ORIGIN;
  /** View stamped on new tabs (see Tab.viewMode). */
  private defaultViewMode: DefaultViewMode = 'split';

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  init(container: HTMLElement): void {
    this.container = container;
    this.strip = container.parentElement?.classList.contains('tab-strip')
      ? container.parentElement
      : null;
    this.mountScrollButtons();

    this.container.addEventListener('scroll', () => {
      this.hideTitleTip();
      this.scheduleOverflowSync();
    }, { passive: true });
    this.container.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.scheduleOverflowSync());
      this.resizeObserver.observe(this.container);
    }

    // Event delegation for clicks
    this.container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const tabEl = target.closest<HTMLElement>('.tab');
      if (!tabEl) return;
      const tabId = tabEl.dataset.tabId;
      if (!tabId) return;
      const tab = this.tabs.find((t) => t.id === tabId);
      if (!tab) return;

      if (target.classList.contains('tab-close')) {
        e.stopPropagation();
        if (tab.modified) {
          this.bus.emit(EVENTS.CONFIRM_CLOSE_TAB, { tabId });
        } else {
          this.removeTab(tabId);
        }
        return;
      }

      this.switchTo(tabId);
    });
  }

  openTab(path: string | null, content: string): void {
    if (path) {
      // Only a tab of the active machine may capture the open: a kept dirty
      // tab from another machine with the same path is a different file.
      const existing = this.findByPath(path, this.origin);
      if (existing) {
        this.switchTo(existing.id);
        return;
      }
    }

    const id = `tab-${++this.tabCounter}`;
    const tab: Tab = {
      id,
      path,
      title: path ? basename(path) : 'Untitled',
      content,
      modified: false,
      savedContent: content,
      origin: this.origin,
      viewMode: this.defaultViewMode,
    };
    this.tabs.push(tab);
    this.appendTabElement(tab);
    this.switchTo(id);
  }

  /** The view new tabs open in. */
  setDefaultViewMode(mode: DefaultViewMode): void {
    this.defaultViewMode = mode;
  }

  /**
   * Set the active tab's view and mark the tab element (a diff tab shows a
   * leading ±). Only the model changes here; the app applies the layout.
   */
  setActiveViewMode(mode: ViewMode): void {
    const tab = this.activeTab();
    if (!tab) return;
    tab.viewMode = mode;
    this.updateViewModeState(tab);
  }

  /** Record git-diff query context on the active tab (see Tab.gitDiff). */
  setActiveGitDiff(root: string, relPath: string): void {
    const tab = this.activeTab();
    if (tab) tab.gitDiff = { root, relPath };
  }

  closeCurrent(): void {
    if (!this.activeTabId) return;
    const tab = this.activeTab();
    if (tab?.modified) {
      this.bus.emit(EVENTS.CONFIRM_CLOSE_TAB, { tabId: this.activeTabId });
      return;
    }
    this.removeTab(this.activeTabId);
  }

  closeTab(tabId: string): void {
    this.removeTab(tabId);
  }

  activeTab(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null;
  }

  getTab(tabId: string): Tab | null {
    return this.tabs.find((t) => t.id === tabId) ?? null;
  }

  switchTo(id: string): void {
    const prevId = this.activeTabId;
    if (prevId) this.bus.emit(EVENTS.TAB_SAVE_STATE, { tabId: prevId });
    if (prevId && prevId !== id) this.elements.get(prevId)?.classList.remove('active');
    this.activeTabId = id;
    const tab = this.activeTab();
    if (tab) {
      this.elements.get(id)?.classList.add('active');
      this.revealTab(this.elements.get(id));
      this.bus.emit(EVENTS.TAB_SWITCHED, { tab });
    }
  }

  markSaved(tabId: string | null = this.activeTabId, expectedContent?: string): boolean {
    const tab = tabId ? this.getTab(tabId) : null;
    if (!tab || (expectedContent !== undefined && tab.content !== expectedContent)) return false;
    tab.savedContent = tab.content;
    tab.modified = false;
    tab.diskConflict = false;
    this.updateModifiedState(tab);
    this.bus.emit(EVENTS.TAB_SAVED, { tab });
    return true;
  }

  /**
   * Replace a tab's text with what is now on disk and make that the clean
   * baseline. Unlike markSaved this emits no TAB_SAVED: the user did not
   * save, and a background tab must not take over the status bar.
   */
  reloadFromDisk(tabId: string, content: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;
    tab.content = content;
    tab.savedContent = content;
    tab.modified = false;
    tab.diskConflict = false;
    this.updateModifiedState(tab);
  }

  /** Flag (or clear) a disk conflict on a tab with unsaved edits. */
  setDiskConflict(tabId: string, conflict: boolean): void {
    const tab = this.getTab(tabId);
    if (!tab) return;
    tab.diskConflict = conflict;
    this.updateModifiedState(tab);
  }

  refreshModified(): boolean {
    const tab = this.activeTab();
    if (!tab) return false;
    const nowModified = tab.content !== tab.savedContent;
    if (nowModified === tab.modified) return false;
    tab.modified = nowModified;
    this.updateModifiedState(tab);
    return true;
  }

  setPathFor(tabId: string, path: string): boolean {
    const tab = this.getTab(tabId);
    if (!tab) return false;
    tab.path = path;
    // A path chosen now lives on the active machine.
    tab.origin = this.origin;
    tab.title = basename(path);
    const titleEl = this.elements.get(tab.id)?.querySelector('.tab-title');
    if (titleEl) titleEl.textContent = tab.title;
    this.updateHost(tab);
    return true;
  }

  setPath(path: string): void {
    const tab = this.activeTab();
    if (tab) this.setPathFor(tab.id, path);
  }

  updateContent(content: string): void {
    const tab = this.activeTab();
    if (tab) {
      tab.content = content;
    }
  }

  setContentFor(tabId: string, content: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (tab) tab.content = content;
  }

  /** Find an open tab by absolute path on one machine (default: the active
   *  origin — the same path on another machine is a different file).
   *  Comparison is separator- and drive-case-insensitive so a mixed-separator
   *  path (e.g. from a git-relative join on Windows) still matches the tab
   *  opened via the tree. */
  findByPath(path: string, origin: string | null = this.origin): Tab | null {
    const target = normalizePathForCompare(path);
    return (
      this.tabs.find(
        (t) => t.path != null && t.origin === origin && normalizePathForCompare(t.path) === target,
      ) ?? null
    );
  }

  /**
   * Replace a (non-active) tab's content from outside the editor — an
   * agent's buffer edit via MCP — and recompute its dirty flag against the
   * saved baseline. The active tab is edited through the editor instead, so
   * the change is undoable there.
   */
  setContentExternally(tabId: string, content: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.content = content;
    tab.modified = tab.content !== tab.savedContent;
    this.updateModifiedState(tab);
  }

  /** Paths of open file tabs. Pass an origin to keep only tabs from that
   *  machine (config persistence stores local paths only). */
  getOpenPaths(origin?: string | null): string[] {
    return this.tabs
      .filter((t) => t.path && (origin === undefined || t.origin === origin))
      .map((t) => t.path!);
  }

  /** The active origin new tabs are stamped with. */
  getOrigin(): string | null {
    return this.origin;
  }

  /** Switch the active origin. Callers first close tabs from other origins. */
  setOrigin(origin: string | null): void {
    this.origin = origin;
  }

  /** File tabs (with a path) that belong to a different machine than `origin`.
   *  Untitled buffers have no machine yet, so they are never included. */
  getTabsNotFrom(origin: string | null): Tab[] {
    return this.tabs.filter((t) => t.path !== null && t.origin !== origin);
  }

  /** All file tabs, in strip order (read-only snapshot for the agent context
   *  bridge). */
  getAllTabs(): readonly Tab[] {
    return this.tabs;
  }

  getModifiedTabs(): Tab[] {
    return this.tabs.filter((t) => t.modified);
  }

  switchNext(): void {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeTabId);
    const next = (idx + 1) % this.tabs.length;
    this.switchTo(this.tabs[next].id);
  }

  switchPrev(): void {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeTabId);
    const prev = (idx - 1 + this.tabs.length) % this.tabs.length;
    this.switchTo(this.tabs[prev].id);
  }

  private removeTab(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;

    this.tabs.splice(idx, 1);
    const el = this.elements.get(id);
    el?.remove();
    this.elements.delete(id);
    this.hideTitleTip();
    this.scheduleOverflowSync();
    this.bus.emit(EVENTS.TAB_CLOSED, { tabId: id });

    if (this.activeTabId === id) {
      // Clear the active id before switching: switchTo emits TAB_SAVE_STATE for
      // the outgoing tab, which for the tab we just closed would re-cache the
      // EditorState that TAB_CLOSED asked to forget — LRU pollution.
      this.activeTabId = null;
      if (this.tabs.length > 0) {
        const newIdx = Math.min(idx, this.tabs.length - 1);
        this.switchTo(this.tabs[newIdx].id);
      } else {
        this.bus.emit(EVENTS.ALL_TABS_CLOSED, {});
      }
    }
  }

  private appendTabElement(tab: Tab): void {
    if (!this.container) return;
    const el = document.createElement('div');
    el.className = 'tab';
    el.dataset.tabId = tab.id;

    // A small leading ± glyph marks a tab that's currently showing its diff
    // view, so the strip reads which files are in review mode. Hidden by
    // default (editor mode); toggled by updateViewDiffState.
    const icon = document.createElement('span');
    icon.className = 'tab-diff-icon';
    icon.textContent = '±';
    icon.setAttribute('aria-hidden', 'true');
    icon.style.display = tab.viewMode === 'diff' ? '' : 'none';
    el.appendChild(icon);

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title;
    title.addEventListener('mouseenter', () => this.showTitleTip(title));
    title.addEventListener('mouseleave', () => this.hideTitleTip());
    el.appendChild(title);

    // Remote tabs name their host in small subtle text after the title.
    const host = document.createElement('span');
    host.className = 'tab-host';
    el.appendChild(host);

    const dot = document.createElement('span');
    dot.className = 'tab-modified-dot';
    dot.textContent = '●';
    dot.style.display = tab.modified ? '' : 'none';
    el.appendChild(dot);

    const closeBtn = document.createElement('span');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    el.appendChild(closeBtn);

    this.container.appendChild(el);
    this.elements.set(tab.id, el);
    this.updateHost(tab);
    this.scheduleOverflowSync();
  }

  /** Show the tab's SSH host (remote tabs only). */
  private updateHost(tab: Tab): void {
    const el = this.elements.get(tab.id);
    const host = el?.querySelector<HTMLElement>('.tab-host');
    if (!el || !host) return;
    host.textContent = tab.origin ?? '';
    host.hidden = !tab.origin;
    el.classList.toggle('tab-remote', !!tab.origin);
  }

  private revealTab(el: HTMLElement | undefined): void {
    if (!el) return;
    el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    this.scheduleOverflowSync();
  }

  private mountScrollButtons(): void {
    if (!this.strip) return;
    this.strip.prepend(this.makeScrollButton('left'));
    this.strip.appendChild(this.makeScrollButton('right'));
  }

  private makeScrollButton(dir: 'left' | 'right'): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `tab-scroll-btn is-${dir}`;
    btn.setAttribute('aria-label', dir === 'left' ? 'Show earlier tabs' : 'Show later tabs');
    btn.innerHTML =
      dir === 'left'
        ? '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5L4 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.scrollTabs(dir === 'left' ? -TAB_SCROLL_STEP_PX : TAB_SCROLL_STEP_PX);
    });
    return btn;
  }

  private onWheel(e: WheelEvent): void {
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    const delta = horizontal ? e.deltaX : e.deltaY;
    if (delta === 0) return;
    const overflowing = this.container.scrollWidth > this.container.clientWidth + 1;
    if (!overflowing) return;
    // Trackpads already send deltaX; mice send deltaY over the strip — both
    // should pan the tabs, not the page.
    if (!horizontal) e.preventDefault();
    this.container.scrollLeft += delta;
    this.scheduleOverflowSync();
  }

  private scrollTabs(delta: number): void {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    this.container.scrollBy({ left: delta, behavior: reduce ? 'auto' : 'smooth' });
    this.scheduleOverflowSync();
  }

  private scheduleOverflowSync(): void {
    if (this.overflowRaf) return;
    this.overflowRaf = requestAnimationFrame(() => {
      this.overflowRaf = 0;
      this.syncOverflow();
    });
  }

  /** True when the title span is painting an ellipsis. */
  static isTitleTruncated(el: HTMLElement): boolean {
    return el.scrollWidth > el.clientWidth + 1;
  }

  private showTitleTip(titleEl: HTMLElement): void {
    this.hideTitleTip();
    if (!TabManager.isTitleTruncated(titleEl)) return;
    const text = titleEl.textContent?.trim();
    if (!text) return;

    const tip = document.createElement('div');
    tip.className = 'tab-tip';
    tip.setAttribute('role', 'tooltip');
    tip.textContent = text;
    document.body.appendChild(tip);

    const r = titleEl.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = r.left;
    let top = r.bottom + 6;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    if (top + th > window.innerHeight - 8) top = Math.max(8, r.top - th - 6);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    this.tip = tip;
  }

  private hideTitleTip(): void {
    this.tip?.remove();
    this.tip = null;
  }

  /** Expose overflow edges for tests and the fade/chevron CSS. */
  syncOverflow(): void {
    const el = this.container;
    if (!el) return;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft < max - 1;
    el.classList.toggle('overflow-left', left);
    el.classList.toggle('overflow-right', right);
    this.strip?.classList.toggle('overflow-left', left);
    this.strip?.classList.toggle('overflow-right', right);
  }

  private updateModifiedState(tab: Tab): void {
    const el = this.elements.get(tab.id);
    const dot = el?.querySelector<HTMLElement>('.tab-modified-dot');
    if (dot) dot.style.display = tab.modified ? '' : 'none';
    const conflict = !!tab.diskConflict;
    el?.classList.toggle('tab-conflict', conflict);
    if (dot) dot.title = conflict ? 'Changed on disk since you started editing' : '';
  }

  private updateViewModeState(tab: Tab): void {
    const el = this.elements.get(tab.id);
    const diff = tab.viewMode === 'diff';
    el?.classList.toggle('tab-diff', diff);
    const icon = el?.querySelector<HTMLElement>('.tab-diff-icon');
    if (icon) icon.style.display = diff ? '' : 'none';
  }
}
