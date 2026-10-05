/**
 * Test doubles for the Tauri layer, backing app-level integration tests.
 *
 * The real backend is replaced by an in-memory filesystem (`vfs`) plus
 * scriptable dialog responses, and Tauri events (menu items, close guard)
 * can be fired with `emitTauriEvent`. Import the exported factories from
 * `vi.mock` in the test file:
 *
 *   vi.mock('@tauri-apps/api/core', async () =>
 *     (await import('./helpers/tauri-mocks')).coreMock);
 */
import { vi } from 'vitest';

// ---------------------------------------------------------------- state ----

/** In-memory filesystem: path -> content. */
export const vfs = new Map<string, string>();
/** In-memory filesystem of the SSH host. While `remote.session` is set,
 *  read_file / write_file route here, like the Rust `remote::is_active()`. */
export const remoteVfs = new Map<string, string>();
/** Live remote session (null = local). `remote_connect` resolves `~` to
 *  `/home/u` so tests can predict the session path. */
export const remote: { session: { host: string; path: string; home: string } | null } = {
  session: null,
};
/** Paths `is_directory` reports as directories. */
export const directories = new Set<string>();
/** Every config object the app persisted, in order. */
export const savedConfigs: unknown[] = [];
/** Config returned by `load_config` (null -> backend defaults). */
export let configOnDisk: Record<string, unknown> | null = null;
export const setConfigOnDisk = (c: Record<string, unknown> | null) => {
  configOnDisk = c;
};
/** Files queued via macOS "Open With" before the frontend was ready. */
export let pendingFiles: string[] = [];
export const setPendingFiles = (p: string[]) => {
  pendingFiles = p;
};
/** Changed paths `git_status` reports (relative to the queried root). */
export const gitChanges: Array<{ path: string; status: string; staged: boolean }> = [];
/** Reviewed marks `review_state_*` persist, per workspace id. */
export const reviewStore: Record<string, Record<string, string>> = {};
/** Per-path fingerprint override for `git_change_stats` (default: status). */
export const changePrints: Record<string, string> = {};
/** Reply for `search_in_files` (null = no matches). */
export const searchState: { results: { matches: unknown[]; truncated: boolean } | null } = {
  results: null,
};
/** Raw log of every invoke() for asserting on backend traffic. */
export const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
export const quitCalls = { count: 0 };

/** Scriptable branch answer for `git_branch_status` (the working-tree
 *  changes that feed `git_status` are the separate `gitChanges` array). */
export const git: {
  /** `git_status` top level; null = the queried root. (The backend answers
   *  in the root's own spelling, even through a symlink.) */
  topLevel: string | null;
  branch: {
    branch: string | null;
    detached: boolean;
    has_upstream: boolean;
    ahead: number;
    behind: number;
  };
} = {
  topLevel: null,
  branch: { branch: 'main', detached: false, has_upstream: true, ahead: 0, behind: 0 },
};

/** What mcp_server_running answers. */
export const mcp = { running: true };

/**
 * Scripted dialog answers, consumed FIFO. `message` feeds the 3-button
 * unsaved-changes prompt; `save`/`open` feed the file dialogs (null = user
 * cancelled). An empty queue answers Cancel/null, the safe default.
 */
export const dialogResponses = {
  message: [] as Array<'Yes' | 'No' | 'Cancel'>,
  save: [] as Array<string | null>,
  open: [] as Array<string | null>,
};

/** Every 3-button prompt shown (title + text), in order. */
export const messageCalls: Array<{ text: string; title?: string }> = [];

/** Text of every message() dialog shown (prompts and plain alerts). */
export const messageLog: string[] = [];

type EventHandler = (event: { payload?: unknown }) => void;
const eventHandlers = new Map<string, Set<EventHandler>>();

/** Fire a Tauri event (e.g. 'menu:save', 'exit-requested') into the app. */
export function emitTauriEvent(name: string, payload?: unknown): void {
  eventHandlers.get(name)?.forEach((h) => h({ payload }));
}

/** The app's drag-drop callback, captured from onDragDropEvent. */
export let dragDropHandler: ((event: { payload: unknown }) => void) | null = null;

export function resetTauriMocks(): void {
  vfs.clear();
  for (const k of Object.keys(reviewStore)) delete reviewStore[k];
  for (const k of Object.keys(changePrints)) delete changePrints[k];
  remoteVfs.clear();
  remote.session = null;
  directories.clear();
  savedConfigs.length = 0;
  configOnDisk = null;
  pendingFiles = [];
  invokeCalls.length = 0;
  quitCalls.count = 0;
  dialogResponses.message.length = 0;
  messageCalls.length = 0;
  dialogResponses.save.length = 0;
  dialogResponses.open.length = 0;
  messageLog.length = 0;
  eventHandlers.clear();
  dragDropHandler = null;
  gitChanges.length = 0;
  searchState.results = null;
  git.topLevel = null;
  git.branch = { branch: 'main', detached: false, has_upstream: true, ahead: 0, behind: 0 };
  mcp.running = true;
}

// ------------------------------------------------------------- backends ----

const DEFAULT_CONFIG = {
  theme: 'system',
  last_open_files: [],
  recent_folders: [],
  terminal_visible: false,
  terminal_height: 200,
  terminals_only: false,
  sidebar_width: 220,
  sidebar_visible: true,
  preview_visible: true,
  word_wrap: true,
  show_hidden_files: false,
  enable_diagrams: true,
};

/** Remote dirs: explicit `directories` entries plus every parent of a
 *  `remoteVfs` file. */
function remoteIsDir(path: string): boolean {
  if (path === '/') return true;
  if (directories.has(path)) return true;
  const prefix = `${path.replace(/\/+$/, '')}/`;
  for (const p of [...remoteVfs.keys(), ...directories]) if (p.startsWith(prefix)) return true;
  return false;
}

function remoteList(
  path: string,
  includeHidden: boolean,
): Array<{ name: string; path: string; is_dir: boolean }> {
  if (!path.startsWith('/')) throw `Invalid path: remote path must be absolute: ${path}`;
  if (!remoteIsDir(path)) throw `Invalid path: Path is not a directory: ${path}`;
  const base = path === '/' ? '' : path.replace(/\/+$/, '');
  const seen = new Map<string, boolean>();
  for (const p of [...remoteVfs.keys(), ...directories]) {
    if (!p.startsWith(`${base}/`)) continue;
    const rest = p.slice(base.length + 1);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    const isDir = slash >= 0 || (directories.has(p) && !remoteVfs.has(p));
    seen.set(name, (seen.get(name) ?? false) || isDir);
  }
  return [...seen.entries()]
    .filter(([name]) => includeHidden || !name.startsWith('.'))
    .map(([name, is_dir]) => ({ name, path: `${base}/${name}`, is_dir }))
    .sort((a, b) =>
      a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1,
    );
}

async function mockInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  invokeCalls.push({ cmd, args });
  switch (cmd) {
    case 'read_file': {
      const path = args?.path as string;
      const fs = remote.session ? remoteVfs : vfs;
      if (!fs.has(path)) throw `Invalid path: Invalid or inaccessible path: ${path}`;
      return fs.get(path);
    }
    case 'write_file': {
      (remote.session ? remoteVfs : vfs).set(args?.path as string, args?.content as string);
      return;
    }
    case 'remote_connect': {
      const raw = String(args?.path ?? '~');
      const path = raw === '~' ? '/home/u' : raw.replace(/^~\//, '/home/u/');
      remote.session = { host: String(args?.host), path, home: '/home/u' };
      return remote.session;
    }
    case 'remote_disconnect':
      remote.session = null;
      return;
    case 'remote_session':
      return remote.session;
    case 'remote_create_dir': {
      // `mkdir -p`: the folder and every missing parent become directories.
      const path = String(args?.path ?? '');
      if (!remote.session) throw 'no remote session';
      if (!path.startsWith('/')) throw `remote path must be absolute: ${path}`;
      if (remoteVfs.has(path)) throw `mkdir: ${path}: File exists`;
      for (let p = path.replace(/\/+$/, ''); p; p = p.slice(0, p.lastIndexOf('/'))) {
        directories.add(p);
      }
      return;
    }
    case 'ssh_config_hosts':
      return [];
    case 'is_directory': {
      const path = args?.path as string;
      if (remote.session) return remoteIsDir(path);
      return directories.has(path);
    }
    case 'list_directory':
      // Local listings stay empty (tests drive the tree via events); the
      // remote host lists `remoteVfs` like the Rust `find` one-level walk.
      if (remote.session) {
        return remoteList(args?.path as string, Boolean(args?.includeHidden));
      }
      return [];
    case 'list_workspace_files': {
      // Quick open: every file under root, relative, from whichever machine
      // is active (the Rust command routes on remote::is_active()).
      const root = String(args?.root ?? '').replace(/\/+$/, '');
      const hidden = Boolean(args?.includeHidden);
      const files = [...(remote.session ? remoteVfs : vfs).keys()]
        .filter((p) => p.startsWith(`${root}/`))
        .map((p) => p.slice(root.length + 1))
        .filter((rel) => hidden || !rel.split('/').some((s) => s.startsWith('.')))
        .sort();
      return { files, truncated: false };
    }
    case 'load_config':
      return configOnDisk ?? { ...DEFAULT_CONFIG };
    case 'save_config':
      savedConfigs.push(args?.config);
      return;
    case 'get_pending_files':
      return pendingFiles;
    case 'quit':
      quitCalls.count++;
      return;
    case 'copy_text':
    case 'copy_file':
    case 'set_html_preview':
    case 'set_html_js_checked':
    case 'show_app_menu':
    case 'open_external':
    case 'terminal_start':
      return 'shell';
    case 'terminal_write':
    case 'terminal_resize':
    case 'terminal_close':
    case 'tmux_send_keys':
    case 'tmux_kill_session':
    case 'agent_context_update':
    case 'agent_context_clear':
    case 'mcp_publish':
    case 'mcp_reply':
    case 'watch_start':
    case 'watch_stop':
      return;
    case 'git_status':
      // Minimal repo rooted at the queried path (enough for the badge count
      // and diff-context derivation; individual tests can assert on the
      // git_diff_file calls instead).
      return {
        is_repo: true,
        top_level: git.topLevel ?? (args?.root as string),
        changes: gitChanges.map((c) => ({ ...c })),
        branch: git.branch.branch ?? 'main',
      };
    case 'git_branch_status':
      return { ...git.branch };
    case 'mcp_server_running':
      return mcp.running;
    case 'git_change_stats':
      return ((args?.changes as Array<{ path: string; status: string }>) ?? []).map((c) => ({
        path: c.path,
        adds: 1,
        dels: c.status === 'untracked' ? 0 : 1,
        binary: false,
        fingerprint: changePrints[c.path] ?? `${c.status}:fp`,
      }));
    case 'review_state_load':
      return { ...(reviewStore[args?.workspace as string] ?? {}) };
    case 'review_state_save':
      reviewStore[args?.workspace as string] = {
        ...(args?.entries as Record<string, string>),
      };
      return;
    case 'search_in_files':
      return searchState.results ?? { matches: [], truncated: false };
    case 'git_diff_file':
      return '@@ -1 +1 @@\n-old\n+new';
    case 'tmux_sessions':
      return [];
    case 'detect_agents':
      return [];
    case 'shell_name':
      return 'bash';
    default:
      throw new Error(`tauri-mocks: unmocked command "${cmd}"`);
  }
}

// -------------------------------------------------------- module mocks -----

export const coreMock = { invoke: mockInvoke };

export const eventMock = {
  listen: async (name: string, handler: EventHandler) => {
    if (!eventHandlers.has(name)) eventHandlers.set(name, new Set());
    eventHandlers.get(name)!.add(handler);
    return () => eventHandlers.get(name)?.delete(handler);
  },
};

const currentWindow = {
  hide: vi.fn(async () => {}),
  show: vi.fn(async () => {}),
  setFocus: vi.fn(async () => {}),
  startDragging: vi.fn(async () => {}),
  minimize: vi.fn(async () => {}),
  maximize: vi.fn(async () => {}),
  unmaximize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  isMaximized: vi.fn(async () => false),
  isFullscreen: vi.fn(async () => false),
  onResized: vi.fn(async () => () => {}),
};

export const windowMock = {
  getCurrentWindow: () => currentWindow,
};

export const webviewMock = {
  getCurrentWebview: () => ({
    onDragDropEvent: async (cb: (event: { payload: unknown }) => void) => {
      dragDropHandler = cb;
      return () => {
        dragDropHandler = null;
      };
    },
  }),
};

export const dialogMock = {
  message: async (text: string, opts?: { buttons?: unknown; title?: string }) => {
    messageLog.push(text);
    // Only 3-button prompts (unsaved changes, disk conflict) consume a
    // scripted answer; plain informational alerts resolve to nothing.
    if (opts && 'buttons' in opts && opts.buttons) {
      messageCalls.push({ text, title: opts.title });
      return dialogResponses.message.shift() ?? 'Cancel';
    }
    return undefined;
  },
  save: async () => dialogResponses.save.shift() ?? null,
  open: async () => dialogResponses.open.shift() ?? null,
};

/** No-op PreviewPane; rendering itself is covered by preview.test.ts. */
export class PreviewPaneStub {
  init(): void {}
  initReverseScroll(): void {}
  setVisible(): void {}
  setAllowScripts(): void {}
  setDiagramsEnabled(): void {}
  setFrameCallbacks(): void {}
  setOpenFileHandler(): void {}
  setOriginResolver(): void {}
  setBaseDir(): void {}
  setRenderMode(): void {}
  render(): void {}
  async renderImmediateForExport(): Promise<void> {}
  getRenderedHtml(): string {
    return '';
  }
  getSearchRoot(): HTMLElement | null {
    return null;
  }
  scrollToRatio(): void {}
  scrollToId(): void {}
  notifyThemeChanged(): void {}
}
