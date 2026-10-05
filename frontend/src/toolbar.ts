import { EventBus, type EventMap } from './events';
import { isMarkdownFile } from './utils';
import { ACTIONS } from './event-names';

type ActionEvent = keyof EventMap;

export class Toolbar {
  private bus: EventBus;
  private mdToolbar!: HTMLElement;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  init(): void {
    // Title bar: only the terminal toggle is a plain button now. New / Open
    // / Save / theme / wrap / sidebar live in the menus (menu.rs), the
    // welcome screen and the shortcuts; the view control is ViewControl.
    this.bind('btn-terminal', () => this.bus.emit(ACTIONS.TOGGLE_TERMINAL));

    // Markdown formatting toolbar (inside editor pane)
    this.mdToolbar = document.getElementById('md-toolbar')!;
    const actionMap: Record<string, ActionEvent> = {
      'bold': ACTIONS.BOLD,
      'italic': ACTIONS.ITALIC,
      'heading': ACTIONS.HEADING,
      'unordered-list': ACTIONS.UNORDERED_LIST,
      'ordered-list': ACTIONS.ORDERED_LIST,
      'inline-code': ACTIONS.INLINE_CODE,
      'code-block': ACTIONS.CODE_BLOCK,
      'quote': ACTIONS.QUOTE,
      'link': ACTIONS.LINK,
      'image': ACTIONS.IMAGE,
      'table': ACTIONS.TABLE,
    };
    for (const btn of this.mdToolbar.querySelectorAll<HTMLElement>('.md-btn')) {
      const action = btn.dataset.action;
      if (action && actionMap[action]) {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          this.bus.emit(actionMap[action]);
        });
      }
    }
  }

  /** Show/hide the md formatting toolbar based on file extension */
  setFileType(path: string | null): void {
    const isMd = isMarkdownFile(path);
    this.mdToolbar.classList.toggle('hidden', !isMd);
    // Drop the editor's top padding (which exists to clear the toolbar) when
    // there's no toolbar to clear.
    document.documentElement.style.setProperty('--editor-top-pad', isMd ? '44px' : '12px');
  }

  private bind(id: string, handler: () => void): void {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        handler();
      });
    }
  }
}
