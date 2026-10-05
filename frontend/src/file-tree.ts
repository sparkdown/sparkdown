import { startDrag } from '@crabnebula/tauri-plugin-drag';
import { EventBus } from './events';
import { debounce, parentDir, basename, isUnderRoot, normalizePathForCompare } from './utils';
import { TIMING, LAYOUT } from './constants';
import { isTextFile } from './file-types';
import { api, type FileEntry } from './api';
import { EVENTS } from './event-names';
import { showContextMenu } from './context-menu';

// 32x32 PNG (data URL) used as the drag preview thumbnail. The plugin
// requires a valid PNG — passing the dragged file's path causes the
// Rust-side serde decoder to fail and the drag never starts.
const DRAG_PREVIEW_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAATUlEQVR42mNgGAWjgAAICAj4TwmmigM+fPhANEa2dEAdMKAhANMzoA4YsBDAlR5GHTDqgFEHjDpg1AGjDhh1wKgDhrYDBrRZPgqGPQAA+G8N37ckd6AAAAAASUVORK5CYII=';

// Fixed row height (px) — virtualization math depends on every row being this
// tall. Must match the .tree-item height in sidebar.css.
const ROW_H = 24;
// Extra rows rendered above/below the viewport so fast scrolls don't flash blank.
const OVERSCAN = 8;

/**
 * Watcher flash: "this path was just written to disk." Cleared after a few
 * seconds. MUST NOT be used for tab focus or git status — those have their
 * own classes (TREE_CURRENT_CLASS / .tree-git-badge). Sharing this class
 * with tab activation is what made Linux (WebKitGTK) light explorer rows
 * as if they had changed (#27).
 */
export const TREE_FLASH_CLASS = 'tree-flash';
/** Quiet "this is the open file." Background only — no accent bar, no flash. */
export const TREE_CURRENT_CLASS = 'tree-current';
/** A file open in a tab: brighter name; other tabs also get a small dot. */
export const TREE_OPEN_CLASS = 'tree-open';

/** One visible line in the flattened tree (a folder or a file). */
type TreeRow =
  | { kind: 'dir'; entry: FileEntry; depth: number; expanded: boolean }
  | { kind: 'file'; entry: FileEntry; depth: number };

// Chevron pointing right; CSS turns it down for an expanded folder.
const CHEVRON_SVG =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

// Folder dot precedence: the strongest git letter below a folder wins.
const DIR_STATUS_ORDER = ['M', 'A', 'D', 'R', 'U'];

/** Left padding of a row (docs/ui-revamp/mockup.html). A folder row starts
 *  at BASE + depth × STEP and draws its chevron there; a nested file starts
 *  under its parent folder's name. A top-level file keeps an empty chevron
 *  slot, so its name lines up with the top-level folder names. */
function rowIndent(kind: TreeRow['kind'], depth: number): number {
  const base = LAYOUT.TREE_BASE_INDENT_PX + depth * LAYOUT.TREE_INDENT_PER_LEVEL_PX;
  return kind === 'file' && depth > 0 ? base + LAYOUT.TREE_NESTED_FILE_EXTRA_PX : base;
}

export class FileTree {
  private sidebarEl!: HTMLElement;
  private bus: EventBus;
  private visible: boolean;
  private width: number;
  private showHidden: boolean;
  private rootPath: string | null = null;
  private expandedDirs = new Set<string>();
  private titleEl: HTMLElement | null = null;
  // Paths the watcher recently reported as changed (agent activity), each with
  // a timer that clears the highlight. Persisted across virtualized re-renders
  // so the flash class is reapplied to rows as they scroll into view.
  private flashedPaths = new Map<string, number>();
  // Absolute path -> git status letter (M/A/D/R/U) for inline tree markers.
  // Comes only from `git status` (never from tab focus or the watcher).
  private gitStatus = new Map<string, string>();
  // Normalized folder path -> strongest git letter below it (folder dot).
  private dirGitStatus = new Map<string, string>();
  // Absolute path of the file currently shown in the editor. Independent of
  // flash and git badges so activating a tab cannot look like a disk change.
  private currentPath: string | null = null;
  // Normalized paths of the files open in tabs (the open-file dot).
  private openPaths = new Set<string>();

  // --- Virtualization state ---
  // The full flattened list of visible rows (the whole tree), and the children
  // cache so expand/collapse can rebuild the flat list without re-reading disk.
  private rows: TreeRow[] = [];
  private childrenCache = new Map<string, FileEntry[]>();
  private rootEntries: FileEntry[] = [];
  private viewport!: HTMLElement;   // scroll container (#file-tree)
  private spacer!: HTMLElement;     // full-height element that drives the scrollbar
  private rowLayer!: HTMLElement;   // absolutely-positioned container for visible rows
  private filterQuery = '';
  // Invalidates an in-flight root or child-directory read when the tree changes.
  private renderGeneration = 0;

  constructor(
    bus: EventBus,
    visible: boolean,
    width: number = LAYOUT.SIDEBAR_DEFAULT_PX,
    showHidden = false,
  ) {
    this.bus = bus;
    this.visible = visible;
    this.width = width;
    this.showHidden = showHidden;
  }

  setShowHidden(show: boolean): void {
    if (this.showHidden === show) return;
    this.showHidden = show;
    document.getElementById('btn-toggle-hidden')?.setAttribute('aria-pressed', String(show));
    if (this.rootPath) void this.renderTree({ resetScroll: true });
  }

  isShowHidden(): boolean {
    return this.showHidden;
  }

  init(container: HTMLElement, sidebarEl: HTMLElement): void {
    this.sidebarEl = sidebarEl;
    this.sidebarEl.classList.toggle('hidden', !this.visible);
    // Sidebar is an in-flow flex panel; its width drives the column width.
    document.documentElement.style.setProperty('--sidebar-width', `${this.width}px`);

    // Virtualized-tree scaffold: #file-tree is the scroll viewport; a tall
    // spacer drives the scrollbar and only the visible rows are mounted into
    // an absolutely-positioned layer. Keeps the DOM at ~viewport size even for
    // folders with thousands of entries.
    this.viewport = container;
    this.spacer = document.createElement('div');
    this.spacer.className = 'tree-spacer';
    this.rowLayer = document.createElement('div');
    this.rowLayer.className = 'tree-rowlayer';
    this.spacer.appendChild(this.rowLayer);
    this.viewport.appendChild(this.spacer);
    this.viewport.addEventListener('scroll', () => this.renderViewport(), { passive: true });

    // Tab activation is not a disk change: apply the quiet current-file
    // class only. App may also call setCurrentPath; the setter is idempotent.
    this.bus.on(EVENTS.TAB_SWITCHED, (data) => {
      this.setCurrentPath(data.tab?.path ?? null);
    });
    this.bus.on(EVENTS.ALL_TABS_CLOSED, () => this.setCurrentPath(null));

    // Header title: the folder name. Right-click goes to the parent folder
    // (the header has no separate parent button).
    this.titleEl = document.getElementById('sidebar-title');
    this.titleEl?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const root = this.rootPath;
      if (!root) return;
      const items = [];
      if (parentDir(root)) {
        items.push({ label: 'Go to Parent Folder', onClick: () => void this.goToParent() });
      }
      items.push({ label: 'Copy Path', onClick: () => void api.copyText(root) });
      showContextMenu(e.clientX, e.clientY, items);
    });
    this.updateTitle();

    // Hidden-files toggle
    const hiddenToggle = document.getElementById('btn-toggle-hidden');
    if (hiddenToggle) {
      hiddenToggle.setAttribute('aria-pressed', String(this.showHidden));
      hiddenToggle.addEventListener('click', () => {
        this.setShowHidden(!this.showHidden);
        this.bus.emit(EVENTS.SIDEBAR_TOGGLED, { visible: this.visible });
      });
    }

    document
      .getElementById('btn-collapse-all')
      ?.addEventListener('click', () => this.collapseAll());

    // Filter: the header button shows a filter field under the header.
    const filterToggle = document.getElementById('btn-search-toggle');
    const filterInput = document.getElementById('sidebar-search-input') as HTMLInputElement | null;
    const filterRow = document.getElementById('sidebar-filter') ?? filterInput;
    if (filterToggle && filterInput && filterRow) {
      const close = () => {
        filterRow.classList.add('hidden');
        filterToggle.setAttribute('aria-pressed', 'false');
        filterInput.value = '';
        this.filterTree('');
      };
      filterToggle.addEventListener('click', () => {
        if (!filterRow.classList.contains('hidden')) {
          close();
          return;
        }
        filterRow.classList.remove('hidden');
        filterToggle.setAttribute('aria-pressed', 'true');
        filterInput.focus();
      });
      const debouncedFilter = debounce((q: string) => this.filterTree(q), TIMING.FILTER_DEBOUNCE_MS);
      filterInput.addEventListener('input', () => {
        debouncedFilter(filterInput.value);
      });
      filterInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
      });
    }
  }

  async setRoot(path: string, force = false): Promise<void> {
    if (this.rootPath === path) return;
    // App.updateBaseDirForTab always setRoot(dirname(open file)) on tab
    // switch. If that directory already lives under the current explorer
    // root, keep the workspace so Linux inotify does not restart (#27).
    // Explicit navigation (Open Folder, parent button, context menu) passes
    // force=true so a nested folder can still become the root.
    if (!force && this.rootPath && isUnderRoot(path, this.rootPath)) return;
    this.rootPath = path;
    this.expandedDirs.clear();
    this.childrenCache.clear();
    this.updateTitle();
    await this.renderTree({ resetScroll: true });
    // A new root: show the open file if it lives below it.
    if (this.currentPath && this.rootPath === path) await this.revealPath(this.currentPath);
  }

  /** Drop the root and everything derived from it (origin switch: the old
   *  machine's paths must not stay clickable). Shows the empty state. */
  clear(): void {
    this.rootPath = null;
    this.expandedDirs.clear();
    this.childrenCache.clear();
    this.gitStatus.clear();
    this.dirGitStatus.clear();
    this.currentPath = null;
    this.openPaths.clear();
    for (const timer of this.flashedPaths.values()) clearTimeout(timer);
    this.flashedPaths.clear();
    this.updateTitle();
    if (this.rowLayer) void this.renderTree({ resetScroll: true });
  }

  /** Current tree root, or null if nothing is open. */
  getRoot(): string | null {
    return this.rootPath;
  }

  /**
   * Re-read the tree from disk, preserving root and which dirs are expanded.
   * Called when the filesystem watcher reports changes (an agent edited files)
   * so the explorer reflects them without losing the user's expansion state.
   */
  async refresh(): Promise<void> {
    if (!this.rootPath) return;
    // Re-read disk but do not wipe scroll; renderTree skips the DOM when the
    // path/structure snapshot is unchanged (remote poll / content-only ticks).
    await this.renderTree({ resetScroll: false });
  }

  /**
   * Flash `paths` as recently written to disk. Highlights the matching rows
   * and any currently-visible ancestor dirs, clearing each after a few
   * seconds. Called from the filesystem-watcher pipeline only — never from
   * tab activation.
   */
  markChanged(paths: string[]): void {
    const HIGHLIGHT_MS = 4000;
    for (const path of paths) {
      const existing = this.flashedPaths.get(path);
      if (existing) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        this.flashedPaths.delete(path);
        this.toggleRowClass(path, TREE_FLASH_CLASS, false);
      }, HIGHLIGHT_MS);
      this.flashedPaths.set(path, timer);
      this.toggleRowClass(path, TREE_FLASH_CLASS, true);
    }
  }

  /**
   * Mark the file currently shown in the editor. Applies TREE_CURRENT_CLASS
   * only — never the watcher flash or a git badge. Activating a tab must
   * call this (and only this) so Linux WebKitGTK focus/selection styling
   * cannot be mistaken for a disk change (#27). Also reveals the file:
   * expands its folders and scrolls it into view (never re-roots the tree).
   */
  setCurrentPath(path: string | null): void {
    if (this.currentPath === path) return;
    this.currentPath = path;
    // Re-mount the visible rows: the current row drops its open-file dot and
    // the previous one gets it back.
    if (this.rowLayer && this.rootPath) this.renderViewport();
    if (path) void this.revealPath(path);
  }

  /** The files open in tabs. Their rows get the open-file dot. */
  setOpenPaths(paths: Iterable<string>): void {
    const next = new Set<string>();
    for (const p of paths) next.add(normalizePathForCompare(p));
    if (next.size === this.openPaths.size && [...next].every((p) => this.openPaths.has(p))) return;
    this.openPaths = next;
    if (this.rowLayer && this.rootPath) this.renderViewport();
  }

  /**
   * Expand every folder between the root and `path`, then scroll its row
   * into view if it is outside the viewport. No-op for a path outside the
   * tree. Folder children are read on demand (and cached).
   */
  async revealPath(path: string): Promise<void> {
    const root = this.rootPath;
    if (!root || !this.viewport || !isUnderRoot(path, root)) return;
    const target = normalizePathForCompare(path);
    const stillWanted = () => this.rootPath === root && this.currentPath === path;
    let entries = this.rootEntries;
    let changed = false;
    for (;;) {
      const dir = entries.find(
        (e) => e.is_dir && target.startsWith(`${normalizePathForCompare(e.path)}/`),
      );
      if (!dir) break;
      if (!this.expandedDirs.has(dir.path)) {
        this.expandedDirs.add(dir.path);
        changed = true;
      }
      let kids = this.childrenCache.get(dir.path);
      if (!kids) {
        try {
          kids = await api.listDirectory(dir.path, this.showHidden);
        } catch {
          this.expandedDirs.delete(dir.path);
          break;
        }
        // The root or the open file moved on while the disk was read.
        if (!stillWanted()) return;
        this.childrenCache.set(dir.path, kids);
      }
      entries = kids;
    }
    if (!stillWanted()) return;
    if (changed) this.rebuildRows();
    const index = this.rows.findIndex((r) => normalizePathForCompare(r.entry.path) === target);
    if (index >= 0) {
      const top = index * ROW_H;
      const height = this.viewport.clientHeight || 0;
      const scroll = this.viewport.scrollTop;
      if (height > 0 && (top < scroll || top + ROW_H > scroll + height)) {
        this.viewport.scrollTop = Math.max(0, Math.round(top - height / 2 + ROW_H / 2));
        changed = true;
      }
    }
    if (changed) this.renderViewport();
  }

  /** Collapse every expanded folder (the header's Collapse all). */
  collapseAll(): void {
    if (this.expandedDirs.size === 0) return;
    ++this.renderGeneration;
    this.expandedDirs.clear();
    this.rebuildRows();
    this.viewport.scrollTop = 0;
    this.renderViewport();
  }

  /** Set inline git-status markers on tree rows. `map` is absolute path → a
   *  single-letter status (M/A/D/R/U) from `git status`. Re-renders so
   *  markers appear/clear. Folders above a change get a small dot. Does not
   *  touch the watcher flash. */
  setGitStatus(map: Map<string, string>): void {
    // Key by a normalized (separator- and drive-case-insensitive) path so the
    // git top-level's forward-slash paths match the tree's native entry paths
    // on Windows — otherwise badges never appear. Lookup normalizes too.
    const normalized = new Map<string, string>();
    const dirs = new Map<string, string>();
    const rank = (s: string) => {
      const i = DIR_STATUS_ORDER.indexOf(s);
      return i < 0 ? DIR_STATUS_ORDER.length : i;
    };
    for (const [path, status] of map) {
      const norm = normalizePathForCompare(path);
      normalized.set(norm, status);
      for (let dir = parentDir(norm); dir; dir = parentDir(dir)) {
        const prev = dirs.get(dir);
        // An ancestor already carries an equal or stronger status, and so
        // do all folders above it.
        if (prev !== undefined && rank(prev) <= rank(status)) break;
        dirs.set(dir, status);
      }
    }
    this.gitStatus = normalized;
    this.dirGitStatus = dirs;
    if (this.rootPath) this.renderViewport();
  }

  /** Find a currently-mounted row by its absolute path (no CSS.escape). */
  private rowEl(path: string): HTMLElement | null {
    const items = this.rowLayer?.querySelectorAll<HTMLElement>('.tree-item');
    if (!items) return null;
    for (const el of items) {
      if (el.dataset.path === path) return el;
    }
    return null;
  }

  private toggleRowClass(path: string, cls: string, on: boolean): void {
    this.rowEl(path)?.classList.toggle(cls, on);
  }

  /** Move the tree root up one level. No-op at the filesystem root. */
  private async goToParent(): Promise<void> {
    if (!this.rootPath) return;
    const parent = parentDir(this.rootPath);
    if (!parent) return;
    await this.setRoot(parent, true);
  }

  /** Header title: the folder's name, with the full path as the tooltip. */
  private updateTitle(): void {
    if (!this.titleEl) return;
    const root = this.rootPath;
    this.titleEl.textContent = root ? basename(root.replace(/[/\\]+$/, '')) || root : 'Files';
    if (root) this.titleEl.title = root;
    else this.titleEl.removeAttribute('title');
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  /** Show or hide the sidebar (the activity bar and the sidebar toggle). */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.sidebarEl.classList.toggle('hidden', !this.visible);
    this.bus.emit(EVENTS.SIDEBAR_TOGGLED, { visible: this.visible });
  }

  getWidth(): number {
    return this.width;
  }

  setWidth(width: number): void {
    this.width = width;
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Show the sidebar if it's currently hidden. No-op when already visible. */
  ensureVisible(): void {
    if (!this.visible) this.toggle();
  }

  /**
   * Stable signature of a directory listing: paths + dir/file bits only.
   * Content/mtime edits do not change this, so remote poll ticks and file
   * saves can skip a DOM remount when the tree shape is unchanged.
   */
  private listingSignature(entries: FileEntry[]): string {
    return entries.map((e) => `${e.is_dir ? 'd' : 'f'}\0${e.path}`).join('\n');
  }

  /** Snapshot of root + every expanded folder currently shown. */
  private treeStructureSignature(
    rootEntries: FileEntry[],
    expanded: Iterable<string>,
    children: Map<string, FileEntry[]>,
  ): string {
    const parts = [`root\0${this.listingSignature(rootEntries)}`];
    for (const path of [...expanded].sort()) {
      const kids = children.get(path);
      parts.push(`${path}\0${kids ? this.listingSignature(kids) : ''}`);
    }
    return parts.join('\n#\n');
  }

  private async renderTree(opts: { resetScroll?: boolean } = {}): Promise<void> {
    const resetScroll = opts.resetScroll === true;
    const generation = ++this.renderGeneration;
    if (!this.rootPath) {
      this.rootEntries = [];
      this.rows = [];
      this.spacer.style.height = '0px';
      this.rowLayer.innerHTML = '<div class="tree-empty">Open a folder to see its files</div>';
      return;
    }
    const rootPath = this.rootPath;
    // Stash before awaits so a real update can restore the user's place.
    const savedScrollTop = resetScroll ? 0 : this.viewport.scrollTop;
    const prevSignature = resetScroll
      ? null
      : this.treeStructureSignature(this.rootEntries, this.expandedDirs, this.childrenCache);
    try {
      const rootEntries = await api.listDirectory(rootPath, this.showHidden);
      if (generation !== this.renderGeneration || this.rootPath !== rootPath) return;

      // Reload expanded directories before rebuilding so a refresh preserves
      // both the expansion state and the visible children. A folder removed
      // during the refresh is pruned instead of leaving a dead open row.
      const expanded = [...this.expandedDirs];
      const loaded = await Promise.all(expanded.map(async (path) => {
        try {
          return [path, await api.listDirectory(path, this.showHidden)] as const;
        } catch {
          return null;
        }
      }));
      if (generation !== this.renderGeneration || this.rootPath !== rootPath) return;

      const nextExpanded = new Set<string>();
      const nextChildren = new Map<string, FileEntry[]>();
      for (const result of loaded) {
        if (!result) continue;
        const [path, entries] = result;
        nextExpanded.add(path);
        nextChildren.set(path, entries);
      }

      const nextSignature = this.treeStructureSignature(rootEntries, nextExpanded, nextChildren);
      if (prevSignature !== null && prevSignature === nextSignature) {
        // Same paths/structure as last render — keep the existing DOM and scroll.
        return;
      }

      this.rootEntries = rootEntries;
      this.childrenCache = nextChildren;
      this.expandedDirs = nextExpanded;
      this.rebuildRows();
      this.viewport.scrollTop = savedScrollTop;
      this.renderViewport();
    } catch {
      if (generation !== this.renderGeneration) return;
      this.rows = [];
      this.spacer.style.height = '0px';
      this.rowLayer.innerHTML = '<div class="tree-error">Failed to load directory</div>';
    }
  }

  /**
   * Flatten the (possibly expanded) tree into the linear `rows` list that the
   * virtualizer windows over. Rebuilt on root change, expand/collapse, and
   * filter — never on scroll. One tree only (folders first, as listed).
   */
  private rebuildRows(): void {
    const rows: TreeRow[] = [];
    const q = this.filterQuery;
    const match = (name: string) => !q || name.toLowerCase().includes(q);

    const walk = (entries: FileEntry[], depth: number) => {
      for (const entry of entries) {
        if (entry.is_dir) {
          const expanded = this.expandedDirs.has(entry.path);
          // When filtering, only keep dirs whose name matches (children of an
          // expanded dir are still walked so matches deeper down can surface).
          if (match(entry.name) || expanded) {
            rows.push({ kind: 'dir', entry, depth, expanded });
          }
          if (expanded) {
            const kids = this.childrenCache.get(entry.path);
            if (kids) walk(kids, depth + 1);
          }
        } else if (match(entry.name)) {
          rows.push({ kind: 'file', entry, depth });
        }
      }
    };
    walk(this.rootEntries, 0);

    this.rows = rows;
    this.spacer.style.height = `${rows.length * ROW_H}px`;
  }

  /**
   * Mount only the rows intersecting the viewport (plus overscan) into the
   * absolutely-positioned row layer. Called on scroll and after any rebuild.
   */
  private renderViewport(): void {
    const scrollTop = this.viewport.scrollTop;
    const height = this.viewport.clientHeight || 1;
    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(this.rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);

    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const el = this.createRowElement(this.rows[i]);
      el.style.position = 'absolute';
      el.style.top = `${i * ROW_H}px`;
      el.style.left = '0';
      el.style.right = '0';
      frag.appendChild(el);
    }
    this.rowLayer.replaceChildren(frag);
  }

  /** Build the DOM element for one flattened row:
   *  [chevron] name [git badge] [open-file dot]. */
  private createRowElement(row: TreeRow): HTMLElement {
    const { entry, depth } = row;
    const el = document.createElement('div');
    el.className = row.kind === 'dir' ? 'tree-item directory' : 'tree-item';
    el.style.paddingLeft = `${rowIndent(row.kind, depth)}px`;
    el.dataset.path = entry.path;
    el.setAttribute('role', 'treeitem');
    // WebKitGTK focuses any clicked div; prevent that so GTK's native
    // selected-row style cannot masquerade as a change flash (#27).
    el.tabIndex = -1;
    if (this.flashedPaths.has(entry.path)) el.classList.add(TREE_FLASH_CLASS);
    if (this.currentPath === entry.path) el.classList.add(TREE_CURRENT_CLASS);
    const norm = normalizePathForCompare(entry.path);

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = entry.name;

    if (row.kind === 'dir') {
      el.setAttribute('aria-expanded', String(row.expanded));
      const chevron = document.createElement('span');
      chevron.className = 'tree-chevron';
      chevron.innerHTML = CHEVRON_SVG;
      if (row.expanded) chevron.classList.add('expanded');
      el.appendChild(chevron);
      el.appendChild(name);
      const status = this.dirGitStatus.get(norm);
      if (status) {
        const dot = document.createElement('span');
        dot.className = `tree-git-badge tree-git-dot git-${status.toLowerCase()}`;
        dot.textContent = '•';
        dot.title = 'Contains changes';
        el.appendChild(dot);
      }
      const wasDragging = this.attachDragHandler(el, entry.path);
      el.addEventListener('click', () => {
        if (!wasDragging()) void this.toggleDir(entry.path);
      });
      this.attachContextMenu(el, entry, false);
      return el;
    }

    // file
    if (depth === 0) {
      const slot = document.createElement('span');
      slot.className = 'tree-chevron';
      el.appendChild(slot);
    }
    const isText = isTextFile(entry.name);
    el.classList.add(isText ? 'text-file' : 'other-file');
    const isOpen = this.openPaths.has(norm);
    if (isOpen) el.classList.add(TREE_OPEN_CLASS);
    el.appendChild(name);
    // Inline git-status marker (M/A/U…), if this file has one. Keyed by
    // normalized path (see setGitStatus) so separators/drive case can't miss.
    const status = this.gitStatus.get(norm);
    if (status) {
      const badge = document.createElement('span');
      badge.className = `tree-git-badge git-${status.toLowerCase()}`;
      badge.textContent = status;
      el.appendChild(badge);
    }
    // Open in another tab (the current file has its own highlight instead).
    if (isOpen && this.currentPath !== entry.path) {
      const dot = document.createElement('span');
      dot.className = 'tree-open-dot';
      dot.title = 'Open in a tab';
      el.appendChild(dot);
    }
    const wasDragging = this.attachDragHandler(el, entry.path);
    if (isText) {
      el.addEventListener('click', () => {
        if (!wasDragging()) this.bus.emit(EVENTS.FILE_TREE_OPEN, { path: entry.path });
      });
    }
    this.attachContextMenu(el, entry, true);
    return el;
  }

  /** Right-click menu: Open (files), Copy file, Copy name, Copy path. */
  private attachContextMenu(el: HTMLElement, entry: FileEntry, isFile: boolean): void {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [];
      if (isFile) {
        items.push({ label: 'Open', onClick: () => this.bus.emit(EVENTS.FILE_TREE_OPEN, { path: entry.path }) });
      } else {
        items.push({ label: 'Open Folder', onClick: () => void this.setRoot(entry.path, true) });
      }
      items.push(
        { label: 'Copy', onClick: () => void api.copyFile(entry.path) },
        { label: 'Copy Name', onClick: () => void api.copyText(basename(entry.path)) },
        { label: 'Copy Path', onClick: () => void api.copyText(entry.path) },
      );
      showContextMenu(e.clientX, e.clientY, items);
    });
  }

  private attachDragHandler(el: HTMLElement, path: string): () => boolean {
    let dragStartX = 0;
    let dragStartY = 0;
    let dragging = false;

    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // Prevent WebKitGTK from focusing the row (GTK selected-row chrome
      // looks like the watcher flash). Click still fires; drag still starts.
      e.preventDefault();
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragging = false;

      const onMove = (ev: MouseEvent) => {
        if (dragging) return;
        const dx = ev.clientX - dragStartX;
        const dy = ev.clientY - dragStartY;
        if (Math.abs(dx) + Math.abs(dy) > LAYOUT.TREE_DRAG_THRESHOLD_PX) {
          dragging = true;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          startDrag({ item: [path], icon: DRAG_PREVIEW_ICON, mode: 'copy' }).catch((err) => {
            console.error('Drag failed:', err);
          });
        }
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    return () => dragging;
  }

  private async toggleDir(path: string): Promise<void> {
    const generation = ++this.renderGeneration;
    if (this.expandedDirs.has(path)) {
      this.expandedDirs.delete(path);
      this.rebuildRows();
      this.renderViewport();
      return;
    }
    this.expandedDirs.add(path);
    // Lazily load and cache children, then rebuild the flat list.
    if (!this.childrenCache.has(path)) {
      try {
        const entries = await api.listDirectory(path, this.showHidden);
        if (generation !== this.renderGeneration || !this.expandedDirs.has(path)) return;
        this.childrenCache.set(path, entries);
      } catch {
        this.expandedDirs.delete(path);
        return;
      }
    }
    this.rebuildRows();
    this.renderViewport();
  }

  /** Filter the tree by name. Matching is applied during row flattening. */
  private filterTree(query: string): void {
    this.filterQuery = query.trim().toLowerCase();
    this.rebuildRows();
    this.viewport.scrollTop = 0;
    this.renderViewport();
  }
}
