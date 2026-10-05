/**
 * In-app file picker for the remote host (remote sessions, #36 follow-up).
 *
 * Native dialogs only see the local disk, but while a remote session is
 * active all file I/O goes over SSH. This picker browses the host with the
 * existing `list_directory` command and returns an absolute remote path:
 *
 * - `open`: pick an existing file.
 * - `save`: pick a folder and type a file name; an existing file needs a
 *   second click ("Replace") to confirm the overwrite. "New Folder" creates
 *   a folder in place; a typed path whose folder is missing needs a second
 *   click ("Create Folder and Save") — folders are never created silently.
 *
 * It resolves to the chosen path, or null when the user cancels. The backend
 * (`validate_remote_path`) still checks every path; its errors show inline.
 */
import { api, type FileEntry } from './api';
import { trapFocus, type ModalHandle } from './modal';

export type RemotePickerMode = 'open' | 'save';

export interface PickerFilter {
  name: string;
  extensions: string[];
}

export interface RemotePickerOptions {
  mode: RemotePickerMode;
  /** SSH host alias, shown in the header. */
  host: string;
  /** Folder to start in (absolute). Falls back to `home`, then `/`. */
  startDir: string;
  /** Remote $HOME, for `~` in typed paths. */
  home?: string | null;
  /** Save mode: the initial file name. */
  defaultName?: string;
  /** Like the native dialog filters. An "All Files" entry is added if missing. */
  filters?: PickerFilter[];
  title?: string;
  /** Label of the primary button (default Open / Save). */
  confirmLabel?: string;
}

const ALL_FILES: PickerFilter = { name: 'All Files', extensions: ['*'] };
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const ICON_DIR =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_FILE =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/></svg>';

/** Resolve a typed path against `base`: expands `~`, drops `.`/`..`/`//`. */
export function normalizeRemotePath(input: string, base: string, home?: string | null): string {
  let p = input.trim();
  if (home && (p === '~' || p.startsWith('~/'))) p = home.replace(/\/+$/, '') + p.slice(1);
  if (!p.startsWith('/')) p = `${base.replace(/\/+$/, '')}/${p}`;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

/** Client-side mirror of the backend check, for a clear inline message. */
export function remotePathError(path: string): string | null {
  if (CONTROL_RE.test(path)) return 'The path contains control characters.';
  if (!path.startsWith('/')) return 'Remote paths must be absolute (start with / or ~).';
  return null;
}

export function matchesFilter(name: string, filter: PickerFilter | undefined): boolean {
  if (!filter || filter.extensions.includes('*')) return true;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return filter.extensions.some((e) => e.toLowerCase() === ext);
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function joinRemote(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`;
}

/** A single folder name for "New Folder" (no path separators). */
export function folderNameError(name: string): string | null {
  if (!name) return 'Type a folder name.';
  if (CONTROL_RE.test(name)) return 'The folder name contains control characters.';
  if (name.includes('/')) return 'A folder name cannot contain "/".';
  if (name === '.' || name === '..') return 'Type a folder name.';
  return null;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One picker at a time, per owner (the App's DocumentController holds one).
 * Opening a new picker cancels the open one. No module state: each instance
 * tracks only its own open dialog.
 */
export class RemotePicker {
  private closeActive: (() => void) | null = null;

  get isOpen(): boolean {
    return this.closeActive !== null;
  }

  /** Show the picker. Resolves to an absolute remote path, or null on cancel. */
  pick(opts: RemotePickerOptions): Promise<string | null> {
    this.close();
    return runPicker(opts, {
      opened: (close) => {
        this.closeActive = close;
      },
      closed: (close) => {
        if (this.closeActive === close) this.closeActive = null;
      },
    });
  }

  /** Cancel the open picker (resolves it to null). No-op when closed. */
  close(): void {
    this.closeActive?.();
  }
}

interface PickerLifecycle {
  opened(close: () => void): void;
  closed(close: () => void): void;
}

function runPicker(opts: RemotePickerOptions, life: PickerLifecycle): Promise<string | null> {
  return new Promise((resolve) => {
    const isSave = opts.mode === 'save';
    const filters = [...(opts.filters ?? [])];
    if (!filters.some((f) => f.extensions.includes('*'))) filters.push(ALL_FILES);

    let cwd = '';
    let entries: FileEntry[] = [];
    let visible: FileEntry[] = [];
    let sel = -1;
    let showHidden = false;
    let filterIdx = 0;
    let loadSeq = 0;
    let busy = false;
    /** Armed second-click confirm: overwrite `full`, or create its folder. */
    let confirmTarget: { kind: 'replace' | 'mkdir'; path: string } | null = null;
    let done = false;
    let modal: ModalHandle | null = null;

    const overlay = document.createElement('div');
    overlay.className = 'remote-overlay remote-picker-overlay';
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) finish(null);
    });

    const dialog = document.createElement('div');
    dialog.className = 'remote-dialog remote-picker';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const titleText = opts.title ?? (isSave ? 'Save As' : 'Open Remote File');
    dialog.setAttribute('aria-label', titleText);
    dialog.tabIndex = -1;

    // Header: title + host chip + close.
    const header = document.createElement('div');
    header.className = 'remote-header';
    const title = document.createElement('h2');
    title.textContent = titleText;
    const chip = document.createElement('span');
    chip.className = 'rp-host';
    chip.textContent = `ssh ${opts.host}`;
    title.append(' ', chip);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'remote-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.title = 'Close (Esc)';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => finish(null));
    header.append(title, closeBtn);

    // Location bar: up + editable path.
    const bar = document.createElement('div');
    bar.className = 'rp-bar';
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'remote-btn rp-up';
    upBtn.title = 'Parent folder (Backspace)';
    upBtn.setAttribute('aria-label', 'Parent folder');
    upBtn.textContent = '↑';
    upBtn.addEventListener('click', () => void goUp());
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.className = 'rp-path';
    pathInput.spellcheck = false;
    pathInput.autocomplete = 'off';
    pathInput.setAttribute('aria-label', 'Remote folder path');
    pathInput.placeholder = '/path/on/host or ~/…';
    bar.append(upBtn, pathInput);

    // Save mode: "New Folder" asks inline for a name, then creates it in the
    // current folder (remote_create_dir) and opens it.
    const newFolderBtn = document.createElement('button');
    newFolderBtn.type = 'button';
    newFolderBtn.className = 'remote-btn rp-new-folder';
    newFolderBtn.textContent = 'New Folder';
    newFolderBtn.title = 'Create a folder here';
    newFolderBtn.addEventListener('click', () => showFolderRow());
    if (isSave) bar.append(newFolderBtn);

    const folderRow = document.createElement('div');
    folderRow.className = 'rp-folder-row hidden';
    const folderInput = document.createElement('input');
    folderInput.type = 'text';
    folderInput.className = 'rp-folder-name';
    folderInput.spellcheck = false;
    folderInput.autocomplete = 'off';
    folderInput.placeholder = 'Folder name';
    folderInput.setAttribute('aria-label', 'New folder name');
    const folderCreate = document.createElement('button');
    folderCreate.type = 'button';
    folderCreate.className = 'remote-btn remote-btn-primary rp-folder-create';
    folderCreate.textContent = 'Create';
    folderCreate.addEventListener('click', () => void createFolder());
    const folderCancel = document.createElement('button');
    folderCancel.type = 'button';
    folderCancel.className = 'remote-btn rp-folder-cancel';
    folderCancel.textContent = 'Cancel';
    folderCancel.addEventListener('click', () => hideFolderRow());
    folderRow.append(folderInput, folderCreate, folderCancel);

    // Listing.
    const list = document.createElement('div');
    list.className = 'rp-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Remote files');
    list.tabIndex = 0;

    // Options row: type filter + hidden toggle.
    const optsRow = document.createElement('div');
    optsRow.className = 'rp-options';
    const filterSel = document.createElement('select');
    filterSel.className = 'rp-filter';
    filterSel.setAttribute('aria-label', 'File type');
    filters.forEach((f, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = f.name;
      filterSel.appendChild(o);
    });
    filterSel.addEventListener('change', () => {
      filterIdx = Number(filterSel.value) || 0;
      render();
    });
    const hiddenLabel = document.createElement('label');
    hiddenLabel.className = 'rp-hidden';
    const hiddenBox = document.createElement('input');
    hiddenBox.type = 'checkbox';
    hiddenBox.addEventListener('change', () => {
      showHidden = hiddenBox.checked;
      void load(cwd);
    });
    hiddenLabel.append(hiddenBox, ' Show hidden files');
    optsRow.append(filterSel, hiddenLabel);

    // Save mode: file name.
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'rp-name';
    nameInput.spellcheck = false;
    nameInput.autocomplete = 'off';
    nameInput.setAttribute('aria-label', 'File name');
    nameInput.value = opts.defaultName ?? '';
    nameInput.addEventListener('input', resetConfirm);
    const nameLabel = document.createElement('label');
    nameLabel.className = 'remote-field rp-name-field';
    nameLabel.append('File name', nameInput);

    const warn = document.createElement('p');
    warn.className = 'rp-warning hidden';
    warn.setAttribute('role', 'status');

    const err = document.createElement('p');
    err.className = 'remote-error hidden';
    err.setAttribute('role', 'alert');

    const actions = document.createElement('div');
    actions.className = 'remote-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'remote-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => finish(null));
    const confirmLabel = opts.confirmLabel ?? (isSave ? 'Save' : 'Open');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'remote-btn remote-btn-primary rp-confirm';
    go.textContent = confirmLabel;
    go.addEventListener('click', () => void submit());
    actions.append(cancel, go);

    dialog.append(header, bar);
    if (isSave) dialog.append(folderRow);
    dialog.append(list, optsRow);
    if (isSave) dialog.append(nameLabel);
    dialog.append(warn, err, actions);
    overlay.appendChild(dialog);

    const showError = (msg: string) => {
      err.textContent = msg;
      err.classList.remove('hidden');
    };
    const clearError = () => err.classList.add('hidden');

    function resetConfirm(): void {
      confirmTarget = null;
      warn.classList.add('hidden');
      go.textContent = confirmLabel;
      go.classList.remove('rp-danger');
    }

    function showFolderRow(): void {
      clearError();
      folderInput.value = '';
      folderRow.classList.remove('hidden');
      folderInput.focus();
    }

    function hideFolderRow(): void {
      folderRow.classList.add('hidden');
      nameInput.focus();
    }

    /** Create the typed folder in the current one, then open it. */
    async function createFolder(): Promise<void> {
      if (busy || done) return;
      clearError();
      const name = folderInput.value.trim();
      const bad = folderNameError(name);
      if (bad) {
        showError(bad);
        folderInput.focus();
        return;
      }
      if (!cwd) {
        showError('Pick a folder first.');
        return;
      }
      const target = joinRemote(cwd, name);
      busy = true;
      folderCreate.disabled = true;
      try {
        await api.remoteCreateDir(target);
      } catch (e) {
        showError(`Could not create ${target}: ${errorText(e)}`);
        folderInput.focus();
        return;
      } finally {
        busy = false;
        folderCreate.disabled = false;
      }
      if (done) return;
      folderRow.classList.add('hidden');
      if (await load(target)) nameInput.focus();
    }

    function finish(value: string | null): void {
      if (done) return;
      done = true;
      overlay.remove();
      // Un-inert the app and hand focus back to where it was (every close
      // path — Esc, Cancel, ×, backdrop, confirm, RemotePicker.close — ends here).
      modal?.release();
      life.closed(closeSelf);
      resolve(value);
    }
    const closeSelf = () => finish(null);
    life.opened(closeSelf);

    function render(): void {
      const filter = filters[filterIdx];
      visible = entries.filter((e) => e.is_dir || matchesFilter(e.name, filter));
      if (sel >= visible.length) sel = visible.length - 1;
      list.replaceChildren();
      if (visible.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'rp-empty';
        empty.textContent = entries.length === 0 ? 'This folder is empty.' : 'No matching files.';
        list.appendChild(empty);
      }
      visible.forEach((entry, i) => {
        const row = document.createElement('div');
        row.className = `rp-item${entry.is_dir ? ' rp-dir' : ''}${i === sel ? ' selected' : ''}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(i === sel));
        row.dataset.path = entry.path;
        row.title = entry.path;
        const icon = document.createElement('span');
        icon.className = 'rp-icon';
        icon.innerHTML = entry.is_dir ? ICON_DIR : ICON_FILE;
        const name = document.createElement('span');
        name.className = 'rp-item-name';
        name.textContent = entry.name;
        row.append(icon, name);
        row.addEventListener('click', () => select(i));
        row.addEventListener('dblclick', () => void activate(i));
        list.appendChild(row);
      });
      upBtn.disabled = cwd === '/' || cwd === '';
    }

    function select(i: number): void {
      if (i < 0 || i >= visible.length) return;
      sel = i;
      const entry = visible[i];
      if (isSave && !entry.is_dir) {
        nameInput.value = entry.name;
        resetConfirm();
      }
      for (const [j, row] of Array.from(list.querySelectorAll('.rp-item')).entries()) {
        row.classList.toggle('selected', j === i);
        row.setAttribute('aria-selected', String(j === i));
        if (j === i) (row as HTMLElement).scrollIntoView?.({ block: 'nearest' });
      }
    }

    async function load(dir: string): Promise<boolean> {
      const bad = remotePathError(dir);
      if (bad) {
        showError(bad);
        return false;
      }
      const seq = ++loadSeq;
      list.classList.add('rp-loading');
      try {
        const result = await api.listDirectory(dir, showHidden);
        if (seq !== loadSeq || done) return false;
        clearError();
        resetConfirm();
        if (dir !== cwd) sel = -1;
        cwd = dir;
        entries = result;
        pathInput.value = dir;
        render();
        if (!isSave && sel < 0 && visible.length > 0) select(0);
        return true;
      } catch (e) {
        if (seq === loadSeq && !done) showError(`Could not open ${dir}: ${errorText(e)}`);
        return false;
      } finally {
        if (seq === loadSeq) list.classList.remove('rp-loading');
      }
    }

    async function goUp(): Promise<void> {
      if (!cwd || cwd === '/') return;
      const from = cwd;
      if (await load(parentOf(cwd))) {
        const i = visible.findIndex((e) => e.path === from);
        if (i >= 0) select(i);
      }
    }

    async function activate(i: number): Promise<void> {
      const entry = visible[i];
      if (!entry) return;
      if (entry.is_dir) {
        await load(entry.path);
        list.focus();
        return;
      }
      if (isSave) {
        nameInput.value = entry.name;
        await submit();
      } else {
        finish(entry.path);
      }
    }

    /** Enter in the path field: a folder navigates; a file opens (or, in
     *  save mode, fills in the name); a new name in an existing folder is
     *  accepted in save mode. */
    async function goToTyped(): Promise<void> {
      const raw = pathInput.value;
      if (!raw.trim()) return;
      if (CONTROL_RE.test(raw)) {
        showError('The path contains control characters.');
        return;
      }
      const target = normalizeRemotePath(raw, cwd || '/', opts.home);
      const bad = remotePathError(target);
      if (bad) {
        showError(bad);
        return;
      }
      if (target === cwd) return;
      if (await api.isDirectory(target).catch(() => false)) {
        await load(target);
        return;
      }
      const parent = parentOf(target);
      const name = baseOf(target);
      let siblings: FileEntry[];
      try {
        siblings = await api.listDirectory(parent, true);
      } catch (e) {
        showError(`Could not open ${parent}: ${errorText(e)}`);
        return;
      }
      const hit = siblings.find((e) => e.name === name && !e.is_dir);
      if (!isSave) {
        if (hit) finish(target);
        else showError(`No such file or folder: ${target}`);
        return;
      }
      if (await load(parent)) {
        nameInput.value = name;
        nameInput.focus();
      }
    }

    async function submit(): Promise<void> {
      if (busy || done) return;
      clearError();
      if (!isSave) {
        const typed = pathInput.value.trim();
        if (typed && typed !== cwd) {
          await goToTyped();
          return;
        }
        const entry = visible[sel];
        if (!entry) {
          showError('Select a file to open.');
          return;
        }
        await activate(sel);
        return;
      }
      busy = true;
      try {
        await submitSave();
      } finally {
        busy = false;
      }
    }

    async function submitSave(): Promise<void> {
      let name = nameInput.value.trim();
      if (!name) {
        showError('Type a file name.');
        nameInput.focus();
        return;
      }
      if (CONTROL_RE.test(name)) {
        showError('The file name contains control characters.');
        return;
      }
      if (!cwd) {
        showError('Pick a folder first.');
        return;
      }
      // Like the native save dialog: add the filter's extension if missing.
      const filter = filters[filterIdx];
      if (!baseOf(name).includes('.') && filter && !filter.extensions.includes('*')) {
        name = `${name}.${filter.extensions[0]}`;
      }
      const full = name.includes('/') || name.startsWith('~')
        ? normalizeRemotePath(name, cwd, opts.home)
        : joinRemote(cwd, name);
      const bad = remotePathError(full);
      if (bad || full === '/') {
        showError(bad ?? 'Type a file name.');
        return;
      }
      const parent = parentOf(full);
      const file = baseOf(full);
      // Second click on "Create Folder and Save": make the folder, then save.
      if (confirmTarget?.kind === 'mkdir' && confirmTarget.path === full) {
        try {
          await api.remoteCreateDir(parent);
        } catch (e) {
          resetConfirm();
          showError(`Could not create ${parent}: ${errorText(e)}`);
          return;
        }
        finish(full);
        return;
      }
      let siblings: FileEntry[];
      try {
        // Always re-list: an agent may have created the file since.
        siblings = await api.listDirectory(parent, true);
      } catch (e) {
        // A missing folder can be created — but only after an explicit
        // second click, never silently.
        if (!(await api.isDirectory(parent).catch(() => true))) {
          armConfirm(
            { kind: 'mkdir', path: full },
            `Folder ${parent} does not exist. Create it and save "${file}" there?`,
            'Create Folder and Save',
            false,
          );
          return;
        }
        showError(`Folder ${parent} is not available: ${errorText(e)}`);
        return;
      }
      const hit = siblings.find((e) => e.name === file);
      if (hit?.is_dir) {
        nameInput.value = '';
        await load(hit.path);
        return;
      }
      if (hit && !(confirmTarget?.kind === 'replace' && confirmTarget.path === full)) {
        armConfirm(
          { kind: 'replace', path: full },
          `"${file}" already exists in ${parent}. Replace it?`,
          'Replace',
          true,
        );
        return;
      }
      finish(full);
    }

    function armConfirm(
      target: { kind: 'replace' | 'mkdir'; path: string },
      text: string,
      label: string,
      danger: boolean,
    ): void {
      confirmTarget = target;
      warn.textContent = text;
      warn.classList.remove('hidden');
      go.textContent = label;
      go.classList.toggle('rp-danger', danger);
      go.focus();
    }

    function moveSel(delta: number): void {
      if (visible.length === 0) return;
      const next = sel < 0 ? (delta > 0 ? 0 : visible.length - 1) : sel + delta;
      select(Math.max(0, Math.min(visible.length - 1, next)));
    }

    overlay.addEventListener('keydown', (e) => {
      const t = e.target;
      let handled = true;
      if (t === folderInput && (e.key === 'Escape' || e.key === 'Enter')) {
        // Esc leaves only the inline folder prompt, not the picker.
        if (e.key === 'Enter') void createFolder();
        else hideFolderRow();
      } else if (e.key === 'Escape') {
        finish(null);
      } else if (e.key === 'ArrowUp' && (e.altKey || e.metaKey)) {
        void goUp();
      } else if (t === list) {
        if (e.key === 'ArrowDown') moveSel(1);
        else if (e.key === 'ArrowUp') moveSel(-1);
        else if (e.key === 'Home') select(0);
        else if (e.key === 'End') select(visible.length - 1);
        else if (e.key === 'Enter') void activate(sel);
        else if (e.key === 'Backspace') void goUp();
        else handled = false;
      } else if (t === pathInput) {
        if (e.key === 'Enter') void goToTyped();
        else if (e.key === 'ArrowDown') {
          list.focus();
          if (sel < 0) moveSel(1);
        } else handled = false;
      } else if (t === nameInput) {
        if (e.key === 'Enter') void submit();
        else if (e.key === 'ArrowDown') {
          list.focus();
          if (sel < 0) moveSel(1);
        } else handled = false;
      } else if (e.key === 'Enter' && t instanceof HTMLButtonElement) {
        handled = false; // native button activation
      } else {
        handled = false;
      }
      if (handled) e.preventDefault();
      // Modal: keep app shortcuts (Cmd+W, Cmd+S, …) away from the editor.
      e.stopPropagation();
    });

    document.body.appendChild(overlay);
    modal = trapFocus(dialog);

    void (async () => {
      const fallbacks = [opts.startDir, opts.home, '/'].filter(
        (d, i, all): d is string => !!d && all.indexOf(d) === i,
      );
      for (const dir of fallbacks) {
        if (await load(dir)) break;
      }
      if (done) return;
      if (isSave) {
        nameInput.focus();
        const dot = nameInput.value.lastIndexOf('.');
        nameInput.setSelectionRange(0, dot > 0 ? dot : nameInput.value.length);
      } else {
        list.focus();
      }
    })();
    dialog.focus();
  });
}

