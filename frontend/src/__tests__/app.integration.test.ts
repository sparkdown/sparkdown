// @vitest-environment jsdom
/**
 * Integration tests for the App orchestration layer: real EventBus,
 * TabManager, EditorManager (CodeMirror), ThemeManager, StatusBar, etc.,
 * with the Tauri IPC boundary replaced by an in-memory backend
 * (see helpers/tauri-mocks.ts). Covers the flows unit tests can't:
 * startup restore, open/edit/save round-trips, the unsaved-changes
 * guard on quit, and config persistence.
 */
import './helpers/dom-shims';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () => (await import('./helpers/tauri-mocks')).coreMock);
vi.mock('@tauri-apps/api/event', async () => (await import('./helpers/tauri-mocks')).eventMock);
vi.mock('@tauri-apps/api/window', async () => (await import('./helpers/tauri-mocks')).windowMock);
vi.mock('@tauri-apps/api/webview', async () => (await import('./helpers/tauri-mocks')).webviewMock);
vi.mock('@tauri-apps/plugin-dialog', async () => (await import('./helpers/tauri-mocks')).dialogMock);
vi.mock('../preview', async () => ({
  PreviewPane: (await import('./helpers/tauri-mocks')).PreviewPaneStub,
}));

// TerminalManager pulls in xterm + PTY IPC; stub it so terminals-only layout tests
// can open the drawer without a real emulator.
const terminalStub = vi.hoisted(() => ({
  store: null as null | {
    load(key: string): unknown;
    save(key: string, layout: unknown): void;
  },
  promptStore: null as null | {
    isDismissed(bin: string): boolean;
    dismiss(bin: string): void;
  },
}));

vi.mock('../terminal', () => ({
  TerminalManager: class {
    setCwd() {}
    setUseTmux() {}
    setAgentArgs() {}
    setOnEmpty() {}
    setOnTerminalsOnly() {}
    refitAll() {}
    setLayoutStore(store: typeof terminalStub.store) {
      terminalStub.store = store;
    }
    setMcpPromptStore(store: typeof terminalStub.promptStore) {
      terminalStub.promptStore = store;
    }
    hasFocus() {
      return false;
    }
    async restoreOrCreate() {}
  },
}));

import {
  vfs,
  directories,
  savedConfigs,
  setConfigOnDisk,
  setPendingFiles,
  quitCalls,
  dialogResponses,
  emitTauriEvent,
  dragDropHandler,
  resetTauriMocks,
  invokeCalls,
  messageCalls,
  remoteVfs,
  remote,
  messageLog,
  gitChanges,
  searchState,
  git,
  mcp,
  reviewStore,
  changePrints,
} from './helpers/tauri-mocks';
import { App } from '../app';
import { FileTree } from '../file-tree';
import { api } from '../api';
import { installRemoteSessions } from '../remote';
import { MENU } from '../event-names';

/** The view control's button for a view. */
const viewBtn = (mode: string) =>
  document.querySelector<HTMLButtonElement>(`#view-mode button[data-view="${mode}"]`)!;
/** Which view the control shows as pressed. */
const pressedView = () =>
  document.querySelector<HTMLElement>('#view-mode button[aria-pressed="true"]')?.dataset.view ?? null;
const viewDisabled = (mode: string) => viewBtn(mode).getAttribute('aria-disabled') === 'true';

/** Open the status bar host chip's menu and pick an item. */
const pickChipMenu = (label: string) => {
  document.getElementById('status-remote')!.click();
  const item = [...document.querySelectorAll<HTMLElement>('.sd-ctxmenu-item')].find(
    (el) => el.textContent === label,
  );
  if (!item) throw new Error(`no chip menu item "${label}"`);
  item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
};

/** The minimal DOM skeleton App.init() expects (subset of index.html). */
const APP_SHELL = `
  <div id="app">
    <div id="toolbar">
      <div class="toolbar-start">
        <button id="btn-app-menu" class="app-icon-btn"></button>
      </div>
      <div class="tab-strip"><div id="tab-bar"></div></div>
      <div class="toolbar-end">
        <div id="view-mode" class="view-seg" hidden>
          <button data-view="edit">Edit</button>
          <button data-view="split">Split</button>
          <button data-view="preview">Preview</button>
          <button data-view="diff">Diff</button>
        </div>
        <button id="btn-terminal" class="toolbar-btn off"></button>
        <div class="window-controls">
          <button id="btn-window-min" class="window-control"></button>
          <button id="btn-window-max" class="window-control"></button>
          <button id="btn-window-close" class="window-control"></button>
        </div>
      </div>
    </div>
    <div id="main-content">
      <nav id="activity-bar">
        <button id="act-files" class="activity-btn" data-view="files"></button>
        <button id="act-changes" class="activity-btn" data-view="changes"><span id="changes-badge" class="activity-badge" hidden></span></button>
        <button id="act-search" class="activity-btn" data-view="search"></button>
        <button id="act-remote" class="activity-btn"></button>
        <button id="act-settings" class="activity-btn"></button>
      </nav>
      <nav id="sidebar">
        <section id="sidebar-files" class="sidebar-view">
          <div id="sidebar-header" class="sidebar-head">
            <h2 id="sidebar-title"></h2>
            <button id="btn-search-toggle"></button>
            <button id="btn-toggle-hidden"></button>
            <button id="btn-collapse-all"></button>
          </div>
          <div id="sidebar-filter" class="sidebar-field hidden"><input id="sidebar-search-input" /></div>
          <div id="file-tree"></div>
        </section>
        <section id="sidebar-changes" class="sidebar-view" hidden>
          <button id="btn-changes-refresh"></button>
          <div id="changes-panel"><div id="changes-list"></div></div>
        </section>
        <section id="sidebar-search" class="sidebar-view" hidden>
          <input id="search-input" />
          <div id="search-status"></div>
          <div id="search-results"></div>
        </section>
      </nav>
      <div id="sidebar-resize-handle" class="resize-divider resize-divider--col"></div>
      <div id="center-column">
      <div id="workspace">
        <div id="welcome" class="hidden">
          <div id="welcome-inner">
            <div id="welcome-actions">
              <button data-welcome="open-folder"></button>
              <button data-welcome="open-file"></button>
              <button data-welcome="new-file"></button>
            </div>
            <div id="welcome-recent" class="hidden"><div id="welcome-recent-list"></div></div>
          </div>
          <div id="welcome-workspace" hidden>
            <h1 id="welcome-workspace-title"></h1>
            <p><kbd id="welcome-workspace-key"></kbd></p>
            <button data-welcome="quick-open"></button>
            <button data-welcome="new-file"></button>
          </div>
        </div>
        <div id="editor-area">
          <div id="editor-container">
            <div id="md-toolbar" class="md-toolbar hidden"></div>
          </div>
          <div id="resize-handle" class="resize-divider resize-divider--col"></div>
          <div id="preview-container">
            <div id="preview-pane" class="preview-pane"></div>
          </div>
        </div>
        <div id="diff-view" class="hidden" tabindex="-1">
          <div id="diff-header">
            <div id="diff-path"><b id="diff-title"></b><span id="diff-meta"></span></div>
            <div id="diff-mode-toggle"><button id="diff-mode-reading"></button><button id="diff-mode-full"></button></div>
            <button id="diff-prev" hidden></button>
            <button id="diff-next" hidden></button>
            <button id="diff-review" hidden><span class="diff-review-label"></span></button>
          </div>
          <div id="diff-body"></div>
        </div>
      </div>
        <div id="terminal-resize-handle" class="resize-divider resize-divider--row hidden"></div>
        <div id="terminal-panel" class="hidden">
          <div id="terminal-host"></div>
        </div>
      </div>
    </div>
    <div id="status-bar">
      <span id="status-path">No file open</span>
      <i id="status-modified" class="status-dirty"></i>
      <span id="status-branch" class="status-item hidden"><span class="status-branch-name"></span></span>
      <button id="status-remote" class="status-item hidden"><span class="status-remote-label"></span></button>
      <button id="status-agent" class="status-item hidden"><i class="status-agent-dot"></i><span class="status-agent-label"></span></button>
      <span class="status-spacer"></span>
      <span id="status-update" class="status-update hidden"></span>
      <span id="status-words">0 words</span>
      <span id="status-chars">0 chars</span>
      <span id="status-lines">0 lines</span>
      <button id="status-cursor">Ln 1, Col 1</button>
      <button id="status-wrap">Wrap: On</button>
    </div>
  </div>`;

/** Apps started by the current test; torn down in afterEach so a debounced
 *  config save from one test can't land in the next test's savedConfigs. */
const liveApps: App[] = [];

async function startApp(): Promise<App> {
  document.body.innerHTML = APP_SHELL;
  const app = new App();
  liveApps.push(app);
  await app.init();
  return app;
}

/** Let queued microtasks (event handlers, promise chains) drain. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Wait out the app's 250 ms watcher coalescing debounce plus the reads. */
const watcherSettle = async () => {
  await new Promise((r) => setTimeout(r, 300));
  await flush();
  await flush();
};

/** Wait for the startup git status (and the branch query it triggers). */
const gitSettle = async () => {
  await new Promise((r) => setTimeout(r, 450));
  await flush();
  await flush();
};

/** The live CodeMirror view. */
const editorView = async () => {
  const { EditorView } = await import('@codemirror/view');
  return EditorView.findFromDOM(document.querySelector('.cm-content') as HTMLElement)!;
};

const tabTitles = () =>
  Array.from(document.querySelectorAll('.tab .tab-title')).map((el) => el.textContent);

const activeTitle = () => document.querySelector('.tab.active .tab-title')?.textContent;

/** Modified dot of the ACTIVE tab (startup always adds an Untitled tab first). */
const activeTabDot = () =>
  document.querySelector('.tab.active .tab-modified-dot') as HTMLElement;

describe('App integration', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    resetTauriMocks();
    // api.watchStart pins its root module-wide; start each App unpinned.
    await api.watchStop();
    invokeCalls.length = 0;
  });

  afterEach(() => {
    for (const app of liveApps.splice(0)) app.destroy();
    document.body.innerHTML = '';
  });

  describe('startup', () => {
    it('shows the welcome screen when there is nothing to restore', async () => {
      await startApp();
      expect(tabTitles()).toEqual([]); // no auto-opened Untitled buffer
      expect(document.getElementById('welcome')?.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('editor-area')?.classList.contains('hidden')).toBe(true);
    });

    it('opening a folder with no file shows the file prompt, not an empty editor', async () => {
      vfs.set('/projects/site/a.md', '# A');
      const app = await startApp();
      await app.openFolder('/projects/site');
      await flush();

      const welcome = document.getElementById('welcome')!;
      expect(welcome.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('editor-area')?.classList.contains('hidden')).toBe(true);
      expect(document.getElementById('welcome-inner')?.hidden).toBe(true);
      expect(document.getElementById('welcome-workspace')?.hidden).toBe(false);
      expect(document.getElementById('welcome-workspace-title')?.textContent).toBe('site');

      // Opening a file replaces the prompt with the editor.
      await app.openFile('/projects/site/a.md');
      await flush();
      expect(welcome.classList.contains('hidden')).toBe(true);
      expect(document.getElementById('editor-area')?.classList.contains('hidden')).toBe(false);
    });

    it('closing the last tab in a folder returns to the file prompt', async () => {
      vfs.set('/projects/site/a.md', '# A');
      const app = await startApp();
      await app.openFolder('/projects/site');
      await app.openFile('/projects/site/a.md');
      await flush();
      (document.querySelector('.tab.active .tab-close') as HTMLElement | null)?.click();
      await flush();
      expect(tabTitles()).toEqual([]);
      expect(document.getElementById('welcome')?.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('welcome-workspace')?.hidden).toBe(false);
    });

    it('the file prompt\'s Find a File button opens quick open', async () => {
      const app = await startApp();
      await app.openFolder('/projects/site');
      await flush();
      (document.querySelector('[data-welcome="quick-open"]') as HTMLElement).click();
      await flush();
      expect(document.querySelector('.palette, #palette, [role="dialog"]')).not.toBeNull();
    });

    it('restores last_open_files from config, in order', async () => {
      vfs.set('/notes/a.md', '# A');
      vfs.set('/notes/b.md', '# B');
      setConfigOnDisk({
        theme: 'system',
        last_open_files: ['/notes/a.md', '/notes/b.md'],
        sidebar_width: 220,
        sidebar_visible: true,
        preview_visible: true,
        word_wrap: true,
        show_hidden_files: false,
        enable_diagrams: true,
      });

      await startApp();
      expect(tabTitles()).toEqual(['a.md', 'b.md']);
    });

    it('prefers pending "Open With" files over session restore', async () => {
      vfs.set('/notes/restored.md', 'old session');
      vfs.set('/inbox/dropped.md', 'from Finder');
      setConfigOnDisk({
        theme: 'system',
        last_open_files: ['/notes/restored.md'],
        sidebar_width: 220,
        sidebar_visible: true,
        preview_visible: true,
        word_wrap: true,
        show_hidden_files: false,
        enable_diagrams: true,
      });
      setPendingFiles(['/inbox/dropped.md']);

      await startApp();
      expect(tabTitles()).toEqual(['dropped.md']);
    });

    it('opens a pending CLI directory as the sidebar root', async () => {
      directories.add('/projects/notes');
      setPendingFiles(['/projects/notes']);

      await startApp();
      // The folder routes to the sidebar. No file is open, so the empty state
      // is the file prompt (not an empty editor, and no Untitled tab yet).
      expect(tabTitles()).toEqual([]);
      expect(document.getElementById('sidebar')?.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('welcome')?.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('welcome-workspace')?.hidden).toBe(false);
      expect(document.getElementById('editor-area')?.classList.contains('hidden')).toBe(true);
      expect(
        invokeCalls.some((c) => c.cmd === 'is_directory' && c.args?.path === '/projects/notes'),
      ).toBe(true);
      expect(
        invokeCalls.some((c) => c.cmd === 'list_directory' && c.args?.path === '/projects/notes'),
      ).toBe(true);
    });

    it('the file prompt\'s New File button creates Untitled', async () => {
      directories.add('/projects/notes');
      setPendingFiles(['/projects/notes']);

      await startApp();
      expect(tabTitles()).toEqual([]);

      (document.querySelector('#welcome-workspace [data-welcome="new-file"]') as HTMLElement).click();
      await flush();
      expect(tabTitles()).toEqual(['Untitled']);
      expect(document.getElementById('welcome')?.classList.contains('hidden')).toBe(true);
    });

    it('session restore still uses openFilesInOrder, not folder routing', async () => {
      vfs.set('/notes/a.md', '# A');
      directories.add('/notes');
      setConfigOnDisk({
        theme: 'system',
        last_open_files: ['/notes/a.md'],
        sidebar_width: 220,
        sidebar_visible: true,
        preview_visible: true,
        word_wrap: true,
        show_hidden_files: false,
        enable_diagrams: true,
      });

      await startApp();
      expect(tabTitles()).toEqual(['a.md']);
      // CLI/drop routing probes is_directory on the given paths. Session
      // restore is files-only and must not treat last_open_files as mixed
      // file/folder paths.
      expect(
        invokeCalls.some((c) => c.cmd === 'is_directory' && c.args?.path === '/notes/a.md'),
      ).toBe(false);
    });

    it('skips files that no longer exist instead of failing startup', async () => {
      vfs.set('/notes/kept.md', 'still here');
      setConfigOnDisk({
        theme: 'system',
        last_open_files: ['/notes/deleted.md', '/notes/kept.md'],
        sidebar_width: 220,
        sidebar_visible: true,
        preview_visible: true,
        word_wrap: true,
        show_hidden_files: false,
        enable_diagrams: true,
      });

      await startApp();
      expect(tabTitles()).toEqual(['kept.md']);
    });

    it('falls back to defaults when load_config itself fails', async () => {
      // Simulate a corrupted config: load_config throws.
      const { coreMock } = await import('./helpers/tauri-mocks');
      const original = coreMock.invoke;
      coreMock.invoke = async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'load_config') throw 'Config error: corrupted';
        return original(cmd, args);
      };
      try {
        await startApp();
        // Corrupted config → defaults → nothing to restore → welcome screen.
        expect(tabTitles()).toEqual([]);
        expect(document.getElementById('welcome')?.classList.contains('hidden')).toBe(false);
      } finally {
        coreMock.invoke = original;
      }
    });
  });

  describe('open / edit / save round-trip', () => {
    it('closes a pristine Untitled tab when opening a real file', async () => {
      vfs.set('/docs/readme.md', '# Readme');
      await startApp();
      emitTauriEvent(MENU.NEW_FILE);
      await flush();
      expect(tabTitles()).toEqual(['Untitled']);

      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/readme.md' });
      await flush();
      expect(tabTitles()).toEqual(['readme.md']);
    });

    it('opens a file via the open-file-path event (macOS Open With)', async () => {
      vfs.set('/docs/readme.md', '# Hello');
      await startApp();

      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/readme.md' });
      await flush();

      expect(tabTitles()).toContain('readme.md');
    });

    it('preview toggle is a no-op for a file with no preview (no stale pane)', async () => {
      // Regression: after viewing a markdown file, toggling preview on a
      // JSON tab revealed the previous document's stale preview DOM.
      vfs.set('/docs/doc.md', '# Hello');
      vfs.set('/docs/data.json', '{"a":1}');
      await startApp();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/doc.md' });
      await flush();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/data.json' });
      await flush();

      const previewContainer = document.getElementById('preview-container')!;
      expect(previewContainer.classList.contains('hidden')).toBe(true);
      // Split and Preview are disabled for a file with no preview.
      expect(pressedView()).toBe('edit');
      expect(viewDisabled('split')).toBe(true);
      expect(viewDisabled('preview')).toBe(true);

      emitTauriEvent(MENU.VIEW_PREVIEW);
      viewBtn('split').click();
      await flush();
      // Still hidden: the view must not reveal the old document's DOM.
      expect(previewContainer.classList.contains('hidden')).toBe(true);
      expect(pressedView()).toBe('edit');
    });

    it('saves editor content to the backend and clears the modified dot', async () => {
      vfs.set('/docs/doc.md', 'original');
      await startApp();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/doc.md' });
      await flush();

      // Type into the real CodeMirror instance by driving the view directly.
      const cmContent = document.querySelector('.cm-content') as HTMLElement;
      expect(cmContent).toBeTruthy();
      const { EditorView } = await import('@codemirror/view');
      const view = EditorView.findFromDOM(cmContent);
      expect(view).toBeTruthy();
      view!.dispatch({
        changes: { from: 0, to: view!.state.doc.length, insert: 'edited content' },
      });
      await flush();

      // The edit marks the (active) tab modified.
      expect(activeTabDot().style.display).not.toBe('none');

      emitTauriEvent(MENU.SAVE);
      await flush();

      expect(vfs.get('/docs/doc.md')).toBe('edited content');
      expect(activeTabDot().style.display).toBe('none');
    });

    it('clears the modified dot when the edit is undone back to saved content', async () => {
      vfs.set('/docs/doc.md', 'original');
      await startApp();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/doc.md' });
      await flush();

      const { EditorView } = await import('@codemirror/view');
      const view = EditorView.findFromDOM(
        document.querySelector('.cm-content') as HTMLElement,
      )!;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'changed' } });
      await flush();
      expect(activeTabDot().style.display).not.toBe('none');

      // Undo back to the on-disk content — the tab must read clean again.
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'original' } });
      await flush();
      expect(activeTabDot().style.display).toBe('none');
    });

    it('routes an untitled save through Save As with the dialog-chosen path', async () => {
      await startApp();
      emitTauriEvent(MENU.NEW_FILE); // create an Untitled buffer
      await flush();
      const { EditorView } = await import('@codemirror/view');
      const view = EditorView.findFromDOM(
        document.querySelector('.cm-content') as HTMLElement,
      )!;
      view.dispatch({ changes: { from: 0, insert: 'brand new' } });
      await flush();

      dialogResponses.save.push('/docs/new-note.md');
      emitTauriEvent(MENU.SAVE);
      await flush();

      expect(vfs.get('/docs/new-note.md')).toBe('brand new');
      expect(tabTitles()).toEqual(['new-note.md']);
    });

    it('keeps the tab modified when the user cancels Save As', async () => {
      await startApp();
      emitTauriEvent(MENU.NEW_FILE);
      await flush();
      const { EditorView } = await import('@codemirror/view');
      const view = EditorView.findFromDOM(
        document.querySelector('.cm-content') as HTMLElement,
      )!;
      view.dispatch({ changes: { from: 0, insert: 'unsaved' } });
      await flush();

      dialogResponses.save.push(null); // user hits Cancel
      emitTauriEvent(MENU.SAVE);
      await flush();

      expect(vfs.size).toBe(0);
      expect(activeTabDot().style.display).not.toBe('none');
    });
  });

  describe('unsaved-changes guard on quit', () => {
    async function startWithModifiedDoc(): Promise<void> {
      vfs.set('/docs/doc.md', 'original');
      await startApp();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/doc.md' });
      await flush();
      const { EditorView } = await import('@codemirror/view');
      const view = EditorView.findFromDOM(
        document.querySelector('.cm-content') as HTMLElement,
      )!;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: 'modified!' },
      });
      await flush();
    }

    it('Save then quit: writes the file and exits', async () => {
      await startWithModifiedDoc();

      dialogResponses.message.push('Yes'); // "Save"
      emitTauriEvent('exit-requested');
      await flush();

      expect(vfs.get('/docs/doc.md')).toBe('modified!');
      expect(quitCalls.count).toBe(1);
    });

    it("Don't Save: quits without writing", async () => {
      await startWithModifiedDoc();

      dialogResponses.message.push('No'); // "Don't Save"
      emitTauriEvent('exit-requested');
      await flush();

      expect(vfs.get('/docs/doc.md')).toBe('original');
      expect(quitCalls.count).toBe(1);
    });

    it('Cancel: aborts the quit and keeps the modified buffer', async () => {
      await startWithModifiedDoc();

      dialogResponses.message.push('Cancel');
      emitTauriEvent('exit-requested');
      await flush();

      expect(vfs.get('/docs/doc.md')).toBe('original');
      expect(quitCalls.count).toBe(0);
      // Both the startup Untitled tab and the modified doc survive the abort.
      expect(tabTitles()).toContain('doc.md');
    });

    it('quits cleanly with no prompt when nothing is modified', async () => {
      vfs.set('/docs/doc.md', 'original');
      await startApp();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/doc.md' });
      await flush();

      emitTauriEvent('exit-requested');
      await flush();

      expect(quitCalls.count).toBe(1);
    });
  });

  describe('Ctrl+Q (Windows/Linux shortcut)', () => {
    // Earlier tests' App instances keep their document-level keydown
    // listeners (and dirty tabs), so a real document dispatch would reach
    // them too. Capture only this app's listeners and call them directly.
    let keydownListeners: EventListener[] = [];
    async function startDirty(): Promise<void> {
      vfs.set('/docs/doc.md', 'original');
      const spy = vi.spyOn(document, 'addEventListener');
      await startApp();
      keydownListeners = spy.mock.calls
        .filter(([type]) => type === 'keydown')
        .map(([, fn]) => fn as EventListener);
      spy.mockRestore();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/doc.md' });
      await flush();
      const view = await editorView();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'dirty' } });
      await flush();
    }
    const pressCtrlQ = () => {
      const e = new KeyboardEvent('keydown', { key: 'q', ctrlKey: true, cancelable: true });
      for (const fn of keydownListeners) fn(e);
    };

    it('prompts for unsaved changes and Cancel aborts the quit', async () => {
      await startDirty();
      dialogResponses.message.push('Cancel');
      pressCtrlQ();
      await flush();
      expect(messageCalls.map((m) => m.title)).toEqual(['Unsaved Changes']);
      expect(quitCalls.count).toBe(0);
      expect(tabTitles()).toContain('doc.md');
    });

    it('quits after Save', async () => {
      await startDirty();
      dialogResponses.message.push('Yes');
      pressCtrlQ();
      await flush();
      await flush();
      expect(vfs.get('/docs/doc.md')).toBe('dirty');
      expect(quitCalls.count).toBe(1);
    });
  });

  describe('files changed on disk (agent writes)', () => {
    const fsChange = async (path: string, kind = 'modify') => {
      emitTauriEvent('watcher://changes', [{ path, kind }]);
      await watcherSettle();
    };
    const tabEl = (title: string) =>
      Array.from(document.querySelectorAll<HTMLElement>('.tab')).find(
        (el) => el.querySelector('.tab-title')?.textContent === title,
      )!;
    const clickTab = async (title: string) => {
      tabEl(title).querySelector<HTMLElement>('.tab-title')!.click();
      await flush();
    };
    async function openTwo(): Promise<void> {
      vfs.set('/docs/a.md', 'A original');
      vfs.set('/docs/b.md', 'B original');
      await startApp();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/a.md' });
      await flush();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/b.md' });
      await flush();
    }

    it('refreshes a clean background tab so switching shows the disk text', async () => {
      await openTwo();
      await clickTab('a.md'); // b.md now in the background, editor state cached
      vfs.set('/docs/b.md', 'B from agent');
      await fsChange('/docs/b.md');

      await clickTab('b.md');
      expect((await editorView()).state.doc.toString()).toBe('B from agent');
      expect(activeTabDot().style.display).toBe('none');

      // Typing and saving now keeps the agent's text as the base; no prompt.
      const view = await editorView();
      view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } });
      await flush();
      emitTauriEvent(MENU.SAVE);
      await flush();
      await flush();
      expect(messageCalls).toEqual([]);
      expect(vfs.get('/docs/b.md')).toBe('B from agent!');
    });

    it('refreshes background tabs on a remote (root-only) change event', async () => {
      await openTwo();
      await clickTab('a.md');
      vfs.set('/docs/b.md', 'B remote edit');
      await fsChange('/docs'); // remote poller reports the workspace root
      await clickTab('b.md');
      expect((await editorView()).state.doc.toString()).toBe('B remote edit');
    });

    it('reloads the clean active tab from disk', async () => {
      await openTwo();
      vfs.set('/docs/b.md', 'B live');
      await fsChange('/docs/b.md');
      expect((await editorView()).state.doc.toString()).toBe('B live');
    });

    it('flags a dirty tab as conflicted and asks before overwriting on save', async () => {
      await openTwo();
      const view = await editorView();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'user text' } });
      await flush();
      vfs.set('/docs/b.md', 'agent text');
      await fsChange('/docs/b.md');

      // The user's text is kept, the tab shows the conflict.
      expect(view.state.doc.toString()).toBe('user text');
      expect(tabEl('b.md').classList.contains('tab-conflict')).toBe(true);

      // Cancel: nothing is written.
      dialogResponses.message.push('Cancel');
      emitTauriEvent(MENU.SAVE);
      await flush();
      await flush();
      expect(messageCalls.map((m) => m.title)).toEqual(['File Changed on Disk']);
      expect(vfs.get('/docs/b.md')).toBe('agent text');

      // Overwrite: our text wins, conflict cleared.
      dialogResponses.message.push('Yes');
      emitTauriEvent(MENU.SAVE);
      await flush();
      await flush();
      expect(vfs.get('/docs/b.md')).toBe('user text');
      expect(tabEl('b.md').classList.contains('tab-conflict')).toBe(false);
      expect(activeTabDot().style.display).toBe('none');
    });

    it('Reload in the conflict prompt takes the disk text', async () => {
      await openTwo();
      await clickTab('a.md');
      await clickTab('b.md');
      let view = await editorView();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'mine' } });
      await flush();
      await clickTab('a.md'); // dirty b.md goes to the background
      vfs.set('/docs/b.md', 'theirs');
      await fsChange('/docs/b.md');
      expect(tabEl('b.md').classList.contains('tab-conflict')).toBe(true);

      await clickTab('b.md');
      view = await editorView();
      expect(view.state.doc.toString()).toBe('mine'); // not clobbered
      dialogResponses.message.push('No'); // "Reload"
      emitTauriEvent(MENU.SAVE);
      await flush();
      await flush();
      expect(vfs.get('/docs/b.md')).toBe('theirs');
      expect(view.state.doc.toString()).toBe('theirs');
      expect(activeTabDot().style.display).toBe('none');
    });

    it('detects a disk change at save time even without a watcher event', async () => {
      await openTwo();
      const view = await editorView();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'mine' } });
      await flush();
      vfs.set('/docs/b.md', 'changed quietly');
      dialogResponses.message.push('Cancel');
      emitTauriEvent(MENU.SAVE);
      await flush();
      await flush();
      expect(messageCalls.map((m) => m.title)).toEqual(['File Changed on Disk']);
      expect(vfs.get('/docs/b.md')).toBe('changed quietly');
    });

    it('does not flag our own save as a conflict', async () => {
      await openTwo();
      const view = await editorView();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'saved once' } });
      await flush();
      emitTauriEvent(MENU.SAVE);
      await flush();
      await flush();
      // The watcher echoes our own write.
      await fsChange('/docs/b.md');
      expect(tabEl('b.md').classList.contains('tab-conflict')).toBe(false);

      view.dispatch({ changes: { from: view.state.doc.length, insert: ' and twice' } });
      await flush();
      await fsChange('/docs/b.md'); // echo arrives while dirty: still ours
      expect(tabEl('b.md').classList.contains('tab-conflict')).toBe(false);
      emitTauriEvent(MENU.SAVE);
      await flush();
      await flush();
      expect(messageCalls).toEqual([]);
      expect(vfs.get('/docs/b.md')).toBe('saved once and twice');
    });
  });

  describe('config persistence', () => {
    it('persists open files and preferences on quit', async () => {
      vfs.set('/docs/doc.md', 'content');
      await startApp();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/doc.md' });
      await flush();

      emitTauriEvent('exit-requested');
      await flush();

      expect(savedConfigs.length).toBeGreaterThan(0);
      const last = savedConfigs[savedConfigs.length - 1] as Record<string, unknown>;
      expect(last.last_open_files).toEqual(['/docs/doc.md']);
      expect(last.theme).toBe('system');
      expect(last.word_wrap).toBe(true);
    });

    it('theme toggle changes the document theme and schedules a config save', async () => {
      vi.useFakeTimers();
      try {
        await startApp();
        const before = document.documentElement.dataset.theme;
        // No theme button in the title bar any more: View → Toggle Theme.
        expect(document.getElementById('btn-theme')).toBeNull();

        emitTauriEvent(MENU.TOGGLE_THEME);
        expect(document.documentElement.dataset.theme).not.toBe(before);

        // Config save is debounced (CONFIG_SAVE_MS = 2000).
        await vi.advanceTimersByTimeAsync(2500);
        const last = savedConfigs[savedConfigs.length - 1] as Record<string, unknown>;
        expect(last.theme).toBe(document.documentElement.dataset.theme);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('tab origin across remote connect / disconnect', () => {
    const REMOTE_ROOT = 'ssh://dev/home/u/proj';

    async function startWithRemote(): Promise<App> {
      const app = await startApp();
      installRemoteSessions(app);
      await flush();
      return app;
    }

    async function editActive(text: string): Promise<void> {
      const { EditorView } = await import('@codemirror/view');
      const view = EditorView.findFromDOM(
        document.querySelector('.cm-content') as HTMLElement,
      )!;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      await flush();
    }

    async function openPath(path: string): Promise<void> {
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path });
      await flush();
    }

    const connects = () => invokeCalls.filter((c) => c.cmd === 'remote_connect').length;

    it('connect closes clean local tabs; remote files then open from the host', async () => {
      vfs.set('/docs/local.md', 'local');
      remoteVfs.set('/home/u/proj/r.md', 'remote');
      const app = await startWithRemote();
      await openPath('/docs/local.md');
      expect(tabTitles()).toContain('local.md');

      await app.openFolder(REMOTE_ROOT);
      await flush();
      expect(remote.session?.host).toBe('dev');
      expect(tabTitles()).not.toContain('local.md');

      await openPath('/home/u/proj/r.md');
      expect(tabTitles()).toEqual(['r.md']);
    });

    it('connect with a dirty local tab: Cancel aborts the connect and keeps the edit', async () => {
      vfs.set('/docs/local.md', 'local');
      const app = await startWithRemote();
      await openPath('/docs/local.md');
      await editActive('local edit');

      dialogResponses.message.push('Cancel');
      await app.openFolder(REMOTE_ROOT);
      await flush();

      expect(connects()).toBe(0);
      expect(remote.session).toBeNull();
      expect(tabTitles()).toContain('local.md');
      expect(activeTabDot().style.display).not.toBe('none');
      // No error dialog for a user cancel.
      expect(messageLog.some((m) => m.includes('Could not open remote folder'))).toBe(false);
    });

    it('connect with a dirty local tab: Save writes locally, then connects and closes it', async () => {
      vfs.set('/docs/local.md', 'local');
      const app = await startWithRemote();
      await openPath('/docs/local.md');
      await editActive('local edit');

      dialogResponses.message.push('Yes');
      await app.openFolder(REMOTE_ROOT);
      await flush();

      expect(vfs.get('/docs/local.md')).toBe('local edit');
      expect(remoteVfs.has('/docs/local.md')).toBe(false);
      expect(remote.session?.host).toBe('dev');
      expect(tabTitles()).not.toContain('local.md');
    });

    it("connect with a dirty local tab: Don't Save closes it without writing", async () => {
      vfs.set('/docs/local.md', 'local');
      const app = await startWithRemote();
      await openPath('/docs/local.md');
      await editActive('local edit');

      dialogResponses.message.push('No');
      await app.openFolder(REMOTE_ROOT);
      await flush();

      expect(vfs.get('/docs/local.md')).toBe('local');
      expect(remoteVfs.size).toBe(0);
      expect(tabTitles()).not.toContain('local.md');
    });

    it('disconnect (open a local folder) closes remote tabs; dirty ones prompt first', async () => {
      remoteVfs.set('/home/u/proj/r.md', 'remote');
      vfs.set('/home/u/proj/r.md', 'LOCAL TWIN');
      const app = await startWithRemote();
      await app.openFolder(REMOTE_ROOT);
      await openPath('/home/u/proj/r.md');
      await editActive('remote edit');

      dialogResponses.message.push('Yes');
      await app.openFolder('/local/code');
      await flush();

      // Saved over SSH before the disconnect; the local twin is untouched.
      expect(remoteVfs.get('/home/u/proj/r.md')).toBe('remote edit');
      expect(vfs.get('/home/u/proj/r.md')).toBe('LOCAL TWIN');
      expect(remote.session).toBeNull();
      expect(tabTitles()).not.toContain('r.md');
    });

    it('the status host chip menu disconnects and closes clean remote tabs', async () => {
      remoteVfs.set('/home/u/proj/r.md', 'remote');
      const app = await startWithRemote();
      await app.openFolder(REMOTE_ROOT);
      await openPath('/home/u/proj/r.md');
      // The remote tab names its host.
      expect(document.querySelector('.tab.active .tab-host')?.textContent).toBe('dev');
      expect(document.getElementById('status-remote')!.classList.contains('hidden')).toBe(false);

      pickChipMenu('Disconnect');
      await flush();

      expect(remote.session).toBeNull();
      expect(tabTitles()).not.toContain('r.md');
    });

    it('saving a remote file refreshes Changes without waiting for the watcher (#28)', async () => {
      remoteVfs.set('/home/u/proj/r.md', 'remote');
      const app = await startWithRemote();
      await app.openFolder(REMOTE_ROOT);
      await openPath('/home/u/proj/r.md');
      await editActive('remote edit');
      // Let the open/connect refreshes settle first.
      await new Promise((r) => setTimeout(r, 800));
      const statusCalls = () => invokeCalls.filter((c) => c.cmd === 'git_status').length;
      const before = statusCalls();

      expect(await app.save()).toBe(true);
      expect(remoteVfs.get('/home/u/proj/r.md')).toBe('remote edit');
      // No watcher event is emitted in this test: only the save can refresh.
      await new Promise((r) => setTimeout(r, 800));
      expect(statusCalls()).toBeGreaterThan(before);
    });

    it('save refuses to write a tab whose origin is not the active session', async () => {
      vfs.set('/docs/local.md', 'local');
      const app = await startWithRemote();
      await openPath('/docs/local.md');
      await editActive('local edit');
      // Simulate a mismatch that slipped past the switch (e.g. edited mid-connect).
      remote.session = { host: 'dev', path: '/home/u', home: '/home/u' };
      (app as unknown as { tabs: { setOrigin(o: string | null): void } }).tabs.setOrigin('dev');

      expect(await app.save()).toBe(false);
      expect(invokeCalls.some((c) => c.cmd === 'write_file')).toBe(false);
      expect(remoteVfs.size).toBe(0);
      expect(vfs.get('/docs/local.md')).toBe('local');
      expect(messageLog.some((m) => m.includes('not the active session'))).toBe(true);
    });

    it('does not persist remote tab paths into last_open_files', async () => {
      vfs.set('/docs/local.md', 'local');
      remoteVfs.set('/home/u/proj/r.md', 'remote');
      const app = await startWithRemote();
      await app.openFolder(REMOTE_ROOT);
      await openPath('/home/u/proj/r.md');

      emitTauriEvent('exit-requested');
      await flush();

      // Assert the invariant over every write: a debounced save from an
      // earlier test's App can land after the reset, so "the last config"
      // is timing-dependent under CI load.
      expect(savedConfigs.length).toBeGreaterThan(0);
      for (const c of savedConfigs as Array<{ last_open_files: string[] }>) {
        expect(c.last_open_files).not.toContain('/home/u/proj/r.md');
      }
    });

    it('openFolder goes through the registered RemoteHandler, which opens the resolved path', async () => {
      const app = await startApp();
      const routed: string[] = [];
      app.setRemoteHandler({
        openFolder: async (dir, openResolved) => {
          routed.push(dir);
          await openResolved('/routed/by-handler');
        },
        attach: () => {},
      });
      await app.openFolder(REMOTE_ROOT);
      await flush();

      expect(routed).toEqual([REMOTE_ROOT]);
      const tree = (app as unknown as { fileTree: { getRoot(): string | null } }).fileTree;
      expect(tree.getRoot()).toBe('/routed/by-handler');
      // The handler owned the request: no SSH connect happened behind it.
      expect(connects()).toBe(0);
    });

    it('the Open Remote action reaches the registered handler dialog', async () => {
      // The title bar button is gone; File → Open Remote Folder (also
      // Ctrl+Shift+O) and the welcome screen reach the same dialog.
      const openRemoteShortcut = () => emitTauriEvent(MENU.OPEN_REMOTE);
      await startApp(); // no handler: the action is a no-op
      expect(document.getElementById('btn-open-remote')).toBeNull();
      openRemoteShortcut();
      await flush();
      expect(document.querySelector('.remote-dialog')).toBeNull();

      await startWithRemote();
      openRemoteShortcut();
      await flush();
      expect(document.querySelector('.remote-dialog')).not.toBeNull();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(document.querySelector('.remote-dialog')).toBeNull();
    });

    it('installRemoteSessions before init(): UI attaches after init, ssh:// opens connect', async () => {
      document.body.innerHTML = APP_SHELL;
      const app = new App();
      installRemoteSessions(app);
      // Nothing touches the half-built app: the UI waits for init().
      expect(document.getElementById('welcome-open-remote')).toBeNull();

      await app.init();
      await flush();
      expect(document.getElementById('welcome-open-remote')).not.toBeNull();
      expect(document.getElementById('status-remote')).not.toBeNull();

      await app.openFolder(REMOTE_ROOT);
      await flush();
      expect(remote.session?.host).toBe('dev');
      expect(connects()).toBe(1);
    });

    describe('origin switch resets per-machine state', () => {
      type Internals = {
        tabs: {
          getAllTabs(): Array<{
            id: string;
            path: string | null;
            origin: string | null;
            content: string;
            modified: boolean;
            diskConflict?: boolean;
          }>;
          setOrigin(o: string | null): void;
        };
        fileTree: { getRoot(): string | null };
        ctx: { workspaceRoot: string | null; baseDir: string | null };
        config: { agent_context_enabled?: boolean };
        agent: { arm(): void; publish(): Promise<void> };
      };
      const internals = (app: App) => app as unknown as Internals;
      const watchStarts = (root: string) =>
        invokeCalls.filter((c) => c.cmd === 'watch_start' && c.args?.root === root).length;
      const disconnectViaChip = async () => {
        pickChipMenu('Disconnect');
        await flush();
        await flush();
      };

      it('reconnecting the same remote folder restarts the watcher', async () => {
        remoteVfs.set('/home/u/proj/r.md', 'remote');
        remoteVfs.set('/home/u/proj/sub/s.md', 's');
        const app = await startWithRemote();
        await app.openFolder(REMOTE_ROOT);
        await flush();
        expect(watchStarts('/home/u/proj')).toBe(1);

        await disconnectViaChip();
        await app.openFolder(REMOTE_ROOT);
        await flush();
        // The backend stopped watching on disconnect; the pin must not skip it.
        expect(watchStarts('/home/u/proj')).toBe(2);

        // Reconnect at a subfolder of the old root also restarts.
        await app.openFolder('ssh://dev/home/u/proj/sub');
        await flush();
        expect(watchStarts('/home/u/proj/sub')).toBe(1);
      });

      it('switching hosts at the same path restarts the watcher', async () => {
        remoteVfs.set('/home/u/proj/r.md', 'remote');
        const app = await startWithRemote();
        await app.openFolder(REMOTE_ROOT);
        await flush();
        await app.openFolder('ssh://box/home/u/proj');
        await flush();
        expect(remote.session?.host).toBe('box');
        expect(watchStarts('/home/u/proj')).toBe(2);
      });

      it('disconnect resets the tree, workspace and base dir and shows welcome', async () => {
        remoteVfs.set('/home/u/proj/r.md', 'remote');
        const app = await startWithRemote();
        await app.openFolder(REMOTE_ROOT);
        await openPath('/home/u/proj/r.md');
        expect(internals(app).fileTree.getRoot()).toBe('/home/u/proj');

        await disconnectViaChip();

        expect(remote.session).toBeNull();
        expect(internals(app).fileTree.getRoot()).toBeNull();
        expect(internals(app).ctx.workspaceRoot).toBeNull();
        expect(internals(app).ctx.baseDir).toBeNull();
        expect(document.querySelector('#file-tree .tree-item')).toBeNull();
        expect(document.getElementById('welcome')!.classList.contains('hidden')).toBe(false);
      });

      it('connect-then-quit clears local agent shadows before the connect, not on the host', async () => {
        vfs.set('/docs/local.md', 'local');
        const app = await startWithRemote();
        await app.openFolder('/docs');
        await openPath('/docs/local.md');
        await editActive('unsaved local text');
        internals(app).config.agent_context_enabled = true;
        internals(app).agent.arm();
        await internals(app).agent.publish();
        expect(
          invokeCalls.some((c) => c.cmd === 'agent_context_update' && c.args?.root === '/docs'),
        ).toBe(true);

        dialogResponses.message.push('No'); // Don't Save the local tab
        await app.openFolder(REMOTE_ROOT);
        await flush();
        expect(remote.session?.host).toBe('dev');

        const clearIdx = invokeCalls.findIndex(
          (c) => c.cmd === 'agent_context_clear' && c.args?.root === '/docs',
        );
        const connectIdx = invokeCalls.findIndex((c) => c.cmd === 'remote_connect');
        expect(clearIdx).toBeGreaterThanOrEqual(0);
        expect(clearIdx).toBeLessThan(connectIdx); // while routing was still local

        emitTauriEvent('exit-requested');
        await flush();
        await flush();
        // Quit (remote routing) must not send an rm for the local root.
        const localClears = invokeCalls.filter(
          (c) => c.cmd === 'agent_context_clear' && c.args?.root === '/docs',
        );
        expect(localClears).toHaveLength(1);
      });

      describe('same-path tabs from two machines stay separate', () => {
        // A dirty local tab kept across a switch (it became dirty after the
        // prompt), then the same path opened on the host.
        async function setupTwins(): Promise<App> {
          vfs.set('/home/u/proj/r.md', 'LOCAL');
          remoteVfs.set('/home/u/proj/r.md', 'REMOTE');
          const app = await startWithRemote();
          await openPath('/home/u/proj/r.md');
          await editActive('local dirty');
          remote.session = { host: 'dev', path: '/home/u/proj', home: '/home/u' };
          internals(app).tabs.setOrigin('dev');
          await openPath('/home/u/proj/r.md');
          return app;
        }
        const byOrigin = (app: App, origin: string | null) =>
          internals(app)
            .tabs.getAllTabs()
            .find((t) => t.path === '/home/u/proj/r.md' && t.origin === origin)!;

        it('opening the path on the host makes its own tab', async () => {
          const app = await setupTwins();
          expect(tabTitles()).toEqual(['r.md', 'r.md']);
          expect(byOrigin(app, 'dev').content).toBe('REMOTE');
          expect(byOrigin(app, null).content).toBe('local dirty');
        });

        it('MCP edit_buffer targets the tab of the active machine', async () => {
          const app = await setupTwins();
          // Make the local twin active so an origin-blind match would pick it.
          const localEl = Array.from(document.querySelectorAll<HTMLElement>('.tab'))[0];
          localEl.querySelector<HTMLElement>('.tab-title')!.click();
          await flush();
          emitTauriEvent('mcp://edit', { id: 1, path: '/home/u/proj/r.md', content: 'agent text' });
          await flush();
          expect(byOrigin(app, 'dev').content).toBe('agent text');
          expect(byOrigin(app, null).content).toBe('local dirty');
        });

        it('a watcher event only syncs tabs of the active machine', async () => {
          const app = await setupTwins();
          remoteVfs.set('/home/u/proj/r.md', 'REMOTE v2');
          emitTauriEvent('watcher://changes', [{ path: '/home/u/proj', kind: 'modify' }]);
          await watcherSettle();
          expect(byOrigin(app, 'dev').content).toBe('REMOTE v2');
          // The local twin is not compared with the host's disk.
          expect(byOrigin(app, null).diskConflict ?? false).toBe(false);
          expect(byOrigin(app, null).content).toBe('local dirty');
        });
      });
    });

    describe('remote file picker', () => {
      const picker = () => document.querySelector<HTMLElement>('.remote-picker');
      const originOf = (app: App) =>
        (app as unknown as { tabs: { activeTab(): { origin: string | null } | null } }).tabs
          .activeTab()?.origin;

      async function waitPicker(): Promise<HTMLElement> {
        for (let i = 0; i < 30; i++) {
          const p = picker();
          if (p?.querySelector('.rp-item, .rp-empty') && !p.querySelector('.rp-loading')) return p;
          await flush();
        }
        throw new Error('picker did not render');
      }
      const items = () =>
        Array.from(picker()!.querySelectorAll<HTMLElement>('.rp-item .rp-item-name')).map(
          (e) => e.textContent,
        );
      const item = (name: string) =>
        Array.from(picker()!.querySelectorAll<HTMLElement>('.rp-item')).find(
          (e) => e.querySelector('.rp-item-name')?.textContent === name,
        )!;
      async function dbl(name: string): Promise<void> {
        item(name).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await flush();
        if (picker()) await waitPicker();
      }
      async function key(el: Element, k: string): Promise<void> {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        await flush();
        await flush();
      }
      async function confirm(): Promise<void> {
        picker()!.querySelector<HTMLButtonElement>('.rp-confirm')!.click();
        await flush();
        await flush();
      }
      function setInput(sel: string, value: string): HTMLInputElement {
        const input = picker()!.querySelector<HTMLInputElement>(sel)!;
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return input;
      }

      async function connected(): Promise<App> {
        remoteVfs.set('/home/u/proj/r.md', 'remote');
        remoteVfs.set('/home/u/proj/notes.txt', 'n');
        remoteVfs.set('/home/u/proj/img.png', 'x');
        remoteVfs.set('/home/u/proj/.hidden.md', 'h');
        remoteVfs.set('/home/u/proj/sub/deep.md', 'deep');
        const app = await startWithRemote();
        await app.openFolder(REMOTE_ROOT);
        await flush();
        return app;
      }

      // A test that fails with the picker open: dismiss it the way a user
      // would, so its promise settles (no module state to reset).
      afterEach(() => {
        picker()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      it('Open File browses the host and opens a remote tab with origin = host', async () => {
        vfs.set('/docs/picked.md', 'local');
        const app = await connected();
        dialogResponses.open.push('/docs/picked.md');

        const done = app.openFileDialog();
        await waitPicker();
        expect(picker()!.textContent).toContain('ssh dev');
        expect(picker()!.querySelector<HTMLInputElement>('.rp-path')!.value).toBe('/home/u/proj');
        // Text filter: folders + text files; no png, no dotfiles by default.
        expect(items()).toEqual(['sub', 'notes.txt', 'r.md']);

        const filter = picker()!.querySelector<HTMLSelectElement>('.rp-filter')!;
        filter.value = String(filter.options.length - 1); // All Files
        filter.dispatchEvent(new Event('change'));
        expect(items()).toContain('img.png');

        const hidden = picker()!.querySelector<HTMLInputElement>('.rp-hidden input')!;
        hidden.checked = true;
        hidden.dispatchEvent(new Event('change'));
        await flush();
        await waitPicker();
        expect(items()).toContain('.hidden.md');

        await dbl('sub');
        expect(items()).toEqual(['deep.md']);
        await key(picker()!.querySelector('.rp-list')!, 'Backspace');
        await waitPicker();
        expect(picker()!.querySelector<HTMLInputElement>('.rp-path')!.value).toBe('/home/u/proj');

        await dbl('r.md');
        await done;
        expect(picker()).toBeNull();
        expect(tabTitles()).toEqual(['r.md']);
        expect(originOf(app)).toBe('dev');
        // The native (local) dialog was never used.
        expect(dialogResponses.open).toEqual(['/docs/picked.md']);
        expect(invokeCalls.some((c) => c.cmd === 'read_file' && c.args?.path === '/docs/picked.md'))
          .toBe(false);
      });

      it('keyboard: arrows select, Enter opens; a typed path navigates', async () => {
        const app = await connected();
        const done = app.openFileDialog();
        await waitPicker();

        const path = picker()!.querySelector<HTMLInputElement>('.rp-path')!;
        path.value = '~/proj/sub';
        await key(path, 'Enter');
        await waitPicker();
        expect(path.value).toBe('/home/u/proj/sub');

        path.value = '/home/u/proj/nope.md';
        await key(path, 'Enter');
        expect(picker()!.querySelector('.remote-error')!.textContent).toContain('No such file');

        const list = picker()!.querySelector('.rp-list')!;
        await key(list, 'ArrowDown');
        await key(list, 'Enter');
        await done;
        expect(tabTitles()).toEqual(['deep.md']);
      });

      it('shows a validation error for control characters in a typed path', async () => {
        const app = await connected();
        const done = app.openFileDialog();
        await waitPicker();
        const path = picker()!.querySelector<HTMLInputElement>('.rp-path')!;
        path.value = '/home/u/a\u0001b';
        await key(path, 'Enter');
        expect(picker()!.querySelector('.remote-error')!.textContent).toContain('control characters');
        await key(path, 'Escape');
        await done;
        expect(tabTitles()).toEqual([]);
      });

      it('Save As on an Untitled buffer writes to the host with origin = host', async () => {
        const app = await connected();
        app.newFile();
        await editActive('draft');

        const done = app.saveAs();
        await waitPicker();
        const name = picker()!.querySelector<HTMLInputElement>('.rp-name')!;
        expect(name.value).toBe('untitled.md');
        setInput('.rp-name', 'new'); // extension added from the Markdown filter
        await confirm();

        expect(await done).toBe(true);
        expect(remoteVfs.get('/home/u/proj/new.md')).toBe('draft');
        expect(vfs.has('/home/u/proj/new.md')).toBe(false);
        expect(tabTitles()).toEqual(['new.md']);
        expect(originOf(app)).toBe('dev');
      });

      it('Save As over an existing file asks to Replace first', async () => {
        const app = await connected();
        app.newFile();
        await editActive('draft');

        const done = app.saveAs();
        await waitPicker();
        setInput('.rp-name', 'r.md');
        await confirm();
        const warn = picker()!.querySelector('.rp-warning')!;
        expect(warn.classList.contains('hidden')).toBe(false);
        expect(warn.textContent).toContain('already exists');
        expect(picker()!.querySelector('.rp-confirm')!.textContent).toBe('Replace');
        expect(remoteVfs.get('/home/u/proj/r.md')).toBe('remote');

        await confirm();
        expect(await done).toBe(true);
        expect(remoteVfs.get('/home/u/proj/r.md')).toBe('draft');
      });

      const mkdirCalls = () =>
        invokeCalls.filter((c) => c.cmd === 'remote_create_dir').map((c) => c.args?.path);

      it('New Folder creates a folder in place, opens it, and saves into it', async () => {
        const app = await connected();
        app.newFile();
        await editActive('draft');

        const done = app.saveAs();
        await waitPicker();
        const row = picker()!.querySelector<HTMLElement>('.rp-folder-row')!;
        expect(row.classList.contains('hidden')).toBe(true);
        picker()!.querySelector<HTMLButtonElement>('.rp-new-folder')!.click();
        expect(row.classList.contains('hidden')).toBe(false);
        const folder = picker()!.querySelector<HTMLInputElement>('.rp-folder-name')!;
        expect(document.activeElement).toBe(folder);

        // A path is not a folder name: rejected inline, nothing created.
        folder.value = 'a/b';
        await key(folder, 'Enter');
        expect(picker()!.querySelector('.remote-error')!.textContent).toContain('cannot contain');
        expect(mkdirCalls()).toEqual([]);

        folder.value = 'drafts';
        await key(folder, 'Enter');
        await waitPicker();
        expect(mkdirCalls()).toEqual(['/home/u/proj/drafts']);
        expect(row.classList.contains('hidden')).toBe(true);
        expect(picker()!.querySelector<HTMLInputElement>('.rp-path')!.value).toBe('/home/u/proj/drafts');
        expect(picker()!.textContent).toContain('This folder is empty.');

        setInput('.rp-name', 'new.md');
        await confirm();
        expect(await done).toBe(true);
        expect(remoteVfs.get('/home/u/proj/drafts/new.md')).toBe('draft');
      });

      it('Escape in the New Folder field closes only the inline prompt', async () => {
        const app = await connected();
        app.newFile();
        const done = app.saveAs();
        await waitPicker();
        picker()!.querySelector<HTMLButtonElement>('.rp-new-folder')!.click();
        const folder = picker()!.querySelector<HTMLInputElement>('.rp-folder-name')!;
        folder.value = 'drafts';
        await key(folder, 'Escape');
        expect(picker()).not.toBeNull();
        expect(picker()!.querySelector('.rp-folder-row')!.classList.contains('hidden')).toBe(true);
        expect(mkdirCalls()).toEqual([]);
        await key(picker()!.querySelector('.rp-name')!, 'Escape');
        expect(await done).toBe(false);
      });

      it('New Folder is not offered when opening a file', async () => {
        const app = await connected();
        const done = app.openFileDialog();
        await waitPicker();
        expect(picker()!.querySelector('.rp-new-folder')).toBeNull();
        await key(picker()!.querySelector('.rp-path')!, 'Escape');
        await done;
      });

      it('Save As into a missing folder asks first, then creates it and saves', async () => {
        const app = await connected();
        app.newFile();
        await editActive('draft');

        const done = app.saveAs();
        await waitPicker();
        setInput('.rp-name', 'later/notes/idea.md');
        await confirm();
        // Never silent: a warning + a relabelled button, nothing made yet.
        const warn = picker()!.querySelector('.rp-warning')!;
        expect(warn.classList.contains('hidden')).toBe(false);
        expect(warn.textContent).toContain('/home/u/proj/later/notes does not exist');
        expect(picker()!.querySelector('.rp-confirm')!.textContent).toBe('Create Folder and Save');
        expect(mkdirCalls()).toEqual([]);
        expect(invokeCalls.some((c) => c.cmd === 'write_file')).toBe(false);

        await confirm();
        expect(await done).toBe(true);
        expect(mkdirCalls()).toEqual(['/home/u/proj/later/notes']);
        expect(remoteVfs.get('/home/u/proj/later/notes/idea.md')).toBe('draft');
      });

      it('editing the name after the missing-folder prompt disarms it', async () => {
        const app = await connected();
        app.newFile();
        const done = app.saveAs();
        await waitPicker();
        setInput('.rp-name', 'later/idea.md');
        await confirm();
        expect(picker()!.querySelector('.rp-confirm')!.textContent).toBe('Create Folder and Save');
        setInput('.rp-name', 'other/idea.md');
        expect(picker()!.querySelector('.rp-warning')!.classList.contains('hidden')).toBe(true);
        expect(picker()!.querySelector('.rp-confirm')!.textContent).toBe('Save');
        await confirm(); // re-arms for the new folder; still nothing created
        expect(mkdirCalls()).toEqual([]);
        await key(picker()!.querySelector('.rp-name')!, 'Escape');
        expect(await done).toBe(false);
      });

      it('a failed folder create shows the error inline and keeps the picker open', async () => {
        const app = await connected();
        app.newFile();
        const done = app.saveAs();
        await waitPicker();
        // r.md is a file: `mkdir -p r.md/x` fails on the host.
        setInput('.rp-name', 'r.md/x.md');
        await confirm();
        await confirm();
        expect(picker()).not.toBeNull();
        expect(picker()!.querySelector('.remote-error')!.textContent).toContain('Could not create');
        expect(picker()!.querySelector('.rp-confirm')!.textContent).toBe('Save');
        await key(picker()!.querySelector('.rp-name')!, 'Escape');
        expect(await done).toBe(false);
      });

      it('Export HTML into a missing folder uses the same confirm', async () => {
        const app = await connected();
        await openPath('/home/u/proj/r.md');
        const done = app.exportHtml();
        await waitPicker();
        setInput('.rp-name', 'site/r.html');
        await confirm();
        expect(picker()!.querySelector('.rp-confirm')!.textContent).toBe('Create Folder and Save');
        await confirm();
        await done;
        expect(mkdirCalls()).toEqual(['/home/u/proj/site']);
        expect(remoteVfs.get('/home/u/proj/site/r.html')).toContain('<!DOCTYPE html>');
      });

      it('Export HTML writes the exported file to the host', async () => {
        const app = await connected();
        await openPath('/home/u/proj/r.md');

        const done = app.exportHtml();
        await waitPicker();
        expect(picker()!.querySelector<HTMLInputElement>('.rp-name')!.value).toBe('r.html');
        expect(picker()!.querySelector('.rp-confirm')!.textContent).toBe('Export');
        await confirm();
        await done;

        expect(remoteVfs.get('/home/u/proj/r.html')).toContain('<!DOCTYPE html>');
        expect(vfs.has('/home/u/proj/r.html')).toBe(false);
      });

      it('cancel (Escape / Cancel button) writes and opens nothing', async () => {
        const app = await connected();
        app.newFile();
        await editActive('draft');

        const saving = app.saveAs();
        await waitPicker();
        await key(picker()!.querySelector('.rp-name')!, 'Escape');
        expect(await saving).toBe(false);
        expect(picker()).toBeNull();

        const opening = app.openFileDialog();
        await waitPicker();
        picker()!
          .querySelector<HTMLButtonElement>('.remote-actions .remote-btn:not(.rp-confirm)')!
          .click();
        await opening;
        expect(picker()).toBeNull();
        expect(invokeCalls.some((c) => c.cmd === 'write_file')).toBe(false);
        expect(tabTitles()).toEqual(['Untitled']);
      });

      it('Finder drops of local files stay blocked while connected', async () => {
        vfs.set('/inbox/one.md', '1');
        await connected();
        dragDropHandler!({ payload: { type: 'drop', paths: ['/inbox/one.md'] } });
        await flush();
        expect(tabTitles()).not.toContain('one.md');
        expect(messageLog.some((m) => m.includes('remote session (ssh dev) is active'))).toBe(true);
      });

      it('local mode keeps the native dialogs', async () => {
        vfs.set('/docs/picked.md', 'local');
        const app = await startWithRemote();
        dialogResponses.open.push('/docs/picked.md');
        await app.openFileDialog();
        expect(picker()).toBeNull();
        expect(tabTitles()).toContain('picked.md');

        app.newFile();
        await editActive('draft');
        dialogResponses.save.push('/docs/new.md');
        expect(await app.saveAs()).toBe(true);
        expect(picker()).toBeNull();
        expect(vfs.get('/docs/new.md')).toBe('draft');
      });
    });
  });

  describe('drag and drop from Finder', () => {
    it('opens dropped files as tabs and a dropped directory as sidebar root', async () => {
      vfs.set('/inbox/one.md', '1');
      directories.add('/projects/site');
      await startApp();

      expect(dragDropHandler).toBeTruthy();
      dragDropHandler!({
        payload: { type: 'drop', paths: ['/inbox/one.md', '/projects/site'] },
      });
      await flush();

      expect(tabTitles()).toContain('one.md');
      // The dropped directory becomes the sidebar root (visible sidebar),
      // and the welcome screen gets out of the way.
      expect(document.getElementById('sidebar')?.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('welcome')?.classList.contains('hidden')).toBe(true);
    });

    it('shows the drop indicator during drag-over and clears it on leave', async () => {
      await startApp();
      const appEl = document.getElementById('app')!;

      dragDropHandler!({ payload: { type: 'enter', paths: [] } });
      expect(appEl.classList.contains('drag-over')).toBe(true);

      dragDropHandler!({ payload: { type: 'leave' } });
      expect(appEl.classList.contains('drag-over')).toBe(false);
    });
  });

  describe('terminals-only layout', () => {
    /** Poll until `pred` is true (toggleTerminalsOnly is async). */
    const waitUntil = async (pred: () => boolean, label: string) => {
      for (let i = 0; i < 40; i++) {
        if (pred()) return;
        await flush();
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    it('toggles the center-column class and persists terminals_only', async () => {
      await startApp();
      const center = document.getElementById('center-column')!;
      expect(center.classList.contains('terminals-only')).toBe(false);
      const savesBefore = savedConfigs.length;

      emitTauriEvent(MENU.TOGGLE_TERMINALS_ONLY);
      await waitUntil(
        () => center.classList.contains('terminals-only'),
        'terminals-only class',
      );
      expect(document.getElementById('terminal-panel')?.classList.contains('hidden')).toBe(false);
      // Terminals-only has no title bar button (menu / ⌃⇧`); the terminal
      // toggle reads as pressed.
      expect(document.getElementById('btn-terminals-only')).toBeNull();
      expect(document.getElementById('btn-terminal')?.classList.contains('off')).toBe(false);

      // Config save is debounced (CONFIG_SAVE_MS = 2000). Use real timers —
      // the debounce was scheduled outside fake-timer scope.
      await new Promise((r) => setTimeout(r, 2100));
      expect(savedConfigs.length).toBeGreaterThan(savesBefore);
      const saved = savedConfigs[savedConfigs.length - 1] as Record<string, unknown>;
      expect(saved.terminals_only).toBe(true);
      expect(saved.terminal_visible).toBe(true);

      // Restore editor+preview layout; terminal drawer stays open.
      emitTauriEvent(MENU.TOGGLE_TERMINALS_ONLY);
      await waitUntil(
        () => !center.classList.contains('terminals-only'),
        'editor layout restore',
      );
      expect(document.getElementById('terminal-panel')?.classList.contains('hidden')).toBe(false);

      await new Promise((r) => setTimeout(r, 2100));
      const saved2 = savedConfigs[savedConfigs.length - 1] as Record<string, unknown>;
      expect(saved2.terminals_only).toBe(false);
    });

    it('persists the terminal split layout per workspace in AppConfig', async () => {
      const saved = { type: 'pane', session: 'sd-00000000-zsh-1' };
      setConfigOnDisk({
        theme: 'system',
        last_open_files: [],
        sidebar_width: 220,
        sidebar_visible: true,
        preview_visible: true,
        word_wrap: true,
        show_hidden_files: false,
        enable_diagrams: true,
        terminal_layouts: { 'sd-00000000-': saved },
      });
      terminalStub.store = null;
      await startApp();
      emitTauriEvent(MENU.TOGGLE_TERMINAL);
      await waitUntil(() => terminalStub.store !== null, 'terminal manager');
      const store = terminalStub.store!;
      // The manager reads the saved layout back for its workspace key.
      expect(store.load('sd-00000000-')).toEqual(saved);
      expect(store.load('sd-ffffffff-')).toBeUndefined();

      const layout = {
        type: 'split',
        dir: 'row',
        ratio: 0.5,
        a: { type: 'pane', session: 'sd-11111111-zsh-1' },
        b: { type: 'pane', session: 'sd-11111111-zsh-2' },
      };
      store.save('sd-11111111-', layout);
      store.save('sd-00000000-', null); // grid emptied → entry dropped
      await new Promise((r) => setTimeout(r, 2100));
      const cfg = savedConfigs[savedConfigs.length - 1] as Record<string, unknown>;
      expect(cfg.terminal_layouts).toEqual({ 'sd-11111111-': layout });
    });

    it('persists "Don\'t ask again" for the MCP install prompt in AppConfig', async () => {
      setConfigOnDisk({
        theme: 'system',
        last_open_files: [],
        sidebar_width: 220,
        sidebar_visible: true,
        preview_visible: true,
        word_wrap: true,
        show_hidden_files: false,
        enable_diagrams: true,
        mcp_install_prompt_dismissed: ['grok'],
      });
      terminalStub.promptStore = null;
      await startApp();
      emitTauriEvent(MENU.TOGGLE_TERMINAL);
      await waitUntil(() => terminalStub.promptStore !== null, 'terminal manager');
      const store = terminalStub.promptStore!;
      expect(store.isDismissed('grok')).toBe(true);
      expect(store.isDismissed('gemini')).toBe(false);
      store.dismiss('gemini');
      store.dismiss('gemini'); // no duplicate
      expect(store.isDismissed('gemini')).toBe(true);
      await new Promise((r) => setTimeout(r, 2100));
      const cfg = savedConfigs[savedConfigs.length - 1] as Record<string, unknown>;
      expect(cfg.mcp_install_prompt_dismissed).toEqual(['grok', 'gemini']);
    });

    it('restores terminals_only from config on startup', async () => {
      setConfigOnDisk({
        theme: 'system',
        last_open_files: [],
        recent_folders: [],
        terminal_visible: true,
        terminal_height: 220,
        terminals_only: true,
        sidebar_width: 220,
        sidebar_visible: true,
        preview_visible: true,
        word_wrap: true,
        show_hidden_files: false,
        enable_diagrams: true,
      });
      await startApp();
      await waitUntil(
        () =>
          document.getElementById('center-column')?.classList.contains('terminals-only') === true,
        'startup terminals-only restore',
      );
      expect(document.getElementById('terminal-panel')?.classList.contains('hidden')).toBe(false);
    });
  });

  const restoreConfig = (files: string[]) =>
    setConfigOnDisk({
      theme: 'system',
      last_open_files: files,
      sidebar_width: 220,
      sidebar_visible: true,
      preview_visible: true,
      word_wrap: true,
      show_hidden_files: false,
      enable_diagrams: true,
    });

  const diffCalls = () => invokeCalls.filter((c) => c.cmd === 'git_diff_file').length;

  describe('open diff refresh on disk change (finding #5)', () => {
    it('re-renders the active diff when its file changes on disk', async () => {
      vfs.set('/repo/a.md', '# A');
      gitChanges.push({ path: 'a.md', status: 'modified', staged: false });
      restoreConfig(['/repo/a.md']);
      await startApp();
      await gitSettle();

      // Switch the active file to its Diff view → first diff render.
      viewBtn('diff').click();
      await flush();
      await flush();
      expect(diffCalls()).toBe(1);

      // A watcher change for the open file must re-render the diff (it reads
      // git, not the tab buffer, so syncTabWithDisk alone wouldn't repaint it).
      vfs.set('/repo/a.md', '# A edited');
      emitTauriEvent('watcher://changes', [{ path: '/repo/a.md', kind: 'modify' }]);
      await watcherSettle();
      expect(diffCalls()).toBe(2);
    });

    it('does not re-render the diff for an unrelated file', async () => {
      vfs.set('/repo/a.md', '# A');
      vfs.set('/repo/b.md', '# B');
      gitChanges.push({ path: 'a.md', status: 'modified', staged: false });
      restoreConfig(['/repo/a.md']);
      await startApp();
      await gitSettle();

      viewBtn('diff').click();
      await flush();
      await flush();
      const before = diffCalls();

      emitTauriEvent('watcher://changes', [{ path: '/repo/b.md', kind: 'modify' }]);
      await watcherSettle();
      expect(diffCalls()).toBe(before);
    });
  });

  describe('title bar view control (one view per document)', () => {
    const el = (id: string) => document.getElementById(id)!;
    const hidden = (id: string) => el(id).classList.contains('hidden');
    const open = async (path: string) => {
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path });
      await flush();
      await flush();
    };
    const activeTitle = () => document.querySelector('.tab.active .tab-title')?.textContent;
    const clickTab = async (title: string) => {
      const tab = [...document.querySelectorAll<HTMLElement>('.tab')].find(
        (t) => t.querySelector('.tab-title')?.textContent === title,
      )!;
      tab.click();
      await flush();
    };

    it('is hidden on the welcome screen and shows Split for a new markdown tab', async () => {
      vfs.set('/docs/a.md', '# A');
      await startApp();
      expect(el('view-mode').hidden).toBe(true);
      await open('/docs/a.md');
      expect(el('view-mode').hidden).toBe(false);
      expect(pressedView()).toBe('split');
      expect(hidden('editor-container')).toBe(false);
      expect(hidden('preview-container')).toBe(false);
      expect(hidden('resize-handle')).toBe(false);
    });

    it('lays out each view and never leaves an impossible state', async () => {
      vfs.set('/docs/a.md', '# A');
      await startApp();
      await open('/docs/a.md');

      viewBtn('preview').click();
      expect(pressedView()).toBe('preview');
      expect(hidden('editor-container')).toBe(true);
      expect(hidden('preview-container')).toBe(false);
      expect(hidden('resize-handle')).toBe(true);

      viewBtn('edit').click();
      expect(pressedView()).toBe('edit');
      expect(hidden('editor-container')).toBe(false);
      expect(hidden('preview-container')).toBe(true);
      expect(hidden('resize-handle')).toBe(true);

      viewBtn('split').click();
      expect(hidden('editor-container')).toBe(false);
      expect(hidden('preview-container')).toBe(false);
      // Exactly one view is pressed at any time.
      expect(document.querySelectorAll('#view-mode [aria-pressed="true"]').length).toBe(1);
    });

    it('each tab remembers its own view', async () => {
      vfs.set('/docs/a.md', '# A');
      vfs.set('/docs/b.md', '# B');
      await startApp();
      await open('/docs/a.md');
      viewBtn('preview').click();
      await open('/docs/b.md');
      // New tabs start in the last Edit / Split / Preview picked.
      expect(pressedView()).toBe('preview');
      viewBtn('edit').click();

      await clickTab('a.md');
      expect(activeTitle()).toBe('a.md');
      expect(pressedView()).toBe('preview');
      expect(hidden('editor-container')).toBe(true);
      await clickTab('b.md');
      expect(pressedView()).toBe('edit');
      expect(hidden('preview-container')).toBe(true);
    });

    it('View menu items (⌘1–⌘4) switch the view', async () => {
      vfs.set('/docs/a.md', '# A');
      await startApp();
      await open('/docs/a.md');
      emitTauriEvent(MENU.VIEW_EDIT);
      expect(pressedView()).toBe('edit');
      emitTauriEvent(MENU.VIEW_PREVIEW);
      expect(pressedView()).toBe('preview');
      emitTauriEvent(MENU.VIEW_SPLIT);
      expect(pressedView()).toBe('split');
      // No git changes: Diff is disabled and the menu item is a no-op.
      expect(viewDisabled('diff')).toBe(true);
      emitTauriEvent(MENU.VIEW_DIFF);
      expect(pressedView()).toBe('split');
      expect(hidden('diff-view')).toBe(true);
    });

    it('Diff is enabled only while the file has git changes', async () => {
      vfs.set('/repo/a.md', '# A');
      vfs.set('/repo/b.md', '# B');
      gitChanges.push({ path: 'a.md', status: 'modified', staged: false });
      await startApp();
      await open('/repo/a.md');
      await gitSettle();
      expect(viewDisabled('diff')).toBe(false);

      emitTauriEvent(MENU.VIEW_DIFF);
      await flush();
      expect(pressedView()).toBe('diff');
      expect(hidden('diff-view')).toBe(false);
      expect(hidden('editor-area')).toBe(true);
      expect(document.querySelector('.tab.active')!.classList.contains('tab-diff')).toBe(true);

      // A clean file in the same repo: Diff disabled.
      await open('/repo/b.md');
      expect(viewDisabled('diff')).toBe(true);
      expect(hidden('diff-view')).toBe(true);

      // Back on a.md: still in its Diff view; Edit leaves it.
      await clickTab('a.md');
      expect(pressedView()).toBe('diff');
      emitTauriEvent(MENU.VIEW_EDIT);
      expect(hidden('diff-view')).toBe(true);
      expect(hidden('editor-area')).toBe(false);
      expect(document.querySelector('.tab.active')!.classList.contains('tab-diff')).toBe(false);
    });

    describe('a hidden editor never takes input (Diff, Preview-only)', () => {
      /** Keys CodeMirror handles itself (its keymap honours read-only). */
      const pressInEditor = (key: string) =>
        document
          .querySelector('.cm-content')!
          .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      const content = () => document.querySelector('.cm-content') as HTMLElement;
      const openModified = async () => {
        vfs.set('/repo/a.md', '# A');
        gitChanges.push({ path: 'a.md', status: 'modified', staged: false });
        await startApp();
        await open('/repo/a.md');
        await gitSettle();
      };

      it('Diff: keys aimed at the editor change nothing; focus is in the diff pane', async () => {
        await openModified();
        const view = await editorView();
        view.focus();
        expect(view.hasFocus).toBe(true);

        emitTauriEvent(MENU.VIEW_DIFF);
        await flush();
        expect(pressedView()).toBe('diff');
        expect(document.activeElement).toBe(el('diff-view'));
        expect(view.hasFocus).toBe(false);
        expect(el('editor-area').hasAttribute('inert')).toBe(true);
        expect(el('editor-area').getAttribute('aria-hidden')).toBe('true');
        expect(content().getAttribute('contenteditable')).toBe('false');
        expect(view.state.readOnly).toBe(true);

        for (const k of ['Enter', 'Backspace', 'Delete']) pressInEditor(k);
        await flush();
        expect(view.state.doc.toString()).toBe('# A');
        expect(activeTabDot().style.display).toBe('none');
        expect(el('status-modified').classList.contains('is-dirty')).toBe(false);

        // Leaving Diff restores editing and focus.
        emitTauriEvent(MENU.VIEW_SPLIT);
        await flush();
        expect(el('editor-area').hasAttribute('inert')).toBe(false);
        expect(el('editor-area').hasAttribute('aria-hidden')).toBe(false);
        expect(content().getAttribute('contenteditable')).toBe('true');
        expect(view.state.readOnly).toBe(false);
        expect(view.hasFocus).toBe(true);
        pressInEditor('Enter');
        await flush();
        expect(view.state.doc.toString()).not.toBe('# A');
        expect(activeTabDot().style.display).not.toBe('none');
      });

      it('review keys still work in the diff pane; find searches the diff', async () => {
        await openModified();
        emitTauriEvent(MENU.VIEW_DIFF);
        await vi.waitFor(() => expect(el('diff-body').textContent).not.toContain('Loading'));
        expect(document.activeElement).toBe(el('diff-view'));
        emitTauriEvent(MENU.FIND);
        await flush();
        const input = el('diff-view').querySelector<HTMLInputElement>('.sd-find-input');
        expect(input).not.toBeNull();
        expect(input!.placeholder).toBe('Find in diff');
        expect(document.activeElement).toBe(input);
        // The hidden editor's search panel is not what opened.
        expect(document.querySelector('#editor-container .sd-find')).toBeNull();
      });

      it('switching tabs gives each tab the right input state', async () => {
        vfs.set('/repo/a.md', '# A');
        vfs.set('/repo/b.md', '# B');
        gitChanges.push({ path: 'a.md', status: 'modified', staged: false });
        await startApp();
        await open('/repo/a.md');
        await gitSettle();
        emitTauriEvent(MENU.VIEW_DIFF);
        await flush();
        const view = await editorView();
        expect(view.state.readOnly).toBe(true);

        await open('/repo/b.md'); // a Split tab
        expect(view.state.readOnly).toBe(false);
        expect(el('editor-area').hasAttribute('inert')).toBe(false);
        expect(view.hasFocus).toBe(true);

        await clickTab('a.md'); // back to the Diff tab (cached editor state)
        expect(pressedView()).toBe('diff');
        expect(view.state.readOnly).toBe(true);
        expect(view.hasFocus).toBe(false);
        pressInEditor('Enter');
        await flush();
        expect(view.state.doc.toString()).toBe('# A');
        expect(activeTabDot().style.display).toBe('none');

        await clickTab('b.md');
        expect(view.state.readOnly).toBe(false);
      });

      it('Preview-only: the hidden editor takes no input; Split restores it', async () => {
        vfs.set('/docs/a.md', '# A');
        await startApp();
        await open('/docs/a.md');
        const view = await editorView();
        view.focus();
        viewBtn('preview').click();
        await flush();
        expect(view.hasFocus).toBe(false);
        expect(el('editor-container').hasAttribute('inert')).toBe(true);
        expect(el('editor-area').hasAttribute('inert')).toBe(false);
        expect(view.state.readOnly).toBe(true);
        pressInEditor('Enter');
        await flush();
        expect(view.state.doc.toString()).toBe('# A');
        expect(activeTabDot().style.display).toBe('none');

        viewBtn('split').click();
        await flush();
        expect(el('editor-container').hasAttribute('inert')).toBe(false);
        expect(view.state.readOnly).toBe(false);
        pressInEditor('Enter');
        await flush();
        expect(view.state.doc.toString()).not.toBe('# A');
      });

      it('welcome screen: the editor behind it takes no input', async () => {
        await startApp();
        expect(el('editor-area').classList.contains('hidden')).toBe(true);
        expect(el('editor-area').hasAttribute('inert')).toBe(true);
        expect((await editorView()).state.readOnly).toBe(true);
      });
    });

    it('a text file gets Edit and Diff only', async () => {
      vfs.set('/repo/main.rs', 'fn main() {}');
      gitChanges.push({ path: 'main.rs', status: 'modified', staged: false });
      await startApp();
      await open('/repo/main.rs');
      await gitSettle();
      expect(pressedView()).toBe('edit');
      expect(viewDisabled('split')).toBe(true);
      expect(viewDisabled('preview')).toBe(true);
      expect(viewDisabled('diff')).toBe(false);
    });

    it('an Untitled buffer has no Diff', async () => {
      await startApp();
      emitTauriEvent(MENU.NEW_FILE);
      await flush();
      expect(pressedView()).toBe('split');
      expect(viewDisabled('diff')).toBe(true);
    });

    it('persists the default view for new tabs (and the legacy preview_visible)', async () => {
      vi.useFakeTimers();
      try {
        vfs.set('/docs/a.md', '# A');
        await startApp();
        emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/a.md' });
        await vi.advanceTimersByTimeAsync(10);
        viewBtn('edit').click();
        await vi.advanceTimersByTimeAsync(2500);
        const last = savedConfigs[savedConfigs.length - 1] as Record<string, unknown>;
        expect(last.default_view_mode).toBe('edit');
        expect(last.preview_visible).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('restores the default view from config, and from an old preview_visible', async () => {
      vfs.set('/docs/a.md', '# A');
      setConfigOnDisk({ last_open_files: ['/docs/a.md'], default_view_mode: 'preview' });
      await startApp();
      await flush();
      expect(pressedView()).toBe('preview');

      document.body.innerHTML = '';
      resetTauriMocks();
      vfs.set('/docs/a.md', '# A');
      setConfigOnDisk({ last_open_files: ['/docs/a.md'], preview_visible: false });
      await startApp();
      await flush();
      expect(pressedView()).toBe('edit');
    });
  });

  describe('removed title bar buttons stay reachable', () => {
    it('index.html title bar has only the tabs, the view control and the terminal toggle', async () => {
      const html = (await import('../../index.html?raw')).default;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const toolbar = doc.getElementById('toolbar')!;
      for (const id of [
        'btn-new',
        'btn-open',
        'btn-open-remote',
        'btn-save',
        'btn-sidebar',
        'btn-wrap',
        'btn-editor',
        'btn-preview',
        'btn-diff',
        'btn-theme',
        'btn-terminals-only',
      ]) {
        expect(doc.getElementById(id), id).toBeNull();
      }
      expect(toolbar.querySelector('#tab-bar')).not.toBeNull();
      expect(toolbar.querySelectorAll('#view-mode button[data-view]').length).toBe(4);
      expect(toolbar.querySelector('#btn-terminal')).not.toBeNull();
      // The markdown formatting toolbar stays.
      expect(doc.getElementById('md-toolbar')).not.toBeNull();
      // Status bar keeps the counts and adds the workspace items.
      for (const id of [
        'status-words',
        'status-chars',
        'status-lines',
        'status-cursor',
        'status-wrap',
        'status-branch',
        'status-remote',
        'status-agent',
        'status-update',
      ]) {
        expect(doc.getElementById(id), id).not.toBeNull();
      }
    });

    it('New, Save, Open Folder, sidebar, wrap and theme work from the menu', async () => {
      vfs.set('/docs/a.md', '# A');
      await startApp();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/a.md' });
      await flush();

      // New File
      emitTauriEvent(MENU.NEW_FILE);
      await flush();
      expect(tabTitles()).toContain('Untitled');

      // Save (the a.md tab, edited)
      const tab = [...document.querySelectorAll<HTMLElement>('.tab')].find(
        (t) => t.querySelector('.tab-title')?.textContent === 'a.md',
      )!;
      tab.click();
      await flush();
      const view = await editorView();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '# A saved' } });
      emitTauriEvent(MENU.SAVE);
      await flush();
      await flush();
      expect(vfs.get('/docs/a.md')).toBe('# A saved');

      // Open Folder → the folder dialog
      dialogResponses.open.push(null);
      emitTauriEvent(MENU.OPEN_FOLDER);
      await flush();
      expect(dialogResponses.open.length).toBe(0);

      // Toggle Sidebar (⌘⇧B)
      const sidebar = document.getElementById('sidebar')!;
      const before = sidebar.classList.contains('hidden');
      emitTauriEvent(MENU.TOGGLE_SIDEBAR);
      expect(sidebar.classList.contains('hidden')).toBe(!before);

      // Word wrap: the status bar reflects it (and clicking it toggles back)
      emitTauriEvent(MENU.TOGGLE_WORD_WRAP);
      expect(document.getElementById('status-wrap')!.textContent).toBe('Wrap: Off');
      document.getElementById('status-wrap')!.click();
      expect(document.getElementById('status-wrap')!.textContent).toBe('Wrap: On');

      // Theme
      const theme = document.documentElement.dataset.theme;
      emitTauriEvent(MENU.TOGGLE_THEME);
      expect(document.documentElement.dataset.theme).not.toBe(theme);
    });

    it('the welcome screen still offers New File and Open Folder', async () => {
      await startApp();
      const actions = document.getElementById('welcome-actions')!;
      expect(actions.querySelector('[data-welcome="new-file"]')).not.toBeNull();
      expect(actions.querySelector('[data-welcome="open-folder"]')).not.toBeNull();
      (actions.querySelector('[data-welcome="new-file"]') as HTMLElement).click();
      await flush();
      expect(tabTitles()).toContain('Untitled');
    });
  });

  describe('status bar items', () => {
    const el = (id: string) => document.getElementById(id)!;

    it('shows the branch with ahead/behind from the git status tick', async () => {
      vfs.set('/repo/a.md', '# A');
      git.branch = { branch: 'feature/x', detached: false, has_upstream: true, ahead: 2, behind: 1 };
      await startApp();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/repo/a.md' });
      await gitSettle();
      expect(el('status-branch').classList.contains('hidden')).toBe(false);
      expect(el('status-branch').textContent).toBe('feature/x ↑2 ↓1');

      // The next watcher tick refreshes it (no polling).
      git.branch = { ...git.branch, ahead: 0, behind: 0 };
      emitTauriEvent('watcher://changes', [{ path: '/repo/a.md', kind: 'modify' }]);
      // Watcher coalescing (250 ms) + the status debounce (600 ms) + the
      // branch debounce (300 ms), plus slack for the async git calls.
      for (let i = 0; i < 60 && el('status-branch').textContent !== 'feature/x'; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(el('status-branch').textContent).toBe('feature/x');

      // No polling: with no further watcher tick, the branch is not re-queried.
      const polls = invokeCalls.filter((c) => c.cmd === 'git_branch_status').length;
      await new Promise((r) => setTimeout(r, 700));
      await flush();
      expect(invokeCalls.filter((c) => c.cmd === 'git_branch_status').length).toBe(polls);
    });

    it('hides the branch outside a repo', async () => {
      vfs.set('/repo/a.md', '# A');
      git.branch = { branch: null, detached: false, has_upstream: false, ahead: 0, behind: 0 };
      await startApp();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/repo/a.md' });
      await gitSettle();
      expect(el('status-branch').classList.contains('hidden')).toBe(true);
    });

    it('shows Agent tools on/off from the MCP server and the setting', async () => {
      await startApp();
      await flush();
      expect(el('status-agent').textContent).toBe('Agent tools on');

      document.body.innerHTML = '';
      resetTauriMocks();
      mcp.running = false;
      await startApp();
      await flush();
      expect(el('status-agent').textContent).toBe('Agent tools off');

      document.body.innerHTML = '';
      resetTauriMocks();
      setConfigOnDisk({ last_open_files: [], agent_context_enabled: false });
      await startApp();
      await flush();
      expect(el('status-agent').textContent).toBe('Agent tools off');
    });

    it('clicking Agent tools opens Settings at Agents', async () => {
      await startApp();
      await flush();
      el('status-agent').click();
      await flush();
      expect(document.querySelector('.settings-dialog [data-section="agents"]')).not.toBeNull();
      // A second click keeps it open (it is not a toggle).
      el('status-agent').click();
      await flush();
      expect(document.querySelectorAll('.settings-dialog').length).toBe(1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    it('clicking Ln/Col opens the go-to-line prompt', async () => {
      vfs.set('/docs/a.md', '# A\n\nline 3');
      await startApp();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/a.md' });
      await flush();
      el('status-cursor').click();
      await flush();
      expect(document.querySelector('.cm-editor .cm-panel, .cm-editor .cm-dialog')).not.toBeNull();
    });

    it('shows the unsaved dot next to the path', async () => {
      vfs.set('/docs/a.md', '# A');
      await startApp();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/docs/a.md' });
      await flush();
      expect(el('status-modified').classList.contains('is-dirty')).toBe(false);
      const view = await editorView();
      view.dispatch({ changes: { from: 0, insert: 'x' } });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      await flush();
      expect(el('status-modified').classList.contains('is-dirty')).toBe(true);
    });
  });

  describe('Export HTML escapes the title (finding #9)', () => {
    it('HTML-escapes the document title in the exported file', async () => {
      const path = '/x/<img src=x onerror=alert(1)>.md';
      vfs.set(path, '# hi');
      restoreConfig([path]);
      const app = await startApp();

      dialogResponses.save.push('/out.html');
      await app.exportHtml();

      const out = vfs.get('/out.html') ?? '';
      expect(out).not.toContain('<img src=x onerror=alert(1)>');
      expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });
  });

  describe('activity bar and sidebar views (UI revamp phase 1)', () => {
    const $ = (id: string) => document.getElementById(id)!;
    const pressed = (id: string) => $(id).getAttribute('aria-pressed');
    const sidebarHidden = () => $('sidebar').classList.contains('hidden');
    const ctrlShift = (key: string) =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    const lastSaved = () => savedConfigs[savedConfigs.length - 1] as Record<string, unknown>;

    it('opens the sidebar on a clicked view and closes it on the active one', async () => {
      await startApp();
      expect(sidebarHidden()).toBe(false);
      expect(pressed('act-files')).toBe('true');
      expect($('sidebar-files').hidden).toBe(false);

      $('act-files').click();
      expect(sidebarHidden()).toBe(true);
      expect(pressed('act-files')).toBe('false');

      $('act-changes').click();
      expect(sidebarHidden()).toBe(false);
      expect(pressed('act-changes')).toBe('true');
      expect(pressed('act-files')).toBe('false');
      expect($('sidebar-changes').hidden).toBe(false);
      expect($('sidebar-files').hidden).toBe(true);

      // Another view while open: switch, don't close.
      $('act-search').click();
      expect(sidebarHidden()).toBe(false);
      expect($('sidebar-search').hidden).toBe(false);
      expect($('sidebar-changes').hidden).toBe(true);
    });

    it('the sidebar toggle (⌘⇧B / menu) reopens the last view', async () => {
      // The title bar's #btn-sidebar is gone (phase 2): the activity bar
      // replaces it, and ⌘⇧B → Toggle Sidebar still opens/closes it.
      await startApp();
      expect(document.getElementById('btn-sidebar')).toBeNull();
      $('act-changes').click();
      emitTauriEvent(MENU.TOGGLE_SIDEBAR);
      expect(sidebarHidden()).toBe(true);
      expect(pressed('act-changes')).toBe('false');
      emitTauriEvent(MENU.TOGGLE_SIDEBAR);
      expect(sidebarHidden()).toBe(false);
      expect(pressed('act-changes')).toBe('true');
      expect($('sidebar-changes').hidden).toBe(false);
    });

    it('persists the view and visibility, and restores them on startup', async () => {
      vi.useFakeTimers();
      try {
        await startApp();
        $('act-search').click();
        await vi.advanceTimersByTimeAsync(2500);
        expect(lastSaved().sidebar_view).toBe('search');
        expect(lastSaved().sidebar_visible).toBe(true);

        $('act-search').click();
        await vi.advanceTimersByTimeAsync(2500);
        expect(lastSaved().sidebar_view).toBe('search');
        expect(lastSaved().sidebar_visible).toBe(false);
      } finally {
        vi.useRealTimers();
      }

      document.body.innerHTML = '';
      setConfigOnDisk({ theme: 'system', last_open_files: [], sidebar_visible: true, sidebar_view: 'changes' });
      await startApp();
      expect(pressed('act-changes')).toBe('true');
      expect($('sidebar-changes').hidden).toBe(false);

      document.body.innerHTML = '';
      setConfigOnDisk({ theme: 'system', last_open_files: [], sidebar_visible: true, sidebar_view: 'bogus' });
      await startApp();
      expect(pressed('act-files')).toBe('true');
    });

    it('badges Changes with the changed-file count', async () => {
      gitChanges.push(
        { path: 'a.md', status: 'modified', staged: false },
        { path: 'b.md', status: 'untracked', staged: false },
      );
      const app = await startApp();
      const badge = $('changes-badge');
      expect(badge.hidden).toBe(true);
      await app.openFolder('/repo');
      await vi.waitFor(() => expect(badge.textContent).toBe('2'));
      expect(badge.hidden).toBe(false);
      expect($('act-changes').getAttribute('aria-label')).toBe('Changes, 2 files to review');

      gitChanges.length = 0;
      $('btn-changes-refresh').click();
      await vi.waitFor(() => expect(badge.hidden).toBe(true));
    });

    describe('review queue (UI revamp phase 5)', () => {
      const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
        el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
      const settle = async () => {
        for (let i = 0; i < 6; i++) await flush();
      };
      const rows = () =>
        [...document.querySelectorAll<HTMLElement>('#changes-list .change-row')].map((r) => ({
          path: r.dataset.path,
          reviewed: r.classList.contains('reviewed'),
          current: r.classList.contains('current'),
        }));
      const setup = async () => {
        vfs.set('/repo/a.md', '# A\n\n## Intro\nold');
        vfs.set('/repo/src/b.ts', 'b');
        vfs.set('/repo/package-lock.json', '{}');
        gitChanges.push(
          { path: 'a.md', status: 'modified', staged: false },
          { path: 'src/b.ts', status: 'modified', staged: false },
          { path: 'package-lock.json', status: 'modified', staged: false },
        );
        const app = await startApp();
        await app.openFolder('/repo');
        await settle();
        return app;
      };

      it('badge counts pending files; noise is collapsed and outside the queue', async () => {
        await setup();
        expect($('changes-badge').textContent).toBe('2');
        $('act-changes').click();
        await vi.waitFor(() =>
          expect(document.querySelector('.changes-review-top')?.textContent).toBe('0 / 2 reviewed'),
        );
        expect(rows().map((r) => r.path)).toEqual(['a.md', 'src/b.ts']);
        const toggle = document.querySelector<HTMLElement>('.changes-noise-toggle')!;
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(toggle.textContent).toContain('Probably noise');
        toggle.click();
        expect(rows().map((r) => r.path)).toContain('package-lock.json');
      });

      it('opening Changes shows the first pending diff; Space marks reviewed and moves on', async () => {
        await setup();
        $('act-changes').click();
        await vi.waitFor(() => expect(activeTitle()).toBe('a.md'));
        expect($('diff-view').classList.contains('hidden')).toBe(false);
        expect($('diff-title').textContent).toBe('a.md');
        await vi.waitFor(() => expect($('diff-meta').textContent).toContain('1 hunk'));
        await vi.waitFor(() => expect($('diff-review').hidden).toBe(false));
        const list = $('changes-list');
        expect(document.activeElement).toBe(list);

        key(list, ' ');
        await vi.waitFor(() => expect(activeTitle()).toBe('b.ts'));
        expect($('changes-badge').textContent).toBe('1');
        // Reviewed files sort after the pending ones and dim.
        expect(rows()).toEqual([
          { path: 'src/b.ts', reviewed: false, current: true },
          { path: 'a.md', reviewed: true, current: false },
        ]);
        // j/k preview tabs: a.md's tab was replaced, not kept.
        expect(tabTitles()).toEqual(['b.ts']);
        expect(Object.values(reviewStore).length).toBe(0); // save is debounced
        await new Promise((r) => setTimeout(r, 300));
        expect(Object.values(reviewStore)[0]).toEqual({ 'a.md': 'modified:fp' });

        // The header button toggles the active file.
        $('diff-review').click();
        expect($('changes-badge').hidden).toBe(true);
        expect($('diff-review').classList.contains('reviewed')).toBe(true);
        expect(document.querySelector('.changes-review-sub')?.textContent).toBe('All caught up');

        // The file changes again: pending again, flagged.
        changePrints['a.md'] = 'modified:fp2';
        $('btn-changes-refresh').click();
        await vi.waitFor(() => expect($('changes-badge').textContent).toBe('1'));
        expect(document.querySelector('.change-row.changed-again')?.getAttribute('data-path')).toBe('a.md');
      });

      it('j/k move in the list and the diff pane, never in the editor', async () => {
        await setup();
        $('act-changes').click();
        await vi.waitFor(() => expect(activeTitle()).toBe('a.md'));
        key($('changes-list'), 'j');
        await vi.waitFor(() => expect(activeTitle()).toBe('b.ts'));
        key($('diff-view'), 'k');
        await vi.waitFor(() => expect(activeTitle()).toBe('a.md'));
        key(document.querySelector('.cm-content')!, 'j');
        await settle();
        expect(activeTitle()).toBe('a.md');
      });

      it('Shift+Enter and hunk links open the editor at the changed line', async () => {
        await setup();
        $('act-changes').click();
        await vi.waitFor(() => expect(document.querySelector('#diff-body .diff-open-line')).not.toBeNull());
        const link = document.querySelector<HTMLElement>('#diff-body .diff-open-line')!;
        expect(link.dataset.line).toBe('1');
        link.click();
        await vi.waitFor(() => expect($('diff-view').classList.contains('hidden')).toBe(true));
        $('act-changes').click(); // close
        $('act-changes').click(); // reopen: back to the diff
        await vi.waitFor(() => expect($('diff-view').classList.contains('hidden')).toBe(false));
        key($('changes-list'), 'Enter', { shiftKey: true });
        await vi.waitFor(() => expect($('diff-view').classList.contains('hidden')).toBe(true));
        expect(activeTitle()).toBe('a.md');
      });
    });

    it('keyboard: Ctrl+Shift+E/G/F pick views; Shift+Ctrl+G is not find-previous', async () => {
      await startApp();
      ctrlShift('G');
      expect(pressed('act-changes')).toBe('true');
      ctrlShift('G');
      expect(sidebarHidden()).toBe(true);

      ctrlShift('F');
      expect(pressed('act-search')).toBe('true');
      expect(document.activeElement).toBe($('search-input'));
      // Search showing but not focused: the shortcut focuses it, not closes.
      ($('search-input') as HTMLInputElement).blur();
      ctrlShift('F');
      expect(sidebarHidden()).toBe(false);
      expect(document.activeElement).toBe($('search-input'));
      ctrlShift('F');
      expect(sidebarHidden()).toBe(true);

      ctrlShift('E');
      expect(pressed('act-files')).toBe('true');

      // In a focused terminal Ctrl+Shift+E is "split down": the activity bar
      // leaves it alone (not handled, not stopped).
      ctrlShift('G');
      expect(pressed('act-changes')).toBe('true');
      const pane = document.createElement('div');
      pane.tabIndex = 0;
      $('terminal-host').appendChild(pane);
      const ev = new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      pane.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(pressed('act-changes')).toBe('true');
      pane.remove();
      ctrlShift('E'); // outside a terminal it opens Files again
      expect(pressed('act-files')).toBe('true');

      // macOS: the native View menu items do the same.
      emitTauriEvent(MENU.SHOW_CHANGES);
      expect(pressed('act-changes')).toBe('true');
    });

    it('Remote and Settings buttons open their dialogs', async () => {
      const app = await startApp();
      const openRemote = vi.fn();
      app.setRemoteHandler({
        attach() {},
        openFolder: (dir: string, open: (p: string) => Promise<void>) => open(dir),
        openRemoteDialog: openRemote,
      } as never);
      $('act-remote').click();
      expect(openRemote).toHaveBeenCalledTimes(1);
      $('act-settings').click();
      await flush();
      expect(document.querySelector('.settings-overlay, .settings-dialog')).toBeTruthy();
    });

    it('searches the folder, groups results by file and opens a hit at its line', async () => {
      vfs.set('/repo/notes/a.md', 'one\ntwo\nsay find me here\nfour');
      searchState.results = {
        truncated: false,
        matches: [
          { path: '/repo/notes/a.md', line: 3, column: 5, preview: 'say find me here', match_start: 4, match_end: 11 },
          { path: '/repo/notes/a.md', line: 4, column: 1, preview: 'four', match_start: 0, match_end: 4 },
          { path: '/repo/b.md', line: 1, column: 1, preview: 'find me', match_start: 0, match_end: 7 },
        ],
      };
      const app = await startApp();
      await app.openFolder('/repo');
      $('act-search').click();
      const input = $('search-input') as HTMLInputElement;
      input.value = 'find me';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flush();
      await flush();

      const call = invokeCalls.find((c) => c.cmd === 'search_in_files');
      expect(call?.args).toMatchObject({ root: '/repo', query: 'find me' });
      const groups = [...document.querySelectorAll('.search-file')].map((g) => g.textContent);
      expect(groups).toEqual(['notes/a.md2', 'b.md1']);
      const hits = document.querySelectorAll<HTMLElement>('.search-hit');
      expect(hits).toHaveLength(3);
      expect(hits[0].querySelector('b')?.textContent).toBe('find me');
      expect($('search-status').textContent).toBe('3 results in 2 files');

      hits[0].click();
      await flush();
      await flush();
      expect(tabTitles()).toContain('a.md');
      const view = await editorView();
      const head = view.state.selection.main.head;
      expect(view.state.doc.lineAt(head).number).toBe(3);
      expect(head - view.state.doc.line(3).from).toBe(4);

      // Another machine: results name paths on the old one, so they go.
      app.commitOriginSwitch('box');
      expect(document.querySelectorAll('.search-hit')).toHaveLength(0);
    });

    it('shows "No results." for an empty reply', async () => {
      const app = await startApp();
      await app.openFolder('/repo');
      $('act-search').click();
      const input = $('search-input') as HTMLInputElement;
      input.value = 'nothing';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flush();
      await flush();
      expect($('search-status').textContent).toBe('No results.');
    });
  });

  describe('quick open and command palette', () => {
    const typeInPalette = async (text: string) => {
      const input = document.querySelector<HTMLInputElement>('.pal-input')!;
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    };
    const pressInPalette = async (key: string, init: KeyboardEventInit = {}) => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      );
      await flush();
      await flush();
    };

    it('Cmd+P (menu) finds a workspace file and opens it', async () => {
      vfs.set('/ws/README.md', '# readme');
      vfs.set('/ws/docs/agent-context-design.md', '# design');
      directories.add('/ws');
      const app = await startApp();
      await app.openFolder('/ws');
      await flush();

      emitTauriEvent(MENU.QUICK_OPEN, {});
      await flush();
      expect(document.querySelector('.palette')).not.toBeNull();
      expect(document.getElementById('app')!.hasAttribute('inert')).toBe(true);
      await typeInPalette('agcon');
      await pressInPalette('Enter');

      expect(document.querySelector('.palette')).toBeNull();
      expect(tabTitles()).toContain('agent-context-design.md');
      const list = invokeCalls.find((c) => c.cmd === 'list_workspace_files');
      expect(list?.args).toEqual({ root: '/ws', includeHidden: false });
    });

    it('Cmd+Shift+P (menu) runs a command', async () => {
      vfs.set('/ws/a.md', 'a');
      restoreConfig(['/ws/a.md']);
      await startApp();
      const wrapBefore = document.getElementById('status-wrap')!.textContent;

      emitTauriEvent(MENU.COMMAND_PALETTE, {});
      await flush();
      expect(document.querySelector('.pal-mode')!.textContent).toBe('>');
      await typeInPalette('toggle word wrap');
      await pressInPalette('Enter');

      expect(document.getElementById('status-wrap')!.textContent).not.toBe(wrapBefore);
    });

    it('view commands switch the document between edit, preview and split', async () => {
      vfs.set('/ws/a.md', '# a');
      restoreConfig(['/ws/a.md']);
      await startApp();
      const editorHidden = () => document.getElementById('editor-container')!.classList.contains('hidden');
      const previewHidden = () =>
        document.getElementById('preview-pane')!.parentElement!.classList.contains('hidden');

      const run = async (q: string) => {
        emitTauriEvent(MENU.COMMAND_PALETTE, {});
        await flush();
        await typeInPalette(q);
        await pressInPalette('Enter');
      };
      await run('view preview only');
      expect([editorHidden(), previewHidden()]).toEqual([true, false]);
      await run('view edit only');
      expect([editorHidden(), previewHidden()]).toEqual([false, true]);
      await run('view edit and preview');
      expect([editorHidden(), previewHidden()]).toEqual([false, false]);
    });

    it('view commands open the activity bar views (and never toggle them closed)', async () => {
      directories.add('/ws');
      const app = await startApp();
      await app.openFolder('/ws');
      await flush();
      const $ = (id: string) => document.getElementById(id)!;
      const run = async (q: string) => {
        emitTauriEvent(MENU.COMMAND_PALETTE, {});
        await flush();
        await typeInPalette(q);
        await pressInPalette('Enter');
      };
      await run('view show changes');
      expect($('sidebar-changes').hidden).toBe(false);
      expect($('act-changes').getAttribute('aria-pressed')).toBe('true');
      await run('view show changes');
      expect($('sidebar-changes').hidden).toBe(false);
      await run('view search in files');
      expect($('sidebar-search').hidden).toBe(false);
      expect(document.activeElement).toBe($('search-input'));
      await run('view toggle sidebar');
      expect($('act-search').getAttribute('aria-pressed')).toBe('false');
      await run('view show files');
      expect($('sidebar-files').hidden).toBe(false);
      expect($('act-files').getAttribute('aria-pressed')).toBe('true');
    });

    it('lists and opens files on the SSH host while a remote folder is open', async () => {
      remoteVfs.set('/home/u/proj/notes/todo.md', 'remote todo');
      const app = await startApp();
      installRemoteSessions(app);
      await flush();
      await app.openFolder('ssh://dev/home/u/proj');
      await flush();
      invokeCalls.length = 0;

      emitTauriEvent(MENU.QUICK_OPEN, {});
      await flush();
      await flush();
      await typeInPalette('todo');
      await pressInPalette('Enter');

      const list = invokeCalls.find((c) => c.cmd === 'list_workspace_files');
      expect(list?.args).toEqual({ root: '/home/u/proj', includeHidden: false });
      expect(tabTitles()).toEqual(['todo.md']);
    });
  });

  // A workspace reached through a symlink (macOS /tmp -> /private/tmp): the
  // backend now reports the repo top level in the workspace's own spelling
  // (`/tmp/x`, not git's canonical `/private/tmp/x`), so every consumer that
  // joins git paths onto it lands on the paths the tabs and tree use.
  describe('workspace opened through a symlinked path', () => {
    const $ = (id: string) => document.getElementById(id)!;
    const settle = async () => {
      for (let i = 0; i < 6; i++) await flush();
    };

    it('enables Diff, badges the tree row, and matches the queue to the open tab', async () => {
      vfs.set('/tmp/x/docs/a.md', '# A');
      vfs.set('/tmp/x/docs/b.md', '# B');
      git.topLevel = '/tmp/x';
      gitChanges.push({ path: 'docs/a.md', status: 'modified', staged: false });
      const badges = vi.spyOn(FileTree.prototype, 'setGitStatus');
      const app = await startApp();
      await app.openFolder('/tmp/x/docs');
      await settle();
      emitTauriEvent(MENU.OPEN_FILE_PATH, { path: '/tmp/x/docs/a.md' });
      await flush();
      await flush();
      await gitSettle();

      // Diff view mode is available for the modified file.
      expect(viewDisabled('diff')).toBe(false);
      // Tree badge keyed by the tab's own path (git path joined onto the top
      // level). Local listings are empty in the mocks, so read the map.
      const marks = badges.mock.calls[badges.mock.calls.length - 1]?.[0];
      expect(marks ? [...marks] : []).toEqual([['/tmp/x/docs/a.md', 'M']]);
      expect($('changes-badge').textContent).toBe('1');

      // Opening Changes selects the open tab's row and shows its diff (no
      // second tab opened under another spelling).
      $('act-changes').click();
      await vi.waitFor(() =>
        expect(document.querySelector('#changes-list .change-row.current')?.getAttribute('data-path')).toBe(
          'docs/a.md',
        ),
      );
      expect(tabTitles()).toEqual(['a.md']);
      expect($('diff-view').classList.contains('hidden')).toBe(false);
      const diff = invokeCalls.filter((c) => c.cmd === 'git_diff_file').pop();
      expect(diff?.args).toMatchObject({ root: '/tmp/x', path: 'docs/a.md' });
      // Review state and the status bar branch key off the same spelling.
      const load = invokeCalls.filter((c) => c.cmd === 'review_state_load').pop();
      expect(String(load?.args?.workspace)).toMatch(/\n\/tmp\/x$/);
      const branch = invokeCalls.filter((c) => c.cmd === 'git_branch_status').pop();
      expect(branch?.args).toMatchObject({ root: '/tmp/x' });
      badges.mockRestore();
    });
  });
});
