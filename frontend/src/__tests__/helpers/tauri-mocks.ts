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
/** Local paths whose `write_file` fails (a full disk, a read-only file). */
export const failingWrites = new Set<string>();

export const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
export const quitCalls = { count: 0 };
export const quitGate = { busy: false };

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

/** User-level run file returned by load_user_run / save_user_run. */
export const userRun = {
  path: '/tmp/sparkdown-user-run.json',
  commands: [] as Array<{ name: string; argv: string[]; timeout_ms?: number | null }>,
  save_hooks: [] as Array<{
    name: string;
    argv: string[];
    globs: string[];
    enabled: boolean;
    timeout_ms?: number | null;
  }>,
  problems: [] as string[],
  lastRun: null as { name: string } | null,
  lastHooks: null as { savedPath: string } | null,
};

/**
 * Scripted dialog answers, consumed FIFO. `message` feeds the 3-button
 * prompts by button ('Yes' = first, 'No' = second, 'Cancel' = third; the mock
 * answers with that button's label, as the plugin does); `save`/`open` feed the file dialogs (null = user
 * cancelled). An empty queue answers Cancel/null, the safe default.
 */
export const dialogResponses = {
  message: [] as Array<'Yes' | 'No' | 'Cancel'>,
  save: [] as Array<string | null>,
  open: [] as Array<string | null>,
};

/** Options of every save() dialog shown (defaultPath etc.), in order. */
export const saveCalls: Array<{ defaultPath?: string }> = [];

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
  failingWrites.clear();
  quitCalls.count = 0;
  quitGate.busy = false;
  dialogResponses.message.length = 0;
  messageCalls.length = 0;
  dialogResponses.save.length = 0;
  saveCalls.length = 0;
  dialogResponses.open.length = 0;
  messageLog.length = 0;
  eventHandlers.clear();
  dragDropHandler = null;
  gitChanges.length = 0;
  searchState.results = null;
  git.topLevel = null;
  git.branch = { branch: 'main', detached: false, has_upstream: true, ahead: 0, behind: 0 };
  mcp.running = true;
  userRun.path = '/tmp/sparkdown-user-run.json';
  userRun.commands = [];
  userRun.save_hooks = [];
  userRun.problems = [];
  userRun.lastRun = null;
  userRun.lastHooks = null;
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
      if (!remote.session && failingWrites.has(args?.path as string)) {
        throw new Error('No space left on device (os error 28)');
      }
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
    case 'list_workspace_files_stream':
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
      // The streaming variant sends the first level first, like the Rust walk.
      const onBatch = args?.onBatch as MockChannel<string[]> | undefined;
      onBatch?.onmessage(files.filter((f) => !f.includes('/')));
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
    case 'window_close':
      return;
    // #88: the core's one-quit gate (lifecycle.rs QuitGate).
    case 'quit_begin':
      if (quitGate.busy) return false;
      quitGate.busy = true;
      return true;
    case 'quit_end':
      quitGate.busy = false;
      return;
    case 'quit_prepare_others':
      return true;
    case 'quit_status':
      return { busy: [], unsaved: [] };
    case 'copy_text':
    case 'print_webview':
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
    // Replace in files over the vfs: literal, case-sensitive, offsets in
    // chars (tests use ASCII); the fingerprint is the file text itself.
    case 'replace_preview': {
      const root = `${String(args?.root).replace(/\/$/, '')}/`;
      const query = args?.query as string;
      const unsaved = new Map(((args?.unsaved ?? []) as { path: string; text: string }[]).map((u) => [u.path, u.text]));
      const skipped = [...vfs.entries()]
        .filter(([p, text]) => p.startsWith(root) && unsaved.has(p) && (text.includes(query) || unsaved.get(p)!.includes(query)))
        .map(([path]) => ({ path, reason: 'open with unsaved changes' }));
      const files = [...vfs.entries()]
        .filter(([p, text]) => p.startsWith(root) && !unsaved.has(p) && text.includes(query))
        .map(([path, text]) => {
          const hits = [];
          for (let i = text.indexOf(query); i >= 0; i = text.indexOf(query, i + query.length)) {
            hits.push({ start: i, end: i + query.length, line: 1, column: i + 1, preview: text, match_start: i, match_end: i + query.length, groups: [] });
          }
          return { path, fingerprint: text, hits };
        });
      return { files, skipped, truncated: false, group_count: 0, group_names: [] };
    }
    case 'replace_apply': {
      const edits = args?.edits as { path: string; fingerprint: string; ranges: [number, number][] }[];
      const files = edits.map((e) => {
        const text = vfs.get(e.path);
        if (text !== e.fingerprint) return { path: e.path, status: 'changed', count: 0, message: 'changed on disk since the preview' };
        let out = '';
        let at = 0;
        for (const [a, b] of e.ranges) {
          out += text.slice(at, a) + String(args?.replacement);
          at = b;
        }
        vfs.set(e.path, out + text.slice(at));
        return { path: e.path, status: 'done', count: e.ranges.length, message: null };
      });
      return { batch_id: 1, files };
    }
    case 'replace_undo':
      return [];
    case 'git_diff_file':
      return '@@ -1 +1 @@\n-old\n+new';
    case 'git_file_layers':
      return {
        path: (args?.path as string) ?? '',
        staged: '',
        unstaged: '@@ -1 +1 @@\n-old\n+new',
        staged_fp: 'staged-fp',
        unstaged_fp: 'unstaged-fp',
        binary_staged: false,
        binary_unstaged: false,
      };
    case 'git_stage_hunk':
      return;
    case 'tmux_sessions':
      return [];
    case 'detect_agents':
      return [];
    case 'shell_name':
      return 'bash';
    case 'window_ready':
      return undefined;
    case 'save_image': {
      const doc = args?.docPath as string;
      const name = `${args?.name as string}.png`;
      vfs.set(`${doc.slice(0, doc.lastIndexOf('/'))}/${name}`, '<png>');
      return name;
    }
    case 'import_image': {
      const source = args?.source as string;
      return source.slice(source.lastIndexOf('/') + 1);
    }
    case 'user_run_path':
      return userRun.path;
    case 'load_user_run':
      return {
        commands: userRun.commands,
        save_hooks: userRun.save_hooks,
        problems: userRun.problems,
        path: userRun.path,
      };
    case 'save_user_run': {
      const file = args?.file as { commands?: unknown; save_hooks?: unknown } | undefined;
      if (file?.commands) userRun.commands = file.commands as typeof userRun.commands;
      if (file?.save_hooks) userRun.save_hooks = file.save_hooks as typeof userRun.save_hooks;
      return {
        commands: userRun.commands,
        save_hooks: userRun.save_hooks,
        problems: userRun.problems,
        path: userRun.path,
      };
    }
    case 'run_user_command':
      userRun.lastRun = { name: String(args?.name ?? '') };
      return {
        name: args?.name,
        argv: ['echo'],
        cwd: '/ws',
        exit_code: 0,
        timed_out: false,
        output: 'ok',
      };
    case 'run_save_hooks':
      userRun.lastHooks = { savedPath: String(args?.savedPath ?? '') };
      return [];
    default:
      throw new Error(`tauri-mocks: unmocked command "${cmd}"`);
  }
}

// -------------------------------------------------------- module mocks -----

/** Stand-in for `Channel` from @tauri-apps/api/core: tests call
 *  `onmessage` directly. */
export class MockChannel<T> {
  constructor(public onmessage: (msg: T) => void = () => {}) {}
}

export const coreMock = { invoke: mockInvoke, Channel: MockChannel };

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
      const answer = dialogResponses.message.shift() ?? 'Cancel';
      // Like the real dialog plugin: with custom labels it answers with the
      // clicked button's label ("Save"), not 'Yes' / 'No' / 'Cancel'.
      const labels = opts.buttons as Partial<Record<'yes' | 'no' | 'cancel', string>>;
      const key = answer === 'Yes' ? 'yes' : answer === 'No' ? 'no' : 'cancel';
      return typeof labels === 'object' && labels[key] ? labels[key] : answer;
    }
    return undefined;
  },
  save: async (opts?: { defaultPath?: string }) => {
    saveCalls.push({ defaultPath: opts?.defaultPath });
    return dialogResponses.save.shift() ?? null;
  },
  open: async () => dialogResponses.open.shift() ?? null,
};

/** Diagram themes asked of the stub preview, in order: `export:<theme>` for
 *  renderImmediateForExport, `theme:<theme>` for notifyThemeChanged. */
export const previewThemeCalls: string[] = [];

/** No-op PreviewPane; rendering itself is covered by preview.test.ts. */
export class PreviewPaneStub {
  init(): void {}
  initReverseScroll(): void {}
  setVisible(): void {}
  setAllowScripts(): void {}
  setDiagramsEnabled(): void {}
  setFrameCallbacks(): void {}
  setOpenFileHandler(): void {}
  setCreateFileHandler(): void {}
  setWikiResolver(): void {}
  refreshWikiLinks(): void {}
  setOriginResolver(): void {}
  setPathResolver(): void {}
  setSourceClickHandler(): void {}
  sourceAnchors(): null {
    return null;
  }
  setBaseDir(): void {}
  setWorkspaceRoot(): void {}
  setRenderMode(): void {}
  render(): void {}
  /** Writes the source into #preview-pane as text, standing in for a render. */
  async renderImmediateForExport(content = '', diagramTheme?: string): Promise<void> {
    previewThemeCalls.push(`export:${diagramTheme ?? 'current'}`);
    const pane = document.getElementById('preview-pane');
    if (pane) pane.textContent = content;
  }
  async whenImagesResolved(): Promise<void> {}
  getRenderRoot(): HTMLElement {
    return document.getElementById('preview-pane')!;
  }
  getRenderedHtml(): string {
    return '';
  }
  getSearchRoot(): HTMLElement | null {
    return null;
  }
  scrollToRatio(): void {}
  scrollToId(): void {}
  notifyThemeChanged(theme?: string): void {
    previewThemeCalls.push(`theme:${theme}`);
  }
  async rerenderForTheme(): Promise<void> {}
}
