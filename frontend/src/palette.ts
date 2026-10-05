/**
 * Quick open (⌘P) and the command palette (⌘⇧P): one overlay, three modes.
 *
 * - files (default): fuzzy search over every file in the workspace (the
 *   backend's `list_workspace_files`, local or over SSH). Empty query =
 *   recently opened files first.
 * - commands (`>` prefix, or ⌘⇧P): everything in the command registry
 *   (commands.ts). Disabled commands show dimmed and cannot run.
 * - line (`:` prefix, or "Go: Go to line…"): jump the editor to a line.
 *
 * ↑↓ choose, ↩ open / run, ⌘↩ open to the side, Esc close. Backspace on an
 * empty query goes back to files. Focus is trapped while open and returns
 * to where it was on close (modal.ts).
 */

import { commands as defaultRegistry, type Command, type CommandRegistry } from './commands';
import { FuzzyIndex, basenameStart, scoreTarget } from './fuzzy';
import { trapFocus, type ModalHandle } from './modal';
import { formatShortcut } from './shortcuts';
import { dirname, basename, isUnderRoot, joinPath, toRelativePath } from './utils';

export type PaletteMode = 'files' | 'commands' | 'line';

export interface FileListing {
  files: string[];
  truncated: boolean;
}

export interface PaletteDeps {
  /** The workspace folder quick open searches, or null (none open). */
  root(): string | null;
  /** Which machine `root` is on (tab origin): keys caches and recents. */
  origin(): string | null;
  /** The explorer's show-hidden setting. */
  showHidden(): boolean;
  /** Root-relative paths (api.listWorkspaceFiles). */
  listFiles(root: string, includeHidden: boolean): Promise<FileListing>;
  openFile(path: string): void | Promise<void>;
  /** ⌘↩. No side-by-side groups yet: open, then show edit + preview. */
  openToSide(path: string): void | Promise<void>;
  /** Absolute path of the active tab, if any. */
  activePath(): string | null;
  gotoLine(line: number): void;
  lineCount(): number;
}

/** Rows shown per query (files); commands show all matches. */
const MAX_FILE_ROWS = 50;
const MAX_RECENT = 50;

interface Row {
  label: string;
  labelMarks: number[];
  detail: string;
  detailMarks: number[];
  hint: string;
  disabled: boolean;
  /** Muted informational row (loading, empty); never selectable. */
  info?: boolean;
  activate?(side: boolean): void | Promise<void>;
}

interface Recent {
  path: string;
  origin: string | null;
}

export class Palette {
  private layer: HTMLElement | null = null;
  private dialog!: HTMLElement;
  private input!: HTMLInputElement;
  private modeEl!: HTMLElement;
  private list!: HTMLElement;
  private foot!: HTMLElement;
  private modal: ModalHandle | null = null;
  private mode: PaletteMode = 'files';
  private rows: Row[] = [];
  private selected = -1;

  private recents: Recent[] = [];
  private recentCommands: string[] = [];

  // Files: one listing (and its fuzzy index) per machine + root + hidden.
  private filesKey: string | null = null;
  private files: FileListing | null = null;
  private fileIndex: FuzzyIndex<string> | null = null;
  private filesLoading: Promise<void> | null = null;
  private filesError: string | null = null;
  private loadToken = 0;

  constructor(
    private readonly deps: PaletteDeps,
    private readonly registry: CommandRegistry = defaultRegistry,
  ) {}

  isOpen(): boolean {
    return this.layer !== null;
  }

  getMode(): PaletteMode {
    return this.mode;
  }

  /** Open in `mode`, or switch an open palette to it. */
  open(mode: PaletteMode = 'files'): void {
    if (!this.layer) this.build();
    this.setMode(mode, '');
    this.input.focus();
  }

  close(): void {
    if (!this.layer) return;
    this.layer.remove();
    this.layer = null;
    this.rows = [];
    // Last: gives focus back to where it was before open().
    this.modal?.release();
    this.modal = null;
  }

  /** Record a file the user opened (tab switch): ranks first on empty query. */
  noteOpened(path: string | null, origin: string | null): void {
    if (!path) return;
    this.recents = this.recents.filter((r) => !(r.path === path && r.origin === origin));
    this.recents.unshift({ path, origin });
    if (this.recents.length > MAX_RECENT) this.recents.length = MAX_RECENT;
  }

  /** The workspace's files changed shape (watcher create/remove/rename). */
  invalidateFiles(): void {
    this.filesKey = null;
    this.files = null;
    this.fileIndex = null;
    this.filesLoading = null;
    this.filesError = null;
    this.loadToken++;
    if (this.layer && this.mode === 'files') this.ensureFiles();
  }

  // --- DOM ------------------------------------------------------------------

  private build(): void {
    const layer = document.createElement('div');
    layer.className = 'palette-layer';
    layer.addEventListener('mousedown', (e) => {
      if (e.target === layer) {
        e.preventDefault();
        this.close();
      }
    });

    const dialog = document.createElement('div');
    dialog.className = 'palette';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1;

    const bar = document.createElement('div');
    bar.className = 'pal-in';
    const modeEl = document.createElement('span');
    modeEl.className = 'pal-mode';
    modeEl.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input');
    input.className = 'pal-input';
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'pal-list');
    input.setAttribute('aria-autocomplete', 'list');
    bar.append(modeEl, input);

    const list = document.createElement('div');
    list.className = 'pal-list';
    list.id = 'pal-list';
    list.setAttribute('role', 'listbox');
    list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    list.addEventListener('mousemove', (e) => {
      const i = this.rowIndexOf(e.target);
      if (i >= 0 && i !== this.selected && this.selectable(i)) this.select(i, false);
    });
    list.addEventListener('click', (e) => {
      const i = this.rowIndexOf(e.target);
      if (i >= 0) void this.activate(i, e.metaKey || e.ctrlKey);
    });

    const foot = document.createElement('div');
    foot.className = 'pal-foot';

    dialog.append(bar, list, foot);
    layer.appendChild(dialog);
    document.body.appendChild(layer);

    input.addEventListener('input', () => this.onInput());
    dialog.addEventListener('keydown', (e) => this.onKeyDown(e));

    this.layer = layer;
    this.dialog = dialog;
    this.input = input;
    this.modeEl = modeEl;
    this.list = list;
    this.foot = foot;
    this.modal = trapFocus(dialog);
  }

  private setMode(mode: PaletteMode, query: string): void {
    this.mode = mode;
    this.input.value = query;
    this.modeEl.textContent = mode === 'commands' ? '>' : mode === 'line' ? ':' : '';
    this.modeEl.hidden = mode === 'files';
    const label = mode === 'files' ? 'Quick open' : mode === 'commands' ? 'Command palette' : 'Go to line';
    this.dialog.setAttribute('aria-label', label);
    this.input.setAttribute('aria-label', label);
    this.input.placeholder =
      mode === 'files' ? 'Search files by name' : mode === 'commands' ? 'Run a command' : 'Line number';
    this.renderFoot();
    if (mode === 'files') this.ensureFiles();
    this.refresh();
  }

  private renderFoot(): void {
    const k = (s: string) => `<kbd>${s}</kbd>`;
    const side = formatShortcut('CmdOrCtrl+Enter');
    const parts =
      this.mode === 'files'
        ? [`${k('↑')} ${k('↓')} choose`, `${k('↩')} open`, `${k(side)} open to the side`, `type ${k('&gt;')} for commands`]
        : this.mode === 'commands'
          ? [`${k('↑')} ${k('↓')} choose`, `${k('↩')} run`, `${k('⌫')} back to files`]
          : [`${k('↩')} go to line`, `${k('Esc')} close`];
    this.foot.innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
    if (this.mode === 'files' && this.files?.truncated) {
      const note = document.createElement('span');
      note.className = 'pal-note';
      note.textContent = `First ${this.files.files.length.toLocaleString('en-US')} files only`;
      this.foot.appendChild(note);
    }
  }

  // --- Input ----------------------------------------------------------------

  private onInput(): void {
    const v = this.input.value;
    if (this.mode === 'files' && (v.startsWith('>') || v.startsWith(':'))) {
      this.setMode(v[0] === '>' ? 'commands' : 'line', v.slice(1).trimStart());
      return;
    }
    this.refresh();
  }

  private onKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        this.move(e.key === 'ArrowDown' ? 1 : -1);
        break;
      }
      case 'Enter': {
        if (e.isComposing) return;
        e.preventDefault();
        if (this.selected >= 0) void this.activate(this.selected, e.metaKey || e.ctrlKey);
        break;
      }
      case 'Escape': {
        e.preventDefault();
        e.stopPropagation();
        this.close();
        break;
      }
      case 'Backspace': {
        if (this.mode !== 'files' && this.input.value === '') {
          e.preventDefault();
          this.setMode('files', '');
        }
        break;
      }
      default:
        return;
    }
  }

  private move(delta: number): void {
    const n = this.rows.length;
    if (n === 0) return;
    let i = this.selected;
    for (let step = 0; step < n; step++) {
      i = (i + delta + n) % n;
      if (this.selectable(i)) {
        this.select(i, true);
        return;
      }
    }
  }

  private selectable(i: number): boolean {
    const r = this.rows[i];
    return !!r && !r.disabled && !r.info;
  }

  private rowIndexOf(target: EventTarget | null): number {
    const el = (target as HTMLElement | null)?.closest?.('.pal-item') as HTMLElement | null;
    return el ? Number(el.dataset.index) : -1;
  }

  private select(i: number, scroll: boolean): void {
    const items = this.list.children;
    if (this.selected >= 0) {
      items[this.selected]?.classList.remove('sel');
      items[this.selected]?.setAttribute('aria-selected', 'false');
    }
    this.selected = i;
    const el = items[i] as HTMLElement | undefined;
    if (!el) {
      this.input.removeAttribute('aria-activedescendant');
      return;
    }
    el.classList.add('sel');
    el.setAttribute('aria-selected', 'true');
    this.input.setAttribute('aria-activedescendant', el.id);
    if (scroll) el.scrollIntoView?.({ block: 'nearest' });
  }

  private async activate(i: number, side: boolean): Promise<void> {
    const row = this.rows[i];
    if (!row || row.disabled || row.info || !row.activate) return;
    // Close first: focus goes back to the app before the action moves it.
    this.close();
    await row.activate(side);
  }

  // --- Rows -----------------------------------------------------------------

  private refresh(): void {
    const q = this.input.value;
    this.rows =
      this.mode === 'files' ? this.fileRows(q) : this.mode === 'commands' ? this.commandRows(q) : this.lineRows(q);
    this.renderRows();
  }

  private renderRows(): void {
    this.list.textContent = '';
    this.selected = -1;
    const frag = document.createDocumentFragment();
    this.rows.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'pal-item';
      if (row.disabled) el.classList.add('disabled');
      if (row.info) el.classList.add('info');
      el.id = `pal-opt-${i}`;
      el.dataset.index = String(i);
      el.setAttribute('role', row.info ? 'presentation' : 'option');
      if (!row.info) el.setAttribute('aria-selected', 'false');
      if (row.disabled) el.setAttribute('aria-disabled', 'true');

      const t = document.createElement('span');
      t.className = 't';
      appendMarked(t, row.label, row.labelMarks);
      if (row.detail) {
        const small = document.createElement('small');
        appendMarked(small, row.detail, row.detailMarks);
        t.appendChild(small);
      }
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = row.hint;
      el.append(t, k);
      frag.appendChild(el);
    });
    this.list.appendChild(frag);
    const first = this.rows.findIndex((_, i) => this.selectable(i));
    if (first >= 0) this.select(first, false);
    else this.input.removeAttribute('aria-activedescendant');
  }

  private fileRows(query: string): Row[] {
    const root = this.deps.root();
    const origin = this.deps.origin();
    const active = this.deps.activePath();
    const recents = this.recents
      .filter((r) => r.origin === origin && r.path !== active && (!root || isUnderRoot(r.path, root)))
      .map((r) => r.path);
    const q = query.replace(/\s+/g, '');

    if (!root) {
      // No folder: only what was opened before (by absolute path).
      const rows = q ? rankAbsolute(recents, q, this.deps) : recents.map((p) => fileRow(p, [], p, true, this.deps));
      if (rows.length === 0) rows.push(infoRow(q ? 'No matching recent files' : 'Open a folder to search its files'));
      return rows.slice(0, MAX_FILE_ROWS);
    }

    const rel = (abs: string) => toRelativePath(abs, root) ?? abs;
    if (!q) {
      const seen = new Set<string>();
      const rows: Row[] = [];
      for (const abs of recents) {
        const r = rel(abs);
        seen.add(r);
        rows.push(fileRow(r, [], abs, true, this.deps));
      }
      if (this.files) {
        for (const r of this.files.files) {
          if (rows.length >= MAX_FILE_ROWS) break;
          if (seen.has(r)) continue;
          rows.push(fileRow(r, [], joinPath(root, r), false, this.deps));
        }
      } else {
        rows.push(infoRow(this.filesError ?? 'Loading files…'));
      }
      return rows.slice(0, MAX_FILE_ROWS);
    }

    if (!this.fileIndex) {
      return [infoRow(this.filesError ?? 'Loading files…')];
    }
    const recentSet = new Set(recents.map(rel));
    const ranked = this.fileIndex.search(q, MAX_FILE_ROWS);
    if (ranked.length === 0) return [infoRow('No matching files')];
    return ranked.map((m) => fileRow(m.item, m.positions, joinPath(root, m.item), recentSet.has(m.item), this.deps));
  }

  private commandRows(query: string): Row[] {
    const all = this.registry.list();
    let ordered: Array<{ cmd: Command; marks: number[] }>;
    if (!query.trim()) {
      const rank = new Map(this.recentCommands.map((id, i) => [id, i]));
      ordered = all
        .map((cmd, i) => ({ cmd, i, r: rank.get(cmd.id) ?? Infinity }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map(({ cmd }) => ({ cmd, marks: [] }));
    } else {
      const index = new FuzzyIndex(all, (c) => (c.keywords ? `${c.title} ${c.keywords}` : c.title), false);
      ordered = index
        .search(query, all.length)
        .map((m) => ({ cmd: m.item, marks: m.positions.filter((p) => p < m.item.title.length) }));
    }
    const rows = ordered.map(({ cmd, marks }) => {
      const disabled = !this.registry.isEnabled(cmd);
      const row: Row = {
        label: cmd.title,
        labelMarks: marks,
        detail: '',
        detailMarks: [],
        hint: this.registry.shortcutLabel(cmd),
        disabled,
        activate: () => {
          this.recentCommands = [cmd.id, ...this.recentCommands.filter((id) => id !== cmd.id)].slice(0, 20);
          return this.registry.run(cmd.id).then(() => undefined);
        },
      };
      return row;
    });
    // Enabled first; disabled stay visible (dimmed) so the command is findable.
    const sorted = [...rows.filter((r) => !r.disabled), ...rows.filter((r) => r.disabled)];
    return sorted.length ? sorted : [infoRow('No matching commands')];
  }

  private lineRows(query: string): Row[] {
    const count = this.deps.lineCount();
    const line = Number.parseInt(query.trim(), 10);
    if (!this.deps.activePath() && count <= 0) return [infoRow('Open a file first')];
    if (!query.trim() || !Number.isFinite(line)) return [infoRow(`Type a line number between 1 and ${count}`)];
    const target = Math.max(1, Math.min(count, line));
    return [
      {
        label: `Go to line ${target}`,
        labelMarks: [],
        detail: target !== line ? `(${count} lines)` : '',
        detailMarks: [],
        hint: '',
        disabled: false,
        activate: () => this.deps.gotoLine(target),
      },
    ];
  }

  // --- Listing --------------------------------------------------------------

  private ensureFiles(): void {
    const root = this.deps.root();
    if (!root) return;
    const hidden = this.deps.showHidden();
    const key = `${this.deps.origin() ?? ''}\u0000${root}\u0000${hidden ? 1 : 0}`;
    if (this.filesKey === key && (this.files || this.filesLoading)) return;
    this.filesKey = key;
    this.files = null;
    this.fileIndex = null;
    this.filesError = null;
    const token = ++this.loadToken;
    this.filesLoading = this.deps
      .listFiles(root, hidden)
      .then((listing) => {
        if (token !== this.loadToken) return;
        this.files = listing;
        this.fileIndex = new FuzzyIndex(listing.files, (p) => p, true);
      })
      .catch((err) => {
        if (token !== this.loadToken) return;
        this.filesError = `Could not list files: ${String(err)}`;
        this.filesKey = null;
      })
      .finally(() => {
        if (token !== this.loadToken) return;
        this.filesLoading = null;
        if (this.layer && this.mode === 'files') {
          this.renderFoot();
          this.refresh();
        }
      });
  }

  /** Test hook: resolves when the current listing request settles. */
  whenFilesLoaded(): Promise<void> {
    return this.filesLoading ?? Promise.resolve();
  }
}

function infoRow(text: string): Row {
  return { label: text, labelMarks: [], detail: '', detailMarks: [], hint: '', disabled: false, info: true };
}

/** A file row: basename bold-marked, directory dim. `marks` index `rel`. */
function fileRow(rel: string, marks: number[], abs: string, recent: boolean, deps: PaletteDeps): Row {
  const start = basenameStart(rel);
  return {
    label: rel.slice(start),
    labelMarks: marks.filter((p) => p >= start).map((p) => p - start),
    detail: start > 0 ? rel.slice(0, start - 1) : '',
    detailMarks: marks.filter((p) => p < start - 1),
    hint: recent ? 'recent' : '',
    disabled: false,
    activate: (side) => (side ? deps.openToSide(abs) : deps.openFile(abs)),
  };
}

/** Fuzzy over absolute paths (no workspace root), best first. */
function rankAbsolute(paths: string[], q: string, deps: PaletteDeps): Row[] {
  const lowerQ = q.toLowerCase();
  const scored: Array<{ p: string; score: number; marks: number[] }> = [];
  for (const p of paths) {
    const norm = p.replace(/\\/g, '/');
    const s = scoreTarget(lowerQ, norm, norm.toLowerCase(), basenameStart(norm));
    if (s) scored.push({ p, score: s.score, marks: s.positions });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ p, marks }) => {
    const name = basename(p);
    const dir = dirname(p);
    const start = p.length - name.length;
    return {
      label: name,
      labelMarks: marks.filter((m) => m >= start).map((m) => m - start),
      detail: dir,
      detailMarks: marks.filter((m) => m < dir.length),
      hint: 'recent',
      disabled: false,
      activate: (side: boolean) => (side ? deps.openToSide(p) : deps.openFile(p)),
    };
  });
}

/** Append `text` to `el`, wrapping the characters at `marks` in <mark>. */
function appendMarked(el: HTMLElement, text: string, marks: number[]): void {
  if (marks.length === 0) {
    el.appendChild(document.createTextNode(text));
    return;
  }
  const set = new Set(marks);
  let i = 0;
  while (i < text.length) {
    const on = set.has(i);
    let j = i + 1;
    while (j < text.length && set.has(j) === on) j++;
    const chunk = text.slice(i, j);
    if (on) {
      const m = document.createElement('mark');
      m.textContent = chunk;
      el.appendChild(m);
    } else {
      el.appendChild(document.createTextNode(chunk));
    }
    i = j;
  }
}
