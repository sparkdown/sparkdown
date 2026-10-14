/**
 * Window-scoped Tauri event listening (#61/#65).
 *
 * `listen` from `@tauri-apps/api/event` registers for ANY target, so with
 * several windows it would also receive events the core sends to another
 * window (`emit_to`): another window's terminal output, watcher changes,
 * askpass prompts. Every listener in the app goes through this wrapper,
 * which targets the current webview window; app-wide broadcasts (`emit`)
 * still arrive.
 */
import {
  listen as listenAny,
  type EventCallback,
  type UnlistenFn,
} from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export type { EventCallback, UnlistenFn };

function currentLabel(): string | null {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return null; // tests / no Tauri runtime
  }
}

export function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const label = currentLabel();
  return label
    ? listenAny<T>(event, handler, { target: { kind: 'WebviewWindow', label } })
    : listenAny<T>(event, handler);
}

/** Run `fn` whenever this window gains focus. Resolves to an unlisten. */
export async function onWindowFocus(fn: () => void): Promise<UnlistenFn> {
  try {
    return await getCurrentWebviewWindow().onFocusChanged(({ payload }) => {
      if (payload) fn();
    });
  } catch {
    return () => {}; // tests / no Tauri runtime
  }
}
