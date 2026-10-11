import { listen } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
import { EditorManager } from './editor';
import { Toolbar } from './toolbar';
import { Titlebar } from './titlebar';
import { StatusBar } from './statusbar';
import { ThemeManager } from './theme';
import { TabManager, LOCAL_ORIGIN, type Tab } from './tabs';
import { FileTree } from './file-tree';
import { ActivityBar, parseSidebarView } from './activity-bar';
import { SearchView } from './search-view';
import { TOC } from './toc';
import { ShortcutManager, applyShortcutLabels } from './shortcuts';
import { EventBus } from './events';
import { SettingsDialog } from './settings-dialog';
import { UpdateManager } from './updater';
import type { RemoteHandler } from './remote';
import { isMarkdownFile, isPreviewable, debounce, createRafBatch } from './utils';
import { effectiveView } from './view-mode';
import { TIMING, LAYOUT } from './constants';
import { initResizeHandle, initSidebarResize, initToolbarDrag } from './app/layout';
import type { AppContext } from './app/context';
import { PaneController } from './app/panes';
import { HtmlScriptsController } from './app/html-scripts';
import { DiffController } from './app/diff';
import { ViewModeController } from './app/view-mode';
import { DocumentController } from './app/documents';
import { LifecycleController } from './app/lifecycle';
import { WorkspaceController } from './app/workspace';
import { WelcomeController } from './app/welcome';
import { AgentContextBridge } from './app/agent-context';
import { CockpitController } from './app/cockpit';
import { registerMenuListeners, registerActionListeners, type ActionTargets } from './app/actions';
import { registerBuiltinCommands, type ViewMode } from './app/builtin-commands';
import { Palette } from './palette';
import { commands } from './commands';
import { api, type AppConfig, type FsChange } from './api';
import { ACTIONS, EVENTS } from './event-names';
import { initPerfTrace, span } from './perf-trace';

const DEFAULT_CONFIG: AppConfig = {
  theme: 'system',
  last_open_files: [],
  recent_folders: [],
  terminal_visible: false,
  terminal_height: 200,
  terminals_only: false,
  sidebar_width: LAYOUT.SIDEBAR_DEFAULT_PX,
  sidebar_visible: true,
  sidebar_view: 'files',
  preview_visible: true,
  default_view_mode: null,
  word_wrap: true,
  show_hidden_files: false,
  enable_diagrams: true,
  use_tmux: true,
  agent_context_enabled: true,
  agent_args: {},
  check_updates_automatically: true,
  last_update_check_ms: 0,
  terminal_layouts: {},
  mcp_install_prompt_dismissed: [],
};

/**
 * The application shell: owns the long-lived UI services (bus, editor, tabs,
 * explorer, status bar, …) and the loaded config, builds the controllers in
 * app/*.ts, and wires bus events between them. Feature logic lives in the
 * controllers; the public methods here are the API main.ts, remote.ts and
 * the integration tests use.
 */
export class App {
  private bus = new EventBus();
  private editor!: EditorManager;
  private toolbar!: Toolbar;
  private titlebar!: Titlebar;
  private statusbar!: StatusBar;
  private theme!: ThemeManager;
  private tabs!: TabManager;
  private fileTree!: FileTree;
  private toc!: TOC;
  private shortcuts!: ShortcutManager;
  private config!: AppConfig;
  private ctx!: AppContext;
  // Controllers (app/*.ts), built in init() once the services exist.
  private panes!: PaneController;
  private htmlScripts!: HtmlScriptsController;
  private documents!: DocumentController;
  private lifecycle!: LifecycleController;
  private agent!: AgentContextBridge;
  private cockpit!: CockpitController;
  private diff!: DiffController;
  private viewMode!: ViewModeController;
  private workspace!: WorkspaceController;
  private welcome!: WelcomeController;
  private activityBar!: ActivityBar;
  private searchView!: SearchView;
  private updates!: UpdateManager;
  private palette!: Palette;
  /** Remote sessions' folder-open router (remote.ts); null = local only. */
  private remoteHandler: RemoteHandler | null = null;
  private settingsDialog = new SettingsDialog();
  /** init() finished building the UI (gates RemoteHandler.attach). */
  private ready = false;
  private unlisteners: Array<() => void> = [];
  private configSaveFailures = 0;
  private raf = createRafBatch();
  private debouncedSaveConfig = debounce(() => this.persistConfig(), TIMING.CONFIG_SAVE_MS);
  private debouncedTocUpdate = debounce((c: string) => this.toc.update(c), TIMING.TOC_UPDATE_MS);

  async init(): Promise<void> {
    await initPerfTrace();
    // Fire both startup IPC calls immediately; config gates UI construction
    // but pending "Open With" files aren't needed until the very end.
    const pendingFilesPromise = api.getPendingFiles().catch(() => [] as string[]);
    try {
      this.config = await api.loadConfig();
    } catch {
      this.config = { ...DEFAULT_CONFIG };
    }

    this.theme = new ThemeManager(this.bus, this.config.theme);
    this.editor = new EditorManager(this.bus, this.config.word_wrap);
    this.toolbar = new Toolbar(this.bus);
    this.titlebar = new Titlebar();
    this.statusbar = new StatusBar(this.bus);
    this.tabs = new TabManager(this.bus);
    this.fileTree = new FileTree(
      this.bus,
      this.config.sidebar_visible,
      this.config.sidebar_width,
      this.config.show_hidden_files,
    );
    this.toc = new TOC(this.bus);
    this.shortcuts = new ShortcutManager(this.bus);
    this.ctx = this.createContext();
    this.htmlScripts = new HtmlScriptsController(this.tabs, () => this.panes.preview);
    this.panes = new PaneController(this.ctx, {
      scriptsAllowedForActive: () => this.htmlScripts.allowedForActive(),
      applyScriptsPolicy: () => this.htmlScripts.applyPolicy(),
      openFile: (path) => void this.openFile(path),
      openDiffFind: () => this.diff.openFind(),
    });
    this.documents = new DocumentController(this.ctx, {
      renderPreview: (content) => this.panes.renderPreview(content),
      loadPreview: () => this.panes.loadPreview(),
    });
    this.lifecycle = new LifecycleController(this.ctx, {
      resolveUnsavedChanges: () => this.documents.resolveUnsavedChanges(),
      persistConfig: () => this.persistConfig(),
      clearAgentContext: () => this.agent.clear(),
      destroy: () => this.destroy(),
    });
    this.agent = new AgentContextBridge(this.ctx, {
      openFile: (path) => this.openFile(path),
    });
    this.cockpit = new CockpitController(this.ctx, {
      armAgentContext: () => this.agent.arm(),
      closePristineUntitled: () => this.documents.closePristineUntitled(),
      defaultTerminalHeight: DEFAULT_CONFIG.terminal_height,
    });
    this.diff = new DiffController(this.ctx, {
      applyTabSwitch: (tab) => this.applyTabSwitch(tab),
      onChangeCount: (count) => this.activityBar.setChangeCount(count),
      onGitStatus: () => this.viewMode.refreshControl(),
      showDiffView: () => this.viewMode.setViewMode('diff'),
      openAt: (path, line, column) => this.openAt(path, line, column),
    });
    this.viewMode = new ViewModeController(this.ctx, {
      panes: this.panes,
      diff: this.diff,
    });
    this.searchView = new SearchView({
      openAt: (path, line, column) => void this.openAt(path, line, column),
      includeHidden: () => this.fileTree.isShowHidden(),
    });
    this.activityBar = new ActivityBar(
      {
        bus: this.bus,
        sidebar: this.fileTree,
        onViewChange: (view) => this.diff.setChangesMode(view === 'changes'),
        focusView: (view) => {
          if (view === 'search') this.searchView.focus();
        },
        // Only Search has a control to focus; for the other views a repeat
        // shortcut closes the sidebar, like a click.
        hasFocus: (view) => (view === 'search' ? this.searchView.hasFocus() : true),
        saveConfigSoon: () => this.debouncedSaveConfig(),
        listenTauri: this.ctx.listenTauri,
      },
      parseSidebarView(this.config.sidebar_view),
    );
    this.workspace = new WorkspaceController(this.ctx, {
      documents: this.documents,
      panes: this.panes,
      diff: this.diff,
      cockpit: this.cockpit,
      search: this.searchView,
      syncEmptyState: () => this.welcome.sync(),
      openFolder: (dir) => this.openFolder(dir),
    });
    this.welcome = new WelcomeController(this.ctx, {
      openFolderDialog: () => this.openFolderDialog(),
      openFileDialog: () => this.openFileDialog(),
      quickOpen: () => this.bus.emit(ACTIONS.QUICK_OPEN),
      newFile: () => this.newFile(),
      openFolder: (dir) => this.openFolder(dir),
      hideDiffPane: () => this.diff.hideDiffPane(),
      refreshViewControl: () => this.viewMode.refreshControl(),
    });

    this.palette = this.createPalette();

    this.editor.init(document.getElementById('editor-container')!);
    this.documents.initUntitledOnEditorFocus();
    this.toolbar.init();
    this.titlebar.init();
    this.statusbar.init();
    this.tabs.init(document.getElementById('tab-bar')!);
    this.fileTree.init(
      document.getElementById('file-tree')!,
      document.getElementById('sidebar')!
    );
    this.toc.init(document.getElementById('app')!);
    this.shortcuts.init();
    // Static HTML tooltips and hints (index.html) in this platform's keys.
    applyShortcutLabels();

    this.viewMode.init();
    this.statusbar.updateWrap(this.config.word_wrap);
    void this.refreshAgentTools();

    initResizeHandle();
    initSidebarResize(this.fileTree, () => this.debouncedSaveConfig());
    initToolbarDrag(this.titlebar);
    this.htmlScripts.init();
    registerMenuListeners(this.actionTargets());
    this.registerBusListeners();
    this.registerCommands();
    this.lifecycle.registerCloseGuard();
    this.initUpdates();
    this.workspace.registerFileDrop();
    this.panes.initPaneFocusTracking();
    this.workspace.registerWatcher();
    this.agent.registerMcpListeners();
    this.cockpit.initTerminalResize();
    this.diff.init();
    this.searchView.init();
    this.activityBar.init();

    const pendingFiles = await pendingFilesPromise;

    this.welcome.init();

    // CLI / "Open With" paths can be files or folders. Folders become the
    // sidebar root (same as a dropped directory); files open as tabs.
    // Session restore is files-only, so it stays on openFilesInOrder.
    if (pendingFiles.length > 0) {
      await this.workspace.openDroppedPaths(pendingFiles);
    } else if (this.config.last_open_files.length > 0) {
      await this.documents.openFilesInOrder(this.config.last_open_files);
    } else {
      // Nothing to restore → the welcome screen (an invitation to act),
      // rather than a blank Untitled buffer.
      this.welcome.show();
    }

    await this.cockpit.restore();

    this.ready = true;
    this.remoteHandler?.attach();
  }

  /** The shared state controllers see (see app/context.ts). Services are
   *  constructed by now; baseDir / workspaceRoot live on the context. */
  private createContext(): AppContext {
    return {
      bus: this.bus,
      editor: this.editor,
      tabs: this.tabs,
      fileTree: this.fileTree,
      statusbar: this.statusbar,
      toolbar: this.toolbar,
      toc: this.toc,
      config: this.config,
      baseDir: null,
      workspaceRoot: null,
      saveConfigSoon: () => this.debouncedSaveConfig(),
      publishContextSoon: () => this.agent.publishSoon(),
      listenTauri: (event, handler) => {
        void listen(event, handler).then((u) => this.unlisteners.push(u));
      },
    };
  }

  /** What menu items and shortcuts reach (see app/actions.ts). */
  private actionTargets(): ActionTargets {
    return {
      bus: this.bus,
      editor: this.editor,
      tabs: this.tabs,
      fileTree: this.fileTree,
      theme: this.theme,
      panes: this.panes,
      viewMode: this.viewMode,
      cockpit: this.cockpit,
      htmlScripts: this.htmlScripts,
      lifecycle: this.lifecycle,
      palette: this.palette,
      newFile: () => this.newFile(),
      openFile: (path) => this.openFile(path),
      openFileDialog: () => this.openFileDialog(),
      openFolderDialog: () => this.openFolderDialog(),
      save: () => this.save(),
      saveAs: () => this.saveAs(),
      exportHtml: () => this.exportHtml(),
      openSettings: () => this.openSettings(),
      openAgentSettings: () => this.openSettings('agents'),
      openRemoteDialog: () => this.remoteHandler?.openRemoteDialog?.(),
      checkForUpdates: () => void this.updates.check(true),
      listenTauri: this.ctx.listenTauri,
    };
  }

  private registerBusListeners(): void {
    this.bus.on(EVENTS.CONTENT_CHANGED, (data) => {
      let tab = this.tabs.activeTab();
      // A folder can show the editor before any tab exists. Materialize the
      // buffer only once the user actually types into that editor.
      if (!tab) {
        this.tabs.openTab(null, data.content);
        tab = this.tabs.activeTab();
        if (tab) {
          tab.savedContent = '';
          this.tabs.updateContent(data.content);
          this.tabs.refreshModified();
        }
      }
      const path = tab?.path ?? null;
      if (isPreviewable(path)) void this.panes.renderPreview(data.content);
      this.tabs.updateContent(data.content);
      // Compare against the saved baseline so undoing back to it clears the
      // dirty flag (instead of latching modified once and never clearing).
      this.tabs.refreshModified();
      const isModified = this.tabs.activeTab()?.modified ?? false;
      // Batch lightweight UI updates into a single animation frame
      this.raf.schedule('modified', () => this.statusbar.updateModified(isModified));
      this.raf.schedule('counts', () => {
        this.statusbar.updateCounts(
          this.editor.getWordCount(),
          this.editor.getLineCount(),
          this.editor.getCharCount(),
          this.editor.getSelectedCharCount(),
        );
      });
      if (isMarkdownFile(path)) {
        this.debouncedTocUpdate(data.content);
      }
      this.agent.publishSoon();
    });

    this.panes.registerScrollSync();

    this.bus.on(EVENTS.TAB_SWITCHED, (data) => {
      if (data.tab) this.applyTabSwitch(data.tab);
      this.syncTreeOpenFiles();
      if (data.tab) this.palette.noteOpened(data.tab.path, data.tab.origin);
    });
    this.bus.on(EVENTS.TAB_CLOSED, () => this.syncTreeOpenFiles());

    // Cursor / selection moves feed the MCP snapshot (get_selection, cursor
    // line). Debounced, so this is cheap even while typing.
    this.bus.on(EVENTS.CURSOR_CHANGED, () => this.agent.publishSoon());

    this.bus.on(EVENTS.TAB_SAVE_STATE, (data) => {
      // Capture content first to avoid race between saveStateFor and getContent
      const content = this.editor.getContent();
      this.tabs.setContentFor(data.tabId, content);
      this.editor.saveStateFor(data.tabId);
    });

    this.bus.on(EVENTS.TAB_CLOSED, (data) => {
      this.editor.forgetState(data.tabId);
    });

    this.bus.on(EVENTS.CONFIRM_CLOSE_TAB, (data) => void this.documents.confirmCloseTab(data.tabId));

    this.bus.on(EVENTS.ALL_TABS_CLOSED, () => {
      // Last tab closed → return to the welcome screen, not quit. The window
      // is a workspace (folder + terminal may still be in use); quitting is
      // Cmd+Q. This is the cockpit model: closing files ≠ closing the app.
      this.welcome.show();
    });

    this.bus.on(EVENTS.TAB_SAVED, (data) => {
      this.diff.onTabSaved(data.tab);
      this.syncTreeOpenFiles();
      this.statusbar.updateModified(false);
      this.statusbar.setActiveFile(data.tab.path, data.tab.title);
      this.debouncedSaveConfig();
      this.agent.publishSoon();
    });

    this.bus.on(EVENTS.FILE_TREE_OPEN, (data) => {
      this.openFile(data.path);
    });

    this.bus.on(EVENTS.TOC_GOTO_LINE, (data) => {
      this.editor.gotoLine(data.line);
    });

    this.bus.on(EVENTS.TOC_SCROLL_PREVIEW, (data) => {
      this.panes.preview?.scrollToId(data.id);
    });

    this.bus.on(EVENTS.INSERT_AT_CURSOR, (data) => {
      this.editor.insertAtCursor(data.text);
    });

    registerActionListeners(this.actionTargets());

    this.bus.on(EVENTS.THEME_CHANGED, (data) => {
      this.cockpit.applyTheme();
      this.debouncedSaveConfig();
      this.panes.rerenderForTheme(data.theme);
    });

    this.bus.on(EVENTS.SIDEBAR_TOGGLED, () => this.debouncedSaveConfig());
    this.bus.on(EVENTS.WORD_WRAP_CHANGED, () => this.debouncedSaveConfig());
  }

  /** The explorer marks files open in tabs (this machine's tabs only). */
  private syncTreeOpenFiles(): void {
    const origin = this.tabs.getOrigin();
    this.fileTree.setOpenPaths(
      this.tabs
        .getAllTabs()
        .filter((t) => t.path && t.origin === origin)
        .map((t) => t.path!),
    );
  }

  /** Open `path` with the cursor at `line` / `column` (Search in files). A
   *  tab showing its diff switches back to the editor so the line shows. */
  private async openAt(path: string, line: number, column: number): Promise<void> {
    await this.openFile(path);
    const tab = this.tabs.activeTab();
    if (!tab || tab.path !== path) return;
    if (effectiveView(tab.viewMode, tab.path) === 'diff') {
      // The view control coerces back to the default (edit/split/preview).
      this.viewMode.setViewMode(this.viewMode.getDefaultMode());
    }
    this.editor.gotoLine(line, column);
  }

  // --- Public API (tests, remote.ts) — thin delegates -----------------------

  openFile(path: string): Promise<void> {
    return this.documents.openFile(path);
  }

  openFileDialog(): Promise<void> {
    return this.documents.openFileDialog();
  }

  newFile(): void {
    this.documents.newFile();
  }

  save(tabId?: string): Promise<boolean> {
    return this.documents.save(tabId);
  }

  saveAs(tabId?: string): Promise<boolean> {
    return this.documents.saveAs(tabId);
  }

  exportHtml(): Promise<void> {
    return this.documents.exportHtml();
  }

  /**
   * Pick a folder and make it the workspace root: point the explorer at it and
   * start watching it, without needing to open a file first. This is the
   * cockpit entry point — "open the folder my agent is working in."
   */
  openFolderDialog(): Promise<void> {
    return this.workspace.openFolderDialog();
  }

  /** Open a folder as the workspace. With a remote handler registered, the
   *  request (a local path or ssh://host/path) goes through it first. */
  openFolder(dir: string): Promise<void> {
    const openResolved = (path: string) => this.workspace.openFolder(path);
    return this.remoteHandler
      ? this.remoteHandler.openFolder(dir, openResolved)
      : openResolved(dir);
  }

  /**
   * Extension point for remote sessions (remote.ts): route folder opens
   * through `handler` and let it attach its UI once init() has built the
   * app. May be called before or after init().
   */
  setRemoteHandler(handler: RemoteHandler): void {
    this.remoteHandler = handler;
    if (this.ready) handler.attach();
  }

  /** Record `dir` at the front of the recent-folders list (see workspace.ts). */
  rememberRecentFolder(dir: string): void {
    this.workspace.rememberRecentFolder(dir);
  }

  /** Remote sessions, before the backend switches machine: resolve dirty
   *  tabs (DocumentController.prepareOriginSwitch), then clear the agent
   *  context where it lives while the old routing is still active. */
  async prepareOriginSwitch(target: string | null): Promise<boolean> {
    if (!(await this.documents.prepareOriginSwitch(target))) return false;
    await this.agent.beginOriginSwitch();
    return true;
  }

  /** Remote sessions, after the backend switched: drop other-machine tabs
   *  (DocumentController.commitOriginSwitch) and every piece of state that
   *  names a path on the old machine — workspace, watcher pin, JS trust. */
  commitOriginSwitch(target: string | null): void {
    this.documents.commitOriginSwitch(target);
    this.workspace.resetForOriginSwitch();
    this.htmlScripts.reset();
    this.agent.endOriginSwitch();
    // No folder and no tab left: the welcome screen (a connect opens its
    // folder right after this, which hides it again).
    if (!this.tabs.activeTab()) this.welcome.show();
  }

  /** Remote sessions: the backend switch failed after prepare. */
  cancelOriginSwitch(): void {
    this.agent.endOriginSwitch();
  }

  /** Unsubscribe all Tauri event listeners. Called before exit. */
  destroy(): void {
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners = [];
    // Quit persists the config itself right after this; a debounced save
    // still pending would only land late with the same (or staler) state.
    this.debouncedSaveConfig.cancel();
  }

  /** Quick open / command palette (palette.ts) over the workspace root. */
  private createPalette(): Palette {
    const palette = new Palette({
      root: () => this.ctx.workspaceRoot ?? this.fileTree.getRoot(),
      origin: () => this.tabs.getOrigin(),
      showHidden: () => this.fileTree.isShowHidden(),
      listFiles: (root, hidden) => api.listWorkspaceFiles(root, hidden),
      openFile: (path) => this.openFile(path),
      // No editor groups yet, so "to the side" = open and show the split.
      openToSide: async (path) => {
        await this.openFile(path);
        this.setViewMode('split');
      },
      activePath: () => this.tabs.activeTab()?.path ?? null,
      gotoLine: (line) => {
        this.editor.gotoLine(line);
        this.panes.focusEditor();
      },
      lineCount: () => (this.tabs.activeTab() ? this.editor.getLineCount() : 0),
    });
    for (const path of this.config.last_open_files) palette.noteOpened(path, LOCAL_ORIGIN);
    // Same rule as the backend cache (file_index.rs): only a structural
    // change (not a content write) can change the file list.
    this.ctx.listenTauri<FsChange[]>('watcher://changes', (e) => {
      if (e.payload.some((c) => c.kind !== 'modify')) palette.invalidateFiles();
    });
    return palette;
  }

  /** The built-in palette commands (app/builtin-commands.ts). */
  private registerCommands(): void {
    commands.register(...this.diff.reviewCommands());
    registerBuiltinCommands(commands, {
      bus: this.bus,
      tabs: this.tabs,
      root: () => this.ctx.workspaceRoot ?? this.fileTree.getRoot(),
      setViewMode: (mode) => this.setViewMode(mode),
      // "Show", not toggle: a view that is already open stays open.
      showSidebarView: (view) => {
        if (this.fileTree.isVisible() && this.activityBar.getView() === view) {
          if (view === 'search') this.searchView.focus();
        } else {
          this.activityBar.request(view, 'click');
        }
      },
      openLinePrompt: () => this.palette.open('line'),
      toggleHtmlScripts: () => this.htmlScripts.toggle(false),
      checkForUpdates: () => void this.updates.check(true),
      terminal: {
        isVisible: () => this.cockpit.isVisible(),
        split: (dir) => this.cockpit.splitTerminal(dir),
        closePane: () => this.cockpit.closeTerminalPane(),
        focusPane: (delta) => this.cockpit.focusTerminalPane(delta),
      },
    });
  }

  /**
   * Put the active document in one view mode. The palette commands
   * (builtin-commands.ts) call this; it delegates to the per-document view
   * control, which owns the state and ignores a view the file can't show.
   */
  private setViewMode(mode: ViewMode): void {
    this.viewMode.setViewMode(mode);
  }

  private applyTabSwitch(tab: Tab): void {
    const endSwitch = span('tab-switch', tab.title);
    // A tab is active → we're no longer on the welcome screen.
    this.welcome.hide();
    // Close any preview-search widget — its highlights belong to the old
    // document and its search root is about to be replaced.
    this.panes.closeSearch();

    // Always load the editor buffer and preview for the tab — the diff is a
    // third view layered on top of a real file, so the underlying editor
    // state must be current for when the user toggles back to it.
    const endEditor = span('tab-switch:editor');
    this.loadEditorForTab(tab);
    endEditor();
    const endPreview = span('tab-switch:preview-kickoff');
    this.panes.applyPreviewForTab(tab, effectiveView(tab.viewMode, tab.path));
    endPreview();
    this.updateStatusbarForTab(tab);
    this.workspace.updateBaseDirForTab(tab);

    // The tab's own view: Diff shows the diff pane over the editor area (the
    // buffer stays loaded underneath so switching back is instant).
    this.viewMode.applyToActive({ focus: true });
    this.agent.publishSoon();
    endSwitch();
  }

  private loadEditorForTab(tab: Tab): void {
    if (!this.editor.restoreStateFor(tab.id)) {
      this.editor.loadFresh(tab.content, tab.path);
    }
    this.toolbar.setFileType(tab.path);
  }

  private updateStatusbarForTab(tab: Tab): void {
    this.statusbar.setActiveFile(tab.path, tab.title);
    this.statusbar.updateModified(tab.modified);
    this.statusbar.updateCounts(
      this.editor.getWordCount(),
      this.editor.getLineCount(),
      this.editor.getCharCount(),
      this.editor.getSelectedCharCount(),
    );
  }

  /** Remote sessions (remote.ts): base dir that the status bar shortens
   *  file paths against while an SSH workspace is open. */
  setRemotePathBase(base: string | null): void {
    this.statusbar.setPathBase(base);
  }

  /** Auto-update (updater.ts): quiet startup check + the menu item. The
   *  relaunch runs the same unsaved-changes flow and teardown as Quit. */
  private initUpdates(): void {
    this.updates = new UpdateManager({
      config: this.config,
      saveConfig: () => this.debouncedSaveConfig(),
      resolveUnsaved: () => this.lifecycle.resolveBeforeRestart(),
      beforeRestart: () => this.lifecycle.prepareExit(),
    });
    // Dev builds (`tauri dev`) skip the automatic check; the menu item works.
    if (!import.meta.env.DEV) this.updates.scheduleStartupCheck();
  }

  /** Open the settings modal, persisting any change and applying it live.
   *  With a section, open (never toggle closed) scrolled to it. */
  private openSettings(section?: 'agents'): void {
    const host = {
      config: this.config,
      onChange: () => {
        this.cockpit.applySettings();
        // Bridge switched off → remove what it already wrote, now.
        if (!this.config.agent_context_enabled) void this.agent.clear();
        else this.agent.publishSoon();
        void this.refreshAgentTools();
        this.debouncedSaveConfig();
      },
    };
    if (section) this.settingsDialog.showSection(host, section);
    else this.settingsDialog.toggle(host);
  }

  /** Status bar "Agent tools on/off": the MCP server is serving and the
   *  user allows sharing. */
  private async refreshAgentTools(): Promise<void> {
    const running = await api.mcpServerRunning().catch(() => false);
    this.statusbar.setAgentTools({
      running: running === true,
      // Missing in a partial config = the Rust default (on).
      enabled: this.config.agent_context_enabled !== false,
    });
  }

  private async persistConfig(): Promise<void> {
    try {
      const config: AppConfig = {
        theme: this.theme.getTheme(),
        // Local tabs only: the next launch starts local, so a remote path
        // would be read from this machine's disk.
        last_open_files: this.tabs.getOpenPaths(LOCAL_ORIGIN),
        recent_folders: this.config.recent_folders,
        terminal_visible: this.cockpit.isVisible(),
        terminal_height: this.cockpit.currentTerminalHeight(),
        terminals_only: this.cockpit.isTerminalsOnly(),
        sidebar_width: this.fileTree.getWidth(),
        sidebar_visible: this.fileTree.isVisible(),
        sidebar_view: this.activityBar.getView(),
        preview_visible: this.viewMode.getDefaultMode() !== 'edit',
        default_view_mode: this.viewMode.getDefaultMode(),
        word_wrap: this.editor.isWordWrapEnabled(),
        show_hidden_files: this.fileTree.isShowHidden(),
        enable_diagrams: this.config.enable_diagrams,
        use_tmux: this.config.use_tmux,
        agent_context_enabled: this.config.agent_context_enabled,
        agent_args: this.config.agent_args ?? {},
        check_updates_automatically: this.config.check_updates_automatically ?? true,
        last_update_check_ms: this.config.last_update_check_ms ?? 0,
        // Kept current by the cockpit (terminal split layout per workspace).
        terminal_layouts: this.config.terminal_layouts ?? {},
        mcp_install_prompt_dismissed: this.config.mcp_install_prompt_dismissed ?? [],
      };
      await api.saveConfig(config);
      this.configSaveFailures = 0;
    } catch (err) {
      console.error('Failed to save config:', err);
      this.configSaveFailures++;
      if (this.configSaveFailures >= 3) {
        this.configSaveFailures = 0;
        await message(
          'Failed to save preferences after multiple attempts. Your settings may not persist across sessions.',
          { title: 'Settings Error', kind: 'warning' }
        );
      }
    }
  }
}
