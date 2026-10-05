import type { EventCallback } from '@tauri-apps/api/event';
import type { EditorManager } from '../editor';
import type { EventBus } from '../events';
import type { FileTree } from '../file-tree';
import type { StatusBar } from '../statusbar';
import type { TabManager } from '../tabs';
import type { TOC } from '../toc';
import type { Toolbar } from '../toolbar';
import type { AppConfig } from '../api';

/**
 * What the App shares with its controllers (app/*.ts): the long-lived UI
 * services, the loaded config, and the little mutable workspace state that
 * several controllers read. Controllers get this instead of the whole App;
 * anything else they need from a sibling comes in as a narrow callback.
 */
export interface AppContext {
  readonly bus: EventBus;
  readonly editor: EditorManager;
  readonly tabs: TabManager;
  readonly fileTree: FileTree;
  readonly statusbar: StatusBar;
  readonly toolbar: Toolbar;
  readonly toc: TOC;
  /** Loaded once in init(); the settings dialog mutates it in place. */
  readonly config: AppConfig;
  /** Directory of the active file, or the opened folder: preview base for
   *  relative links and the fallback root for terminals / git / context. */
  baseDir: string | null;
  /** Folder the user explicitly opened (Open Folder / drop). Git status and
   *  the watcher stay pinned here; tab focus must not re-root or re-watch
   *  (Linux inotify + WebKitGTK made that look like a change flash — #27). */
  workspaceRoot: string | null;
  /** Debounced config persist. */
  saveConfigSoon(): void;
  /** Debounced agent-context publish (see agent-context.ts). */
  publishContextSoon(): void;
  /** Subscribe to a Tauri event; the App unsubscribes it on destroy(). */
  listenTauri<T>(event: string, handler: EventCallback<T>): void;
}

