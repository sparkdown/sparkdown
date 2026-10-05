//! In-app MCP server (agent context v2).
//!
//! Agents in the embedded terminal discover SparkDown through MCP instead of
//! a typed prompt: at startup an MCP client calls `tools/list` and receives
//! each tool's name, description and schema — the one channel every agent
//! CLI learns by itself. See docs/agent-context-design.md.
//!
//! Transport: newline-delimited JSON-RPC over a Unix domain socket at a
//! stable per-user path (`mcp_socket_path`, dir 0700). Agents never talk to
//! it directly: they run this same binary as a stdio MCP server
//! (`sparkdown --mcp-stdio`, see mcp_stdio.rs), which forwards to the socket
//! named by `$SPARKDOWN_MCP` — exported only in SparkDown's own terminals.
//! Outside SparkDown the variable is unset and the shim answers with zero
//! tools, so an installed config is silent there. No HTTP, no port, no token:
//! filesystem permissions are the access control. No new crates.
//!
//! State: the frontend owns tabs/editor and pushes a snapshot (`mcp_publish`)
//! whenever it changes; tools read that in-memory snapshot. Unsaved text
//! therefore never touches disk. The one write tool, `edit_buffer`, edits the
//! EDITOR BUFFER (unsaved) via a round trip to the frontend — the user
//! reviews and saves. SparkDown never runs the agent.

use crate::context::{truncate_at_char_boundary, MAX_BUFFER_BYTES};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// How long `edit_buffer` / `open_file` wait for the frontend to apply.
const ROUNDTRIP_TIMEOUT: Duration = Duration::from_secs(5);
/// MCP protocol revisions we speak; newest first.
const PROTOCOL_VERSIONS: [&str; 2] = ["2025-06-18", "2025-03-26"];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TabInfo {
    pub path: Option<String>,
    pub title: String,
    pub dirty: bool,
    /// Live editor text (unsaved included). Absent when the frontend chose
    /// not to ship it (e.g. binary-ish or over the cap).
    #[serde(default)]
    pub content: Option<String>,
    /// Set by the backend (never trusted from the frontend) when `content` was
    /// cut down to `MAX_BUFFER_BYTES`: the copy we hold is incomplete, so
    /// `read_buffer` flags it and `edit_buffer` refuses (a whole-buffer replace
    /// would drop everything past the cut).
    #[serde(default, skip_deserializing)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub workspace_root: Option<String>,
    pub active_path: Option<String>,
    pub active_title: Option<String>,
    pub cursor_line: Option<u32>,
    pub selection: Option<String>,
    pub tabs: Vec<TabInfo>,
    /// Whether the user allows context sharing (Settings → Agents). When
    /// false the tools answer with a clear refusal instead of stale data.
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub updated_at: Option<String>,
}

fn default_true() -> bool {
    true
}

impl Default for Snapshot {
    /// Before the frontend's first publish: sharing is allowed, nothing is
    /// open yet. (`derive(Default)` would make `enabled` false and the tools
    /// would wrongly report "switched off".)
    fn default() -> Self {
        Self {
            workspace_root: None,
            active_path: None,
            active_title: None,
            cursor_line: None,
            selection: None,
            tabs: vec![],
            enabled: true,
            updated_at: None,
        }
    }
}

/// Result of a frontend round trip (edit_buffer / open_file).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoundtripReply {
    pub id: u64,
    pub ok: bool,
    #[serde(default)]
    pub message: String,
}

pub struct McpState {
    pub snapshot: Mutex<Snapshot>,
    pending: Mutex<HashMap<u64, Sender<RoundtripReply>>>,
    next_id: Mutex<u64>,
}

impl McpState {
    pub fn new() -> Self {
        Self {
            snapshot: Mutex::new(Snapshot::default()),
            pending: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }
}

impl Default for McpState {
    fn default() -> Self {
        Self::new()
    }
}

// --- Tauri commands (frontend side) ------------------------------------------

/// Frontend pushes the current editor state. Called on every debounced
/// change; cheap (in-memory clone).
#[tauri::command]
pub fn mcp_publish(state: tauri::State<'_, Arc<McpState>>, mut snapshot: Snapshot) {
    if let Ok(mut g) = state.snapshot.lock() {
        // The frontend omits (sends `content: None`) a tab whose text is
        // unchanged since the last publish, so a cursor move doesn't re-ship
        // every open buffer. Carry the previous text forward, matched by path,
        // together with its `truncated` flag: already-cut text is under the
        // cap, so re-capping it would not set the flag again.
        // Untitled tabs (no path) can't be matched, so the frontend always
        // ships their content.
        for t in &mut snapshot.tabs {
            if t.content.is_none() {
                if let Some(path) = t.path.as_deref() {
                    if let Some(prev) = g.tabs.iter().find(|p| p.path.as_deref() == Some(path)) {
                        t.content = prev.content.clone();
                        t.truncated = prev.truncated;
                    }
                }
            }
        }
        cap_tab_buffers(&mut snapshot.tabs);
        *g = snapshot;
    }
}

/// Cap each tab's carried text at `MAX_BUFFER_BYTES`, flagging any tab we had
/// to cut so the read/edit tools can be honest about it. Idempotent: a later
/// publish with a smaller buffer clears the flag (it deserializes false).
pub(crate) fn cap_tab_buffers(tabs: &mut [TabInfo]) {
    for t in tabs {
        if let Some(c) = &t.content {
            if c.len() > MAX_BUFFER_BYTES {
                t.content = Some(truncate_at_char_boundary(c, MAX_BUFFER_BYTES).to_string());
                t.truncated = true;
            }
        }
    }
}

/// Frontend answers a pending `edit_buffer` / `open_file` round trip.
#[tauri::command]
pub fn mcp_reply(state: tauri::State<'_, Arc<McpState>>, reply: RoundtripReply) {
    let tx = state
        .pending
        .lock()
        .ok()
        .and_then(|mut p| p.remove(&reply.id));
    if let Some(tx) = tx {
        let _ = tx.send(reply);
    }
}

/// How an agent should start the SparkDown MCP server: this binary in stdio
/// mode. Absent when the server is not running (bind or pipe setup failed).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShimCommand {
    pub program: String,
    pub args: Vec<String>,
    /// Local Windows only: a Claude Code `--mcp-config` FILE with the same
    /// server, so the PowerShell launch line passes a plain path instead of
    /// inline JSON (see [`write_claude_session_config`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_file: Option<String>,
}

/// Whether the in-app MCP server is serving (the status bar's "Agent tools"
/// item). False when the socket failed to bind or on unsupported platforms.
#[tauri::command]
pub fn mcp_server_running() -> bool {
    is_running()
}

#[tauri::command]
pub fn mcp_shim_command() -> Option<ShimCommand> {
    if !is_running() {
        return None;
    }
    // Remote workspace: the agent runs on the host, so it gets the shim script
    // SparkDown installed there, which bridges to the reverse-forwarded
    // socket. None while the forward is down (→ file-bridge fallback).
    if crate::remote::is_active() {
        crate::remote::remote_mcp_socket()?;
        let session = crate::remote::current_session()?;
        return Some(ShimCommand {
            program: crate::remote::remote_mcp_shim_path(&session),
            args: vec![],
            config_file: None,
        });
    }
    let program = shim_program()?.to_string_lossy().into_owned();
    let args = vec![SHIM_FLAG.to_string()];
    // Windows: Claude Code gets its session server from a file (a path has no
    // quoting hazard in PowerShell; inline JSON does). A failed write only
    // costs the injection: the frontend then uses the teaching prompt.
    let config_file = if cfg!(windows) {
        let path = claude_session_config_path();
        write_claude_session_config(&path, &program, &args)
            .ok()
            .map(|_| path.to_string_lossy().into_owned())
    } else {
        None
    };
    Some(ShimCommand {
        program,
        args,
        config_file,
    })
}

/// Per-process file for Claude Code's `--mcp-config` on Windows, in the
/// per-user temp dir (`%LOCALAPPDATA%\Temp`: its ACL admits only the user,
/// SYSTEM and Administrators, and the file inherits it). The pid keeps two
/// app instances apart. It holds no secret (the socket travels in
/// `$SPARKDOWN_MCP`), only the shim command. Removed in [`shutdown`].
pub(crate) fn claude_session_config_path() -> PathBuf {
    std::env::temp_dir().join(format!("sparkdown-{}-claude-mcp.json", std::process::id()))
}

/// The `--mcp-config` JSON for one stdio server named [`SERVER_NAME`].
/// serde_json escapes the Windows backslashes and any quote in the path.
pub(crate) fn claude_session_config_json(program: &str, args: &[String]) -> String {
    json!({ "mcpServers": { SERVER_NAME: { "command": program, "args": args } } }).to_string()
}

/// (Re)write the Claude Code session config at `path`. Rewritten on every
/// launch, so a moved app binary is picked up.
pub(crate) fn write_claude_session_config(
    path: &std::path::Path,
    program: &str,
    args: &[String],
) -> std::io::Result<()> {
    std::fs::write(path, claude_session_config_json(program, args))
}

/// The shim program an agent config should point at for the active target
/// (remote host or this machine), and whether that target is remote.
fn shim_for_target() -> Result<(String, bool), String> {
    if crate::remote::is_active() {
        let session = crate::remote::current_session().ok_or("no remote session")?;
        if crate::remote::remote_mcp_socket().is_none() {
            return Err("the remote MCP forward is not available on this host".into());
        }
        return Ok((crate::remote::remote_mcp_shim_path(&session), true));
    }
    Ok((
        shim_program()
            .ok_or("could not locate the SparkDown executable")?
            .to_string_lossy()
            .into_owned(),
        false,
    ))
}

/// Run an agent CLI command (argv) where the agent lives: the remote login
/// shell for a remote workspace, else the local login shell (Unix) or the
/// resolved program itself (Windows, see [`run_local_argv_windows`]).
/// Blocking.
fn run_agent_cli(argv: &[String], remote: bool) -> Result<String, String> {
    if remote {
        crate::remote::run_in_login_shell(&posix_command_line(argv))
    } else if cfg!(windows) {
        run_local_argv_windows(argv)
    } else {
        run_in_login_shell(&posix_command_line(argv))
    }
}

/// The CLI flag that switches this binary into stdio-MCP mode (main.rs).
pub const SHIM_FLAG: &str = "--mcp-stdio";
/// The name SparkDown registers itself under in each agent's MCP config.
pub const SERVER_NAME: &str = "sparkdown";

/// Single-quote a value for a POSIX shell (wrap, escape embedded quotes).
fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// One argv as a POSIX shell command line: words made only of safe
/// characters stay bare, every other word is single-quoted.
fn posix_command_line(argv: &[String]) -> String {
    let safe = |c: char| c.is_ascii_alphanumeric() || "-_./=:@,+%".contains(c);
    argv.iter()
        .map(|w| {
            if !w.is_empty() && w.chars().all(safe) {
                w.clone()
            } else {
                shq(w)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The commands (argv) to add / remove our stdio server in one agent's own
/// MCP config, keyed by the agent's `bin`. `None` for agents with no such
/// CLI (they keep the launch-time flag or the prompt fallback). `exe` is the
/// shim program. An argv, not a shell string, so each platform quotes it
/// for the way it runs it: a POSIX login shell, or the program itself on
/// Windows.
fn agent_mcp_commands(bin: &str, exe: &str) -> Option<(Vec<String>, Vec<String>)> {
    let n = SERVER_NAME;
    let v = |words: &[&str]| words.iter().map(|w| w.to_string()).collect::<Vec<_>>();
    Some(match bin {
        // Claude Code: `mcp add <name> [--scope user] -- <cmd> <args>`.
        "claude" => (
            v(&[
                "claude", "mcp", "add", n, "--scope", "user", "--", exe, SHIM_FLAG,
            ]),
            v(&["claude", "mcp", "remove", n, "--scope", "user"]),
        ),
        // Codex: `mcp add <name> -- <cmd> <args>`.
        "codex" => (
            v(&["codex", "mcp", "add", n, "--", exe, SHIM_FLAG]),
            v(&["codex", "mcp", "remove", n]),
        ),
        // Grok: `mcp add [-s user] <name> <cmd> -- <args>` (args after --).
        "grok" => (
            v(&["grok", "mcp", "add", "-s", "user", n, exe, "--", SHIM_FLAG]),
            v(&["grok", "mcp", "remove", n]),
        ),
        // Kiro: flag-based; --force replaces an existing entry.
        "kiro-cli" => (
            v(&[
                "kiro-cli",
                "mcp",
                "add",
                "--name",
                n,
                "--command",
                exe,
                "--args",
                SHIM_FLAG,
                "--scope",
                "global",
                "--force",
            ]),
            v(&[
                "kiro-cli", "mcp", "remove", "--name", n, "--scope", "global",
            ]),
        ),
        // Gemini CLI: `mcp add <name> <cmd> <args>`.
        "gemini" => (
            v(&["gemini", "mcp", "add", n, exe, SHIM_FLAG]),
            v(&["gemini", "mcp", "remove", n]),
        ),
        // cursor-agent, agy: no add-server CLI; see `json_file_agent`.
        // opencode: per-session inline config at launch (terminal.ts), no install.
        _ => return None,
    })
}

/// Windows: the program and leading arguments that run a resolved agent
/// program. An `.exe` / `.com` runs directly; a `.cmd` / `.bat` (npm's
/// shims) too: Rust's std starts `cmd.exe` for it and escapes every
/// argument for cmd, or refuses one it cannot escape. A `.ps1` (a
/// script-only install) runs through Windows PowerShell `-File`.
pub(crate) fn windows_runner(program: &std::path::Path) -> Vec<std::ffi::OsString> {
    let ext = program
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "ps1" {
        let mut v: Vec<std::ffi::OsString> = [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-File",
        ]
        .iter()
        .map(Into::into)
        .collect();
        v.push(program.as_os_str().to_owned());
        v
    } else {
        vec![program.as_os_str().to_owned()]
    }
}

/// Windows: run `argv` with no shell string at all. `argv[0]` is resolved on
/// PATH + PATHEXT (`claude` → `claude.exe` or npm's `claude.cmd`), so the
/// arguments (the shim path can hold spaces or an apostrophe) are never
/// parsed by PowerShell. Same timeout and error shape as the Unix
/// [`run_in_login_shell`]. Blocking.
pub(crate) fn run_local_argv_windows(argv: &[String]) -> Result<String, String> {
    let (bin, rest) = argv.split_first().ok_or("empty agent command")?;
    let program =
        crate::context::find_on_path(bin).ok_or_else(|| format!("could not find {bin} on PATH"))?;
    run_program_windows(&program, rest)
}

/// Run a resolved agent `program` (see [`windows_runner`]) with `rest`.
pub(crate) fn run_program_windows(
    program: &std::path::Path,
    rest: &[String],
) -> Result<String, String> {
    let mut full = windows_runner(program);
    let runner = full.remove(0);
    full.extend(rest.iter().map(std::ffi::OsString::from));
    let (ok, stdout, stderr) =
        run_with_timeout(&runner, &full, &std::env::temp_dir(), CLI_TIMEOUT)?;
    cli_result(ok, stdout, stderr)
}

/// Combined output on success, else an error with the CLI's own message.
fn cli_result(ok: bool, stdout: String, stderr: String) -> Result<String, String> {
    if ok {
        Ok(format!("{stdout}{stderr}"))
    } else {
        Err(format!(
            "the agent CLI reported an error:\n{}",
            if stderr.trim().is_empty() {
                stdout
            } else {
                stderr
            }
        ))
    }
}

/// Cursor CLI's bin. It has no `mcp add`, so SparkDown edits its user-scope
/// config itself, only with the user's consent: ONE `"sparkdown"` entry
/// under `mcpServers`, nothing else touched.
pub const CURSOR_BIN: &str = "cursor-agent";
/// Antigravity CLI's bin (Google's successor to Gemini CLI). Same deal as
/// Cursor: no `mcp add` CLI and no inline flag, so SparkDown writes one
/// entry in its config file, with consent.
pub const AGY_BIN: &str = "agy";

/// An agent whose MCP servers live in a JSON file under `mcpServers` (the
/// `command` / `args` / `env` shape) and that has no `mcp add` CLI, so
/// SparkDown edits that file itself: ONE `"sparkdown"` entry, nothing else.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct JsonFileAgent {
    /// The config file, relative to `$HOME`.
    pub rel: &'static str,
    /// `env` value that hands the agent's own `$SPARKDOWN_MCP` to the shim,
    /// in the agent's interpolation syntax. An agent may start servers with
    /// a reduced environment (Codex does), so the gate variable is named.
    pub env_value: &'static str,
}

/// The JSON-file agents, keyed by bin.
/// - Cursor: `${env:NAME}` interpolation in `mcp.json` `env` is documented
///   (cursor.com/docs/context/mcp).
/// - Antigravity: its docs (antigravity.google/docs/mcp) describe `env` but
///   say nothing about inheritance or expansion; `$SPARKDOWN_MCP` is the
///   form Gemini CLI (its predecessor, same `~/.gemini` tree) documents.
pub(crate) fn json_file_agent(bin: &str) -> Option<JsonFileAgent> {
    Some(match bin {
        CURSOR_BIN => JsonFileAgent {
            rel: ".cursor/mcp.json",
            env_value: "${env:SPARKDOWN_MCP}",
        },
        AGY_BIN => JsonFileAgent {
            rel: ".gemini/config/mcp_config.json",
            env_value: "$SPARKDOWN_MCP",
        },
        _ => return None,
    })
}

/// The `mcpServers.sparkdown` entry for a JSON-file agent.
pub(crate) fn json_server_entry(agent: JsonFileAgent, program: &str, args: &[String]) -> Value {
    json!({
        "command": program,
        "args": args,
        "env": { SOCKET_ENV: agent.env_value },
    })
}

/// Parse an agent's JSON config as an object (key order kept: serde_json's
/// `preserve_order`). A missing or blank file is an empty object. Anything
/// else that is not a JSON object is refused, never overwritten. `rel`
/// names the file in messages.
fn parse_json_config(
    existing: Option<&str>,
    rel: &str,
) -> Result<serde_json::Map<String, Value>, String> {
    let text = existing.unwrap_or("");
    if text.trim().is_empty() {
        return Ok(serde_json::Map::new());
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(format!(
            "~/{rel} is not a JSON object, so SparkDown left it unchanged."
        )),
        Err(e) => Err(format!(
            "~/{rel} is not valid JSON ({e}), so SparkDown left it unchanged. \
             Fix the file, then try again."
        )),
    }
}

fn json_config_text(root: serde_json::Map<String, Value>) -> String {
    let mut text = serde_json::to_string_pretty(&Value::Object(root)).unwrap_or_default();
    text.push('\n');
    text
}

/// The config text with our server `entry` added (or replaced, in place).
/// Every other key and server is kept, in its order.
pub(crate) fn json_config_with_server(
    existing: Option<&str>,
    rel: &str,
    entry: Value,
) -> Result<String, String> {
    let mut root = parse_json_config(existing, rel)?;
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Value::Object(servers) = servers else {
        return Err(format!(
            "\"mcpServers\" in ~/{rel} is not an object, so SparkDown left the file unchanged."
        ));
    };
    servers.insert(SERVER_NAME.to_string(), entry);
    Ok(json_config_text(root))
}

/// The config text with our server removed, or `None` when there is nothing
/// to remove (no file, or no entry of ours): the file is then not rewritten
/// at all.
pub(crate) fn json_config_without_server(
    existing: Option<&str>,
    rel: &str,
) -> Result<Option<String>, String> {
    if existing.is_none_or(|t| t.trim().is_empty()) {
        return Ok(None);
    }
    let mut root = parse_json_config(existing, rel)?;
    let Some(Value::Object(servers)) = root.get_mut("mcpServers") else {
        return Ok(None);
    };
    // shift_remove keeps the other servers' order (remove would swap).
    if servers.shift_remove(SERVER_NAME).is_none() {
        return Ok(None);
    }
    Ok(Some(json_config_text(root)))
}

/// Read a file for a read-modify-write: `Ok(None)` only when it does not
/// exist; any other read error is returned (never treated as empty).
fn read_for_edit(path: &std::path::Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

/// Add our entry to `<home>/<agent.rel>`. Missing dirs / file are created
/// owner-only (0700 / 0600); an existing file keeps its mode
/// (`write_atomic`). Home is injected so tests use a temp dir.
pub(crate) fn json_install_at(
    home: &std::path::Path,
    agent: JsonFileAgent,
    program: &str,
    args: &[String],
) -> Result<(), String> {
    let path = home.join(agent.rel);
    let existing = read_for_edit(&path)?;
    let text = json_config_with_server(
        existing.as_deref(),
        agent.rel,
        json_server_entry(agent, program, args),
    )?;
    let dir = path.parent().ok_or("config path has no parent")?;
    let io = |e: std::io::Error| format!("could not write {}: {e}", path.display());
    if !dir.exists() {
        let mut b = std::fs::DirBuilder::new();
        b.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(dir).map_err(io)?;
    }
    if existing.is_none() {
        // Create it owner-only first; write_atomic then keeps that mode.
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        match o.open(&path) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(io(e)),
        }
    }
    crate::fsio::write_atomic(&path, text.as_bytes()).map_err(io)
}

/// Remove our entry from `<home>/<agent.rel>` (nothing else).
pub(crate) fn json_uninstall_at(
    home: &std::path::Path,
    agent: JsonFileAgent,
) -> Result<(), String> {
    let path = home.join(agent.rel);
    let existing = read_for_edit(&path)?;
    if let Some(text) = json_config_without_server(existing.as_deref(), agent.rel)? {
        crate::fsio::write_atomic(&path, text.as_bytes())
            .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Install into a JSON-file agent on the active target. Remote: read the
/// host's file over SSH, merge here, write it back (atomic, size-checked;
/// missing dirs / file created owner-only).
fn json_install(
    agent: JsonFileAgent,
    program: &str,
    args: &[String],
    remote: bool,
) -> Result<(), String> {
    if remote {
        let existing = crate::remote::read_home_file_for_edit(agent.rel)?;
        let text = json_config_with_server(
            existing.as_deref(),
            agent.rel,
            json_server_entry(agent, program, args),
        )?;
        return crate::remote::write_home_file(agent.rel, &text);
    }
    json_install_at(
        &home_dir().ok_or("could not find the home folder")?,
        agent,
        program,
        args,
    )
}

fn json_uninstall(agent: JsonFileAgent, remote: bool) -> Result<(), String> {
    if remote {
        let existing = crate::remote::read_home_file_for_edit(agent.rel)?;
        if let Some(text) = json_config_without_server(existing.as_deref(), agent.rel)? {
            crate::remote::write_home_file(agent.rel, &text)?;
        }
        return Ok(());
    }
    json_uninstall_at(&home_dir().ok_or("could not find the home folder")?, agent)
}

/// The local home folder: `$HOME`, or `%USERPROFILE%` on Windows.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// How long an agent CLI may take for `mcp add` / `mcp remove` before we
/// give up and kill it (some CLIs contact every configured server).
const CLI_TIMEOUT: Duration = Duration::from_secs(20);

/// Run `program args…` with a deadline: stdin closed, stdout/stderr drained
/// on helper threads (so a chatty child never blocks on a full pipe), and the
/// child killed if it outlives `timeout`. Returns (success, stdout, stderr).
pub(crate) fn run_with_timeout<P, A>(
    program: P,
    args: &[A],
    cwd: &std::path::Path,
    timeout: Duration,
) -> Result<(bool, String, String), String>
where
    P: AsRef<std::ffi::OsStr>,
    A: AsRef<std::ffi::OsStr>,
{
    use std::process::{Command, Stdio};
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // A GUI app on Windows would flash a console window for each console
    // child (git, an agent CLI, cmd.exe for a .cmd shim) without this.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    // Own process group, so a timeout can kill the shell AND anything it
    // spawned (the agent CLI, its MCP children). Killing only the shell would
    // leave grandchildren holding our pipes open.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not run the agent CLI: {e}"))?;
    fn drain<R: std::io::Read + Send + 'static>(r: Option<R>) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    }
    let out_t = drain(child.stdout.take());
    let err_t = drain(child.stderr.take());
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if std::time::Instant::now() >= deadline => {
                kill_tree(&mut child);
                let _ = child.wait();
                // Do NOT join the drain threads here: a grandchild that
                // survived may still hold the pipes; the threads end when it
                // exits, and we have nothing to read from a failed run.
                return Err(format!(
                    "the agent CLI did not finish within {} s and was stopped",
                    timeout.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("could not wait for the agent CLI: {e}")),
        }
    };
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    Ok((status.success(), stdout, stderr))
}

/// Kill `child` and, on Unix, its whole process group (see `process_group(0)`
/// at spawn), so grandchildren go too.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // SAFETY: kill(2) with a negative pid signals a process group; the
        // pid is our own child's, obtained from the live handle.
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        const SIGKILL: i32 = 9;
        unsafe {
            kill(-(child.id() as i32), SIGKILL);
        }
    }
    let _ = child.kill();
}

/// Run a command in the user's interactive login shell (so the agent binary,
/// possibly a shell function or on a profile-only PATH, resolves). The
/// working directory is the temp dir, NOT the app's (home or `/` for a Dock
/// launch): agent CLIs scan the cwd for project config, and a scan of `$HOME`
/// touches Documents/Downloads/Desktop, which macOS attributes to SparkDown
/// and prompts for. Returns combined output on success, or an error with the
/// CLI's own message. Blocking: call from a worker thread, never the UI.
fn run_in_login_shell(cmd: &str) -> Result<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let (ok, stdout, stderr) =
        run_with_timeout(&shell, &["-lic", cmd], &std::env::temp_dir(), CLI_TIMEOUT)?;
    cli_result(ok, stdout, stderr)
}

/// Register SparkDown as a stdio MCP server in `bin`'s own config, via that
/// agent's `mcp add`. The user runs this from Settings or accepts the launch
/// prompt. SparkDown writes no agent config itself, except for the agents
/// with no `mcp add` CLI (Cursor, Antigravity): one entry in their JSON
/// config file, see `json_file_agent` / `json_install_at`.
/// Errors carry the CLI's own message.
// Async: the CLI call runs on Tauri's worker pool so the window never freezes.
#[tauri::command]
pub async fn mcp_install_agent(bin: String) -> Result<String, String> {
    let (exe, remote) = shim_for_target()?;
    if let Some(agent) = json_file_agent(&bin) {
        // Same program + args as the session ShimCommand: the remote shim
        // script takes none.
        let args = if remote {
            vec![]
        } else {
            vec![SHIM_FLAG.to_string()]
        };
        return tauri::async_runtime::spawn_blocking(move || {
            json_install(agent, &exe, &args, remote)
        })
        .await
        .map_err(|e| format!("install task failed: {e}"))?
        .map(|_| format!("Installed the SparkDown MCP server for {bin}."));
    }
    let (add, _remove) = agent_mcp_commands(&bin, &exe)
        .ok_or_else(|| format!("{bin} has no MCP install command SparkDown knows"))?;
    tauri::async_runtime::spawn_blocking(move || run_agent_cli(&add, remote))
        .await
        .map_err(|e| format!("install task failed: {e}"))?
        .map(|_| format!("Installed the SparkDown MCP server for {bin}."))
}

/// Remove SparkDown from `bin`'s MCP config.
#[tauri::command]
pub async fn mcp_uninstall_agent(bin: String) -> Result<String, String> {
    // Removal needs no shim path; do not fail just because the forward is down.
    let remote = crate::remote::is_active();
    if let Some(agent) = json_file_agent(&bin) {
        return tauri::async_runtime::spawn_blocking(move || json_uninstall(agent, remote))
            .await
            .map_err(|e| format!("uninstall task failed: {e}"))?
            .map(|_| format!("Removed the SparkDown MCP server from {bin}."));
    }
    let (_add, remove) = agent_mcp_commands(&bin, "")
        .ok_or_else(|| format!("{bin} has no MCP config SparkDown manages"))?;
    tauri::async_runtime::spawn_blocking(move || run_agent_cli(&remove, remote))
        .await
        .map_err(|e| format!("uninstall task failed: {e}"))?
        .map(|_| format!("Removed the SparkDown MCP server from {bin}."))
}

/// Format of an agent's user-scope MCP config file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigFormat {
    /// JSON with a top-level `"mcpServers": { "<name>": … }` object.
    JsonMcpServers,
    /// TOML with `[mcp_servers.<name>]` tables.
    TomlMcpServers,
}

/// The user-scope MCP config file each agent's `mcp add` writes, relative to
/// `$HOME`. This is what the Installed/Not-installed status reads: a file
/// read is instant and touches no user folders, whereas the CLIs' `mcp list`
/// starts and health-checks every configured server (seconds) and scans the
/// cwd for project config (macOS folder-permission prompts).
pub fn agent_mcp_config(bin: &str) -> Option<(&'static str, ConfigFormat)> {
    Some(match bin {
        "claude" => (".claude.json", ConfigFormat::JsonMcpServers),
        "codex" => (".codex/config.toml", ConfigFormat::TomlMcpServers),
        "grok" => (".grok/config.toml", ConfigFormat::TomlMcpServers),
        "kiro-cli" => (".kiro/settings/mcp.json", ConfigFormat::JsonMcpServers),
        "gemini" => (".gemini/settings.json", ConfigFormat::JsonMcpServers),
        _ => (json_file_agent(bin)?.rel, ConfigFormat::JsonMcpServers),
    })
}

/// Whether `text` (an agent config in `fmt`) declares a server called `name`.
pub fn config_lists_server(text: &str, fmt: ConfigFormat, name: &str) -> bool {
    match fmt {
        ConfigFormat::JsonMcpServers => serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|v| v.get("mcpServers")?.get(name).map(|_| ()))
            .is_some(),
        ConfigFormat::TomlMcpServers => {
            let bare = format!("[mcp_servers.{name}");
            let quoted = format!("[mcp_servers.\"{name}\"");
            text.lines().map(str::trim).any(|l| {
                for prefix in [&bare, &quoted] {
                    if let Some(rest) = l.strip_prefix(prefix.as_str()) {
                        // Exactly this table (`]`) or one of its sub-tables (`.`).
                        if rest.starts_with(']') || rest.starts_with('.') || rest.starts_with("\"]")
                        {
                            return true;
                        }
                    }
                }
                false
            })
        }
    }
}

/// Whether `bin`'s user-scope MCP config already lists our server. Reads the
/// agent's config file directly (see `agent_mcp_config`); never runs the CLI.
/// For a remote workspace the file is read on the host (one SSH round trip
/// over the control (mux) connection), hence async.
#[tauri::command]
pub async fn mcp_agent_installed(bin: String) -> bool {
    let Some((rel, fmt)) = agent_mcp_config(&bin) else {
        return false;
    };
    if crate::remote::is_active() {
        return tauri::async_runtime::spawn_blocking(move || {
            crate::remote::read_home_file(rel)
                .map(|t| config_lists_server(&t, fmt, SERVER_NAME))
                .unwrap_or(false)
        })
        .await
        .unwrap_or(false);
    }
    let Some(home) = home_dir() else {
        return false;
    };
    std::fs::read_to_string(home.join(rel))
        .map(|t| config_lists_server(&t, fmt, SERVER_NAME))
        .unwrap_or(false)
}
/// Env var naming the socket; set in SparkDown terminals only.
pub const SOCKET_ENV: &str = "SPARKDOWN_MCP";

/// Path of the executable an agent config should point at. AppImage mounts
/// under a fresh path every run, so prefer the `$APPIMAGE` file it exports.
pub fn shim_program() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("APPIMAGE") {
        return Some(PathBuf::from(p));
    }
    std::env::current_exe().ok()
}

/// Stable per-user socket path: `<runtime dir>/sparkdown/mcp.sock`. macOS
/// `$TMPDIR` is already per-user; Linux prefers `$XDG_RUNTIME_DIR`. The
/// parent dir is created 0700. Stable (not per-pid) so tmux sessions that
/// outlive an app restart keep a working `$SPARKDOWN_MCP`.
#[cfg(unix)]
pub fn mcp_socket_path() -> PathBuf {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("sparkdown").join("mcp.sock")
}

/// Windows: a per-launch named pipe with an unguessable name. Pipes live in
/// one flat, machine-wide namespace with no per-user isolation, so a
/// predictable name (`sparkdown-<user>-mcp`) lets another local account
/// pre-create or squat the pipe and feed our agents forged tool results.
/// Three layers guard against that:
/// - the NAME is unguessable: a random per-launch suffix handed to agents
///   only through `$SPARKDOWN_MCP` (set solely in SparkDown's own
///   terminals);
/// - the first instance is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`
///   (interprocess 2.4 sets it on the listener's first `CreateNamedPipeW`),
///   so if the name already exists, start fails instead of joining a pipe
///   someone else created;
/// - the pipe gets an explicit, protected DACL (`pipe_sddl`): full access
///   for the current user's SID and SYSTEM only. The default named-pipe
///   DACL gives Everyone read access, so any local account could connect.
///
/// Per-launch (not stable across restarts) is fine: a named pipe vanishes
/// with the app anyway, so nothing outlives a restart to reattach to. The
/// `\\.\pipe\` form is what both the server and the shim open
/// (`GenericFilePath`).
#[cfg(windows)]
pub fn mcp_socket_path() -> PathBuf {
    static PIPE: OnceLock<PathBuf> = OnceLock::new();
    PIPE.get_or_init(|| {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".into());
        let safe: String = user
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect();
        PathBuf::from(format!(r"\\.\pipe\sparkdown-{safe}-{}-mcp", random_token()))
    })
    .clone()
}

/// 128 bits of OS-seeded randomness as hex, no extra crate. `RandomState` is
/// seeded from the platform RNG (it backs HashMap's hash-flooding defence), so
/// hashing a fixed input under two fresh instances yields an unguessable token
/// for the pipe name.
#[cfg(windows)]
fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut token = String::with_capacity(32);
    for _ in 0..2 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(0x9E37_79B9_7F4A_7C15);
        token.push_str(&format!("{:016x}", h.finish()));
    }
    token
}

static SOCKET: OnceLock<PathBuf> = OnceLock::new();

fn is_running() -> bool {
    SOCKET.get().is_some()
}

/// The live socket path if the server bound successfully, for the terminal to
/// export as `$SPARKDOWN_MCP`. `None` when the server is not running.
pub fn running_socket_path() -> Option<std::ffi::OsString> {
    SOCKET.get().map(|p| p.clone().into_os_string())
}

/// Remove the socket file (called on quit). Best-effort. A Windows named
/// pipe disappears with its last handle, so there is nothing to remove.
pub fn shutdown() {
    #[cfg(unix)]
    if let Some(p) = SOCKET.get() {
        let _ = std::fs::remove_file(p);
    }
    // Claude Code's Windows session config (never written elsewhere).
    if cfg!(windows) {
        let _ = std::fs::remove_file(claude_session_config_path());
    }
}

// --- Server ------------------------------------------------------------------

/// Bind the Unix socket and serve forever on a background thread. Returns the
/// socket path. Fails if another SparkDown instance already serves it.
#[cfg(unix)]
pub fn start(app: AppHandle, state: Arc<McpState>) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    let path = mcp_socket_path();
    let dir = path.parent().expect("socket path has a parent");
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    if path.exists() {
        // Live socket → another instance owns it. Dead file (crash) → reclaim.
        if UnixStream::connect(&path).is_ok() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "another SparkDown instance is serving the MCP socket",
            ));
        }
        let _ = std::fs::remove_file(&path);
    }
    let listener = UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    let _ = SOCKET.set(path.clone());
    eprintln!("SparkDown MCP socket: {}", path.display());
    std::thread::Builder::new()
        .name("sparkdown-mcp".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let app = app.clone();
                let state = state.clone();
                // One thread per client (one shim per agent process); a slow
                // round trip in one never blocks another.
                std::thread::spawn(move || serve_client(stream, &app, &state));
            }
        })?;
    Ok(path)
}

/// Windows: serve on a per-user named pipe via `interprocess`. Same
/// line protocol; `serve_client` gets the pipe's two halves.
#[cfg(windows)]
pub fn start(app: AppHandle, state: Arc<McpState>) -> std::io::Result<PathBuf> {
    use interprocess::local_socket::traits::ListenerExt as _;
    let path = mcp_socket_path();
    let listener = create_pipe_listener(&path)?;
    let _ = SOCKET.set(path.clone());
    eprintln!("SparkDown MCP pipe: {}", path.display());
    std::thread::Builder::new()
        .name("sparkdown-mcp".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let app = app.clone();
                let state = state.clone();
                std::thread::spawn(move || serve_client(stream, &app, &state));
            }
        })?;
    Ok(path)
}

/// SDDL for the MCP pipe: a protected DACL (`P`: no inherited ACEs) that
/// allows GENERIC_ALL to `user_sid` and to SYSTEM (`SY`), nothing to anyone
/// else.
#[cfg(any(windows, test))]
fn pipe_sddl(user_sid: &str) -> String {
    format!("D:P(A;;GA;;;{user_sid})(A;;GA;;;SY)")
}

/// The current process user's SID as a string (`S-1-5-21-...`), read from
/// the process token (`TokenUser`), not from the environment.
#[cfg(windows)]
fn current_user_sid() -> std::io::Result<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    struct Token(HANDLE);
    impl Drop for Token {
        fn drop(&mut self) {
            // SAFETY: the handle came from a successful OpenProcessToken and
            // is closed exactly once.
            unsafe { CloseHandle(self.0) };
        }
    }

    let mut raw: HANDLE = std::ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo-handle; `raw` is a valid
    // out-pointer.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let token = Token(raw);

    // First call: size query (fails with ERROR_INSUFFICIENT_BUFFER).
    let mut len = 0u32;
    // SAFETY: a null buffer with length 0 is the documented size query.
    unsafe { GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut len) };
    if len == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // u64 storage keeps the buffer aligned for TOKEN_USER (pointer-sized).
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    // SAFETY: `buf` holds at least `len` writable bytes.
    let ok =
        unsafe { GetTokenInformation(token.0, TokenUser, buf.as_mut_ptr().cast(), len, &mut len) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: on success the buffer starts with a TOKEN_USER whose SID
    // pointer points into the same buffer (alive until the end of scope).
    let sid = unsafe { (*buf.as_ptr().cast::<TOKEN_USER>()).User.Sid };

    let mut wide: *mut u16 = std::ptr::null_mut();
    // SAFETY: `sid` is a valid SID; `wide` is a valid out-pointer.
    if unsafe { ConvertSidToStringSidW(sid, &mut wide) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: on success `wide` is a NUL-terminated UTF-16 string that we
    // own and free with LocalFree.
    let s = unsafe {
        let n = (0..).take_while(|&i| *wide.add(i) != 0).count();
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(wide, n));
        LocalFree(wide.cast());
        s
    };
    Ok(s)
}

/// The MCP pipe's security descriptor: current user + SYSTEM only.
#[cfg(windows)]
fn pipe_security_descriptor(
) -> std::io::Result<interprocess::os::windows::security_descriptor::SecurityDescriptor> {
    use interprocess::os::windows::security_descriptor::SecurityDescriptor;
    let sddl = pipe_sddl(&current_user_sid()?);
    let wide = widestring::U16CString::from_str(&sddl)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    SecurityDescriptor::deserialize(&wide)
}

/// Create the pipe listener with the per-user DACL. Fails closed: if the
/// SID or the descriptor cannot be built, no pipe is made. A live pipe of
/// this name (another instance, or a squatter) makes the create fail
/// (first-instance flag); there is no stale file to reclaim.
#[cfg(windows)]
fn create_pipe_listener(
    path: &std::path::Path,
) -> std::io::Result<interprocess::local_socket::Listener> {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    use interprocess::os::windows::local_socket::ListenerOptionsExt;
    let name = path.as_os_str().to_fs_name::<GenericFilePath>()?;
    ListenerOptions::new()
        .name(name)
        .security_descriptor(pipe_security_descriptor()?)
        .create_sync()
}

#[cfg(windows)]
fn serve_client(
    stream: interprocess::local_socket::Stream,
    app: &AppHandle,
    state: &Arc<McpState>,
) {
    use interprocess::local_socket::traits::Stream as _;
    let (read_half, write_half) = stream.split();
    serve_lines(read_half, write_half, |msg| dispatch(app, state, msg));
}

/// One client: newline-delimited JSON-RPC in, one line per response out.
/// Notifications get no reply. Runs until the client hangs up.
#[cfg(unix)]
fn serve_client(stream: std::os::unix::net::UnixStream, app: &AppHandle, state: &Arc<McpState>) {
    let Ok(read_half) = stream.try_clone() else {
        return;
    };
    serve_lines(read_half, stream, |msg| dispatch(app, state, msg));
}

/// Transport-agnostic line loop: read newline-delimited JSON-RPC from
/// `reader`, write one line per response to `writer`. Notifications produce
/// no reply. Shared by the socket server and the stdio shim. Returns when
/// the peer hangs up or a write fails.
pub fn serve_lines<R, W, F>(reader: R, mut writer: W, mut handle: F)
where
    R: std::io::Read,
    W: Write,
    F: FnMut(&Value) -> Option<Value>,
{
    let buf = BufReader::new(reader);
    for line in buf.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => handle(&msg),
            Err(_) => Some(rpc_error(Value::Null, -32700, "Parse error")),
        };
        if let Some(r) = reply {
            if writeln!(writer, "{r}")
                .and_then(|_| writer.flush())
                .is_err()
            {
                break;
            }
        }
    }
}

// --- JSON-RPC / MCP ------------------------------------------------------------

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Route one JSON-RPC message. Returns None for notifications (no id).
pub fn dispatch(app: &AppHandle, state: &Arc<McpState>, msg: &Value) -> Option<Value> {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let id = msg.get("id").cloned();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let Some(id) = id else {
        // Notification (e.g. notifications/initialized): nothing to answer.
        return None;
    };
    Some(match method {
        "initialize" => rpc_result(id, initialize_result(&params)),
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({ "tools": tool_definitions() })),
        "tools/call" => match call_tool(app, state, &params) {
            Ok(v) => rpc_result(id, v),
            Err(e) => rpc_error(id, -32602, &e),
        },
        "resources/list" => rpc_result(id, json!({ "resources": [] })),
        "prompts/list" => rpc_result(id, json!({ "prompts": [] })),
        _ => rpc_error(id, -32601, "Method not found"),
    })
}

fn initialize_result(params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or("");
    let version = if PROTOCOL_VERSIONS.contains(&requested) {
        requested
    } else {
        PROTOCOL_VERSIONS[0]
    };
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "sparkdown", "version": env!("CARGO_PKG_VERSION") },
        "instructions":
            "SparkDown is the user's markdown editor. Call sparkdown_get_context first, and again \
             whenever you need to know what the user is looking at. For files it marks dirty, read \
             them with sparkdown_read_buffer (the exact raw text) — the copy on disk is stale. For \
             specific lines by number (as the editor shows them), call sparkdown_get_lines instead of \
             counting; for the line under the cursor, use cursor_line_text. You may edit files on disk \
             with your own tools as usual; SparkDown reloads them. Exception: a file marked dirty has \
             unsaved user edits that a disk write would clobber — for those, use \
             sparkdown_edit_buffer, which changes the editor buffer instead."
    })
}

/// The agent's vocabulary. Descriptions carry the instructions that the old
/// typed prompt used to; keep them precise.
pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "sparkdown_get_context",
            "description": "What the user is viewing in the SparkDown editor: workspace root, the active file with its cursor_line (1-based), cursor_line_text (the exact text of that line) and line_count, the current selection (if any), and every open tab with its path and whether it has unsaved changes (dirty). Call this first, and again whenever you need to know what the user is looking at. line_count and cursor_line use the editor's numbering (the gutter numbers). For 'this line' use cursor_line_text; for any other line, call sparkdown_get_lines instead of counting lines yourself.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "sparkdown_read_buffer",
            "description": "The exact live text of a file open in SparkDown, including unsaved edits: no line numbers, no added markup, safe to edit and send back to sparkdown_edit_buffer. Use this instead of reading the file from disk for any tab marked dirty (the disk copy is stale). To answer about specific lines by number (e.g. 'what is on line 7'), call sparkdown_get_lines instead of counting lines in this output. Fails if the file is not open in SparkDown.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path of the open file, as listed by sparkdown_get_context." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "sparkdown_get_lines",
            "description": "Get specific lines of a file open in SparkDown by 1-based line number (the numbers the editor shows). Use this for questions like 'what is on line 7' instead of counting lines in sparkdown_read_buffer output. For the line under the cursor, sparkdown_get_context already includes cursor_line_text. Returns JSON: {path, line_count, start_line, end_line, lines: [{n, text}]}. Numbering matches the editor: \\n, \\r\\n and \\r each end a line, text is the exact line without its line ending, a trailing newline is followed by one more (empty) line, and an empty file has one empty line. Ranges are inclusive; end_line past the end is clamped to line_count; at most 2000 lines per call (truncated_range: true when clipped).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path of the open file, as listed by sparkdown_get_context." },
                    "start_line": { "type": "integer", "minimum": 1, "description": "First line to return, 1-based. Must not be past the last line." },
                    "end_line": { "type": "integer", "minimum": 1, "description": "Last line to return, 1-based and inclusive (default: start_line, i.e. one line; a value past the end is clamped to line_count)." }
                },
                "required": ["path", "start_line"], "additionalProperties": false
            }
        },
        {
            "name": "sparkdown_get_selection",
            "description": "The text currently selected in the editor, with the file it belongs to. Empty when nothing is selected. Use it when the user says 'this', 'here', or 'the selected part'.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "sparkdown_edit_buffer",
            "description": "Replace the full text of a file that is open in SparkDown with new content, as an UNSAVED edit in the editor (nothing is written to disk; the user reviews, undoes, or saves). Use this when the file is marked dirty — it has unsaved user edits that a disk write would clobber — or when the user wants to review before anything is saved. For other files, editing on disk with your normal tools is fine. Fails if the file is not open.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path of the open file." },
                    "content": { "type": "string", "description": "The complete new text of the file, exactly as it should be." }
                },
                "required": ["path", "content"], "additionalProperties": false
            }
        },
        {
            "name": "sparkdown_open_file",
            "description": "Open a file in the SparkDown editor (and optionally jump to a line) so the user sees it. Use it to show the user something you refer to.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path of the file to open." },
                    "line": { "type": "integer", "minimum": 1, "description": "1-based line to scroll to." }
                },
                "required": ["path"], "additionalProperties": false
            }
        },
        {
            "name": "sparkdown_list_changes",
            "description": "The git working-tree changes of the SparkDown workspace (what changed since the last commit), as the user sees them in SparkDown's Changes view: each path with its status (modified/added/deleted/renamed/untracked), whether it is staged, and SparkDown's review verdict — meat (worth reviewing) or noise (lockfile, generated, build output, dependency, source map, minified, snapshot, OS file). Call this to review what you or the user changed; start with the meat. Read-only.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "sparkdown_read_diff",
            "description": "The unified diff of one changed file versus HEAD (untracked files diff against nothing). mode \"reading\" (default) is SparkDown's reading diff: import-only and whitespace-only hunks are replaced by one marker line each, so you read only the substantive changes. mode \"full\" is the verbatim diff. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path of the changed file, exactly as listed by sparkdown_list_changes (relative to the repository top level)." },
                    "mode": { "type": "string", "enum": ["reading", "full"], "description": "reading (default) or full." }
                },
                "required": ["path"], "additionalProperties": false
            }
        }
    ])
}

fn text_result(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": false })
}

fn error_result(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

fn call_tool(app: &AppHandle, state: &Arc<McpState>, params: &Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or("missing tool name")?;
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    let snap = state
        .snapshot
        .lock()
        .map(|g| g.clone())
        .map_err(|_| "state poisoned".to_string())?;
    if let Some(result) = snapshot_tool(&snap, name, &args) {
        return Ok(result);
    }
    Ok(match name {
        "sparkdown_edit_buffer" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or("");
            let content = args.get("content").and_then(Value::as_str).unwrap_or("");
            if !snap.tabs.iter().any(|t| t.path.as_deref() == Some(path)) {
                return Ok(error_result(&format!(
                    "{path} is not open in SparkDown. Edit it on disk instead."
                )));
            }
            if let Some(refusal) = edit_buffer_refusal(&snap, path) {
                return Ok(error_result(&refusal));
            }
            match roundtrip(app, state, "mcp://edit", json!({ "path": path, "content": content })) {
                Ok(r) if r.ok => text_result(format!(
                    "Applied to the editor buffer for {path} as an unsaved change; the user can review and save."
                )),
                Ok(r) => error_result(&r.message),
                Err(e) => error_result(&e),
            }
        }
        "sparkdown_open_file" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or("");
            let line = args.get("line").and_then(Value::as_u64);
            match roundtrip(
                app,
                state,
                "mcp://open",
                json!({ "path": path, "line": line }),
            ) {
                Ok(r) if r.ok => text_result(format!("Opened {path} in SparkDown.")),
                Ok(r) => error_result(&r.message),
                Err(e) => error_result(&e),
            }
        }
        "sparkdown_list_changes" => match list_changes(&snap) {
            Ok(v) => text_result(v.to_string()),
            Err(e) => error_result(&e),
        },
        "sparkdown_read_diff" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or("");
            let full = args.get("mode").and_then(Value::as_str) == Some("full");
            match read_diff(&snap, path, full) {
                Ok(text) => text_result(text),
                Err(e) => error_result(&e),
            }
        }
        other => return Err(format!("unknown tool: {other}")),
    })
}

/// The tools answered from the snapshot alone (no frontend round trip, no
/// git), and the `enabled` gate that covers every tool. `None` means the
/// tool is not one of these and the caller dispatches it.
fn snapshot_tool(snap: &Snapshot, name: &str, args: &Value) -> Option<Value> {
    if !snap.enabled {
        return Some(error_result(
            "The user has switched off editor context sharing in SparkDown (Settings → Agents).",
        ));
    }
    let path = args.get("path").and_then(Value::as_str).unwrap_or("");
    Some(match name {
        "sparkdown_get_context" => text_result(context_json(snap)),
        // Old `numbered` / `start_line` / `end_line` arguments are ignored:
        // this tool always returns the exact raw text.
        "sparkdown_read_buffer" => read_buffer_result(snap, path),
        "sparkdown_get_lines" => get_lines_result(snap, path, args),
        "sparkdown_get_selection" => text_result(
            json!({
                "path": snap.active_path,
                "selection": snap.selection.clone().unwrap_or_default(),
                "empty": snap.selection.as_deref().unwrap_or("").is_empty(),
            })
            .to_string(),
        ),
        _ => return None,
    })
}

/// The workspace's git status with SparkDown's meat/noise verdict per path.
/// Uses the same `git_status` as the Changes view (local or remote).
fn list_changes(snap: &Snapshot) -> Result<Value, String> {
    let root = snap
        .workspace_root
        .clone()
        .ok_or("No workspace folder is open in SparkDown.")?;
    let status = crate::git::git_status_impl(root)?;
    if !status.is_repo {
        return Ok(json!({ "is_repo": false, "changes": [] }));
    }
    let changes: Vec<Value> = status
        .changes
        .iter()
        .map(|c| {
            let noise = crate::meat::classify_file(&c.path);
            json!({
                "path": c.path,
                "status": c.status,
                "staged": c.staged,
                "verdict": if noise.is_some() { "noise" } else { "meat" },
                "noise_reason": noise.map(|r| r.as_str()),
            })
        })
        .collect();
    let meat = changes.iter().filter(|c| c["verdict"] == "meat").count();
    Ok(json!({
        "is_repo": true,
        "branch": status.branch,
        "top_level": status.top_level,
        "meat_count": meat,
        "noise_count": changes.len() - meat,
        "changes": changes,
    }))
}

/// One file's diff, abridged to the reading diff unless `full`.
fn read_diff(snap: &Snapshot, path: &str, full: bool) -> Result<String, String> {
    if path.is_empty() {
        return Err("path is required".into());
    }
    let root = snap
        .workspace_root
        .clone()
        .ok_or("No workspace folder is open in SparkDown.")?;
    let status = crate::git::git_status_impl(root)?;
    if !status.is_repo {
        return Err("The workspace is not a git repository.".into());
    }
    let top = status
        .top_level
        .clone()
        .ok_or("could not resolve the repository top level")?;
    let change = status.changes.iter().find(|c| c.path == path).ok_or_else(|| {
        format!("{path} is not in the working-tree changes; call sparkdown_list_changes for the current list.")
    })?;
    let diff = crate::git::git_diff_file_impl(top, path.to_string(), change.status == "untracked")?;
    if full {
        return Ok(diff);
    }
    let (text, omitted) = crate::meat::abridge_diff(&diff);
    Ok(if omitted == 0 {
        text
    } else {
        format!(
            "{text}\n({omitted} noise hunk{} omitted; mode \"full\" shows everything)\n",
            if omitted == 1 { "" } else { "s" }
        )
    })
}

/// Whole-MiB form of `MAX_BUFFER_BYTES` for user-facing messages.
fn max_buffer_mib() -> usize {
    MAX_BUFFER_BYTES / (1024 * 1024)
}

/// The lines of a buffer as the editor (CodeMirror) numbers them, each
/// WITHOUT its line ending. `\r\n`, `\r` and `\n` each end a line (as
/// CodeMirror's default line splitting does); a trailing line ending is
/// followed by one more, empty, line; an empty buffer is one empty line.
/// So `"a\nb\n"` is 3 lines (`a`, `b`, ``), matching the editor's gutter.
fn editor_lines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(['\r', '\n']) {
        lines.push(&rest[..i]);
        let eol = if rest[i..].starts_with("\r\n") { 2 } else { 1 };
        rest = &rest[i + eol..];
    }
    lines.push(rest);
    lines
}

/// Number of lines, as the editor counts them (never 0).
fn line_count(text: &str) -> usize {
    editor_lines(text).len()
}

/// The text of 1-based line `n` (line ending stripped), `None` past the end.
fn line_text(text: &str, n: u32) -> Option<String> {
    let i = (n as usize).checked_sub(1)?;
    editor_lines(text).get(i).map(|l| l.to_string())
}

/// Most lines one `sparkdown_get_lines` call returns.
const MAX_GET_LINES: usize = 2000;

/// A 1-based line argument: absent / null → None; a positive integer (or a
/// string of one) → Some; anything else is an error naming the argument.
fn line_arg(args: &Value, key: &str) -> Result<Option<usize>, String> {
    let bad = || format!("{key} must be a positive integer (1-based line number).");
    let n = match args.get(key) {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Number(n)) => n.as_u64().ok_or_else(bad)?,
        Some(Value::String(s)) => s.trim().parse::<u64>().map_err(|_| bad())?,
        Some(_) => return Err(bad()),
    };
    if n == 0 {
        return Err(bad());
    }
    Ok(Some(usize::try_from(n).unwrap_or(usize::MAX)))
}

/// The open tab for `path` whose text SparkDown holds.
fn open_tab<'a>(snap: &'a Snapshot, path: &str) -> Option<&'a TabInfo> {
    snap.tabs
        .iter()
        .find(|t| t.path.as_deref() == Some(path) && t.content.is_some())
}

fn not_open(path: &str) -> Value {
    error_result(&format!(
        "{path} is not open in SparkDown (or its text is unavailable). Read it from disk."
    ))
}

/// `sparkdown_read_buffer`: the exact live text of an open file (no
/// numbering, no footer). A clear notice is appended only when SparkDown
/// holds a truncated copy, so the agent does not mistake the cut text for
/// the whole file.
fn read_buffer_result(snap: &Snapshot, path: &str) -> Value {
    let Some(t) = open_tab(snap, path) else {
        return not_open(path);
    };
    let mut out = t.content.clone().unwrap_or_default();
    if t.truncated {
        out.push_str(&format!(
            "\n\n[SparkDown: this buffer is larger than {} MiB and the text above is TRUNCATED here — the tail is not included. It has unsaved edits, so the on-disk copy is also incomplete. Do not treat this as the full file.]",
            max_buffer_mib()
        ));
    }
    text_result(out)
}

/// `sparkdown_get_lines`: lines `start_line..=end_line` (1-based, editor
/// numbering; `end_line` defaults to `start_line` and is clamped to the last
/// line) as JSON, each line number a separate field from its exact text.
fn get_lines_result(snap: &Snapshot, path: &str, args: &Value) -> Value {
    let (start, end) = match (line_arg(args, "start_line"), line_arg(args, "end_line")) {
        (Err(e), _) | (_, Err(e)) => return error_result(&e),
        (Ok(None), _) => return error_result("start_line is required (1-based line number)."),
        (Ok(Some(s)), Ok(e)) => (s, e.unwrap_or(s)),
    };
    if end < start {
        return error_result(&format!(
            "end_line ({end}) is before start_line ({start}); both are 1-based and inclusive."
        ));
    }
    let Some(t) = open_tab(snap, path) else {
        return not_open(path);
    };
    let lines = editor_lines(t.content.as_deref().unwrap_or_default());
    let total = lines.len();
    if start > total {
        return error_result(&format!(
            "start_line {start} is past the end: {path} has {total} line{}.",
            if total == 1 { "" } else { "s" }
        ));
    }
    let clamped = end.min(total);
    let last = clamped.min(start + MAX_GET_LINES - 1);
    let mut out = json!({
        "path": path,
        "line_count": total,
        "start_line": start,
        "end_line": last,
        "lines": lines[start - 1..last]
            .iter()
            .enumerate()
            .map(|(i, l)| json!({ "n": start + i, "text": l }))
            .collect::<Vec<_>>(),
    });
    if last < clamped {
        out["truncated_range"] = json!(true);
        out["hint"] = json!(format!(
            "At most {MAX_GET_LINES} lines per call; call again with start_line {} for the rest.",
            last + 1
        ));
    }
    if t.truncated {
        out["buffer_truncated"] = json!(true);
        out["note"] = json!(format!(
            "SparkDown holds only the first {} MiB of this buffer; line_count counts that copy, not the whole file.",
            max_buffer_mib()
        ));
    }
    text_result(out.to_string())
}

/// `sparkdown_edit_buffer` guard: refuse (with the reason) when the target tab
/// was truncated. `edit_buffer` replaces the WHOLE buffer, so applying it to a
/// tab we only hold a cut copy of would silently drop everything past the cut.
fn edit_buffer_refusal(snap: &Snapshot, path: &str) -> Option<String> {
    snap.tabs
        .iter()
        .any(|t| t.path.as_deref() == Some(path) && t.truncated)
        .then(|| {
            format!(
                "{path} is larger than {} MiB and SparkDown holds only a truncated copy, so a whole-buffer replacement would drop everything past the cut. Edit a smaller file, or ask the user to split this one.",
                max_buffer_mib()
            )
        })
}

fn context_json(snap: &Snapshot) -> String {
    let active_tab = |p: &String| snap.tabs.iter().find(|t| t.path.as_deref() == Some(p));
    json!({
        "workspace_root": snap.workspace_root,
        "active": snap.active_path.as_ref().map(|p| {
            let text = active_tab(p).and_then(|t| t.content.as_deref());
            json!({
                "path": p,
                "title": snap.active_title,
                "cursor_line": snap.cursor_line,
                // The cursor line's own text, so "what is on this line" needs
                // no counting (null when the text is unavailable).
                "cursor_line_text": text.zip(snap.cursor_line).and_then(|(t, n)| line_text(t, n)),
                "line_count": text.map(line_count),
                "dirty": active_tab(p).map(|t| t.dirty).unwrap_or(false),
            })
        }),
        "has_selection": snap.selection.as_deref().map(|s| !s.is_empty()).unwrap_or(false),
        "tabs": snap.tabs.iter().map(|t| json!({
            "path": t.path, "title": t.title, "dirty": t.dirty,
            "read_with": if t.dirty { "sparkdown_read_buffer" } else { "disk or sparkdown_read_buffer" },
        })).collect::<Vec<_>>(),
        "updated_at": snap.updated_at,
    })
    .to_string()
}

/// Emit an event to the frontend and wait for its `mcp_reply`.
fn roundtrip(
    app: &AppHandle,
    state: &Arc<McpState>,
    event: &str,
    mut payload: Value,
) -> Result<RoundtripReply, String> {
    let id = {
        let mut n = state.next_id.lock().map_err(|_| "state poisoned")?;
        let id = *n;
        *n += 1;
        id
    };
    let (tx, rx) = channel();
    state
        .pending
        .lock()
        .map_err(|_| "state poisoned")?
        .insert(id, tx);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("id".into(), json!(id));
    }
    app.emit(event, payload).map_err(|e| e.to_string())?;
    let out = rx
        .recv_timeout(ROUNDTRIP_TIMEOUT)
        .map_err(|_| "SparkDown did not apply the change in time.".to_string());
    if out.is_err() {
        if let Ok(mut p) = state.pending.lock() {
            p.remove(&id);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap() -> Snapshot {
        Snapshot {
            workspace_root: Some("/w".into()),
            active_path: Some("/w/a.md".into()),
            active_title: Some("a.md".into()),
            cursor_line: Some(3),
            selection: Some("sel".into()),
            tabs: vec![
                TabInfo {
                    path: Some("/w/a.md".into()),
                    title: "a.md".into(),
                    dirty: true,
                    content: Some("live text".into()),
                    truncated: false,
                },
                TabInfo {
                    path: Some("/w/b.md".into()),
                    title: "b.md".into(),
                    dirty: false,
                    content: Some("saved".into()),
                    truncated: false,
                },
            ],
            enabled: true,
            updated_at: None,
        }
    }

    #[test]
    fn initialize_negotiates_a_known_version() {
        let r = initialize_result(&json!({ "protocolVersion": "2025-03-26" }));
        assert_eq!(r["protocolVersion"], "2025-03-26");
        let r = initialize_result(&json!({ "protocolVersion": "1999-01-01" }));
        assert_eq!(r["protocolVersion"], PROTOCOL_VERSIONS[0]);
        assert_eq!(r["serverInfo"]["name"], "sparkdown");
        assert!(r["instructions"]
            .as_str()
            .unwrap()
            .contains("sparkdown_get_context"));
        let instructions = r["instructions"].as_str().unwrap();
        assert!(instructions.contains("sparkdown_get_lines"));
        assert!(!instructions.contains("<TAB>"));
    }

    #[test]
    fn tools_are_well_formed() {
        let tools = tool_definitions();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "sparkdown_get_context",
                "sparkdown_read_buffer",
                "sparkdown_get_lines",
                "sparkdown_get_selection",
                "sparkdown_edit_buffer",
                "sparkdown_open_file",
                "sparkdown_list_changes",
                "sparkdown_read_diff"
            ]
        );
        for t in tools.as_array().unwrap() {
            assert!(t["description"].as_str().unwrap().len() > 40);
            assert_eq!(t["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn context_marks_dirty_tabs_for_buffer_reads() {
        let s = snap();
        let v: Value = serde_json::from_str(&context_json(&s)).unwrap();
        assert_eq!(v["active"]["path"], "/w/a.md");
        assert_eq!(v["active"]["dirty"], true);
        assert_eq!(v["active"]["cursor_line"], 3);
        assert_eq!(v["has_selection"], true);
        assert_eq!(v["tabs"][0]["read_with"], "sparkdown_read_buffer");
        assert_eq!(v["tabs"][1]["dirty"], false);
    }

    #[test]
    fn publish_truncates_oversized_buffers_at_char_boundary() {
        let big = format!("{}😀", "x".repeat(MAX_BUFFER_BYTES - 2));
        let cut = truncate_at_char_boundary(&big, MAX_BUFFER_BYTES);
        assert_eq!(cut.len(), MAX_BUFFER_BYTES - 2);
    }

    #[test]
    fn cap_flags_only_the_tabs_it_cuts() {
        let mut tabs = vec![
            TabInfo {
                path: Some("/w/big.md".into()),
                title: "big.md".into(),
                dirty: true,
                content: Some("z".repeat(MAX_BUFFER_BYTES + 100)),
                truncated: false,
            },
            TabInfo {
                path: Some("/w/small.md".into()),
                title: "small.md".into(),
                dirty: true,
                content: Some("small".into()),
                truncated: false,
            },
        ];
        cap_tab_buffers(&mut tabs);
        assert!(tabs[0].truncated);
        assert_eq!(tabs[0].content.as_ref().unwrap().len(), MAX_BUFFER_BYTES);
        assert!(!tabs[1].truncated);
    }

    #[test]
    fn read_buffer_flags_truncation_and_edit_refuses() {
        let mut s = snap();
        // Mark the open tab as truncated (as cap_tab_buffers would).
        s.tabs[0].truncated = true;

        let read = read_buffer_result(&s, "/w/a.md");
        assert_eq!(read["isError"], false);
        let text = read["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("live text\n\n["), "keeps the text: {text}");
        assert!(text.contains("TRUNCATED"), "flags truncation: {text}");

        // A non-truncated tab reads clean.
        let clean = read_buffer_result(&s, "/w/b.md");
        assert_eq!(clean["content"][0]["text"], "saved");

        // edit_buffer refuses the truncated tab, allows the intact one.
        assert!(edit_buffer_refusal(&s, "/w/a.md").is_some());
        assert!(edit_buffer_refusal(&s, "/w/b.md").is_none());
    }

    /// A snapshot with one open tab holding `text`, cursor on `cursor`.
    fn snap_with(text: &str, cursor: u32) -> Snapshot {
        let mut s = snap();
        s.cursor_line = Some(cursor);
        s.tabs[0].content = Some(text.into());
        s
    }

    /// Call a snapshot tool the way `tools/call` does: (isError, text).
    fn call(s: &Snapshot, name: &str, args: Value) -> (bool, String) {
        let r = snapshot_tool(s, name, &args).expect("a snapshot tool");
        (
            r["isError"].as_bool().unwrap(),
            r["content"][0]["text"].as_str().unwrap().to_string(),
        )
    }

    fn get_lines(s: &Snapshot, mut args: Value) -> Value {
        args["path"] = json!("/w/a.md");
        let (err, text) = call(s, "sparkdown_get_lines", args);
        assert!(!err, "{text}");
        serde_json::from_str(&text).unwrap()
    }

    fn get_lines_err(s: &Snapshot, mut args: Value) -> String {
        args["path"] = json!("/w/a.md");
        let (err, text) = call(s, "sparkdown_get_lines", args);
        assert!(err, "expected an error: {text}");
        text
    }

    #[test]
    fn read_buffer_is_the_exact_raw_text_and_ignores_old_params() {
        for body in [
            "# Title\n\nline three\n",
            "1\tfirst\n2\tsecond\n", // content that starts with numbers and tabs
            "1. one\n2. two",
            "2024\tQ1\r\n2023\tQ4\r\n",
            "",
        ] {
            let s = snap_with(body, 1);
            for args in [
                json!({ "path": "/w/a.md" }),
                json!({ "path": "/w/a.md", "numbered": true, "start_line": 2, "end_line": 2 }),
                json!({ "path": "/w/a.md", "numbered": "yes", "start_line": 0 }),
            ] {
                let (err, text) = call(&s, "sparkdown_read_buffer", args.clone());
                assert!(!err, "{args}");
                assert_eq!(text, body, "{args}");
            }
        }
        let (err, text) = call(
            &snap(),
            "sparkdown_read_buffer",
            json!({ "path": "/w/x.md" }),
        );
        assert!(err);
        assert!(text.contains("not open"), "{text}");
    }

    #[test]
    fn editor_lines_match_codemirror() {
        // CodeMirror: doc.lines of "a\nb\n" is 3 (empty last line), of "" is 1;
        // \r\n, \r and \n all end a line.
        assert_eq!(editor_lines("a\nb\n"), ["a", "b", ""]);
        assert_eq!(editor_lines("a\nb"), ["a", "b"]);
        assert_eq!(editor_lines(""), [""]);
        assert_eq!(editor_lines("a\r\nb\r\n"), ["a", "b", ""]);
        assert_eq!(editor_lines("a\rb"), ["a", "b"]);
        assert_eq!(editor_lines("\n\n"), ["", "", ""]);
    }

    #[test]
    fn get_lines_single_line_and_range() {
        let body: String = (1..=10).map(|i| format!("L{i}\n")).collect();
        let s = snap_with(&body, 1);
        let v = get_lines(&s, json!({ "start_line": 7 }));
        assert_eq!(
            v,
            json!({
                "path": "/w/a.md", "line_count": 11, "start_line": 7, "end_line": 7,
                "lines": [{ "n": 7, "text": "L7" }]
            })
        );
        let v = get_lines(&s, json!({ "start_line": 2, "end_line": 4 }));
        assert_eq!(
            v["lines"],
            json!([{ "n": 2, "text": "L2" }, { "n": 3, "text": "L3" }, { "n": 4, "text": "L4" }])
        );
        // String integers are accepted.
        let v = get_lines(&s, json!({ "start_line": "3", "end_line": "3" }));
        assert_eq!(v["lines"][0]["text"], "L3");
        // Numbered-looking content is returned verbatim.
        let v = get_lines(
            &snap_with("1\tx\n2. y\n", 1),
            json!({ "start_line": 1, "end_line": 2 }),
        );
        assert_eq!(
            v["lines"],
            json!([{ "n": 1, "text": "1\tx" }, { "n": 2, "text": "2. y" }])
        );
    }

    #[test]
    fn get_lines_clamps_and_caps_ranges() {
        let body: String = (1..=10).map(|i| format!("L{i}\n")).collect();
        let s = snap_with(&body, 1);
        // end_line past the end is clamped; the trailing newline's empty line 11 counts.
        let v = get_lines(&s, json!({ "start_line": 9, "end_line": 99 }));
        assert_eq!(v["end_line"], 11);
        assert_eq!(
            v["lines"],
            json!([{ "n": 9, "text": "L9" }, { "n": 10, "text": "L10" }, { "n": 11, "text": "" }])
        );
        assert!(v.get("truncated_range").is_none());

        let big: String = (1..=2500).map(|i| format!("L{i}\n")).collect();
        let s = snap_with(&big, 1);
        let v = get_lines(&s, json!({ "start_line": 1, "end_line": 2500 }));
        assert_eq!(v["end_line"], 2000);
        assert_eq!(v["lines"].as_array().unwrap().len(), 2000);
        assert_eq!(v["truncated_range"], true);
        assert!(v["hint"].as_str().unwrap().contains("start_line 2001"));
        // A clamp to the end within the cap is not a truncated range.
        let v = get_lines(&s, json!({ "start_line": 2000, "end_line": 9999 }));
        assert_eq!(v["end_line"], 2501);
        assert!(v.get("truncated_range").is_none());
    }

    #[test]
    fn get_lines_rejects_invalid_arguments() {
        let s = snap_with("a\nb\nc", 1);
        for (args, needle) in [
            (json!({}), "start_line is required"),
            (
                json!({ "start_line": 0 }),
                "start_line must be a positive integer",
            ),
            (
                json!({ "start_line": -1 }),
                "start_line must be a positive integer",
            ),
            (json!({ "start_line": 1.5 }), "start_line must be"),
            (json!({ "start_line": "x" }), "start_line must be"),
            (
                json!({ "start_line": 1, "end_line": 0 }),
                "end_line must be",
            ),
            (
                json!({ "start_line": 3, "end_line": 2 }),
                "is before start_line",
            ),
            (
                json!({ "start_line": 4 }),
                "past the end: /w/a.md has 3 lines",
            ),
        ] {
            let text = get_lines_err(&s, args.clone());
            assert!(text.contains(needle), "{args}: {text}");
        }
        let (err, text) = call(
            &s,
            "sparkdown_get_lines",
            json!({ "path": "/w/x.md", "start_line": 1 }),
        );
        assert!(err);
        assert!(text.contains("not open"), "{text}");
    }

    #[test]
    fn get_lines_handles_crlf_trailing_newlines_and_empty_files() {
        let s = snap_with("one\r\ntwo\r\n", 1);
        let v = get_lines(&s, json!({ "start_line": 1, "end_line": 3 }));
        assert_eq!(v["line_count"], 3);
        assert_eq!(
            v["lines"],
            json!([{ "n": 1, "text": "one" }, { "n": 2, "text": "two" }, { "n": 3, "text": "" }]),
            "no stray \\r in the text"
        );
        // "a\nb\n" is 3 lines in the editor; "a\nb" is 2.
        assert_eq!(
            get_lines(&snap_with("a\nb\n", 1), json!({ "start_line": 1 }))["line_count"],
            3
        );
        assert_eq!(
            get_lines(&snap_with("a\nb", 1), json!({ "start_line": 1 }))["line_count"],
            2
        );
        // An empty file is one empty line (the editor shows line 1).
        let empty = snap_with("", 1);
        let v = get_lines(&empty, json!({ "start_line": 1 }));
        assert_eq!(v["line_count"], 1);
        assert_eq!(v["lines"], json!([{ "n": 1, "text": "" }]));
        let text = get_lines_err(&empty, json!({ "start_line": 2 }));
        assert!(text.contains("has 1 line."), "{text}");
    }

    #[test]
    fn get_lines_flags_truncated_buffers() {
        let mut s = snap_with("a\nb", 1);
        s.tabs[0].truncated = true;
        let v = get_lines(&s, json!({ "start_line": 1 }));
        assert_eq!(v["buffer_truncated"], true);
        assert!(v["note"].as_str().unwrap().contains("MiB"));
    }

    #[test]
    fn disabled_gate_refuses_every_snapshot_tool() {
        let mut s = snap();
        s.enabled = false;
        for name in [
            "sparkdown_get_context",
            "sparkdown_read_buffer",
            "sparkdown_get_lines",
            "sparkdown_get_selection",
            "sparkdown_edit_buffer",
        ] {
            let (err, text) = call(&s, name, json!({ "path": "/w/a.md", "start_line": 1 }));
            assert!(err, "{name}");
            assert!(text.contains("switched off"), "{name}: {text}");
        }
        // Enabled: tools that need the app are left to the caller.
        assert!(snapshot_tool(&snap(), "sparkdown_edit_buffer", &json!({})).is_none());
    }

    #[test]
    fn context_carries_cursor_line_text_and_line_count() {
        let body = "l1\nl2\nl3\nl4\nl5\nl6\nseventh line\nl8\nl9\n";
        let v: Value = serde_json::from_str(&context_json(&snap_with(body, 7))).unwrap();
        assert_eq!(v["active"]["cursor_line"], 7);
        assert_eq!(v["active"]["cursor_line_text"], "seventh line");
        // Editor numbering: the trailing newline is followed by an empty line 10.
        assert_eq!(v["active"]["line_count"], 10);
        // CRLF: the text carries no \r.
        let v: Value = serde_json::from_str(&context_json(&snap_with("a\r\nb\r\n", 2))).unwrap();
        assert_eq!(v["active"]["cursor_line_text"], "b");
        // Cursor on the empty line after a trailing newline: "".
        let v: Value = serde_json::from_str(&context_json(&snap_with("a\n", 2))).unwrap();
        assert_eq!(v["active"]["cursor_line_text"], "");
        assert_eq!(v["active"]["line_count"], 2);
        // Out of range, or no text: null.
        let v: Value = serde_json::from_str(&context_json(&snap_with("a", 5))).unwrap();
        assert!(v["active"]["cursor_line_text"].is_null());
        let mut s = snap_with("a", 1);
        s.tabs[0].content = None;
        let v: Value = serde_json::from_str(&context_json(&s)).unwrap();
        assert!(v["active"]["cursor_line_text"].is_null());
        assert!(v["active"]["line_count"].is_null());
        // Empty file: 1 empty line, as the editor shows.
        let v: Value = serde_json::from_str(&context_json(&snap_with("", 1))).unwrap();
        assert_eq!(v["active"]["line_count"], 1);
        assert_eq!(v["active"]["cursor_line_text"], "");
    }

    #[test]
    fn edit_buffer_accepts_numbered_looking_content() {
        // Only a truncated tab is refused; content is never second-guessed.
        let s = snap_with("x", 1);
        assert!(edit_buffer_refusal(&s, "/w/a.md").is_none());
        let defs = tool_definitions();
        let edit = defs
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "sparkdown_edit_buffer")
            .unwrap();
        let schema = edit["inputSchema"].to_string();
        assert!(!schema.contains("prefix"), "{schema}");
    }

    #[test]
    fn serve_lines_answers_requests_and_skips_notifications() {
        // Two requests and one notification (no id); expect exactly two
        // response lines, in order, and nothing for the notification.
        let input = concat!(
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            "\n",
        );
        let mut out: Vec<u8> = Vec::new();
        serve_lines(input.as_bytes(), &mut out, |msg| {
            let id = msg.get("id").cloned()?;
            let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
            Some(match method {
                "ping" => rpc_result(id, json!({})),
                "tools/list" => rpc_result(id, json!({ "tools": tool_definitions() })),
                _ => rpc_error(id, -32601, "Method not found"),
            })
        });
        let text = String::from_utf8(out).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines.len(),
            2,
            "one line per request, none for notification"
        );
        let r0: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(r0["id"], 1);
        let r1: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(r1["id"], 2);
        assert!(r1["result"]["tools"].as_array().unwrap().len() >= 5);
    }

    #[cfg(unix)]
    #[test]
    fn socket_path_is_under_a_sparkdown_dir() {
        let p = mcp_socket_path();
        assert!(p.ends_with("sparkdown/mcp.sock"), "{}", p.display());
    }
    /// The POSIX form (local Unix and every remote host) is the same command
    /// the string templates produced before the argv refactor.
    #[test]
    fn install_commands_as_posix_lines() {
        let line =
            |bin: &str, exe: &str| posix_command_line(&agent_mcp_commands(bin, exe).unwrap().0);
        assert_eq!(
            line("claude", "/opt/SparkDown/sparkdown"),
            "claude mcp add sparkdown --scope user -- /opt/SparkDown/sparkdown --mcp-stdio"
        );
        assert_eq!(
            line("grok", "/Users/o'neil/My Apps/sparkdown"),
            r"grok mcp add -s user sparkdown '/Users/o'\''neil/My Apps/sparkdown' -- --mcp-stdio"
        );
        assert_eq!(
            line("kiro-cli", "/x"),
            "kiro-cli mcp add --name sparkdown --command /x --args --mcp-stdio --scope global --force"
        );
        assert_eq!(
            line("gemini", "$HOME/`x`"),
            "gemini mcp add sparkdown '$HOME/`x`' --mcp-stdio"
        );
        let remove = posix_command_line(&agent_mcp_commands("codex", "").unwrap().1);
        assert_eq!(remove, "codex mcp remove sparkdown");
        assert_eq!(posix_command_line(&["".into()]), "''");
    }

    /// Windows runs the resolved shim itself: .exe/.cmd directly (std
    /// escapes .cmd arguments for cmd.exe), .ps1 via Windows PowerShell.
    #[test]
    fn windows_runner_by_extension() {
        use std::ffi::OsString;
        let p = std::path::Path::new(r"C:\Users\Jane O'Brien\AppData\Roaming\npm\claude.CMD");
        assert_eq!(windows_runner(p), [OsString::from(p)]);
        let exe = std::path::Path::new(r"C:\x\codex.exe");
        assert_eq!(windows_runner(exe), [OsString::from(exe)]);
        let ps1 = std::path::Path::new(r"C:\npm\gemini.ps1");
        assert_eq!(
            windows_runner(ps1),
            [
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-File"
            ]
            .iter()
            .map(OsString::from)
            .chain([OsString::from(ps1)])
            .collect::<Vec<_>>()
        );
    }

    /// Claude Code's Windows session config: valid JSON, backslashes,
    /// spaces and quotes in the path survive a round trip.
    #[test]
    fn claude_session_config_round_trips_windows_paths() {
        let program = r#"C:\Users\Jane O'Brien "JB"\AppData\Local\SparkDown\sparkdown.exe"#;
        let text = claude_session_config_json(program, &shim_args());
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["mcpServers"]["sparkdown"]["command"], program);
        assert_eq!(v["mcpServers"]["sparkdown"]["args"], json!(["--mcp-stdio"]));
        let dir = std::env::temp_dir().join(format!("sd-claude-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cfg.json");
        write_claude_session_config(&path, program, &shim_args()).unwrap();
        write_claude_session_config(&path, program, &shim_args()).unwrap(); // rewrite is fine
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        let _ = std::fs::remove_dir_all(&dir);
        // Per process, in the per-user temp dir.
        let p = claude_session_config_path();
        assert!(p.starts_with(std::env::temp_dir()));
        assert!(p
            .to_string_lossy()
            .contains(&std::process::id().to_string()));
    }

    /// Serialized for the frontend in camelCase; no key without a file.
    #[test]
    fn shim_command_serializes_config_file_only_when_set() {
        let mut s = ShimCommand {
            program: "p".into(),
            args: vec![],
            config_file: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"program": "p", "args": []})
        );
        s.config_file = Some(r"C:\t\c.json".into());
        assert_eq!(
            serde_json::to_value(&s).unwrap()["configFile"],
            json!(r"C:\t\c.json")
        );
    }

    /// Windows smoke test: `mcp add` reaches npm-style shims with every
    /// argument intact (the `--` separator and a shim path with spaces and
    /// an apostrophe), through cmd.exe for `.cmd` and through Windows
    /// PowerShell `-File` for a `.ps1`.
    #[cfg(windows)]
    #[test]
    fn windows_install_command_reaches_npm_shims_intact() {
        use crate::win_test_agents::{
            dump_argv, node_ready, parse_dump, wait_for_file, FakeAgents,
        };
        if !node_ready() {
            return;
        }
        let agents = FakeAgents::new("mcp-add", &["claude"], true);
        let exe = r"C:\Users\Jane O'Brien\AppData\Local\SparkDown\sparkdown.exe";
        let (add, _) = agent_mcp_commands("claude", exe).unwrap();
        for shim in ["claude.cmd", "claude.ps1"] {
            let _ = std::fs::remove_file(agents.default_out());
            run_program_windows(&agents.bin_dir.join(shim), &add[1..])
                .unwrap_or_else(|e| panic!("{shim}: {e}"));
            let text = wait_for_file(&agents.default_out(), Duration::from_secs(20))
                .unwrap_or_else(|| panic!("{shim}: the fake agent did not run"));
            assert_eq!(dump_argv(&parse_dump(&text)), add[1..], "{shim}");
        }
    }

    #[test]
    fn agent_config_paths_cover_installable_agents_only() {
        for bin in ["claude", "codex", "grok", "kiro-cli", "gemini"] {
            assert!(agent_mcp_config(bin).is_some(), "{bin}");
            assert!(agent_mcp_commands(bin, "/x").is_some(), "{bin}");
        }
        // Cursor, Antigravity: status from their config file, install by
        // file edit (no CLI).
        assert_eq!(
            agent_mcp_config(CURSOR_BIN),
            Some((".cursor/mcp.json", ConfigFormat::JsonMcpServers))
        );
        assert!(agent_mcp_commands(CURSOR_BIN, "/x").is_none());
        assert_eq!(
            agent_mcp_config(AGY_BIN),
            Some((
                ".gemini/config/mcp_config.json",
                ConfigFormat::JsonMcpServers
            ))
        );
        assert!(agent_mcp_commands(AGY_BIN, "/x").is_none());
        // Gemini CLI keeps its own `mcp add` and settings file.
        assert_eq!(
            agent_mcp_config("gemini"),
            Some((".gemini/settings.json", ConfigFormat::JsonMcpServers))
        );
        assert!(json_file_agent("gemini").is_none());
        assert!(json_file_agent("claude").is_none());
        assert!(agent_mcp_config("opencode").is_none());
        assert!(agent_mcp_commands("opencode", "/x").is_none());
    }

    fn shim_args() -> Vec<String> {
        vec![SHIM_FLAG.to_string()]
    }

    fn cursor() -> JsonFileAgent {
        json_file_agent(CURSOR_BIN).unwrap()
    }
    fn agy() -> JsonFileAgent {
        json_file_agent(AGY_BIN).unwrap()
    }
    // Cursor-flavoured wrappers over the shared JSON-file helpers.
    fn cursor_config_with_server(
        existing: Option<&str>,
        program: &str,
        args: &[String],
    ) -> Result<String, String> {
        let a = cursor();
        json_config_with_server(existing, a.rel, json_server_entry(a, program, args))
    }
    fn cursor_config_without_server(existing: Option<&str>) -> Result<Option<String>, String> {
        json_config_without_server(existing, cursor().rel)
    }
    fn cursor_install_at(
        home: &std::path::Path,
        program: &str,
        args: &[String],
    ) -> Result<(), String> {
        json_install_at(home, cursor(), program, args)
    }
    fn cursor_uninstall_at(home: &std::path::Path) -> Result<(), String> {
        json_uninstall_at(home, cursor())
    }

    #[test]
    fn json_agents_forward_the_gate_variable_in_their_syntax() {
        let e = json_server_entry(cursor(), "/opt/sd", &shim_args());
        assert_eq!(
            e,
            json!({ "command": "/opt/sd", "args": ["--mcp-stdio"], "env": { "SPARKDOWN_MCP": "${env:SPARKDOWN_MCP}" } })
        );
        let e = json_server_entry(agy(), "/opt/sd", &shim_args());
        assert_eq!(e["env"], json!({ "SPARKDOWN_MCP": "$SPARKDOWN_MCP" }));
        // Remote: the shim script, no args.
        let e = json_server_entry(agy(), "/home/u/.cache/sparkdown/mcp-shim", &[]);
        assert_eq!(e["command"], "/home/u/.cache/sparkdown/mcp-shim");
        assert_eq!(e["args"], json!([]));
    }

    #[test]
    fn agy_install_creates_private_dirs_keeps_gemini_settings_and_round_trips() {
        let home = temp_home("agy");
        // Gemini CLI's own files in ~/.gemini must stay untouched.
        std::fs::create_dir_all(home.join(".gemini")).unwrap();
        let settings = r#"{"mcpServers":{"sparkdown":{"command":"gemini-owned"}}}"#;
        std::fs::write(home.join(".gemini/settings.json"), settings).unwrap();
        json_install_at(&home, agy(), "/opt/sd", &shim_args()).unwrap();
        let path = home.join(".gemini/config/mcp_config.json");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["sparkdown"]["command"], "/opt/sd");
        assert_eq!(
            v["mcpServers"]["sparkdown"]["env"]["SPARKDOWN_MCP"],
            "$SPARKDOWN_MCP"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode =
                |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&home.join(".gemini/config")), 0o700);
            assert_eq!(mode(&path), 0o600);
        }
        // Other servers in agy's file are kept, in order; uninstall removes
        // only ours; Gemini's settings.json is byte-for-byte unchanged.
        std::fs::write(
            &path,
            r#"{"mcpServers":{"z":{"serverUrl":"https://x.test/sse"},"sparkdown":{}}}"#,
        )
        .unwrap();
        json_install_at(&home, agy(), "/opt/sd2", &shim_args()).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let servers: Vec<&String> = v["mcpServers"].as_object().unwrap().keys().collect();
        assert_eq!(servers, ["z", "sparkdown"]);
        json_uninstall_at(&home, agy()).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            v,
            json!({ "mcpServers": { "z": { "serverUrl": "https://x.test/sse" } } })
        );
        assert_eq!(
            std::fs::read_to_string(home.join(".gemini/settings.json")).unwrap(),
            settings
        );
        // Invalid JSON is refused and left alone; errors name agy's file.
        std::fs::write(&path, "{ broken").unwrap();
        let err = json_install_at(&home, agy(), "/opt/sd", &shim_args()).unwrap_err();
        assert!(err.contains(".gemini/config/mcp_config.json"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ broken");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn agy_uninstall_without_a_file_is_a_no_op() {
        let home = temp_home("agy-none");
        json_uninstall_at(&home, agy()).unwrap();
        assert!(!home.join(".gemini").exists(), "nothing is created");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn cursor_merge_into_missing_or_empty_file() {
        for existing in [None, Some(""), Some("  \n")] {
            let text = cursor_config_with_server(existing, "/opt/sd", &shim_args()).unwrap();
            let v: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(
                v,
                json!({ "mcpServers": { "sparkdown": {
                    "command": "/opt/sd", "args": ["--mcp-stdio"],
                    "env": { "SPARKDOWN_MCP": "${env:SPARKDOWN_MCP}" }
                } } })
            );
            assert!(text.ends_with('\n'));
            assert!(config_lists_server(
                &text,
                ConfigFormat::JsonMcpServers,
                SERVER_NAME
            ));
        }
    }

    #[test]
    fn cursor_merge_keeps_other_keys_and_servers_in_order() {
        let existing = r#"{
  "zeta": true,
  "mcpServers": {
    "zz-last": { "command": "z", "env": { "TOKEN": "secret" } },
    "aa-first": { "url": "https://example.test/mcp" }
  },
  "alpha": [1, 2, { "b": null }]
}"#;
        let text = cursor_config_with_server(Some(existing), "/opt/sd", &shim_args()).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        let before: Value = serde_json::from_str(existing).unwrap();
        // Top-level keys in their original order (preserve_order), unchanged.
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["zeta", "mcpServers", "alpha"]);
        assert_eq!(v["zeta"], before["zeta"]);
        assert_eq!(v["alpha"], before["alpha"]);
        let servers: Vec<&String> = v["mcpServers"].as_object().unwrap().keys().collect();
        assert_eq!(servers, ["zz-last", "aa-first", "sparkdown"]);
        assert_eq!(v["mcpServers"]["zz-last"], before["mcpServers"]["zz-last"]);
        assert_eq!(
            v["mcpServers"]["aa-first"],
            before["mcpServers"]["aa-first"]
        );
    }

    #[test]
    fn cursor_merge_replaces_our_entry_in_place() {
        let existing =
            r#"{"mcpServers":{"a":{},"sparkdown":{"command":"/old","args":[],"x":1},"b":{}}}"#;
        let text = cursor_config_with_server(Some(existing), "/new", &[]).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        let servers: Vec<&String> = v["mcpServers"].as_object().unwrap().keys().collect();
        assert_eq!(servers, ["a", "sparkdown", "b"]);
        assert_eq!(
            v["mcpServers"]["sparkdown"],
            json!({ "command": "/new", "args": [], "env": { "SPARKDOWN_MCP": "${env:SPARKDOWN_MCP}" } })
        );
    }

    #[test]
    fn cursor_merge_refuses_invalid_json() {
        for bad in [
            "{ \"mcpServers\": { ",     // truncated
            "// comment\n{}",           // JSONC is not JSON
            "[1, 2]",                   // not an object
            r#"{"mcpServers": ["x"]}"#, // mcpServers not an object
        ] {
            let err = cursor_config_with_server(Some(bad), "/x", &[]).unwrap_err();
            assert!(err.contains("left"), "{bad}: {err}");
        }
    }

    #[test]
    fn cursor_uninstall_removes_only_ours() {
        let existing =
            r#"{"k":1,"mcpServers":{"a":{"command":"a"},"sparkdown":{},"b":{"command":"b"}}}"#;
        let text = cursor_config_without_server(Some(existing))
            .unwrap()
            .unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            v,
            json!({ "k": 1, "mcpServers": { "a": { "command": "a" }, "b": { "command": "b" } } })
        );
        let servers: Vec<&String> = v["mcpServers"].as_object().unwrap().keys().collect();
        assert_eq!(servers, ["a", "b"], "order kept");
        // Nothing of ours: no rewrite at all.
        assert_eq!(cursor_config_without_server(None).unwrap(), None);
        assert_eq!(cursor_config_without_server(Some("")).unwrap(), None);
        assert_eq!(
            cursor_config_without_server(Some(r#"{"mcpServers":{"a":{}}}"#)).unwrap(),
            None
        );
        assert_eq!(
            cursor_config_without_server(Some(r#"{"x":1}"#)).unwrap(),
            None
        );
        // Invalid JSON is refused, not "fixed".
        assert!(cursor_config_without_server(Some("{nope")).is_err());
    }

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sd-cursor-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn cursor_install_at_creates_owner_only_files_and_round_trips() {
        let home = temp_home("fresh");
        cursor_install_at(&home, "/opt/sd", &shim_args()).unwrap();
        let path = home.join(".cursor/mcp.json");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(config_lists_server(
            &text,
            ConfigFormat::JsonMcpServers,
            SERVER_NAME
        ));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode =
                |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&home.join(".cursor")), 0o700);
            assert_eq!(mode(&path), 0o600);
        }
        // Idempotent; then uninstall leaves a valid file without our entry.
        cursor_install_at(&home, "/opt/sd", &shim_args()).unwrap();
        cursor_uninstall_at(&home).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!config_lists_server(
            &text,
            ConfigFormat::JsonMcpServers,
            SERVER_NAME
        ));
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            json!({ "mcpServers": {} })
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn cursor_install_at_keeps_existing_file_mode_and_refuses_bad_json() {
        let home = temp_home("existing");
        let dir = home.join(".cursor");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mcp.json");
        std::fs::write(&path, r#"{"mcpServers":{"mine":{"command":"m"}}}"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        cursor_install_at(&home, "/opt/sd", &shim_args()).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["mine"], json!({ "command": "m" }));
        assert_eq!(v["mcpServers"]["sparkdown"]["command"], "/opt/sd");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o644, "existing mode kept, not loosened or changed");
        }
        // Invalid JSON: refused, and the file is left byte-for-byte as is.
        std::fs::write(&path, "{ broken").unwrap();
        assert!(cursor_install_at(&home, "/opt/sd", &shim_args()).is_err());
        assert!(cursor_uninstall_at(&home).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ broken");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn cursor_uninstall_at_without_a_file_is_a_no_op() {
        let home = temp_home("none");
        cursor_uninstall_at(&home).unwrap();
        assert!(!home.join(".cursor").exists(), "nothing is created");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn json_config_detects_our_server() {
        let f = ConfigFormat::JsonMcpServers;
        let yes = r#"{"other":1,"mcpServers":{"foo":{},"sparkdown":{"command":"/x","args":["--mcp-stdio"]}}}"#;
        let no = r#"{"mcpServers":{"foo":{}}}"#;
        assert!(config_lists_server(yes, f, "sparkdown"));
        assert!(!config_lists_server(no, f, "sparkdown"));
        assert!(!config_lists_server("{}", f, "sparkdown"));
        assert!(!config_lists_server("not json", f, "sparkdown"));
        // A project-scoped entry under `projects` must not count as user scope.
        let proj = r#"{"projects":{"/p":{"mcpServers":{"sparkdown":{}}}}}"#;
        assert!(!config_lists_server(proj, f, "sparkdown"));
    }

    #[test]
    fn toml_config_detects_our_server() {
        let f = ConfigFormat::TomlMcpServers;
        let yes = "model = \"x\"\n\n[mcp_servers.sparkdown]\ncommand = \"/x\"\nargs = [\"--mcp-stdio\"]\n";
        let sub = "[mcp_servers.sparkdown.env]\nFOO = \"1\"\n";
        let quoted = "  [mcp_servers.\"sparkdown\"]\n";
        let other = "[mcp_servers.sparkdown-old]\ncommand = \"y\"\n";
        let none = "[mcp_servers.foo]\ncommand = \"y\"\n";
        assert!(config_lists_server(yes, f, "sparkdown"));
        assert!(config_lists_server(sub, f, "sparkdown"));
        assert!(config_lists_server(quoted, f, "sparkdown"));
        assert!(!config_lists_server(other, f, "sparkdown"));
        assert!(!config_lists_server(none, f, "sparkdown"));
        assert!(!config_lists_server("", f, "sparkdown"));
    }

    #[cfg(unix)]
    #[test]
    fn run_with_timeout_captures_output_and_kills_slow_children() {
        let tmp = std::env::temp_dir();
        let (ok, out, _err) =
            run_with_timeout("/bin/sh", &["-c", "echo hi"], &tmp, Duration::from_secs(5)).unwrap();
        assert!(ok);
        assert_eq!(out.trim(), "hi");

        let (ok, _out, err) = run_with_timeout(
            "/bin/sh",
            &["-c", "echo bad >&2; exit 3"],
            &tmp,
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(!ok);
        assert_eq!(err.trim(), "bad");

        let t0 = std::time::Instant::now();
        let r = run_with_timeout(
            "/bin/sh",
            &["-c", "sleep 10"],
            &tmp,
            Duration::from_millis(300),
        );
        assert!(r.is_err(), "slow child must time out");
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "must not wait for the child"
        );
        assert!(r.unwrap_err().contains("did not finish"));
    }
    /// The review tools against this very repository (CI checkouts have .git).
    #[test]
    fn review_tools_read_this_repo() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        if !root.join(".git").exists() {
            return;
        }
        let _guard = crate::remote::TEST_SESSION_LOCK.lock().unwrap();
        let snap = Snapshot {
            workspace_root: Some(root.to_string_lossy().into_owned()),
            ..Snapshot::default()
        };
        let v = list_changes(&snap).unwrap();
        assert_eq!(v["is_repo"], true);
        // Match the actual checkout directory name, not a hardcoded "sparkdown":
        // git worktrees (and CI) check out under a differently named directory.
        let expected = root.file_name().unwrap().to_string_lossy();
        assert!(
            v["top_level"]
                .as_str()
                .unwrap()
                .ends_with(expected.as_ref()),
            "{v}"
        );
        let changes = v["changes"].as_array().unwrap();
        for c in changes {
            assert!(c["verdict"] == "meat" || c["verdict"] == "noise", "{c}");
            assert_eq!(c["verdict"] == "noise", !c["noise_reason"].is_null(), "{c}");
        }
        assert_eq!(
            v["meat_count"].as_u64().unwrap() + v["noise_count"].as_u64().unwrap(),
            changes.len() as u64
        );
        // Diff of a changed file works in both modes; an unknown path is a
        // clear error, not a crash.
        if let Some(c) = changes.first() {
            let path = c["path"].as_str().unwrap();
            let full = read_diff(&snap, path, true).unwrap();
            let reading = read_diff(&snap, path, false).unwrap();
            assert!(full.contains("+++") || full.is_empty(), "{full}");
            assert!(
                reading.len() <= full.len() + 120,
                "reading diff is not longer than full"
            );
        }
        let err = read_diff(&snap, "definitely/not/changed.xyz", false).unwrap_err();
        assert!(err.contains("sparkdown_list_changes"), "{err}");
        assert!(read_diff(&snap, "", false).is_err());
        let none = Snapshot::default();
        assert!(list_changes(&none).unwrap_err().contains("No workspace"));
    }

    #[test]
    fn pipe_sddl_allows_only_user_and_system() {
        let s = pipe_sddl("S-1-5-21-1-2-3-1001");
        // Protected DACL (no inherited ACEs), exactly two allow ACEs.
        assert_eq!(s, "D:P(A;;GA;;;S-1-5-21-1-2-3-1001)(A;;GA;;;SY)");
        assert_eq!(s.matches("(A;").count(), 2);
        assert!(!s.contains("WD"), "no Everyone ACE: {s}");
    }

    #[cfg(windows)]
    #[test]
    fn windows_current_user_sid_is_a_user_sid() {
        let sid = current_user_sid().unwrap();
        assert!(sid.starts_with("S-1-5-"), "{sid}");
        // Deterministic for the process.
        assert_eq!(sid, current_user_sid().unwrap());
        assert!(pipe_security_descriptor().is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_pipe_is_first_instance_and_connectable_by_owner() {
        use interprocess::local_socket::{prelude::*, GenericFilePath, Stream};
        use std::io::{BufRead, BufReader, Write};
        let path = PathBuf::from(format!(
            r"\\.\pipe\sparkdown-test-{}-{}-mcp",
            std::process::id(),
            random_token()
        ));
        let listener = create_pipe_listener(&path).unwrap();
        // A second listener on the same name must fail: the first-instance
        // flag stops a squatter (or a second copy) from joining our pipe.
        assert!(create_pipe_listener(&path).is_err());

        // The owner (this process's user) can connect and talk.
        let p2 = path.clone();
        let client = std::thread::spawn(move || {
            let name = p2.as_os_str().to_fs_name::<GenericFilePath>().unwrap();
            let mut s = Stream::connect(name).unwrap();
            s.write_all(b"ping\n").unwrap();
            let mut line = String::new();
            BufReader::new(s).read_line(&mut line).unwrap();
            line
        });
        let conn = listener.accept().unwrap();
        let (r, mut w) = conn.split();
        let mut line = String::new();
        BufReader::new(r).read_line(&mut line).unwrap();
        assert_eq!(line, "ping\n");
        w.write_all(b"pong\n").unwrap();
        w.flush().unwrap();
        assert_eq!(client.join().unwrap(), "pong\n");
    }

    #[cfg(windows)]
    #[test]
    fn windows_pipe_name_is_random_per_launch() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        let p = mcp_socket_path();
        assert!(p.to_string_lossy().starts_with(r"\\.\pipe\sparkdown-"));
        assert_eq!(p, mcp_socket_path(), "stable within one launch");
    }
}
