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
  [ACTIONS.NEW_WINDOW]: 'CmdOrCtrl+Shift+N',
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
  [ACTIONS.TOGGLE_FOCUS_MODE]: 'CmdOrCtrl+Shift+Enter',
  [ACTIONS.TOGGLE_WRAP]: 'Alt+Z',
  [ACTIONS.TOGGLE_TERMINAL]: 'Ctrl+`',
  [ACTIONS.TOGGLE_TERMINALS_ONLY]: 'Ctrl+Shift+`',
  // More keys for these in TAB_SWITCH_KEYS.
  [ACTIONS.NEXT_TAB]: 'Ctrl+Tab',
  [ACTIONS.PREV_TAB]: 'Ctrl+Shift+Tab',
  [ACTIONS.SHOW_SHORTCUTS]: 'CmdOrCtrl+Shift+H',
  [ACTIONS.SHOW_SETTINGS]: 'CmdOrCtrl+,',
  [ACTIONS.QUICK_OPEN]: 'CmdOrCtrl+P',
  [ACTIONS.COMMAND_PALETTE]: 'CmdOrCtrl+Shift+P',
};

/**
 * Every key for the next / previous document tab, on every platform (Ctrl is
 * the Control key on macOS too, as in Safari). The first is the one in
 * KEYBINDINGS. Ctrl+Tab and Ctrl+PageDown / PageUp stay with a focused
 * terminal pane (see tabSwitchStep).
 */
export const TAB_SWITCH_KEYS = {
  next: ['Ctrl+Tab', 'Ctrl+PageDown', 'CmdOrCtrl+Alt+Right'],
  prev: ['Ctrl+Shift+Tab', 'Ctrl+PageUp', 'CmdOrCtrl+Alt+Left'],
} as const;

/** All keys for the next or previous tab, for labels ("Ctrl+Tab / …"). */
export function tabSwitchLabel(dir: keyof typeof TAB_SWITCH_KEYS, mac = isMacOS()): string {
  return TAB_SWITCH_KEYS[dir].map((k) => formatShortcut(k, mac)).join(' / ');
}

/**
 * Ctrl+Tab / Ctrl+PageDown → next tab, Ctrl+Shift+Tab / Ctrl+PageUp →
 * previous tab, else null. Control only (no Cmd, no Alt), on every platform.
 * Matched on e.key, which names these keys the same on every layout, or on
 * the physical e.code: WebKitGTK reports Shift+Tab as key "Unidentified"
 * (X11's ISO_Left_Tab) with code "Tab".
 */
export function tabSwitchStep(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & { code?: string },
): 'next' | 'prev' | null {
  if (!e.ctrlKey || e.metaKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  const code = e.code ?? '';
  if (key === 'tab' || code === 'Tab') return e.shiftKey ? 'prev' : 'next';
  if (e.shiftKey) return null;
  if (key === 'pagedown' || code === 'PageDown') return 'next';
  if (key === 'pageup' || code === 'PageUp') return 'prev';
  return null;
}

/** True when a key event comes from inside a terminal pane (xterm.js). */
function fromTerminal(e: Event): boolean {
  const t = e.target;
  return t instanceof Element && t.closest('.xterm') !== null;
}

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
  Tab: '⇥', PageDown: '⇟', PageUp: '⇞',
};
/** Windows/Linux spell Enter, Tab and the page keys out; the arrows read the
 *  same everywhere. */
const KEY_NAMES_OTHER: Record<string, string> = {
  ...KEY_NAMES, Enter: 'Enter', Tab: 'Tab', PageDown: 'PageDown', PageUp: 'PageUp',
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
  const names = mac ? KEY_NAMES : KEY_NAMES_OTHER;
  const keyLabel = names[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (mac) return parts.map((m) => MAC_GLYPHS[m] ?? m).join('') + keyLabel;
  const words = parts.map((m) => (m === 'CmdOrCtrl' || m === 'Cmd' || m === 'Command' ? 'Ctrl' : m === 'Option' ? 'Alt' : m));
  return [...words, keyLabel].join('+');
}

/** Physical key (KeyboardEvent.code) → the US-layout character it carries. */
const CODE_CHARS: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

/**
 * The key a shortcut matches on, lower-cased ("o", "`", ",", "arrowright").
 *
 * `e.key` when it is a plain printable ASCII character, so remapped layouts
 * (AZERTY, Dvorak) keep their letters. Otherwise the physical `e.code`:
 * on Windows, Ctrl+Alt is AltGr, so on US-International or ABNT2 Ctrl+Alt+O
 * reports key "ó", and the backtick is a dead key ("Dead"). Matching on
 * e.key alone made Ctrl+Alt+O and Ctrl+` do nothing there (#16).
 */
export function shortcutKey(
  e: Pick<KeyboardEvent, 'key' | 'code'> & { altKey?: boolean; keyCode?: number },
): string {
  const code = e.code ?? '';
  // macOS Option changes the character (⌥Z is "Ω" on US, ⌥L is "@" on
  // German), so with Option held e.key is useless. WebKit's keyCode is the
  // layout's unmodified key (Z on AZERTY too), the same fallback CodeMirror
  // uses; else the physical e.code.
  if (e.altKey && isMacOS()) {
    const kc = e.keyCode ?? 0;
    if (kc >= 65 && kc <= 90) return String.fromCharCode(kc + 32);
    if (kc >= 48 && kc <= 57) return String.fromCharCode(kc);
    const l = /^Key([A-Z])$/.exec(code);
    if (l) return l[1].toLowerCase();
    const d = /^Digit([0-9])$/.exec(code);
    if (d) return d[1];
  }
  if (/^[\x21-\x7e]$/.test(e.key)) return e.key.toLowerCase();
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return CODE_CHARS[code] ?? e.key.toLowerCase();
}

/** When the keydown handler last toggled wrap (ms since epoch). */
let lastJsWrapToggle = 0;

/** True when a View → Toggle Word Wrap menu event is the same ⌥Z press the
 *  keydown handler already acted on (so wrap doesn't flip twice). */
export function isWrapMenuEcho(now = Date.now()): boolean {
  return now - lastJsWrapToggle < 250;
}

/** The terminal-toggle key: the key left of 1 (Backquote), whatever it
 *  types on this layout (` on US, a dead key on US-International, ~ with
 *  Shift). */
export function isBacktickKey(e: Pick<KeyboardEvent, 'key' | 'code'>): boolean {
  return e.code === 'Backquote' || e.key === '`' || e.key === '~';
}

/**
 * Whether a key pressed inside a terminal pane should skip the shell and
 * reach the app's shortcut handler. Windows/Linux only: there the app
 * shortcuts are JS keydown handlers, and xterm.js would otherwise consume
 * them (Ctrl+` becomes NUL, Ctrl+Alt+O becomes ESC ^O) and cancel the
 * event, so with a terminal focused they did nothing (#16, #21). On macOS
 * the native menu catches them before the web view does.
 *
 * Only app-level keys a shell has no real use for pass: the terminal
 * toggles (Ctrl+` / Ctrl+Shift+`), Open Folder (Ctrl+Alt+O), Open Remote
 * (Ctrl+Shift+O), Command Palette (Ctrl+Shift+P), Shortcuts
 * (Ctrl+Shift+H), Focus Mode (Ctrl+Shift+Enter), Settings (Ctrl+,), Quit
 * (Ctrl+Q) and tab switching (Ctrl+Alt+←/→). Other plain Ctrl+letter, the clipboard (Ctrl+Shift+C/V) and the pane keys
 * (Ctrl+Shift+D/E/W/[/]) stay with the terminal, and so do Ctrl+Tab,
 * Ctrl+Shift+Tab and Ctrl+PageDown / PageUp, which terminal programs use.
 */
export function terminalPassesToApp(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  mac: boolean,
): boolean {
  if (mac || !e.ctrlKey || e.metaKey) return false;
  if (isBacktickKey(e)) return !e.altKey;
  const key = shortcutKey(e);
  if (e.altKey) {
    if (e.shiftKey) return false;
    return key === 'o' || key === 'arrowleft' || key === 'arrowright';
  }
  if (e.shiftKey) return key === 'o' || key === 'p' || key === 'h' || key === 'enter';
  // Ctrl+Q always quits, even from a focused terminal (as in VS Code): the
  // shell loses XON, which nobody types by hand. Same quit flow and prompt.
  return key === ',' || key === 'q';
}

/**
 * Render shortcut labels baked into static HTML for this platform.
 * `data-shortcut="<action>"` sets the element's text to that action's
 * shortcut; `data-shortcut-title="Bold ({action:bold})"` sets its tooltip,
 * with each `{<action>}` replaced. Labels come from KEYBINDINGS, so Windows
 * and Linux read "Ctrl+B" and macOS reads "⌘B".
 */
export function applyShortcutLabels(root: ParentNode = document, mac = isMacOS()): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-shortcut]')) {
    const label = shortcutFor(el.dataset.shortcut ?? '', mac);
    if (label) el.textContent = label;
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-shortcut-title]')) {
    const template = el.dataset.shortcutTitle ?? '';
    el.title = template.replace(/\{([a-z]+:[a-z-]+)\}/g, (_, action: string) => shortcutFor(action, mac));
  }
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

    // Toggle word wrap: Alt+Z / ⌥Z (VS Code's key, #52), matched by the
    // physical key: on macOS ⌥Z reports key "Ω". Handled here on macOS too:
    // an Option-only menu key equivalent is not guaranteed to reach the menu
    // before the focused editor types "Ω". preventDefault marks it handled,
    // and the menu's own echo (if any) is dropped by isWrapMenuEcho().
    if (
      e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      shortcutKey(e) === 'z'
    ) {
      e.preventDefault();
      lastJsWrapToggle = Date.now();
      this.bus.emit(ACTIONS.TOGGLE_WRAP);
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    const key = shortcutKey(e);
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
    // Ctrl+Tab / Ctrl+PageDown and the reverse, on every platform. A focused
    // terminal keeps them (terminalPassesToApp lets xterm have them; this
    // check covers a key xterm leaves alone).
    const step = tabSwitchStep(e);
    if (step) {
      if (fromTerminal(e)) return;
      e.preventDefault();
      this.bus.emit(step === 'next' ? ACTIONS.NEXT_TAB : ACTIONS.PREV_TAB);
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
    // Menu accelerator is Ctrl+` on every platform (not Cmd). Matched on the
    // physical key too: ` is a dead key on some layouts, and Shift+` is ~.
    if (isBacktickKey(e) && !e.shiftKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.TOGGLE_TERMINAL);
      return;
    }
    // Terminals-only layout. Ctrl+Shift+` on every platform.
    if (isBacktickKey(e) && e.shiftKey) {
      e.preventDefault();
      this.bus.emit(ACTIONS.TOGGLE_TERMINALS_ONLY);
      return;
    }

    if (isMacOS()) return;

    if (key === 'n' && e.shiftKey && !e.altKey) {
      // Mirrors Window → New Window (CmdOrCtrl+Shift+N) for the Win/Linux
      // popup menu, whose accelerators don't fire.
      e.preventDefault();
      this.bus.emit(ACTIONS.NEW_WINDOW);
    } else if (key === 'n' && !e.shiftKey) {
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
    } else if (viewForDigit(key) && !e.shiftKey && !e.altKey) {
      // Mirrors View → Edit / Split / Preview / Diff (CmdOrCtrl+1–4).
      e.preventDefault();
      this.bus.emit(ACTIONS.SET_VIEW_MODE, { mode: viewForDigit(key)! });
    } else if (key === 'enter' && e.shiftKey && !e.altKey) {
      // Mirrors View → Focus Mode (CmdOrCtrl+Shift+Enter).
      e.preventDefault();
      this.bus.emit(ACTIONS.TOGGLE_FOCUS_MODE);
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
  | 'focus-prev'
  | 'find';

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
 *  - Find in terminal: ⌘F on macOS (the native Edit → Find accelerator
 *    usually gets it first and is routed to the pane, see app/actions.ts);
 *    Ctrl+Shift+F elsewhere, as in Windows Terminal, so plain Ctrl+F stays
 *    the shell's forward-char. A focused terminal wins over Search in Files.
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
    if (key === 'f') return e.shiftKey ? null : 'find';
    return e.shiftKey ? null : bracket;
  }
  if (!e.ctrlKey || !e.shiftKey || e.metaKey) return null;
  if (key === 'd') return 'split-right';
  if (key === 'e') return 'split-down';
  if (key === 'w') return 'close-pane';
  if (key === 'f') return 'find';
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
  find: { mac: 'Cmd+F', other: 'Ctrl+Shift+F' },
};

/** Label for a terminal pane key ("⌘D" / "Ctrl+Shift+D"). */
export function terminalPaneShortcut(action: TerminalPaneAction, mac = isMacOS()): string {
  const k = TERMINAL_PANE_KEYS[action];
  return formatShortcut(mac ? k.mac : k.other, mac);
}
