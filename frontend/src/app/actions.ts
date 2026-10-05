import type { EventCallback } from '@tauri-apps/api/event';
import type { EditorManager } from '../editor';
import type { EventBus } from '../events';
import type { FileTree } from '../file-tree';
import type { TabManager } from '../tabs';
import type { ThemeManager } from '../theme';
import { showShortcutsDialog } from '../shortcuts-dialog';
import { MENU, ACTIONS } from '../event-names';
import type { PaneController } from './panes';
import type { CockpitController } from './cockpit';
import type { HtmlScriptsController } from './html-scripts';
import type { LifecycleController } from './lifecycle';
import type { Palette } from '../palette';
import type { ViewModeController } from './view-mode';

/** Everything a native-menu item or keyboard shortcut can trigger. */
export interface ActionTargets {
  bus: EventBus;
  editor: EditorManager;
  tabs: TabManager;
  fileTree: FileTree;
  theme: ThemeManager;
  panes: Pick<PaneController, 'openFind'>;
  /** The active document's view (Edit | Split | Preview | Diff). */
  viewMode: Pick<ViewModeController, 'setViewMode' | 'togglePreview' | 'toggleEditor'>;
  cockpit: Pick<
    CockpitController,
    | 'toggleTerminal'
    | 'toggleTerminalsOnly'
    | 'splitTerminal'
    | 'closeTerminalPane'
    | 'focusTerminalPane'
    | 'hasTerminalFocus'
  >;
  htmlScripts: Pick<HtmlScriptsController, 'toggle'>;
  lifecycle: Pick<LifecycleController, 'requestQuit'>;
  palette: Pick<Palette, 'open'>;
  newFile(): void;
  openFile(path: string): Promise<void>;
  openFileDialog(): Promise<void>;
  openFolderDialog(): Promise<void>;
  save(): Promise<boolean>;
  saveAs(): Promise<boolean>;
  exportHtml(): Promise<void>;
  openSettings(): void;
  /** Settings, scrolled to Agents (status bar "Agent tools"). */
  openAgentSettings(): void;
  /** The remote handler's "Open Remote Folder" dialog (no-op without one). */
  openRemoteDialog(): void;
  checkForUpdates(): void;
  listenTauri<T>(event: string, handler: EventCallback<T>): void;
}

/** ⌘W / Close Tab: closes the focused terminal pane when a terminal has
 *  keyboard focus, otherwise the current document tab. */
function closeTabOrPane(t: ActionTargets): void {
  if (t.cockpit.hasTerminalFocus()) t.cockpit.closeTerminalPane();
  else t.tabs.closeCurrent();
}

/** Native menu items (Rust emits one Tauri event per item). */
export function registerMenuListeners(t: ActionTargets): void {
  const reg = (event: string, handler: (e?: any) => void) => {
    t.listenTauri(event, handler);
  };
  reg(MENU.NEW_FILE, () => t.newFile());
  reg(MENU.NEW_TAB, () => t.newFile());
  reg(MENU.OPEN_FILE, () => t.openFileDialog());
  reg(MENU.OPEN_FOLDER, () => void t.openFolderDialog());
  reg(MENU.SAVE, () => t.save());
  reg(MENU.SAVE_AS, () => t.saveAs());
  reg(MENU.TOGGLE_THEME, () => t.theme.toggle());
  reg(MENU.VIEW_EDIT, () => t.viewMode.setViewMode('edit'));
  reg(MENU.VIEW_SPLIT, () => t.viewMode.setViewMode('split'));
  reg(MENU.VIEW_PREVIEW, () => t.viewMode.setViewMode('preview'));
  reg(MENU.VIEW_DIFF, () => t.viewMode.setViewMode('diff'));
  reg(MENU.TOGGLE_TERMINAL, () => void t.cockpit.toggleTerminal());
  reg(MENU.TOGGLE_TERMINALS_ONLY, () => void t.cockpit.toggleTerminalsOnly());
  reg(MENU.TOGGLE_SIDEBAR, () => t.fileTree.toggle());
  reg(MENU.TOGGLE_WORD_WRAP, () => t.editor.toggleWordWrap());
  reg(MENU.TOGGLE_HTML_JS, () => t.htmlScripts.toggle(false));
  reg(MENU.EXPORT_HTML, () => t.exportHtml());
  reg(MENU.FIND, () => t.panes.openFind());
  reg(MENU.SHOW_SHORTCUTS, () => showShortcutsDialog());
  reg(MENU.SHOW_SETTINGS, () => t.openSettings());
  reg(MENU.CHECK_UPDATES, () => t.checkForUpdates());
  reg(MENU.CLOSE_TAB, () => closeTabOrPane(t));
  reg(MENU.TERMINAL_SPLIT_RIGHT, () => void t.cockpit.splitTerminal('right'));
  reg(MENU.TERMINAL_SPLIT_DOWN, () => void t.cockpit.splitTerminal('down'));
  reg(MENU.TERMINAL_CLOSE_PANE, () => t.cockpit.closeTerminalPane());
  reg(MENU.TERMINAL_FOCUS_NEXT, () => t.cockpit.focusTerminalPane(1));
  reg(MENU.TERMINAL_FOCUS_PREV, () => t.cockpit.focusTerminalPane(-1));
  reg(MENU.QUICK_OPEN, () => t.palette.open('files'));
  reg(MENU.COMMAND_PALETTE, () => t.palette.open('commands'));
  reg(MENU.OPEN_FILE_PATH, (event: any) => {
    const path = event.payload?.path;
    if (path) t.openFile(path);
  });
}

/** Keyboard shortcuts and toolbar buttons (ShortcutManager / Toolbar emit
 *  ACTIONS.* on the bus). */
export function registerActionListeners(t: ActionTargets): void {
  t.bus.on(ACTIONS.NEW_FILE, () => t.newFile());
  t.bus.on(ACTIONS.OPEN_FILE, () => t.openFileDialog());
  t.bus.on(ACTIONS.OPEN_FOLDER, () => void t.openFolderDialog());
  t.bus.on(ACTIONS.OPEN_REMOTE, () => t.openRemoteDialog());
  t.bus.on(ACTIONS.SAVE, () => t.save());
  t.bus.on(ACTIONS.SAVE_AS, () => t.saveAs());
  t.bus.on(ACTIONS.CLOSE_TAB, () => closeTabOrPane(t));
  t.bus.on(ACTIONS.EXPORT_HTML, () => t.exportHtml());
  t.bus.on(ACTIONS.FIND, () => t.panes.openFind());
  // Ctrl+Q (Windows/Linux) must take the same guarded path as Cmd+Q.
  t.bus.on(ACTIONS.QUIT, () => void t.lifecycle.requestQuit());
  t.bus.on(ACTIONS.BOLD, () => t.editor.wrapSelection('**', '**'));
  t.bus.on(ACTIONS.ITALIC, () => t.editor.wrapSelection('_', '_'));
  t.bus.on(ACTIONS.HEADING, () => t.editor.insertLinePrefix('## '));
  t.bus.on(ACTIONS.UNORDERED_LIST, () => t.editor.insertLinePrefix('- '));
  t.bus.on(ACTIONS.ORDERED_LIST, () => t.editor.insertLinePrefix('1. '));
  t.bus.on(ACTIONS.CODE_BLOCK, () =>
    t.editor.wrapSelection('```\n', '\n```')
  );
  t.bus.on(ACTIONS.INLINE_CODE, () =>
    t.editor.wrapSelection('`', '`')
  );
  t.bus.on(ACTIONS.QUOTE, () => t.editor.insertLinePrefix('> '));
  t.bus.on(ACTIONS.LINK, () => t.editor.wrapSelection('[', '](url)'));
  t.bus.on(ACTIONS.IMAGE, () =>
    t.editor.insertAtCursor('![alt text](image.png)')
  );
  t.bus.on(ACTIONS.TABLE, () =>
    t.editor.insertAtCursor('| Header | Header | Header |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n| Cell | Cell | Cell |\n')
  );
  t.bus.on(ACTIONS.TOGGLE_SIDEBAR, () => t.fileTree.toggle());
  t.bus.on(ACTIONS.TOGGLE_PREVIEW, () => t.viewMode.togglePreview());
  t.bus.on(ACTIONS.TOGGLE_TERMINAL, () => void t.cockpit.toggleTerminal());
  t.bus.on(ACTIONS.TOGGLE_TERMINALS_ONLY, () => void t.cockpit.toggleTerminalsOnly());
  t.bus.on(ACTIONS.TOGGLE_EDITOR, () => t.viewMode.toggleEditor());
  t.bus.on(ACTIONS.SET_VIEW_MODE, ({ mode }) => t.viewMode.setViewMode(mode));
  t.bus.on(ACTIONS.TOGGLE_WRAP, () => t.editor.toggleWordWrap());
  t.bus.on(ACTIONS.GOTO_LINE, () => t.editor.openGotoLine());
  t.bus.on(ACTIONS.SHOW_AGENT_SETTINGS, () => t.openAgentSettings());
  t.bus.on(ACTIONS.TOGGLE_THEME, () => t.theme.toggle());
  t.bus.on(ACTIONS.NEXT_TAB, () => t.tabs.switchNext());
  t.bus.on(ACTIONS.PREV_TAB, () => t.tabs.switchPrev());
  t.bus.on(ACTIONS.SHOW_SHORTCUTS, () => showShortcutsDialog());
  t.bus.on(ACTIONS.SHOW_SETTINGS, () => t.openSettings());
  t.bus.on(ACTIONS.QUICK_OPEN, () => t.palette.open('files'));
  t.bus.on(ACTIONS.COMMAND_PALETTE, () => t.palette.open('commands'));
}
