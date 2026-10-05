import type { Tab } from './tabs';
import type { ViewMode } from './view-mode';
import { EVENTS, ACTIONS } from './event-names';

export type EventMap = {
  [EVENTS.CONTENT_CHANGED]: { content: string };
  [EVENTS.CURSOR_CHANGED]: { line: number; column: number; chars: number; selectedChars: number };
  [EVENTS.SCROLL_SYNC]: { scrollRatio: number };
  [EVENTS.PREVIEW_SCROLL]: { scrollRatio: number };
  [EVENTS.PREVIEW_TOGGLED]: { visible: boolean };
  [EVENTS.SIDEBAR_TOGGLED]: { visible: boolean };
  [EVENTS.WORD_WRAP_CHANGED]: { enabled: boolean };
  [EVENTS.THEME_CHANGED]: {
    theme: 'light' | 'dark';
    preference: 'light' | 'dark' | 'system';
  };
  [EVENTS.TAB_SWITCHED]: { tab: Tab };
  [EVENTS.TAB_SAVE_STATE]: { tabId: string };
  [EVENTS.TAB_SAVED]: { tab: Tab };
  [EVENTS.TAB_CLOSED]: { tabId: string };
  [EVENTS.CONFIRM_CLOSE_TAB]: { tabId: string };
  [EVENTS.ALL_TABS_CLOSED]: Record<string, never>;
  [EVENTS.FILE_TREE_OPEN]: { path: string };
  [EVENTS.TOC_GOTO_LINE]: { line: number };
  [EVENTS.TOC_SCROLL_PREVIEW]: { id: string };
  [EVENTS.INSERT_AT_CURSOR]: { text: string };
  // Actions are payload-less (except SHOW_SIDEBAR_VIEW).
  [ACTIONS.NEW_FILE]: void;
  [ACTIONS.OPEN_FILE]: void;
  [ACTIONS.OPEN_FOLDER]: void;
  [ACTIONS.OPEN_REMOTE]: void;
  [ACTIONS.SAVE]: void;
  [ACTIONS.SAVE_AS]: void;
  [ACTIONS.CLOSE_TAB]: void;
  [ACTIONS.EXPORT_HTML]: void;
  [ACTIONS.FIND]: void;
  [ACTIONS.QUIT]: void;
  [ACTIONS.BOLD]: void;
  [ACTIONS.ITALIC]: void;
  [ACTIONS.HEADING]: void;
  [ACTIONS.UNORDERED_LIST]: void;
  [ACTIONS.ORDERED_LIST]: void;
  [ACTIONS.CODE_BLOCK]: void;
  [ACTIONS.INLINE_CODE]: void;
  [ACTIONS.QUOTE]: void;
  [ACTIONS.LINK]: void;
  [ACTIONS.IMAGE]: void;
  [ACTIONS.TABLE]: void;
  [ACTIONS.TOGGLE_SIDEBAR]: void;
  [ACTIONS.TOGGLE_PREVIEW]: void;
  [ACTIONS.TOGGLE_TERMINAL]: void;
  [ACTIONS.TOGGLE_TERMINALS_ONLY]: void;
  [ACTIONS.TOGGLE_EDITOR]: void;
  [ACTIONS.SET_VIEW_MODE]: { mode: ViewMode };
  [ACTIONS.TOGGLE_WRAP]: void;
  [ACTIONS.GOTO_LINE]: void;
  [ACTIONS.SHOW_AGENT_SETTINGS]: void;
  [ACTIONS.TOGGLE_THEME]: void;
  [ACTIONS.NEXT_TAB]: void;
  [ACTIONS.PREV_TAB]: void;
  [ACTIONS.SHOW_SHORTCUTS]: void;
  [ACTIONS.SHOW_SETTINGS]: void;
  [ACTIONS.SHOW_SIDEBAR_VIEW]: { view: 'files' | 'changes' | 'search' };
  [ACTIONS.QUICK_OPEN]: void;
  [ACTIONS.COMMAND_PALETTE]: void;
};

type Handler<E extends keyof EventMap> = (data: EventMap[E]) => void;

export class EventBus {
  private handlers = new Map<keyof EventMap, Set<Handler<any>>>();

  on<E extends keyof EventMap>(event: E, handler: Handler<E>): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off<E extends keyof EventMap>(event: E, handler: Handler<E>): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit<E extends keyof EventMap>(
    ...args: EventMap[E] extends void ? [event: E] : [event: E, data: EventMap[E]]
  ): void {
    const [event, data] = args as [E, EventMap[E]];
    this.handlers.get(event)?.forEach((h) => {
      try {
        h(data);
      } catch (err) {
        console.error(`EventBus handler for "${String(event)}" threw:`, err);
      }
    });
  }
}
