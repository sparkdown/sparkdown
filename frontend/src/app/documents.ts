import { open, save, message } from '@tauri-apps/plugin-dialog';
import type { PreviewPane } from '../preview';
import { LOCAL_ORIGIN } from '../tabs';
import { RemotePicker, type RemotePickerOptions } from '../remote-picker';
import { isPreviewable, stripMarkdownExt, dirname, basename } from '../utils';
import { DIALOG_FILTERS } from '../file-types';
import { api } from '../api';
import type { AppContext } from './context';
import { buildExportHtml } from './export-html';

/** What document I/O needs from the preview. */
export interface DocumentDeps {
  renderPreview(content: string): Promise<void>;
  loadPreview(): Promise<PreviewPane>;
}

/**
 * Document I/O: open / save / save as / export, the on-disk conflict check
 * before a write, unsaved-changes prompts, and the tab-origin guards that
 * keep remote and local files on their own machine.
 */
export class DocumentController {
  // Tabs with a save in progress: a watcher event that lands between our
  // write and markSaved() would otherwise look like a foreign change.
  private savesInFlight = new Set<string>();
  /** Tabs the user chose "Don't Save" for in prepareOriginSwitch; only these
   *  dirty tabs may be dropped by commitOriginSwitch. */
  private discardOnOriginSwitch = new Set<string>();
  /** The in-app remote file picker (one open at a time). */
  private remotePicker = new RemotePicker();

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: DocumentDeps,
  ) {}

  /** True while save() is writing this tab (see syncTabWithDisk). */
  isSaving(tabId: string): boolean {
    return this.savesInFlight.has(tabId);
  }

  async openFile(path: string): Promise<void> {
    try {
      const content = await api.readFile(path);
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
    const content = id === this.ctx.tabs.activeTab()?.id ? this.ctx.editor.getContent() : tab.content;
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
        await api.writeFile(originalPath, content);
        if (this.ctx.tabs.getTab(id)?.content !== content) return false;
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
    const content = id === this.ctx.tabs.activeTab()?.id ? this.ctx.editor.getContent() : tab.content;
    const defaultPath = tab.path || 'untitled.md';
    const filters = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mkd'] }];
    const path =
      this.ctx.tabs.getOrigin() !== LOCAL_ORIGIN
        ? await this.pickRemote({
            mode: 'save',
            title: 'Save As',
            filters,
            defaultName: basename(defaultPath),
            // A tab from another machine: its path means nothing here.
            near: tab.path && tab.origin === this.ctx.tabs.getOrigin() ? tab.path : undefined,
          })
        : await save({ filters, defaultPath });
    if (!path) return false;
    try {
      await api.writeFile(path, content);
      if (this.ctx.tabs.getTab(id)?.content !== content) return false;
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

    const defaultName = tab.path
      ? stripMarkdownExt(tab.path, '.html')
      : 'export.html';

    const filters = [{ name: 'HTML', extensions: ['html'] }];
    const path = remote
      ? await this.pickRemote({
          mode: 'save',
          title: 'Export HTML',
          confirmLabel: 'Export',
          filters,
          defaultName: basename(defaultName),
          near: tab.path && tab.origin === this.ctx.tabs.getOrigin() ? tab.path : undefined,
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
