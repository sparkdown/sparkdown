import type { CommandRegistry, Command } from '../commands';
import type { EventBus } from '../events';
import type { TabManager } from '../tabs';
import { ACTIONS, type ActionName } from '../event-names';
import { KEYBINDINGS, terminalPaneShortcut } from '../shortcuts';
import { isPreviewable } from '../utils';
import { viewAccelerator, type SidebarView } from '../activity-bar';
import { effectiveView } from '../view-mode';

export type ViewMode = 'edit' | 'split' | 'preview' | 'diff';

/** What the built-in commands reach beyond the bus actions. */
export interface BuiltinCommandTargets {
  bus: EventBus;
  tabs: Pick<TabManager, 'activeTab' | 'getAllTabs'>;
  /** Workspace folder, or null. */
  root(): string | null;
  setViewMode(mode: ViewMode): void;
  showSidebarView(view: SidebarView): void;
  openLinePrompt(): void;
  toggleHtmlScripts(): void;
  checkForUpdates(): void;
  /** The terminal split grid (CockpitController). */
  terminal: {
    isVisible(): boolean;
    split(dir: 'right' | 'down'): void | Promise<void>;
    closePane(): void;
    focusPane(delta: 1 | -1): void;
  };
}

/**
 * The app's own commands, registered once at startup. Most emit the same
 * bus action as their shortcut / toolbar button (app/actions.ts routes it),
 * so the palette, the key and the menu all take one path.
 */
export function registerBuiltinCommands(reg: CommandRegistry, t: BuiltinCommandTargets): () => void {
  const emit = (action: ActionName) => () => t.bus.emit(action);
  const hasTab = () => t.tabs.activeTab() !== null;
  const editable = () => {
    const tab = t.tabs.activeTab();
    return !!tab && effectiveView(tab.viewMode, tab.path) !== 'diff';
  };
  const previewable = () => {
    const tab = t.tabs.activeTab();
    return !!tab && isPreviewable(tab.path);
  };
  const multipleTabs = () => t.tabs.getAllTabs().length > 1;
  const terminalShown = () => t.terminal.isVisible();

  /** A command that emits `action`; its key comes from KEYBINDINGS. */
  const act = (id: string, title: string, action: ActionName, extra: Partial<Command> = {}): Command => ({
    id,
    title,
    keys: KEYBINDINGS[action],
    run: emit(action),
    ...extra,
  });

  const format = (id: string, title: string, action: ActionName): Command =>
    act(id, title, action, { enabled: editable });

  return reg.register(
    act('file.new', 'File: New file', ACTIONS.NEW_FILE),
    act('file.open', 'File: Open file…', ACTIONS.OPEN_FILE),
    act('file.openFolder', 'File: Open folder…', ACTIONS.OPEN_FOLDER),
    act('remote.openFolder', 'Remote: Open remote folder…', ACTIONS.OPEN_REMOTE),
    act('file.save', 'File: Save', ACTIONS.SAVE, { enabled: hasTab }),
    act('file.saveAs', 'File: Save as…', ACTIONS.SAVE_AS, { enabled: hasTab }),
    act('file.exportHtml', 'File: Export HTML…', ACTIONS.EXPORT_HTML, { enabled: hasTab }),
    act('file.closeTab', 'File: Close tab', ACTIONS.CLOSE_TAB, { enabled: hasTab }),

    act('go.file', 'Go: Go to file…', ACTIONS.QUICK_OPEN),
    {
      id: 'go.line',
      title: 'Go: Go to line…',
      run: () => t.openLinePrompt(),
      enabled: editable,
    },
    act('tabs.next', 'Tabs: Next tab', ACTIONS.NEXT_TAB, { enabled: multipleTabs }),
    act('tabs.previous', 'Tabs: Previous tab', ACTIONS.PREV_TAB, { enabled: multipleTabs }),

    act('edit.find', 'Edit: Find', ACTIONS.FIND, { enabled: hasTab }),
    format('format.bold', 'Format: Bold', ACTIONS.BOLD),
    format('format.italic', 'Format: Italic', ACTIONS.ITALIC),
    format('format.heading', 'Format: Heading', ACTIONS.HEADING),
    format('format.bulletList', 'Format: Bulleted list', ACTIONS.UNORDERED_LIST),
    format('format.numberedList', 'Format: Numbered list', ACTIONS.ORDERED_LIST),
    format('format.codeBlock', 'Format: Code block', ACTIONS.CODE_BLOCK),
    format('format.inlineCode', 'Format: Inline code', ACTIONS.INLINE_CODE),
    format('format.quote', 'Format: Quote', ACTIONS.QUOTE),
    format('format.link', 'Format: Link', ACTIONS.LINK),
    format('format.image', 'Format: Image', ACTIONS.IMAGE),
    format('format.table', 'Format: Table', ACTIONS.TABLE),

    act('view.toggleSidebar', 'View: Toggle sidebar', ACTIONS.TOGGLE_SIDEBAR),
    {
      id: 'view.files',
      title: 'View: Show files',
      keys: viewAccelerator('files'),
      keywords: 'explorer sidebar',
      run: () => t.showSidebarView('files'),
    },
    {
      id: 'view.changes',
      title: 'View: Show changes',
      keys: viewAccelerator('changes'),
      keywords: 'git diff review sidebar',
      run: () => t.showSidebarView('changes'),
      enabled: () => t.root() !== null,
    },
    {
      id: 'view.search',
      title: 'View: Search in files',
      keys: viewAccelerator('search'),
      keywords: 'grep find text sidebar',
      run: () => t.showSidebarView('search'),
      enabled: () => t.root() !== null,
    },
    {
      id: 'view.edit',
      title: 'View: Edit only',
      keywords: 'editor mode',
      run: () => t.setViewMode('edit'),
      enabled: hasTab,
    },
    {
      id: 'view.split',
      title: 'View: Edit and preview (split)',
      keywords: 'mode side by side',
      run: () => t.setViewMode('split'),
      enabled: previewable,
    },
    {
      id: 'view.preview',
      title: 'View: Preview only',
      keywords: 'reading mode',
      run: () => t.setViewMode('preview'),
      enabled: previewable,
    },
    {
      id: 'view.diff',
      title: 'View: Diff',
      keywords: 'git changes mode',
      run: () => t.setViewMode('diff'),
      enabled: () => !!t.tabs.activeTab()?.path,
    },
    act('view.toggleWrap', 'View: Toggle word wrap', ACTIONS.TOGGLE_WRAP),
    act('view.toggleTheme', 'View: Toggle theme', ACTIONS.TOGGLE_THEME, { keywords: 'dark light' }),
    {
      id: 'preview.toggleScripts',
      title: 'Preview: Toggle JavaScript in HTML preview',
      run: () => t.toggleHtmlScripts(),
    },

    act('terminal.toggle', 'Terminal: Toggle terminal', ACTIONS.TOGGLE_TERMINAL),
    act('terminal.only', 'Terminal: Terminals only', ACTIONS.TOGGLE_TERMINALS_ONLY, {
      keywords: 'maximize full height',
    }),
    // Pane keys act only while a terminal has focus; the palette runs these
    // on the focused pane (it stays the grid's focus while the palette is up).
    {
      id: 'terminal.splitRight',
      title: 'Terminal: Split right',
      shortcut: terminalPaneShortcut('split-right'),
      keywords: 'pane new',
      // Opens the terminal when it is hidden.
      run: () => t.terminal.split('right'),
    },
    {
      id: 'terminal.splitDown',
      title: 'Terminal: Split down',
      shortcut: terminalPaneShortcut('split-down'),
      keywords: 'pane new',
      run: () => t.terminal.split('down'),
    },
    {
      id: 'terminal.closePane',
      title: 'Terminal: Close pane',
      shortcut: terminalPaneShortcut('close-pane'),
      run: () => t.terminal.closePane(),
      enabled: terminalShown,
    },
    {
      id: 'terminal.focusNext',
      title: 'Terminal: Focus next pane',
      shortcut: terminalPaneShortcut('focus-next'),
      run: () => t.terminal.focusPane(1),
      enabled: terminalShown,
    },
    {
      id: 'terminal.focusPrevious',
      title: 'Terminal: Focus previous pane',
      shortcut: terminalPaneShortcut('focus-prev'),
      run: () => t.terminal.focusPane(-1),
      enabled: terminalShown,
    },

    act('app.settings', 'Preferences: Open settings', ACTIONS.SHOW_SETTINGS),
    act('help.shortcuts', 'Help: Keyboard shortcuts', ACTIONS.SHOW_SHORTCUTS),
    {
      id: 'help.checkUpdates',
      title: 'Help: Check for updates…',
      run: () => t.checkForUpdates(),
    },
    act('app.quit', 'App: Quit', ACTIONS.QUIT),
  );
}
