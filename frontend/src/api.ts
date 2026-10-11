import { invoke } from '@tauri-apps/api/core';
import { isUnderRoot } from './utils';
import type { AppConfig } from './types/AppConfig';

export type { AppConfig };

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** Absolute path currently watched, so watchStart can no-op for nested roots. */
let watchRoot: string | null = null;

export const api = {
  readFile: (path: string) => invoke<string>('read_file', { path }),
  writeFile: (path: string, content: string) =>
    invoke<void>('write_file', { path, content }),
  isDirectory: (path: string) => invoke<boolean>('is_directory', { path }),
  /** Append a crash-log entry; the backend picks the platform log dir. */
  appendCrashLog: (entry: string) => invoke<void>('append_crash_log', { entry }),
  copyText: (text: string) => invoke<void>('copy_text', { text }),
  copyFile: (path: string) => invoke<void>('copy_file', { path }),
  listDirectory: (path: string, includeHidden = false) =>
    invoke<FileEntry[]>('list_directory', { path, includeHidden }),
  /** Every file under `root` (root-relative, `/`-separated) for Quick open.
   *  Local walk or one remote `find`; capped and cached in the backend. */
  listWorkspaceFiles: (root: string, includeHidden = false) =>
    invoke<{ files: string[]; truncated: boolean }>('list_workspace_files', { root, includeHidden }),
  loadConfig: () => invoke<AppConfig>('load_config'),
  saveConfig: (config: AppConfig) => invoke<void>('save_config', { config }),
  getPendingFiles: () => invoke<string[]>('get_pending_files'),
  quit: () => invoke<void>('quit'),
  setHtmlPreview: (html: string) => invoke<void>('set_html_preview', { html }),
  setHtmlJsChecked: (checked: boolean) =>
    invoke<void>('set_html_js_checked', { checked }),
  /** Native app menu under the brand icon; x/y are window-logical CSS px. */
  showAppMenu: (x: number, y: number) => invoke<void>('show_app_menu', { x, y }),
  /** Open an http(s)/mailto URL in the system default handler (browser). */
  openExternal: (url: string) => invoke<void>('open_external', { url }),
  /** Grant the asset protocol each local preview image (one flag per path). */
  allowPreviewAssets: (paths: string[]) =>
    invoke<boolean[]>('allow_preview_assets', { paths }),
  /** Raw bytes of an image on the SSH host `host` (must be the active one). */
  remoteReadImage: (host: string, path: string) =>
    invoke<ArrayBuffer>('remote_read_image', { host, path }),

  // Agent cockpit: embedded terminals + file watching.
  // Each terminal is keyed by a frontend-generated id so several can run at once.
  /** Returns "tmux" (persistent session) or "shell" (plain fallback). */
  terminalStart: (
    id: string,
    cwd: string | null,
    cols: number,
    rows: number,
    session: string | null,
    launch: string | null = null,
  ) => invoke<string>('terminal_start', { id, cwd, cols, rows, session, launch }),
  tmuxSessions: (prefix: string) => invoke<string[]>('tmux_sessions', { prefix }),
  /** Type text into a tmux session (no Enter) via tmux's own input cycle, so
   *  it can't race tmux's startup redraw and appear duplicated. */
  tmuxSendKeys: (session: string, text: string) =>
    invoke<void>('tmux_send_keys', { session, text }),
  tmuxKillSession: (session: string) => invoke<void>('tmux_kill_session', { session }),
  terminalWrite: (id: string, data: string) =>
    invoke<void>('terminal_write', { id, data }),
  terminalResize: (id: string, cols: number, rows: number) =>
    invoke<void>('terminal_resize', { id, cols, rows }),
  terminalClose: (id: string) => invoke<void>('terminal_close', { id }),
  shellName: () => invoke<string>('shell_name'),
  /** Which shell syntax a chip's launch line needs right now. */
  launchShell: () => invoke<LaunchShell>('terminal_launch_shell'),
  // Pin the inotify/FSEvents root: tab-switch into a subdir must not
  // restart the watcher (that burst flashes the active file on Linux).
  watchStart: async (root: string) => {
    if (watchRoot && (watchRoot === root || isUnderRoot(root, watchRoot))) return;
    await invoke<void>('watch_start', { root });
    watchRoot = root;
  },
  watchStop: async () => {
    watchRoot = null;
    await invoke<void>('watch_stop');
  },
  gitStatus: (root: string) => invoke<GitStatus>('git_status', { root }),
  /** Literal text search under `root` (local walk or remote grep). */
  searchInFiles: (root: string, query: string, caseSensitive = false, includeHidden = false) =>
    invoke<SearchResults>('search_in_files', { root, query, caseSensitive, includeHidden }),
  /** Branch + ahead/behind its upstream (status bar). */
  gitBranchStatus: (root: string) => invoke<GitBranchStatus>('git_branch_status', { root }),
  gitDiffFile: (root: string, path: string, untracked: boolean) =>
    invoke<string>('git_diff_file', { root, path, untracked }),
  /** Per changed file: +adds / −dels and a fingerprint of the change
   *  (review.rs). Paths are repo-relative to `root` (the repo top level). */
  gitChangeStats: (root: string, changes: Pick<GitChange, 'path' | 'status'>[]) =>
    invoke<ChangeStat[]>('git_change_stats', {
      root,
      changes: changes.map((c) => ({ path: c.path, status: c.status })),
    }),
  /** Reviewed marks (path → fingerprint) of one workspace ("origin\nroot"). */
  reviewStateLoad: (workspace: string) =>
    invoke<Record<string, string>>('review_state_load', { workspace }),
  reviewStateSave: (workspace: string, entries: Record<string, string>) =>
    invoke<void>('review_state_save', { workspace, entries }),
  // Agent context bridge: publish editor state for agents to read; detect
  // installed agent CLIs for the terminal's launch buttons.
  agentContextUpdate: (root: string, contextJson: string, buffers: ShadowBuffer[]) =>
    invoke<string>('agent_context_update', { root, contextJson, buffers }),
  agentContextClear: (root: string) => invoke<void>('agent_context_clear', { root }),
  detectAgents: () => invoke<AgentCli[]>('detect_agents'),
  // In-app MCP server (agent context v2): push editor state; answer edit /
  // open round trips; get the endpoint URL agents are pointed at.
  mcpPublish: (snapshot: McpSnapshot) => invoke<void>('mcp_publish', { snapshot }),
  mcpReply: (reply: { id: number; ok: boolean; message: string }) =>
    invoke<void>('mcp_reply', { reply }),
  /** How an agent should start our stdio MCP server (this binary), or null
   *  when the server is not running. */
  mcpShimCommand: () => invoke<ShimCommand | null>('mcp_shim_command'),
  /** Whether the in-app MCP server is serving (status bar "Agent tools"). */
  mcpServerRunning: () => invoke<boolean>('mcp_server_running'),
  /** Register / remove SparkDown in an agent's own MCP config, via its CLI. */
  mcpInstallAgent: (bin: string) => invoke<string>('mcp_install_agent', { bin }),
  mcpUninstallAgent: (bin: string) => invoke<string>('mcp_uninstall_agent', { bin }),
  mcpAgentInstalled: (bin: string) => invoke<boolean>('mcp_agent_installed', { bin }),
  // Remote sessions v1 (#36): SSH config hosts + one workspace at a time.
  sshConfigHosts: () => invoke<SshHost[]>('ssh_config_hosts'),
  // First connect to an unknown host (#24): scan its keys for the user to
  // confirm, then append exactly the scanned lines to known_hosts.
  remoteHostkeyScan: (host: string) => invoke<HostKeyScan>('remote_hostkey_scan', { host }),
  remoteHostkeyTrust: (scanId: string) => invoke<void>('remote_hostkey_trust', { scanId }),
  remoteHostkeyForget: (scanId: string) => invoke<void>('remote_hostkey_forget', { scanId }),
  // Both stop the backend watcher (watch_stop in remote/mod.rs), so drop the
  // watchStart pin too — else reopening the same root never restarts it.
  remoteConnect: (host: string, path: string) =>
    invoke<RemoteSession>('remote_connect', { host, path }).finally(() => {
      watchRoot = null;
    }),
  remoteDisconnect: () =>
    invoke<void>('remote_disconnect').finally(() => {
      watchRoot = null;
    }),
  remoteSession: () => invoke<RemoteSession | null>('remote_session'),
  /** `mkdir -p` on the remote host (absolute path; the backend validates it). */
  remoteCreateDir: (path: string) => invoke<void>('remote_create_dir', { path }),
};

/** One open tab as seen by the MCP server. `content` is the live editor
 *  text (unsaved included). */
export interface McpTab {
  path: string | null;
  title: string;
  dirty: boolean;
  content: string | null;
}

/** Editor state pushed to the in-app MCP server (mcp.rs). */
/** remote_hostkey_scan result (remote/hostkey.rs). */
export interface HostKeyScan {
  scan_id: string;
  /** `host` or `[host]:port`, as written to known_hosts. */
  known_hosts_name: string;
  keys: { key_type: string; fingerprint: string }[];
  known_hosts_file: string;
  hashed: boolean;
}

export interface McpSnapshot {
  workspace_root: string | null;
  active_path: string | null;
  active_title: string | null;
  cursor_line: number | null;
  selection: string | null;
  tabs: McpTab[];
  enabled: boolean;
  updated_at: string;
}

/** Live mirror of one unsaved editor buffer, for the agent context dir. */
export interface ShadowBuffer {
  name: string;
  content: string;
}

/** The command an agent runs to start SparkDown's stdio MCP server. */
export interface ShimCommand {
  program: string;
  args: string[];
  /** Local Windows only: a Claude Code `--mcp-config` file with the same
   *  server (a path is safe to pass in PowerShell; inline JSON is not). */
  configFile?: string;
}

/** Shell syntax an agent chip's launch line must use (see
 *  `terminal_launch_shell`): PowerShell for a local terminal on Windows,
 *  POSIX for macOS / Linux and for any remote SSH host. */
export type LaunchShell = 'posix' | 'powershell';

/** A known agent CLI and whether it was found on PATH. */
export interface AgentCli {
  id: string;
  label: string;
  bin: string;
  found: boolean;
}

/** A changed path in the git working tree (Changes view). */
export interface GitChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  staged: boolean;
}

/** Mirror of `GitBranchStatus` in src-tauri/src/git.rs. */
export interface GitBranchStatus {
  /** Branch name; a short commit id when detached; null outside a repo or
   *  before the first commit. */
  branch: string | null;
  detached: boolean;
  has_upstream: boolean;
  ahead: number;
  behind: number;
}

/** Line counts + change fingerprint for one changed path (review.rs). */
export interface ChangeStat {
  path: string;
  /** null when unknown or binary. */
  adds: number | null;
  dels: number | null;
  binary: boolean;
  fingerprint: string;
}

export interface GitStatus {
  is_repo: boolean;
  branch: string | null;
  /** Absolute path of the repo's top-level directory. Change paths are
   *  relative to this (not to the queried root, which may be a subdir). */
  top_level: string | null;
  changes: GitChange[];
}

/** One matching line from `search_in_files` (search.rs). Columns and the
 *  match range are counted in characters; `line` / `column` are 1-based. */
export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
  match_start: number;
  match_end: number;
}

export interface SearchResults {
  matches: SearchMatch[];
  /** The backend stopped at a limit (results or files scanned). */
  truncated: boolean;
}

/** One filesystem change from the watcher (`watcher://changes` event).
 *  The debouncer reports coarse "something changed at this path"; the
 *  frontend re-reads and diffs content to decide how to react. */
export interface FsChange {
  path: string;
  kind: string;
}

/** A concrete Host alias from ~/.ssh/config (wildcards omitted). */
export interface SshHost {
  alias: string;
  hostname: string | null;
  user: string | null;
  port: number | null;
  identity_file: string | null;
  password_only: boolean;
}

/** The single active remote workspace (v1). */
export interface RemoteSession {
  host: string;
  path: string;
  /** Remote $HOME (physical path); the agent context bridge lives under it. */
  home: string;
}
