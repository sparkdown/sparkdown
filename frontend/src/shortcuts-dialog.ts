import { trapFocus, type ModalHandle } from './modal';
import { ACTIONS } from './event-names';
import { formatShortcut, shortcutFor, terminalPaneShortcut } from './shortcuts';
import { viewShortcutLabel } from './activity-bar';

const mod = (key: string) => formatShortcut(`CmdOrCtrl+${key}`);

/** Built on open, so labels follow the platform and KEYBINDINGS
 *  (shortcuts.ts) — the same table the command palette reads. */
function shortcutSections(): Array<{ section: string; items: Array<[string, string]> }> {
  const k = (action: string) => shortcutFor(action);
  return [
    {
      section: 'File',
      items: [
        [k(ACTIONS.NEW_FILE), 'New File'],
        [mod('T'), 'New Tab'],
        [k(ACTIONS.OPEN_FILE), 'Open File'],
        [k(ACTIONS.OPEN_FOLDER), 'Open Folder'],
        [k(ACTIONS.OPEN_REMOTE), 'Open Remote Folder'],
        [k(ACTIONS.SAVE), 'Save'],
        [k(ACTIONS.SAVE_AS), 'Save As'],
        [k(ACTIONS.CLOSE_TAB), 'Close Tab'],
        [k(ACTIONS.QUIT), 'Quit'],
      ],
    },
    {
      section: 'Edit',
      items: [
        [k(ACTIONS.BOLD), 'Bold'],
        [k(ACTIONS.ITALIC), 'Italic'],
        [mod('F'), 'Find'],
        [mod('Alt+G'), 'Go to Line'],
        [mod('Z'), 'Undo'],
        [mod('Shift+Z'), 'Redo'],
      ],
    },
    {
      section: 'View',
      items: [
        [mod('1'), 'Edit Only'],
        [mod('2'), 'Edit and Preview'],
        [mod('3'), 'Preview Only'],
        [mod('4'), 'Diff (git changes)'],
        [k(ACTIONS.COMMAND_PALETTE), 'Command Palette'],
        [k(ACTIONS.QUICK_OPEN), 'Go to File'],
        [viewShortcutLabel('files'), 'Files'],
        [viewShortcutLabel('changes'), 'Changes'],
        [viewShortcutLabel('search'), 'Search in Files'],
        [k(ACTIONS.TOGGLE_TERMINAL), 'Toggle Terminal'],
        [k(ACTIONS.TOGGLE_TERMINALS_ONLY), 'Terminals Only'],
        [k(ACTIONS.TOGGLE_SIDEBAR), 'Toggle Sidebar'],
        [k(ACTIONS.TOGGLE_WRAP), 'Toggle Word Wrap'],
      ],
    },
    {
      // Active while a terminal pane has keyboard focus.
      section: 'Terminal',
      items: [
        [terminalPaneShortcut('split-right'), 'Split Right'],
        [terminalPaneShortcut('split-down'), 'Split Down'],
        [terminalPaneShortcut('close-pane'), 'Close Pane'],
        [terminalPaneShortcut('focus-next'), 'Next Pane'],
        [terminalPaneShortcut('focus-prev'), 'Previous Pane'],
      ],
    },
    {
      section: 'Navigation',
      items: [
        [k(ACTIONS.NEXT_TAB), 'Next Tab'],
        [k(ACTIONS.PREV_TAB), 'Previous Tab'],
        [k(ACTIONS.SHOW_SHORTCUTS), 'Show Shortcuts'],
      ],
    },
  ];
}

let overlay: HTMLElement | null = null;
let modal: ModalHandle | null = null;

export function showShortcutsDialog(): void {
  if (overlay) {
    closeShortcutsDialog();
    return;
  }

  overlay = document.createElement('div');
  overlay.className = 'shortcuts-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeShortcutsDialog();
  });

  const dialog = document.createElement('div');
  dialog.className = 'shortcuts-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', 'Keyboard Shortcuts');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;

  const title = document.createElement('h2');
  title.textContent = 'Keyboard Shortcuts';
  dialog.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'shortcuts-grid';

  for (const { section, items } of shortcutSections()) {
    const sec = document.createElement('div');
    sec.className = 'shortcuts-section';

    const heading = document.createElement('h3');
    heading.textContent = section;
    sec.appendChild(heading);

    for (const [key, desc] of items) {
      const row = document.createElement('div');
      row.className = 'shortcut-row';

      const descEl = document.createElement('span');
      descEl.className = 'shortcut-desc';
      descEl.textContent = desc;

      const keyEl = document.createElement('kbd');
      keyEl.textContent = key;

      row.appendChild(descEl);
      row.appendChild(keyEl);
      sec.appendChild(row);
    }

    grid.appendChild(sec);
  }

  dialog.appendChild(grid);

  const hint = document.createElement('p');
  hint.className = 'shortcuts-hint';
  hint.textContent = `Press Escape or ${shortcutFor(ACTIONS.SHOW_SHORTCUTS)} to close`;
  dialog.appendChild(hint);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  modal = trapFocus(dialog);
  dialog.focus();

  // Close on Escape. (Cmd+Shift+H toggles closed via the native Help menu,
  // so it isn't handled here — a second listener would double-fire against
  // the menu's own toggle and cancel out.)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeShortcutsDialog();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
}

function closeShortcutsDialog(): void {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  modal?.release();
  modal = null;
}
