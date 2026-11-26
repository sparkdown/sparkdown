import type { SearchResults } from '../api';
import {
  WikiIndex,
  backlinkQuery,
  findBacklinks,
  wikiRenderFor,
  type BacklinkHit,
  type WikiRender,
} from '../wiki-links';
import { debounce, escapeHtml, isMarkdownFile, joinPath, neutralizeUnicodeControls, toRelativePath } from '../utils';

export interface WikiLinkDeps {
  /** The open folder, or null. */
  root(): string | null;
  /** Machine of the folder (null = local): keys the file-list cache. */
  origin(): string | null;
  /** Absolute path of the active tab, if any. */
  activePath(): string | null;
  showHidden(): boolean;
  listFiles(root: string, includeHidden: boolean): Promise<{ files: string[]; truncated: boolean }>;
  search(root: string, regex: string, includeHidden: boolean): Promise<SearchResults>;
  /** The file list changed: re-render wiki links in the preview. */
  onIndexChanged(): void;
  openAt(path: string, line: number): void | Promise<void>;
  createEntry(parent: string, name: string, isDir: boolean): Promise<string>;
  openFile(path: string): void | Promise<void>;
  showError(text: string): void;
}

/** Delay between a save / watcher batch / tab switch and a backlinks refresh. */
const BACKLINKS_DEBOUNCE_MS = 250;

/**
 * Wiki links for the app: the workspace file index the preview resolves
 * `[[...]]` against, creating a missing note on click, and the Backlinks
 * list under the preview. The file list comes from the same backend listing
 * as Quick open (capped, ignored folders skipped); backlinks come from one
 * search-in-files query per refresh, so both follow the existing limits.
 */
export class WikiLinks {
  private index: WikiIndex | null = null;
  private indexKey: string | null = null;
  private loading: Promise<void> | null = null;
  private loadToken = 0;
  private backlinksToken = 0;
  private panel: HTMLElement | null;
  private expanded = false;
  private readonly refreshSoon = debounce(() => void this.refreshBacklinks(), BACKLINKS_DEBOUNCE_MS);

  constructor(private readonly deps: WikiLinkDeps, panel: HTMLElement | null = document.getElementById('wiki-backlinks')) {
    this.panel = panel;
  }

  private key(root: string): string {
    return JSON.stringify([this.deps.origin(), root, this.deps.showHidden()]);
  }

  /** Root-relative path of the active file, or null outside the folder. */
  private activeRel(): string | null {
    const root = this.deps.root();
    const path = this.deps.activePath();
    if (!root || !path) return null;
    return toRelativePath(path, root);
  }

  /** How the preview renders `[[target]]` for the active document. */
  resolve(target: string): WikiRender {
    this.ensureIndex();
    const root = this.deps.root();
    const rel = this.activeRel();
    const usable = root !== null && rel !== null && this.indexKey === this.key(root);
    return wikiRenderFor(target, usable ? this.index : null, usable ? rel : '');
  }

  /** Load the file list for the current folder unless it is current. */
  ensureIndex(): Promise<void> {
    const root = this.deps.root();
    if (!root) {
      this.index = null;
      this.indexKey = null;
      return Promise.resolve();
    }
    const key = this.key(root);
    if (this.indexKey === key && this.index) return Promise.resolve();
    if (this.loading && this.indexKey === key) return this.loading;
    this.indexKey = key;
    this.index = null;
    const token = ++this.loadToken;
    const hidden = this.deps.showHidden();
    this.loading = Promise.resolve()
      .then(() => this.deps.listFiles(root, hidden))
      .then((listing) => {
        if (token !== this.loadToken) return;
        this.index = new WikiIndex(listing.files);
        this.deps.onIndexChanged();
        this.refreshSoon();
      })
      .catch((err) => {
        if (token === this.loadToken) this.indexKey = null;
        console.warn('Wiki links: file list failed', err);
      })
      .finally(() => {
        if (token === this.loadToken) this.loading = null;
      });
    return this.loading;
  }

  /** Files were created, removed or renamed: reload the list. */
  invalidateIndex(): void {
    this.loadToken++;
    this.index = null;
    this.indexKey = null;
    this.loading = null;
    void this.ensureIndex();
  }

  /** Tab switch, save, or a watcher batch: refresh backlinks soon. */
  noteChanged(): void {
    this.refreshSoon();
  }

  /** Create the note a missing link points at (folders too), then open it. */
  async createAndOpen(path: string): Promise<void> {
    const root = this.deps.root();
    const rel = root ? toRelativePath(path, root) : null;
    if (!root || rel === null || rel === '') {
      this.deps.showError('Open a folder to create notes from wiki links.');
      return;
    }
    const segs = rel.split('/');
    let dir = root;
    try {
      for (const seg of segs.slice(0, -1)) {
        await this.createIgnoringExisting(dir, seg, true);
        dir = joinPath(dir, seg);
      }
      await this.createIgnoringExisting(dir, segs[segs.length - 1], false);
    } catch (err) {
      this.deps.showError(`Couldn't create ${rel}: ${String(err)}`);
      return;
    }
    this.invalidateIndex();
    await this.deps.openFile(joinPath(root, rel));
  }

  private async createIgnoringExisting(parent: string, name: string, isDir: boolean): Promise<void> {
    try {
      await this.deps.createEntry(parent, name, isDir);
    } catch (err) {
      if (/already exists/i.test(String(err))) return;
      throw err;
    }
  }

  /** Recompute the Backlinks list for the active file. */
  async refreshBacklinks(): Promise<void> {
    const token = ++this.backlinksToken;
    const root = this.deps.root();
    const path = this.deps.activePath();
    const rel = this.activeRel();
    if (!root || !path || rel === null || rel === '' || !isMarkdownFile(path)) {
      this.render(null, false);
      return;
    }
    await this.ensureIndex();
    const index = this.index;
    if (token !== this.backlinksToken || !index) return;
    let results: SearchResults;
    try {
      results = await this.deps.search(root, backlinkQuery(rel), this.deps.showHidden());
    } catch (err) {
      console.warn('Wiki links: backlinks search failed', err);
      if (token === this.backlinksToken) this.render(null, false);
      return;
    }
    if (token !== this.backlinksToken) return;
    const hits = findBacklinks(
      results.matches.map((m) => ({
        rel: toRelativePath(m.path, root),
        path: m.path,
        line: m.line,
        preview: m.preview,
      })),
      index,
      rel,
    );
    this.render(hits, results.truncated);
  }

  private render(hits: BacklinkHit[] | null, truncated: boolean): void {
    const panel = this.panel;
    if (!panel) return;
    if (!hits || hits.length === 0) {
      panel.classList.add('hidden');
      panel.replaceChildren();
      return;
    }
    const files = new Set(hits.map((h) => h.rel)).size;
    panel.classList.remove('hidden');
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'wiki-backlinks-header';
    header.setAttribute('aria-expanded', String(this.expanded));
    header.textContent =
      `${this.expanded ? '▾' : '▸'} Linked from ${files} ${files === 1 ? 'file' : 'files'}` +
      (truncated ? ' (search stopped at its limit)' : '');
    header.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.render(hits, truncated);
    });
    const children: HTMLElement[] = [header];
    if (this.expanded) {
      const list = document.createElement('ul');
      list.className = 'wiki-backlinks-list';
      for (const h of hits) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wiki-backlink';
        btn.title = `${h.rel}:${h.line}`;
        btn.innerHTML =
          `<span class="wiki-backlink-file">${escapeHtml(neutralizeUnicodeControls(h.rel))}</span>` +
          `<span class="wiki-backlink-line">${escapeHtml(neutralizeUnicodeControls(h.preview))}</span>`;
        btn.addEventListener('click', () => void this.deps.openAt(h.path, h.line));
        li.appendChild(btn);
        list.appendChild(li);
      }
      children.push(list);
    }
    panel.replaceChildren(...children);
  }
}
