import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../events';
import { ACTIONS, MENU } from '../event-names';
import { registerActionListeners, registerMenuListeners, type ActionTargets } from '../app/actions';

/** ⌘W routing and the Terminal menu items (app/actions.ts). */
function targets(terminalFocused: boolean) {
  const handlers = new Map<string, (e?: unknown) => void>();
  const cockpit = {
    toggleTerminal: vi.fn(async () => {}),
    toggleTerminalsOnly: vi.fn(async () => {}),
    splitTerminal: vi.fn(async (_d: 'right' | 'down') => {}),
    closeTerminalPane: vi.fn(),
    focusTerminalPane: vi.fn((_d: 1 | -1) => {}),
    hasTerminalFocus: vi.fn(() => terminalFocused),
    openTerminalFind: vi.fn(() => true),
  };
  const panes = { openFind: vi.fn() };
  const tabs = { closeCurrent: vi.fn(), switchNext: vi.fn(), switchPrev: vi.fn() };
  const bus = new EventBus();
  const t = {
    bus,
    tabs,
    cockpit,
    panes,
    listenTauri: (event: string, h: (e?: unknown) => void) => handlers.set(event, h),
  } as unknown as ActionTargets;
  registerMenuListeners(t);
  registerActionListeners(t);
  return { bus, cockpit, tabs, panes, fire: (event: string) => handlers.get(event)!() };
}

describe('terminal actions', () => {
  it('⌘W (menu Close Tab) closes the focused pane when a terminal has focus', () => {
    const { cockpit, tabs, fire } = targets(true);
    fire(MENU.CLOSE_TAB);
    expect(cockpit.closeTerminalPane).toHaveBeenCalledTimes(1);
    expect(tabs.closeCurrent).not.toHaveBeenCalled();
  });

  it('⌘W closes the document tab otherwise (menu and shortcut)', () => {
    const { bus, cockpit, tabs, fire } = targets(false);
    fire(MENU.CLOSE_TAB);
    bus.emit(ACTIONS.CLOSE_TAB);
    expect(tabs.closeCurrent).toHaveBeenCalledTimes(2);
    expect(cockpit.closeTerminalPane).not.toHaveBeenCalled();
  });

  it('Terminal menu items reach the cockpit', () => {
    const { cockpit, fire } = targets(false);
    fire(MENU.TERMINAL_SPLIT_RIGHT);
    fire(MENU.TERMINAL_SPLIT_DOWN);
    fire(MENU.TERMINAL_CLOSE_PANE);
    fire(MENU.TERMINAL_FOCUS_NEXT);
    fire(MENU.TERMINAL_FOCUS_PREV);
    expect(cockpit.splitTerminal.mock.calls).toEqual([['right'], ['down']]);
    expect(cockpit.closeTerminalPane).toHaveBeenCalledTimes(1);
    expect(cockpit.focusTerminalPane.mock.calls).toEqual([[1], [-1]]);
  });

  it('Find (menu ⌘F and shortcut) opens the terminal find bar when a terminal has focus', () => {
    const { bus, cockpit, panes, fire } = targets(true);
    fire(MENU.FIND);
    bus.emit(ACTIONS.FIND);
    expect(cockpit.openTerminalFind).toHaveBeenCalledTimes(2);
    expect(panes.openFind).not.toHaveBeenCalled();
  });

  it('Find goes to the editor / preview otherwise, or when no pane can search', () => {
    const { cockpit, panes, fire } = targets(false);
    fire(MENU.FIND);
    expect(cockpit.openTerminalFind).not.toHaveBeenCalled();
    expect(panes.openFind).toHaveBeenCalledTimes(1);

    const focused = targets(true);
    focused.cockpit.openTerminalFind.mockReturnValue(false);
    focused.fire(MENU.FIND);
    expect(focused.panes.openFind).toHaveBeenCalledTimes(1);
  });
});
