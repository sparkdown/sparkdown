import { open, save as nativeSave, message } from '@tauri-apps/plugin-dialog';
import type { PreviewPane } from '../preview';
import { LOCAL_ORIGIN } from '../tabs';
import { RemotePicker, type RemotePickerOptions } from '../remote-picker';
import { isPreviewable, isMarkdownFile, stripMarkdownExt, dirname, basename, defaultSavePath } from '../utils';
import { DIALOG_FILTERS } from '../file-types';
import { api } from '../api';
import type { AppContext } from './context';
import { buildExportHtml } from './export-html';
import { printTarget } from './export-pdf';

type SaveOptions = Parameters<typeof nativeSave>[0];

/**
 * The backend refuses a write to a file within this many ms of the previous
 * write to it (MIN_WRITE_INTERVAL_MS in src-tauri/src/commands.rs; a test
 * keeps the two equal). Its clock starts when that write was asked for, so
 * once this long has passed since the previous write finished, the next one
 * is accepted.
 */
export const WRITE_INTERVAL_MS = 50;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The native Save dialog. The E2E suite (e2e/lib/save_dialog.py) installs
 * `window.__sparkdownE2eSave` over WebDriver to see the options we pass and
 * answer Cancel without a modal OS dialog: Tauri's IPC `invoke` is a
 * non-writable property, so it can't be intercepted there. Nothing in the
 * app sets it.
 */
function save(options: SaveOptions): Promise<string | null> {
  const hook = (window as unknown as { __sparkdownE2eSave?: (o: SaveOptions) => Promise<string | null> }).__sparkdownE2eSave;
  return typeof hook === 'function' ? hook(options) : nativeSave(options);
}

/** What document I/O needs from the preview. */
export interface DocumentDeps {
  renderPreview(content: string): Promise<void>;
  loadPreview(): Promise<PreviewPane>;
  /** After a successful save / save-as write (not export). Must not throw. */
  afterWrite?(path: string): void;
}

/**
 * Document I/O: open / save / save as / export, the on-disk conflict check
 * before a write, unsaved-changes prompts, and the tab-origin guards that
 * keep remote and local files on their own machine.
 */
/** How a file open was asked for. */
export interface OpenFileOptions {
  /** Open only a path inside this window's folder: set for paths that come
   *  from a document link, terminal output or an agent, not for paths the
   *  user picked. */
  folderOnly?: boolean;
}

export class DocumentController {
  // Tabs with a save in progress: a watcher event that lands between our
  // write and markSaved() would otherwise look like a foreign change.
  private savesInFlight = new Set<string>();
  /** Follow-up writes in progress, by tab (see writeFollowUp). */
  private followUps = new Map<string, Promise<boolean>>();
  /** Tabs the user chose "Don't Save" for in prepareOriginSwitch; only these
   *  dirty tabs may be dropped by commitOriginSwitch. */
  private discardOnOriginSwitch = new Set<string>();
  /** The in-app remote file picker (one open at a time). */
  private remotePicker = new RemotePicker();

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: DocumentDeps,
  ) {
    // Unloaded tabs (session restore) read their file on first use, from the
    // machine they belong to only.
    ctx.tabs.setContentLoader((tab) =>
      tab.path && tab.origin === ctx.tabs.getOrigin()
        ? api.readFile(tab.path).catch(() => null)
        : Promise.resolve(null),
    );
  }

  /** When we last wrote each path ourselves (ms since epoch). */
  private ownWrites = new Map<string, number>();

  /** True while save() is writing this tab (see syncTabWithDisk). */
  isSaving(tabId: string): boolean {
    return this.savesInFlight.has(tabId);
  }

  /** True when this app wrote `path` within the last `withinMs`: the watcher
   *  event for that write is our own save, not someone else's edit. */
  wroteRecently(path: string, withinMs = 3000): boolean {
    const at = this.ownWrites.get(path);
    return at !== undefined && Date.now() - at < withinMs;
  }

  private async writeOwn(path: string, content: string): Promise<void> {
    await api.writeFile(path, content);
    this.ownWrites.set(path, Date.now());
    try {
      this.deps.afterWrite?.(path);
    } catch {
      // A follow-up (reload user commands, later on-save hooks) must never
      // fail the save the user just completed.
    }
  }

  /** Resolve once the backend accepts another write to `path` (see
   *  WRITE_INTERVAL_MS). */
  private async waitForWriteInterval(path: string): Promise<void> {
    for (;;) {
      const last = this.ownWrites.get(path);
      const left = last === undefined ? 0 : last + WRITE_INTERVAL_MS - Date.now();
      if (left <= 0) return;
      await sleep(left);
    }
  }

  /** Open `path` in a tab. `folderOnly`: see {@link OpenFileOptions}. */
  async openFile(path: string, options: OpenFileOptions = {}): Promise<void> {
    try {
      const content = await api.readFile(path, options.folderOnly ?? false);
      this.closePristineUntitled();
      this.ctx.tabs.openTab(path, content);
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  }

  async openFilesInOrder(paths: string[]): Promise<void> {
    // Read in parallel, open tabs in original order so active-tab selection is deterministic
    const results = await Promise.all(
      paths.map((path) =>
        api.readFile(path)
          .then((content) => ({ path, content }))
          .catch(() => null)
      )
    );
    for (const r of results) {
      if (r) {
        this.closePristineUntitled();
        this.ctx.tabs.openTab(r.path, r.content);
      }
    }
  }

  /**
   * Session restore: show a tab for every path at once, in order, but read
   * only the file of the tab that becomes active (the last one, as when every
   * file was opened in turn; the one before it if that file is gone). The
   * others load on first activation or through loadRestoredTabs.
   */
  async restoreTabs(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    this.closePristineUntitled();
    const ids = paths
      .map((path) => this.ctx.tabs.addUnloaded(path))
      .filter((id): id is string => id !== null);
    for (let i = ids.length - 1; i >= 0; i--) {
      if (await this.ctx.tabs.ensureLoaded(ids[i])) {
        this.ctx.tabs.switchTo(ids[i]);
        return;
      }
    }
  }

  /** Read every still unloaded tab, one at a time, in strip order. */
  async loadRestoredTabs(): Promise<void> {
    const pending = this.ctx.tabs.getUnloadedTabs();
    if (pending.length === 0) return;
    for (const tab of pending) await this.ctx.tabs.ensureLoaded(tab.id);
    this.ctx.publishContextSoon();
  }

  async openFileDialog(): Promise<void> {
    if (this.ctx.tabs.getOrigin() !== LOCAL_ORIGIN) {
      const picked = await this.pickRemote({ mode: 'open', filters: DIALOG_FILTERS });
      if (picked) await this.openFile(picked);
      return;
    }
    const selected = await open({
      multiple: false,
      filters: DIALOG_FILTERS,
    });
    if (selected) {
      await this.openFile(selected as string);
    }
  }

  /**
   * Remote sessions (remote.ts), step 1 of an origin switch (connect,
   * disconnect, or host change). File I/O routes by the global session, so
   * tabs from the other machine must not outlive the switch. Prompt
   * Save / Don't Save / Cancel for each dirty one while the old routing is
   * still active. Returns false if the user cancelled or a save failed; the
   * caller must then abort the switch.
   */
  async prepareOriginSwitch(target: string | null): Promise<boolean> {
    this.discardOnOriginSwitch.clear();
    this.ctx.editor.flushPendingInput();
    for (const tab of this.ctx.tabs.getTabsNotFrom(target)) {
      if (!tab.modified) continue;
      this.ctx.tabs.switchTo(tab.id);
      const choice = await this.promptUnsaved(tab.title);
      if (choice === 'Cancel') return false;
      if (choice === 'Yes' && !(await this.save(tab.id))) return false;
      if (choice === 'No') this.discardOnOriginSwitch.add(tab.id);
    }
    return true;
  }

  /**
   * Step 2, after the backend switched: close tabs from the other machine and
   * stamp new tabs with `target`. A tab that became dirty after step 1 (and
   * was not explicitly discarded) stays open; save() refuses to write it to
   * the wrong machine.
   */
  commitOriginSwitch(target: string | null): void {
    for (const tab of this.ctx.tabs.getTabsNotFrom(target)) {
      if (tab.modified && !this.discardOnOriginSwitch.has(tab.id)) continue;
      this.ctx.tabs.closeTab(tab.id);
    }
    this.discardOnOriginSwitch.clear();
    this.ctx.tabs.setOrigin(target);
    this.ctx.saveConfigSoon();
  }

  /**
   * Native dialogs only see this computer. While a remote session is active,
   * Open / Save As / Export use the in-app picker that browses the host
   * (remote-picker.ts). It starts in the folder of the active remote tab,
   * else the workspace root, else the remote $HOME.
   */
  private async pickRemote(
    opts: Omit<RemotePickerOptions, 'host' | 'startDir' | 'home'> & { near?: string | null },
  ): Promise<string | null> {
    const host = this.ctx.tabs.getOrigin();
    if (host === LOCAL_ORIGIN || host === null) return null;
    const session = await api.remoteSession().catch(() => null);
    const active = this.ctx.tabs.activeTab();
    const near =
      opts.near ?? (active?.path && active.origin === host ? active.path : null);
    const startDir =
      (near && dirname(near)) || this.ctx.workspaceRoot || session?.path || session?.home || '/';
    const { near: _near, ...rest } = opts;
    return this.remotePicker.pick({ ...rest, host, startDir, home: session?.home ?? null });
  }

  /** Native pickers and Finder drops give local paths, but file I/O goes to the
   *  remote host while connected. Block the action with a clear message. */
  async blockLocalPathWhileRemote(action: string): Promise<boolean> {
    const host = this.ctx.tabs.getOrigin();
    if (host === LOCAL_ORIGIN) return false;
    await message(
      `${action} uses a local path, but a remote session (ssh ${host}) is active. ` +
      'Use Open File (it browses the host) or the explorer, or disconnect first.',
      { title: 'Remote Session Active', kind: 'warning' },
    );
    return true;
  }

  async save(tabId?: string): Promise<boolean> {
    const id = tabId ?? this.ctx.tabs.activeTab()?.id;
    const tab = id ? this.ctx.tabs.getTab(id) : null;
    if (!tab) return false;
    if (!id) return false;
    let content = id === this.ctx.tabs.activeTab()?.id ? this.ctx.editor.getContent() : tab.content;
    const originalPath = tab.path;
    if (originalPath && tab.origin !== this.ctx.tabs.getOrigin()) {
      // Defence in depth: never write a tab to another machine's disk.
      const where = tab.origin === LOCAL_ORIGIN ? 'this computer' : `ssh ${tab.origin}`;
      await message(
        `"${originalPath}" belongs to ${where}, which is not the active session. ` +
        'It was not saved. Reconnect to that machine to save it.',
        { title: 'Save Failed', kind: 'error' },
      );
      return false;
    }
    if (originalPath) {
      this.savesInFlight.add(id);
      try {
        const verdict = await this.checkDiskBeforeSave(id, originalPath);
        if (verdict === 'cancel') return false;
        if (verdict === 'reloaded') return true; // tab now matches disk
        // The disk check awaits I/O (and a dialog on a conflict), so keys typed
        // meanwhile are not in the text taken above. Take it again right
        // before the write so the file gets what the editor holds now.
        if (id === this.ctx.tabs.activeTab()?.id) content = this.ctx.editor.getContent();
        await this.writeOwn(originalPath, content);
        if (this.ctx.tabs.getTab(id)?.content !== content) {
          // Typing landed during the write. The file now holds `content`, so
          // that is the baseline: the tab stays dirty and our own write is
          // not mistaken for a foreign change by the watcher or the next save.
          this.ctx.tabs.recordWritten(id, content);
          // Then write once more with the text the tab holds now.
          return await this.writeFollowUp(id, originalPath, content);
        }
        return this.ctx.tabs.markSaved(id, content);
      } catch (err) {
        if (this.ctx.tabs.getTab(id)?.content === content) await this.reportSaveError(originalPath, err);
        return false;
      } finally {
        this.savesInFlight.delete(id);
      }
    }
    return this.saveAs(id);
  }

  /**
   * Typing landed in a tab while save() wrote it. Write once more, right
   * away, with the text the tab holds now. One such write per tab at a time:
   * a request while one is running joins it. Text typed during this write is
   * not written again; the tab stays modified, as after any write that typing
   * overtakes. No write when the tab is gone, moved to another file, belongs
   * to a machine that is no longer the active session, or no longer differs
   * from what was written.
   */
  private writeFollowUp(id: string, path: string, written: string): Promise<boolean> {
    const pending = this.followUps.get(id);
    if (pending) return pending;
    const run = this.runFollowUp(id, path, written).finally(() => this.followUps.delete(id));
    this.followUps.set(id, run);
    return run;
  }

  private async runFollowUp(id: string, path: string, written: string): Promise<boolean> {
    // The first write just finished. A larger file takes long enough to write
    // that typing lands during it, yet the write can finish within the
    // backend's per-file interval, which would refuse this write. Wait the
    // interval out; keys typed meanwhile are in the text taken below.
    await this.waitForWriteInterval(path);
    const tab = this.ctx.tabs.getTab(id);
    if (!tab || tab.path !== path || tab.origin !== this.ctx.tabs.getOrigin()) return false;
    const content = id === this.ctx.tabs.activeTab()?.id ? this.ctx.editor.getContent() : tab.content;
    if (content === written) return this.ctx.tabs.markSaved(id, content);
    try {
      await this.writeOwn(path, content);
    } catch (err) {
      if (this.ctx.tabs.getTab(id)?.content === content) await this.reportSaveError(path, err);
      return false;
    }
    if (this.ctx.tabs.getTab(id)?.content !== content) {
      this.ctx.tabs.recordWritten(id, content);
      return false;
    }
    return this.ctx.tabs.markSaved(id, content);
  }

  /**
   * Before overwriting a file, make sure nobody (an agent, another editor)
   * changed it since we last read or wrote it. On a conflict ask the user:
   * Overwrite (write ours), Reload (take the disk text, drop ours), or
   * Cancel. A missing/unreadable file is not a conflict — the write
   * recreates it or reports its own error.
   */
  private async checkDiskBeforeSave(
    tabId: string,
    path: string,
  ): Promise<'write' | 'reloaded' | 'cancel'> {
    let disk: string;
    try {
      disk = await api.readFile(path);
    } catch {
      return 'write';
    }
    const tab = this.ctx.tabs.getTab(tabId);
    if (!tab) return 'cancel';
    if (disk === tab.savedContent) return 'write';
    let choice: string;
    try {
      choice = await message(
        `"${tab.title}" changed on disk after you started editing it.\n\n` +
          'Overwrite it with your version, or reload the version on disk (your unsaved edits are lost)?',
        {
          title: 'File Changed on Disk',
          kind: 'warning',
          buttons: { yes: 'Overwrite', no: 'Reload', cancel: 'Cancel' },
        },
      );
    } catch (err) {
      console.error('Disk-conflict prompt failed:', err);
      return 'cancel';
    }
    if (choice === 'Yes') return 'write';
    if (choice !== 'No' || !this.ctx.tabs.getTab(tabId)) return 'cancel';
    this.ctx.tabs.reloadFromDisk(tabId, disk);
    if (tabId === this.ctx.tabs.activeTab()?.id) {
      this.ctx.editor.loadFresh(disk, path);
      this.ctx.statusbar.updateModified(false);
      if (isPreviewable(path)) void this.deps.renderPreview(disk);
    } else {
      this.ctx.editor.forgetState(tabId);
    }
    this.ctx.publishContextSoon();
    return 'reloaded';
  }

  async saveAs(tabId?: string): Promise<boolean> {
    const id = tabId ?? this.ctx.tabs.activeTab()?.id;
    const tab = id ? this.ctx.tabs.getTab(id) : null;
    if (!id) return false;
    if (!tab) return false;
    let content = id === this.ctx.tabs.activeTab()?.id ? this.ctx.editor.getContent() : tab.content;
    const sameOrigin = tab.origin === this.ctx.tabs.getOrigin();
    const defaultPath = defaultSavePath(sameOrigin ? tab.path : null, this.ctx.fileTree.getSaveDir(), 'untitled.md');
    const filters = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mkd'] }];
    const path =
      this.ctx.tabs.getOrigin() !== LOCAL_ORIGIN
        ? await this.pickRemote({
            mode: 'save',
            title: 'Save As',
            filters,
            defaultName: basename(defaultPath),
            // A tab from another machine: its path means nothing here.
            near: defaultPath.includes('/') || defaultPath.includes('\\') ? defaultPath : undefined,
          })
        : await save({ filters, defaultPath });
    if (!path) return false;
    try {
      // The picker is async: take the text again so keys typed meanwhile count.
      if (id === this.ctx.tabs.activeTab()?.id) content = this.ctx.editor.getContent();
      await this.writeOwn(path, content);
      if (this.ctx.tabs.getTab(id)?.content !== content) {
        // Typing landed during the write: the file exists with `content`, so
        // bind the tab to it and keep the tab dirty for the newer text.
        if (this.ctx.tabs.setPathFor(id, path)) this.ctx.tabs.recordWritten(id, content);
        return false;
      }
      if (!this.ctx.tabs.setPathFor(id, path)) return false;
      return this.ctx.tabs.markSaved(id, content);
    } catch (err) {
      if (this.ctx.tabs.getTab(id)?.content === content) await this.reportSaveError(path, err);
      return false;
    }
  }

  private async reportSaveError(path: string, err: unknown): Promise<void> {
    console.error('Failed to save file:', err);
    await message(`Could not save "${path}".\n\n${String(err)}`, {
      title: 'Save Failed',
      kind: 'error',
    });
  }

  closePristineUntitled(): void {
    for (const tab of [...this.ctx.tabs.getAllTabs()]) {
      if (!tab.path && !tab.modified && tab.content === '') this.ctx.tabs.closeTab(tab.id);
    }
  }

  /** Create an Untitled buffer only when the otherwise tabless editor is used. */
  initUntitledOnEditorFocus(): void {
    document.getElementById('editor-container')?.addEventListener('focusin', () => {
      if (!this.ctx.tabs.activeTab()) this.newFile();
    });
  }

  newFile(): void {
    this.ctx.tabs.openTab(null, '');
  }

  async exportHtml(): Promise<void> {
    const tab = this.ctx.tabs.activeTab();
    if (!tab) return;
    const remote = this.ctx.tabs.getOrigin() !== LOCAL_ORIGIN;

    const preview = await this.deps.loadPreview();
    await preview.renderImmediateForExport(this.ctx.editor.getContent());
    const html = preview.getRenderedHtml();

    const defaultName = defaultSavePath(
      tab.path && tab.origin === this.ctx.tabs.getOrigin() ? stripMarkdownExt(tab.path, '.html') : null,
      this.ctx.fileTree.getSaveDir(),
      'export.html',
    );

    const filters = [{ name: 'HTML', extensions: ['html'] }];
    const path = remote
      ? await this.pickRemote({
          mode: 'save',
          title: 'Export HTML',
          confirmLabel: 'Export',
          filters,
          defaultName: basename(defaultName),
          near: defaultName.includes('/') || defaultName.includes('\\') ? defaultName : undefined,
        })
      : await save({ filters, defaultPath: defaultName });

    if (path) {
      const fullHtml = buildExportHtml(html, tab.title || 'Export');
      try {
        await api.writeFile(path, fullHtml);
      } catch (err) {
        console.error('Failed to export HTML:', err);
        await message(`Could not export "${path}".\n\n${String(err)}`, {
          title: 'Export Failed',
          kind: 'error',
        });
      }
    }
  }

  /**
   * Export PDF: render the document into the preview (even when the preview
   * is hidden), wait for its images, then open the platform print dialog;
   * its PDF destination writes the file. Markdown documents only: HTML and
   * SVG files preview in a frame that prints as one clipped page.
   *
   * The PDF is always light, whatever the app theme: the print styles use the
   * light palette, and Mermaid diagrams are drawn light for the export and
   * redrawn in the app theme when the print ends.
   */
  async exportPdf(): Promise<void> {
    const tab = this.ctx.tabs.activeTab();
    if (!tab) return;
    if (tab.path && !isMarkdownFile(tab.path)) {
      await message('Export PDF works with Markdown documents.', {
        title: 'Export PDF',
        kind: 'info',
      });
      return;
    }

    const preview = await this.deps.loadPreview();
    await preview.renderImmediateForExport(this.ctx.editor.getContent(), 'light');
    await preview.whenImagesResolved();
    const title = tab.path ? basename(stripMarkdownExt(tab.path, '')) : tab.title || 'Untitled';
    const appTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const restoreDiagrams = () => {
      if (appTheme === 'light') return;
      preview.notifyThemeChanged(appTheme);
      void preview.rerenderForTheme(this.ctx.editor.getContent());
    };
    // Linux print dialogs suggest `<doc name>.pdf` in the document's folder
    // (or the open folder for an Untitled tab). A tab from another machine
    // has no local folder, so it gets the bare name.
    const local = tab.origin === LOCAL_ORIGIN && this.ctx.tabs.getOrigin() === LOCAL_ORIGIN;
    const pdfPath = local
      ? defaultSavePath(tab.path ? stripMarkdownExt(tab.path, '.pdf') : null, this.ctx.fileTree.getSaveDir(), `${title}.pdf`)
      : `${title}.pdf`;
    try {
      await printTarget(preview.getRenderRoot(), title, () => api.printWebview(pdfPath), restoreDiagrams);
    } catch (err) {
      console.error('Failed to export PDF:', err);
      await message(`Could not open the print dialog.\n\n${String(err)}`, {
        title: 'Export Failed',
        kind: 'error',
      });
    }
  }

  /** A tab's close button on a dirty tab: Save / Don't Save / Cancel. */
  async confirmCloseTab(tabId: string): Promise<void> {
    const tab = this.ctx.tabs.getTab(tabId);
    if (!tab) return;
    const choice = await this.promptUnsaved(tab.title);
    if (choice === 'Cancel' || !this.ctx.tabs.getTab(tabId)) return;
    if (choice === 'Yes' && !(await this.save(tabId))) return;
    this.ctx.tabs.closeTab(tabId);
  }

  /**
   * Walk every modified tab and prompt Save/Discard. Returns false if the user
   * cancelled or a save failed (caller should abort), true if it's safe to
   * proceed (everything saved, discarded, or nothing was modified).
   */
  async resolveUnsavedChanges(): Promise<boolean> {
    for (const tab of this.ctx.tabs.getModifiedTabs()) {
      this.ctx.tabs.switchTo(tab.id);
      const choice = await this.promptUnsaved(tab.title);
      if (choice === 'Cancel') return false; // abort the whole operation
      if (choice === 'Yes') {
        // switchTo above made this the active tab, so save() targets it.
        const ok = await this.save();
        if (!ok) return false; // save failed or was cancelled
      }
      // 'No' (Don't Save) → leave it modified-but-unsaved, move on
    }
    return true;
  }

  /**
   * Native 3-button unsaved-changes prompt (Save / Don't Save / Cancel) via the
   * dialog plugin's YesNoCancel message dialog. Returns 'Yes' | 'No' | 'Cancel'
   * ('Cancel' on any failure, so work is never discarded silently).
   */
  private async promptUnsaved(filename: string): Promise<'Yes' | 'No' | 'Cancel'> {
    try {
      const result = await message(
        `"${filename}" has unsaved changes. Do you want to save them?`,
        {
          title: 'Unsaved Changes',
          kind: 'warning',
          buttons: { yes: 'Save', no: "Don't Save", cancel: 'Cancel' },
        },
      );
      return result as 'Yes' | 'No' | 'Cancel';
    } catch (err) {
      console.error('Unsaved-changes prompt failed:', err);
      return 'Cancel';
    }
  }
}
