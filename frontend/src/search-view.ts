import {
  api,
  type ReplaceFileOutcome,
  type ReplacePreview,
  type SearchMatch,
  type SearchResults,
} from './api';
import { editsFor, planFrom, selectedCount, splitPreview, UNSAVED_REASON, type PlanFile } from './replace-plan';
import { debounce, toRelativePath, basename } from './utils';

/** Start of the message search.rs returns for `\p{..}` / `\P{..}` classes
 *  (the regex engine has no Unicode property tables). Shown as it is. */
const UNICODE_CLASS_MESSAGE = 'Unicode classes like';

/** Wait this long after the last keystroke before searching. */
const SEARCH_DEBOUNCE_MS = 250;

export interface SearchViewDeps {
  /** Open `path` and put the cursor at `line` / `column` (1-based). */
  openAt(path: string, line: number, column: number): void;
  /** Search hidden files too (follows the explorer's "show hidden"). */
  includeHidden(): boolean;
  /** The open folder is on an SSH host (replace is local only). */
  isRemote(): boolean;
  /** `path` is open in a tab whose text differs from what it last read from
   *  or wrote to disk. Such files are left out of a replace. */
  hasUnsavedChanges(path: string): boolean;
  /** Replace wrote these files: bring open tabs up to date. */
  filesWritten(paths: string[]): Promise<void>;
}

/** What a replace preview was made from; apply sends the same. */
interface PreviewArgs {
  root: string;
  query: string;
  includeHidden: boolean;
  useRegex: boolean;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
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
  private useRegex = false;
  private debouncedRun = debounce(() => void this.run(), SEARCH_DEBOUNCE_MS);
  private replaceInput: HTMLInputElement | null = null;
  /** The replace preview being shown, or null for plain search results. */
  private plan: { files: PlanFile[]; args: PreviewArgs; preview: ReplacePreview } | null = null;
  /** The last replace, while it can still be undone. */
  private undoBatch: { id: number; root: string } | null = null;
  private busy = false;

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
      const target = e.target as HTMLElement;
      const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
      if (action === 'apply') return void this.apply();
      if (action === 'cancel') return this.closePreview();
      if (action === 'undo') return void this.undo();
      if (target.closest('input, button')) return;
      const row = target.closest<HTMLElement>('.search-hit');
      if (!row?.dataset.path) return;
      this.resultsEl?.querySelector('.search-hit.selected')?.classList.remove('selected');
      row.classList.add('selected');
      this.deps.openAt(row.dataset.path, Number(row.dataset.line), Number(row.dataset.column));
    });

    // Regex toggle button
    const regexBtn = document.getElementById('search-regex-btn');
    regexBtn?.addEventListener('click', () => {
      this.useRegex = !this.useRegex;
      regexBtn.classList.toggle('active', this.useRegex);
      regexBtn.setAttribute('aria-pressed', String(this.useRegex));
      void this.run(true);
    });

    this.initReplace();
    this.renderStatus(this.root ? '' : 'Open a folder to search its files.');
  }

  private initReplace(): void {
    this.replaceInput = document.getElementById('search-replace-input') as HTMLInputElement | null;
    const row = document.getElementById('search-replace-row');
    const toggle = document.getElementById('search-replace-btn');
    toggle?.addEventListener('click', () => {
      const open = !!row?.hidden;
      if (row) row.hidden = !open;
      toggle.classList.toggle('active', open);
      toggle.setAttribute('aria-pressed', String(open));
      if (open) this.replaceInput?.focus();
      else if (this.plan) this.closePreview();
    });
    document.getElementById('search-replace-preview-btn')?.addEventListener('click', () => void this.preview());
    this.replaceInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.preview();
      }
    });
    // The preview shows the replacement live; no new backend call needed.
    this.replaceInput?.addEventListener('input', () => {
      if (this.plan) this.renderPlan();
    });
    this.resultsEl?.addEventListener('change', (e) => {
      const box = e.target as HTMLInputElement;
      if (!this.plan || !box.matches('input.replace-check')) return;
      const file = this.plan.files[Number(box.dataset.file)];
      if (!file) return;
      if (box.dataset.hit === undefined) file.selected = file.selected.map(() => box.checked);
      else file.selected[Number(box.dataset.hit)] = box.checked;
      this.renderPlan();
    });
  }

  /** The folder to search. A change clears the results (they name paths in
   *  the old folder) and re-runs the current query. */
  setRoot(root: string | null): void {
    if (root === this.root) return;
    this.root = root;
    this.generation++;
    this.lastQuery = '';
    this.plan = null;
    this.undoBatch = null;
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
    if (this.busy) return;
    this.lastQuery = query;
    this.plan = null;
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
      results = await api.searchInFiles(root, query, false, this.deps.includeHidden(), this.useRegex);
    } catch (err) {
      if (gen !== this.generation) return;
      this.resultsEl?.replaceChildren();
      // Show friendly error for invalid regex patterns (first line only)
      const errMsg = String(err);
      const firstLine = errMsg.split('\n')[0];
      if (firstLine.includes('Invalid regex pattern') || firstLine.includes(UNICODE_CLASS_MESSAGE)) {
        this.renderStatus(firstLine.replace('Search failed: ', ''));
      } else {
        this.renderStatus(`Search failed: ${firstLine}`);
      }
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

  /** Leave the preview and show the plain search results again. */
  closePreview(): void {
    this.plan = null;
    void this.run(true);
  }

  /** List every hit with its replacement, for the user to confirm. */
  async preview(): Promise<void> {
    const query = this.input?.value.trim() ?? '';
    const root = this.root;
    if (this.busy) return;
    if (!root) return this.renderStatus('Open a folder to search its files.');
    if (this.deps.isRemote()) return this.renderStatus('Replace is not available for remote folders.');
    if (!query) return this.renderStatus('Type what to find, then what to replace it with.');
    const args: PreviewArgs = { root, query, includeHidden: this.deps.includeHidden(), useRegex: this.useRegex };
    const gen = ++this.generation;
    this.lastQuery = query;
    this.renderStatus('Finding matches…');
    let preview: ReplacePreview;
    try {
      preview = await api.replacePreview(root, query, args.includeHidden, args.useRegex);
    } catch (err) {
      if (gen !== this.generation) return;
      this.resultsEl?.replaceChildren();
      this.renderStatus(String(err).split('\n')[0]);
      return;
    }
    if (gen !== this.generation) return;
    this.plan = { files: planFrom(preview, (p) => this.deps.hasUnsavedChanges(p)), args, preview };
    this.renderPlan();
  }

  /** Replace the selected hits. Files that got unsaved changes since the
   *  preview are left out too. */
  async apply(): Promise<void> {
    const plan = this.plan;
    if (!plan || this.busy) return;
    for (const f of plan.files) {
      if (!f.blocked && this.deps.hasUnsavedChanges(f.path)) f.blocked = UNSAVED_REASON;
    }
    const edits = editsFor(plan.files);
    if (!edits.length) {
      this.renderPlan();
      return;
    }
    const replacement = this.replaceInput?.value ?? '';
    const { root, query, includeHidden, useRegex } = plan.args;
    this.busy = true;
    this.generation++;
    this.renderStatus('Replacing…');
    this.resultsEl?.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach((el) => (el.disabled = true));
    let outcomes: ReplaceFileOutcome[];
    let batchId: number | null;
    try {
      const result = await api.replaceApply(root, query, replacement, edits, includeHidden, useRegex);
      outcomes = result.files;
      batchId = result.batch_id;
    } catch (err) {
      this.busy = false;
      this.renderPlan();
      this.renderStatus(`Replace failed: ${String(err).split('\n')[0]}`);
      return;
    }
    const written = outcomes.filter((o) => o.status === 'done').map((o) => o.path);
    try {
      if (written.length) await this.deps.filesWritten(written);
    } finally {
      this.busy = false;
    }
    this.undoBatch = batchId !== null && this.root === root ? { id: batchId, root } : null;
    const blocked = plan.files
      .filter((f) => f.blocked && f.selected.some(Boolean))
      .map((f): ReplaceFileOutcome => ({ path: f.path, status: 'changed', count: 0, message: f.blocked }));
    const skipped = plan.preview.skipped.map(
      (s): ReplaceFileOutcome => ({ path: s.path, status: 'failed', count: 0, message: s.reason }),
    );
    this.plan = null;
    const hits = outcomes.reduce((n, o) => n + (o.status === 'done' ? o.count : 0), 0);
    this.renderOutcome(
      `Replaced ${plural(hits, 'match', 'matches')} in ${plural(written.length, 'file')}.`,
      [...outcomes, ...blocked, ...skipped],
      root,
    );
  }

  /** Put back the files of the last replace. */
  async undo(): Promise<void> {
    const batch = this.undoBatch;
    if (!batch || this.busy) return;
    this.busy = true;
    this.undoBatch = null;
    this.renderStatus('Undoing…');
    let outcomes: ReplaceFileOutcome[];
    try {
      outcomes = await api.replaceUndo(batch.id);
      const back = outcomes.filter((o) => o.status === 'done').map((o) => o.path);
      if (back.length) await this.deps.filesWritten(back);
    } catch (err) {
      this.renderStatus(`Undo failed: ${String(err).split('\n')[0]}`);
      return;
    } finally {
      this.busy = false;
    }
    const n = outcomes.filter((o) => o.status === 'done').length;
    this.renderOutcome(`Undid the replace in ${plural(n, 'file')}.`, outcomes, batch.root);
  }

  /** The preview: a bar with Replace / Cancel, then per file a checkbox and
   *  every hit as before → after with its own checkbox. */
  private renderPlan(): void {
    const plan = this.plan;
    const list = this.resultsEl;
    if (!plan || !list) return;
    const replacement = this.replaceInput?.value ?? '';
    const { hits, files } = selectedCount(plan.files);
    const frag = document.createDocumentFragment();
    frag.appendChild(this.replaceBar(hits, files));
    plan.files.forEach((f, fi) => {
      const head = document.createElement('div');
      head.className = 'search-file replace-file';
      head.setAttribute('role', 'treeitem');
      head.title = f.path;
      const box = this.checkbox(fi, undefined, !f.blocked && f.selected.every(Boolean), !!f.blocked);
      box.indeterminate = !f.blocked && f.selected.some(Boolean) && !f.selected.every(Boolean);
      box.setAttribute('aria-label', `Replace in ${basename(f.path)}`);
      const name = document.createElement('span');
      name.className = 'search-file-name';
      name.textContent = toRelativePath(f.path, plan.args.root) || basename(f.path);
      const count = document.createElement('span');
      count.className = 'search-count';
      count.textContent = String(f.hits.length);
      head.append(box, name, count);
      if (f.blocked) head.append(this.note(`skipped: ${f.blocked}`));
      frag.appendChild(head);
      f.hits.forEach((h, hi) => {
        const row = document.createElement('div');
        row.className = 'search-hit replace-hit';
        row.setAttribute('role', 'treeitem');
        row.dataset.path = f.path;
        row.dataset.line = String(h.line);
        row.dataset.column = String(h.column);
        row.title = `Line ${h.line}`;
        const check = this.checkbox(fi, hi, !f.blocked && f.selected[hi], !!f.blocked);
        check.setAttribute('aria-label', `Replace on line ${h.line}`);
        const { before, match, after } = splitPreview(h);
        const text = document.createElement('span');
        text.className = 'search-hit-text';
        const del = document.createElement('del');
        del.textContent = match;
        const ins = document.createElement('ins');
        ins.textContent = replacement;
        text.append(before, del, ins, after);
        const line = document.createElement('span');
        line.className = 'search-hit-line';
        line.textContent = String(h.line);
        row.append(check, text, line);
        if (f.blocked || !f.selected[hi]) row.classList.add('excluded');
        frag.appendChild(row);
      });
    });
    for (const s of plan.preview.skipped) frag.appendChild(this.outcomeRow(s.path, `skipped: ${s.reason}`, plan.args.root));
    list.replaceChildren(frag);
    const total = plan.files.reduce((n, f) => n + f.hits.length, 0);
    if (!total) {
      this.renderStatus(plan.preview.skipped.length ? 'No files can be changed.' : 'No results.');
      return;
    }
    const summary = `${plural(total, 'match', 'matches')} in ${plural(plan.files.length, 'file')}`;
    this.renderStatus(
      plan.preview.truncated ? `${summary} (stopped early; only these are replaced)` : summary,
    );
  }

  private replaceBar(hits: number, files: number): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'replace-bar';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'replace-btn replace-apply';
    apply.dataset.action = 'apply';
    apply.disabled = hits === 0;
    apply.textContent = `Replace ${plural(hits, 'match', 'matches')} in ${plural(files, 'file')}`;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'replace-btn';
    cancel.dataset.action = 'cancel';
    cancel.textContent = 'Cancel';
    bar.append(apply, cancel);
    return bar;
  }

  private checkbox(file: number, hit: number | undefined, checked: boolean, disabled: boolean): HTMLInputElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'replace-check';
    box.dataset.file = String(file);
    if (hit !== undefined) box.dataset.hit = String(hit);
    box.checked = checked;
    box.disabled = disabled;
    return box;
  }

  private note(text: string): HTMLElement {
    const el = document.createElement('span');
    el.className = 'replace-note';
    el.textContent = text;
    return el;
  }

  /** After apply or undo: the summary, an Undo button while possible, and
   *  every file that was left alone with the reason. */
  private renderOutcome(summary: string, outcomes: ReplaceFileOutcome[], root: string): void {
    const frag = document.createDocumentFragment();
    if (this.undoBatch) {
      const bar = document.createElement('div');
      bar.className = 'replace-bar';
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'replace-btn';
      undo.dataset.action = 'undo';
      undo.textContent = 'Undo replace';
      bar.append(undo);
      frag.appendChild(bar);
    }
    const left = outcomes.filter((o) => o.status !== 'done');
    for (const o of left) frag.appendChild(this.outcomeRow(o.path, `skipped: ${o.message ?? o.status}`, root));
    this.resultsEl?.replaceChildren(frag);
    this.renderStatus(left.length ? `${summary} ${plural(left.length, 'file')} left unchanged.` : summary);
  }

  private outcomeRow(path: string, text: string, root: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'search-file replace-skipped';
    row.setAttribute('role', 'treeitem');
    row.title = path;
    const name = document.createElement('span');
    name.className = 'search-file-name';
    name.textContent = toRelativePath(path, root) || basename(path);
    row.append(name, this.note(text));
    return row;
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
