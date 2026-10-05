import { EventBus } from './events';
import { ACTIONS, type ActionName } from './event-names';
import { isMacOS } from './utils';
import { viewForDigit } from './view-mode';

/**
 * The key for each bus action, in Tauri accelerator syntax (the same strings
 * as src-tauri/src/menu.rs). One table for display: the command palette and
 * any other label read it through formatShortcut(). handleKeydown below is
 * the JS side of the same bindings (the native menu owns most of them on
 * macOS); shortcuts.test.ts presses every entry here and checks that it
 * dispatches, and that menu.rs uses the same accelerator.
 *
 * A new binding goes here, next to the handler that implements it.
 */
export const KEYBINDINGS: Partial<Record<ActionName, string>> = {
  [ACTIONS.NEW_FILE]: 'CmdOrCtrl+N',
  [ACTIONS.OPEN_FILE]: 'CmdOrCtrl+O',
  [ACTIONS.OPEN_FOLDER]: 'CmdOrCtrl+Alt+O',
  [ACTIONS.OPEN_REMOTE]: 'CmdOrCtrl+Shift+O',
  [ACTIONS.SAVE]: 'CmdOrCtrl+S',
  [ACTIONS.SAVE_AS]: 'CmdOrCtrl+Shift+S',
  [ACTIONS.CLOSE_TAB]: 'CmdOrCtrl+W',
  // Menu accelerator; the JS side is PaneController's own Cmd+F routing.
  [ACTIONS.FIND]: 'CmdOrCtrl+F',
  [ACTIONS.QUIT]: 'CmdOrCtrl+Q',
  [ACTIONS.BOLD]: 'CmdOrCtrl+B',
  [ACTIONS.ITALIC]: 'CmdOrCtrl+I',
  [ACTIONS.TOGGLE_SIDEBAR]: 'CmdOrCtrl+Shift+B',
  [ACTIONS.TOGGLE_WRAP]: 'CmdOrCtrl+Shift+W',
  [ACTIONS.TOGGLE_TERMINAL]: 'Ctrl+`',
  [ACTIONS.TOGGLE_TERMINALS_ONLY]: 'Ctrl+Shift+`',
  [ACTIONS.NEXT_TAB]: 'CmdOrCtrl+Alt+Right',
  [ACTIONS.PREV_TAB]: 'CmdOrCtrl+Alt+Left',
  [ACTIONS.SHOW_SHORTCUTS]: 'CmdOrCtrl+Shift+H',
  [ACTIONS.SHOW_SETTINGS]: 'CmdOrCtrl+,',
  [ACTIONS.QUICK_OPEN]: 'CmdOrCtrl+P',
  [ACTIONS.COMMAND_PALETTE]: 'CmdOrCtrl+Shift+P',
};

/** The display label for a bound action (e.g. "⌘⇧P" / "Ctrl+Shift+P"). */
export function shortcutFor(action: string, mac = isMacOS()): string {
  const accel = KEYBINDINGS[action as ActionName];
  return accel ? formatShortcut(accel, mac) : '';
}

const MAC_GLYPHS: Record<string, string> = {
  CmdOrCtrl: '⌘', Cmd: '⌘', Command: '⌘', Ctrl: '⌃', Control: '⌃',
  Alt: '⌥', Option: '⌥', Shift: '⇧',
};
const KEY_NAMES: Record<string, string> = {
  Right: '→', Left: '←', Up: '↑', Down: '↓', Enter: '↩', Space: 'Space',
};

/** Tauri accelerator → label: macOS glyphs ("⌘⌥O"), elsewhere words
 *  ("Ctrl+Alt+O"). Modifier order follows the accelerator. */
export function formatShortcut(accel: string, mac = isMacOS()): string {
  const parts = accel.split('+');
  // "Ctrl+Shift++" style: an empty last part means the key is "+".
  if (parts[parts.length - 1] === '' && parts.length > 1) {
    parts.splice(parts.length - 2, 2, '+');
  }
  const key = parts.pop() ?? '';
  const keyLabel = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (mac) return parts.map((m) => MAC_GLYPHS[m] ?? m).join('') + keyLabel;
  const words = parts.map((m) => (m === 'CmdOrCtrl' || m === 'Cmd' || m === 'Command' ? 'Ctrl' : m === 'Option' ? 'Alt' : m));
  return [...words, keyLabel].join('+');
}

export class ShortcutManager {
  private bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  init(): void {
    document.addEventListener('keydown', (e) => this.handleKeydown(e));
  }

  private handleKeydown(e: KeyboardEvent): void {
    // When the editor has focus, CodeMirror's high-precedence keymap handles
    // formatting (Cmd/Ctrl+B/I) first and calls preventDefault. Bail so we
    // don't fire the same action a second time (which would wrap an already
    // wrapped/selected range).
    if (e.defaultPrevented) return;

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    const key = e.key.toLowerCase();
    // Formatting uses the platform's primary accelerator only — Cmd on macOS,
    // Ctrl elsewhere. On macOS, Ctrl+B / Ctrl+I are editor cursor motions, not
    // formatting, so they must not italicize/bolden. (The pane/menu shortcuts
    // below intentionally accept either modifier.)
    const primary = isMacOS() ? e.metaKey : e.ctrlKey;

    // Formatting + a few pane shortcuts are handled in JS on every platform.
    // File/view accelerators come from the native macOS menu bar; on
    // Windows/Linux there is no menu bar (popup only), so JS owns them.
    if (key === 'b' && !e.shiftKey) {
      if (!primary) return;
      e.preventDefault();
      this.bus.emit(ACTIONS.BOLD);
      return;
    }
    if (key === 'i' && !e.shiftKey) {
      if (!primary) return;
      e.preventDefault();
      this.bus.emit(ACTIONS.ITALIC);
      return;
    }
    if (key === 'b' && e.shiftKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.TOGGLE_SIDEBAR);
      return;
    }
    if (e.key === 'ArrowRight' && e.altKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.NEXT_TAB);
      return;
    }
    if (e.key === 'ArrowLeft' && e.altKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.PREV_TAB);
      return;
    }
    // Menu accelerator is Ctrl+` on every platform (not Cmd).
    if (e.key === '`' && !e.shiftKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.TOGGLE_TERMINAL);
      return;
    }
    // Terminals-only layout. Ctrl+Shift+` on every platform.
    if (e.key === '`' && e.shiftKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.TOGGLE_TERMINALS_ONLY);
      return;
    }

    if (isMacOS()) return;

    if (key === 'n' && !e.shiftKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.NEW_FILE);
    } else if (key === 't' && !e.shiftKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.NEW_FILE);
    } else if (key === 'o' && e.altKey && !e.shiftKey) {
      // Mirrors File → Open Folder... (CmdOrCtrl+Alt+O). Native accelerators
      // only fire from the macOS menu bar; Win/Linux popup menus need this
      // JS twin (same pattern as Open Remote below).
      e.preventDefault();
      this.bus.emit(ACTIONS.OPEN_FOLDER);
    } else if (key === 'o' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.OPEN_FILE);
    } else if (key === 'o' && e.shiftKey && !e.altKey) {
      // Mirrors File → Open Remote Folder... (CmdOrCtrl+Shift+O). Native
      // accelerators only fire from the macOS menu bar; Win/Linux popup menus
      // need this JS twin (same pattern as the other File shortcuts above).
      e.preventDefault();
      this.bus.emit(ACTIONS.OPEN_REMOTE);
    } else if (key === 's' && !e.shiftKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.SAVE);
    } else if (key === 's' && e.shiftKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.SAVE_AS);
    } else if (key === 'w' && !e.shiftKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.CLOSE_TAB);
    } else if (key === 'p') {
      // Mirrors View → Go to File... / Command Palette... (menu.rs).
      e.preventDefault();
      this.bus.emit(e.shiftKey ? ACTIONS.COMMAND_PALETTE : ACTIONS.QUICK_OPEN);
    } else if (viewForDigit(e.key) && !e.shiftKey && !e.altKey) {
      // Mirrors View → Edit / Split / Preview / Diff (CmdOrCtrl+1–4).
      e.preventDefault();
      this.bus.emit(ACTIONS.SET_VIEW_MODE, { mode: viewForDigit(e.key)! });
    } else if (key === 'w' && e.shiftKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.TOGGLE_WRAP);
    } else if (key === 'h' && e.shiftKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.SHOW_SHORTCUTS);
    } else if (key === ',' && !e.shiftKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.SHOW_SETTINGS);
    } else if (key === 'q' && !e.shiftKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.QUIT);
    }
  }
}

/** What a key press inside a focused terminal pane does to the split grid. */
export type TerminalPaneAction =
  | 'split-right'
  | 'split-down'
  | 'close-pane'
  | 'focus-next'
  | 'focus-prev';

/**
 * Map a keydown inside a terminal pane to a split action, or null to let the
 * terminal have it. Only consulted while a terminal has keyboard focus, so
 * the editor keeps ⌘D (select next occurrence) and ⌘[ / ⌘] (indent).
 *
 *  - macOS: ⌘D split right, ⌘⇧D split down, ⌘] / ⌘[ next / previous pane.
 *    Close pane is ⌘W, which arrives through the native File → Close Tab
 *    accelerator and is routed to the pane when a terminal has focus
 *    (see app/actions.ts), so it is not mapped here.
 *  - Windows/Linux: Ctrl+Shift+D / Ctrl+Shift+E split right / down,
 *    Ctrl+Shift+W close pane, Ctrl+Shift+] / [ next / previous pane. Plain
 *    Ctrl+D / Ctrl+W stay EOF / delete-word for the shell.
 *
 * ⌘⌥← / ⌘⌥→ already switch document tabs, so pane focus uses brackets (as
 * in iTerm2). Pure, so it is unit-tested without xterm.
 */
export function terminalPaneAction(
  e: Pick<KeyboardEvent, 'type' | 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  mac: boolean,
): TerminalPaneAction | null {
  if (e.type !== 'keydown' || e.altKey) return null;
  const key = e.key.toLowerCase();
  const bracket =
    e.code === 'BracketRight' || key === ']' || key === '}'
      ? 'focus-next'
      : e.code === 'BracketLeft' || key === '[' || key === '{'
        ? 'focus-prev'
        : null;
  if (mac) {
    if (!e.metaKey || e.ctrlKey) return null;
    if (key === 'd') return e.shiftKey ? 'split-down' : 'split-right';
    return e.shiftKey ? null : bracket;
  }
  if (!e.ctrlKey || !e.shiftKey || e.metaKey) return null;
  if (key === 'd') return 'split-right';
  if (key === 'e') return 'split-down';
  if (key === 'w') return 'close-pane';
  return bracket;
}

/**
 * The keys terminalPaneAction() answers to, as accelerators, for labels
 * (palette, shortcuts dialog). shortcuts.test.ts checks each one against
 * terminalPaneAction. macOS close pane is ⌘W via File → Close Tab.
 */
export const TERMINAL_PANE_KEYS: Record<TerminalPaneAction, { mac: string; other: string }> = {
  'split-right': { mac: 'Cmd+D', other: 'Ctrl+Shift+D' },
  'split-down': { mac: 'Cmd+Shift+D', other: 'Ctrl+Shift+E' },
  'close-pane': { mac: 'Cmd+W', other: 'Ctrl+Shift+W' },
  'focus-next': { mac: 'Cmd+]', other: 'Ctrl+Shift+]' },
  'focus-prev': { mac: 'Cmd+[', other: 'Ctrl+Shift+[' },
};

/** Label for a terminal pane key ("⌘D" / "Ctrl+Shift+D"). */
export function terminalPaneShortcut(action: TerminalPaneAction, mac = isMacOS()): string {
  const k = TERMINAL_PANE_KEYS[action];
  return formatShortcut(mac ? k.mac : k.other, mac);
}
