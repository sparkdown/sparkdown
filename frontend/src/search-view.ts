import { api, type SearchMatch, type SearchResults } from './api';
import { debounce, toRelativePath, basename } from './utils';

/** Wait this long after the last keystroke before searching. */
const SEARCH_DEBOUNCE_MS = 250;

export interface SearchViewDeps {
  /** Open `path` and put the cursor at `line` / `column` (1-based). */
  openAt(path: string, line: number, column: number): void;
  /** Search hidden files too (follows the explorer's "show hidden"). */
  includeHidden(): boolean;
}

/**
 * The sidebar's "Search in files" view: a literal, case-insensitive text
 * search over the open folder (search_in_files in search.rs — a local walk,
 * or grep on the SSH host). Results are grouped by file; a click opens the
 * file at the matching line.
 */
export class SearchView {
  private root: string | null = null;
  private input: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;
  /** Bumped for every search and root change; stale replies are dropped. */
  private generation = 0;
  private lastQuery = '';
  private debouncedRun = debounce(() => void this.run(), SEARCH_DEBOUNCE_MS);

  constructor(private readonly deps: SearchViewDeps) {}

  init(): void {
    this.input = document.getElementById('search-input') as HTMLInputElement | null;
    this.statusEl = document.getElementById('search-status');
    this.resultsEl = document.getElementById('search-results');
    this.input?.addEventListener('input', () => this.debouncedRun());
    this.input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.run(true);
      } else if (e.key === 'Escape' && this.input?.value) {
        e.preventDefault();
        this.input.value = '';
        void this.run();
      }
    });
    this.resultsEl?.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.search-hit');
      if (!row?.dataset.path) return;
      this.resultsEl?.querySelector('.search-hit.selected')?.classList.remove('selected');
      row.classList.add('selected');
      this.deps.openAt(row.dataset.path, Number(row.dataset.line), Number(row.dataset.column));
    });
    this.renderStatus(this.root ? '' : 'Open a folder to search its files.');
  }

  /** The folder to search. A change clears the results (they name paths in
   *  the old folder) and re-runs the current query. */
  setRoot(root: string | null): void {
    if (root === this.root) return;
    this.root = root;
    this.generation++;
    this.lastQuery = '';
    this.resultsEl?.replaceChildren();
    if (!root) {
      this.renderStatus('Open a folder to search its files.');
      return;
    }
    this.renderStatus('');
    if (this.input?.value.trim()) void this.run(true);
  }

  focus(): void {
    this.input?.focus();
    this.input?.select();
  }

  hasFocus(): boolean {
    return !!this.input && document.activeElement === this.input;
  }

  /** Search for the input's text. `force` re-runs an unchanged query. */
  async run(force = false): Promise<void> {
    const query = this.input?.value.trim() ?? '';
    if (!force && query === this.lastQuery) return;
    this.lastQuery = query;
    const gen = ++this.generation;
    if (!query) {
      this.resultsEl?.replaceChildren();
      this.renderStatus(this.root ? '' : 'Open a folder to search its files.');
      return;
    }
    const root = this.root;
    if (!root) {
      this.renderStatus('Open a folder to search its files.');
      return;
    }
    this.renderStatus('Searching…');
    let results: SearchResults;
    try {
      results = await api.searchInFiles(root, query, false, this.deps.includeHidden());
    } catch (err) {
      if (gen !== this.generation) return;
      this.resultsEl?.replaceChildren();
      this.renderStatus(`Search failed: ${String(err)}`);
      return;
    }
    if (gen !== this.generation) return; // a newer search or another folder
    this.render(results, root);
  }

  private renderStatus(text: string): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    this.statusEl.hidden = !text;
  }

  private render(results: SearchResults, root: string): void {
    const list = this.resultsEl;
    if (!list) return;
    const groups = new Map<string, SearchMatch[]>();
    for (const m of results.matches) {
      const group = groups.get(m.path);
      if (group) group.push(m);
      else groups.set(m.path, [m]);
    }
    if (groups.size === 0) {
      list.replaceChildren();
      this.renderStatus('No results.');
      return;
    }
    const frag = document.createDocumentFragment();
    for (const [path, matches] of groups) {
      const head = document.createElement('div');
      head.className = 'search-file';
      head.setAttribute('role', 'treeitem');
      head.setAttribute('aria-expanded', 'true');
      const rel = toRelativePath(path, root) || basename(path);
      head.title = path;
      const name = document.createElement('span');
      name.className = 'search-file-name';
      name.textContent = rel;
      const count = document.createElement('span');
      count.className = 'search-count';
      count.textContent = String(matches.length);
      head.append(name, count);
      frag.appendChild(head);
      for (const m of matches) frag.appendChild(this.hitRow(m));
    }
    list.replaceChildren(frag);
    const files = groups.size;
    const n = results.matches.length;
    const summary = `${n} ${n === 1 ? 'result' : 'results'} in ${files} ${files === 1 ? 'file' : 'files'}`;
    this.renderStatus(results.truncated ? `${summary} (search stopped early; refine the query)` : summary);
  }

  private hitRow(m: SearchMatch): HTMLElement {
    const row = document.createElement('div');
    row.className = 'search-hit';
    row.setAttribute('role', 'treeitem');
    row.dataset.path = m.path;
    row.dataset.line = String(m.line);
    row.dataset.column = String(m.column);
    row.title = `Line ${m.line}`;
    const text = document.createElement('span');
    text.className = 'search-hit-text';
    const chars = [...m.preview];
    const before = chars.slice(0, m.match_start).join('');
    const hit = chars.slice(m.match_start, m.match_end).join('');
    const after = chars.slice(m.match_end).join('');
    const mark = document.createElement('b');
    mark.textContent = hit;
    text.append(before, mark, after);
    const line = document.createElement('span');
    line.className = 'search-hit-line';
    line.textContent = String(m.line);
    row.append(text, line);
    return row;
  }
}
