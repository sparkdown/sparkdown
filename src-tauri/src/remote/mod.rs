//! Remote sessions v1 (#36): one SSH workspace at a time.
//!
//! Local-first: SparkDown never hosts the files. We shell out to the user's
//! `ssh` (BatchMode, existing keys only) so we don't add a crypto stack or a
//! cloud. Editor / explorer / git / watch / PTY all go through this module
//! when a session is active, behind the same Tauri commands as local.

use crate::commands::{AppError, FileEntry};
use crate::file_index::FileListing;
use crate::git::{branch_status_from, parse_porcelain, GitBranchStatus, GitStatus};
use portable_pty::CommandBuilder;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

mod ssh;
use ssh::{
    classify_remote_watch_delta, close_mux, load_ssh_hosts, map_ssh_failure, mux_options,
    shell_quote, ssh_git, ssh_run, ssh_run_bytes, ssh_run_stdin, validate_host_alias,
    validate_remote_input, validate_remote_path, watch_fingerprint_script,
};
pub use ssh::{RemoteSession, SshHost};

static SESSION: OnceLock<Mutex<Option<RemoteSession>>> = OnceLock::new();
static WATCH_STOP: OnceLock<AtomicBool> = OnceLock::new();
static WATCH_GENERATION: OnceLock<AtomicU64> = OnceLock::new();
/// Serializes the whole connect (probe + forward setup) and disconnect
/// sequences against each other. connect runs on a worker thread and
/// disconnect/shutdown on another; without one lock a disconnect landing
/// mid-`mcp_forward_start`, or two overlapping connects, leak the SSH control
/// (mux) connection and its `-R` forward.
static LIFECYCLE: OnceLock<Mutex<()>> = OnceLock::new();

fn session_lock() -> &'static Mutex<Option<RemoteSession>> {
    SESSION.get_or_init(|| Mutex::new(None))
}

fn lifecycle_lock() -> &'static Mutex<()> {
    LIFECYCLE.get_or_init(|| Mutex::new(()))
}

fn watch_stop_flag() -> &'static AtomicBool {
    WATCH_STOP.get_or_init(|| AtomicBool::new(true))
}

fn watch_generation() -> &'static AtomicU64 {
    WATCH_GENERATION.get_or_init(|| AtomicU64::new(0))
}

pub fn is_active() -> bool {
    session_lock().lock().map(|g| g.is_some()).unwrap_or(false)
}

pub fn current_session() -> Option<RemoteSession> {
    session_lock().lock().ok().and_then(|g| g.clone())
}

fn set_session(session: Option<RemoteSession>) {
    if let Ok(mut g) = session_lock().lock() {
        *g = session;
    }
}

/// Preflight + store. `probe` is `ssh host 'cd path && pwd -P'` in production.
pub fn connect_with(
    hosts: &[SshHost],
    host: &str,
    path: &str,
    probe: impl Fn(&str, &str) -> Result<String, String>,
) -> Result<RemoteSession, String> {
    validate_host_alias(host)?;
    // A ~/.ssh/config alias, or a typed `[user@]host[:port]` (#22) that ssh
    // resolves with the user's normal config, keys and agent.
    let entry = hosts.iter().find(|h| h.alias == host);
    if entry.is_some_and(|e| e.password_only) {
        return Err(format!(
            "Host '{host}' is configured for password authentication. SparkDown v1 uses existing SSH keys only — add an IdentityFile (or load a key in ssh-agent) in ~/.ssh/config. There is no password prompt."
        ));
    }
    let path = if path.trim().is_empty() {
        "~"
    } else {
        path.trim()
    };
    // The dialog input may still be `~`/`~/sub` here (resolved to an absolute
    // path by the probe below); only reject control chars at this stage. The
    // resolved `pwd`/`home` are checked with the strict absolute validator.
    validate_remote_input(path)?;
    // quote_cd_target lets a leading `~` expand (quoting would suppress it —
    // and `~` is the dialog's default). `pwd -P` resolves symlinks: on many
    // hosts /home/user is a symlink (e.g. → /local/home/user),
    // and storing the logical path breaks every later `find` on the session
    // root, which does not follow symlinked arguments by default.
    // Second line: the remote $HOME, for the per-user context-bridge dir.
    // `CDPATH= cd … >/dev/null`: a CDPATH set in the user's environment makes
    // `cd` echo the resolved directory to stdout, which would land ahead of
    // `pwd -P` and be mistaken for the home path — sending the context /
    // `rm -rf` cleanup to the wrong place. Clearing it and silencing cd's
    // output closes that.
    let probe_cmd = format!(
        "CDPATH= cd -- {} >/dev/null && pwd -P && printf '%s\\n' \"$HOME\"",
        ssh::quote_cd_target(path)
    );
    let out = match probe(host, &probe_cmd) {
        Ok(s) => s,
        Err(e) => return Err(map_ssh_failure(host, &e)),
    };
    let mut lines = out.lines().map(str::trim).filter(|l| !l.is_empty());
    let pwd = lines.next().unwrap_or("").to_string();
    let home = lines.next().unwrap_or("").to_string();
    if pwd.is_empty() {
        return Err(format!("Host '{host}' did not return a working directory."));
    }
    validate_remote_path(&pwd)?;
    if !home.is_empty() {
        validate_remote_path(&home)?;
    }
    // One workspace at a time: replace any previous session. Close the old
    // host's SSH control (mux) connection too — no reason to keep it warm.
    watch_stop();
    if let Some(prev) = current_session() {
        mcp_forward_stop(&prev);
        // The previous session's shadow buffers (unsaved text) must not
        // outlive it — replacing a session skipped this, so switching hosts
        // left unsaved copies on the old host. Do it before closing the
        // control connection so the cleanup still has a live link.
        clear_all_context(&prev);
        if prev.host != host {
            close_mux(&prev.host);
        }
    }
    let session = RemoteSession {
        host: host.to_string(),
        path: pwd,
        home,
    };
    set_session(Some(session.clone()));
    Ok(session)
}

// --- Agent layer on the remote: CLI detection + context bridge -------------

/// Remote `command -v` probe body. Always ends with `true` so a missing last
/// bin does not make the whole SSH call fail (`ssh_run` treats non-zero as Err).
fn detect_agent_probe_inner(safe_bins: &[&str]) -> String {
    format!(
        "for b in {}; do command -v \"$b\" >/dev/null 2>&1 && echo \"$b\"; done; true",
        safe_bins.join(" ")
    )
}

/// Which of `bins` the remote login shell can run (`command -v`, so aliases
/// and functions count, same as the local check). One round trip. None when
/// no session is active or the probe fails.
pub fn detect_agent_bins(bins: &[&str]) -> Option<Vec<String>> {
    let session = current_session()?;
    let safe: Vec<&str> = bins
        .iter()
        .copied()
        .filter(|b| {
            b.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        })
        .collect();
    let inner = detect_agent_probe_inner(&safe);
    // Interactive login shell so rc-file PATH additions and aliases apply.
    let cmd = format!("${{SHELL:-/bin/sh}} -lic {}", shell_quote(&inner));
    let out = ssh_run(&session.host, &cmd).ok()?;
    Some(
        out.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// A stable-per-install id for THIS SparkDown client, so two clients sharing
/// one remote user don't collide on the socket / shim / context dirs (and so
/// one client's disconnect `rm -rf` only removes its own cache). Derived from
/// the local hostname + user + home — pid-independent, so a relaunch reuses
/// (and can clean up) the same remote dir. Hashed with the stable FNV-1a
/// `workspace_key` (not `DefaultHasher`, whose output may change across Rust
/// releases and would orphan the old remote dir after an app upgrade).
fn client_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        let user = std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_default();
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        crate::context::workspace_key(&format!("{}\0{user}\0{home}", local_hostname()))
    })
    .as_str()
}

fn local_hostname() -> String {
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.is_empty() {
            return h;
        }
    }
    crate::proc::command("hostname")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// This client's private cache root on the remote:
/// `<home>/.cache/sparkdown/<client-id>`. The MCP socket + shim and every
/// workspace context dir live under it; only this client writes here.
fn client_cache_dir(session: &RemoteSession) -> String {
    let base = if session.home.is_empty() {
        format!("{}/.sparkdown-cache", session.path.trim_end_matches('/'))
    } else {
        format!("{}/.cache/sparkdown", session.home.trim_end_matches('/'))
    };
    format!("{base}/{}", client_id())
}

/// Remote context dir for a workspace root:
/// `<home>/.cache/sparkdown/<client-id>/<key>`. Falls back to the workspace
/// itself when the probe returned no $HOME.
pub fn context_dir_for(root: &str) -> Option<String> {
    let session = current_session()?;
    Some(format!(
        "{}/{}",
        client_cache_dir(&session),
        crate::context::workspace_key(root)
    ))
}

/// A heredoc delimiter that does not occur in any of `bodies`.
fn heredoc_delimiter(bodies: &[&str]) -> String {
    let mut n = 0u32;
    loop {
        let d = format!("__SPARKDOWN_EOF_{n}__");
        if bodies.iter().all(|b| !b.contains(&d)) {
            return d;
        }
        n += 1;
    }
}

/// Build the `sh -s` script that (re)writes a whole context dir in ONE round
/// trip: mkdir 0700, context.json, README, wipe + rewrite the shadow buffers.
/// Quoted heredocs keep every byte literal; the delimiter is chosen to be
/// absent from all payloads.
pub fn context_write_script(dir: &str, files: &[(String, String)]) -> String {
    let bodies: Vec<&str> = files.iter().map(|(_, c)| c.as_str()).collect();
    let eof = heredoc_delimiter(&bodies);
    let d = shell_quote(dir);
    let mut s = format!(
        "umask 077; mkdir -p {d}/buffers && chmod 700 {d} {d}/buffers && rm -f {d}/buffers/* 2>/dev/null\n"
    );
    for (name, content) in files {
        // Heredoc bodies always end in a newline; a trailing newline in the
        // payload would be doubled, so strip exactly one if present and let
        // the heredoc supply it.
        let body = content.strip_suffix('\n').unwrap_or(content);
        s.push_str(&format!(
            "cat > {}/{} <<'{eof}'\n{body}\n{eof}\n",
            d,
            shell_quote(name)
        ));
    }
    s
}

/// Write the context snapshot on the remote host (see context.rs for the
/// local twin). Returns the remote dir path.
pub fn agent_context_update(
    root: &str,
    context_json: &str,
    readme: &str,
    buffers: &[(String, String)],
) -> Result<String, String> {
    let session = current_session().ok_or_else(|| "no remote session".to_string())?;
    let dir = context_dir_for(root).ok_or_else(|| "no remote session".to_string())?;
    validate_remote_path(&dir)?;
    let mut files: Vec<(String, String)> = vec![
        ("context.json".into(), context_json.to_string()),
        ("README.md".into(), readme.to_string()),
    ];
    for (name, content) in buffers {
        files.push((format!("buffers/{name}"), content.clone()));
    }
    let script = context_write_script(&dir, &files);
    ssh_run_stdin(&session.host, "sh -s", Some(script.as_bytes()))?;
    Ok(dir)
}

/// Remove the remote context dir for `root` (quit / bridge disabled).
pub fn agent_context_clear(root: &str) -> Result<(), String> {
    let session = current_session().ok_or_else(|| "no remote session".to_string())?;
    let dir = context_dir_for(root).ok_or_else(|| "no remote session".to_string())?;
    validate_remote_path(&dir)?;
    ssh_run(&session.host, &format!("rm -rf {}", shell_quote(&dir))).map(|_| ())
}

/// Remove every context dir THIS client wrote on this host (disconnect). Only
/// this client writes under its per-client cache dir, so wholesale removal is
/// safe and never touches another SparkDown client sharing the remote user.
fn clear_all_context(session: &RemoteSession) {
    if session.home.is_empty() {
        return;
    }
    let base = client_cache_dir(session);
    let _ = ssh_run(&session.host, &format!("rm -rf {}", shell_quote(&base)));
}

#[tauri::command]
pub fn ssh_config_hosts() -> Result<Vec<SshHost>, String> {
    load_ssh_hosts()
}

// Async: the connect probe and the MCP forward are SSH round trips; run them
// on the worker pool so the window stays responsive.
#[tauri::command]
pub async fn remote_connect(host: String, path: String) -> Result<RemoteSession, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Held across the whole connect (probe + forward setup) so a disconnect
        // or a second connect can't interleave and orphan the SSH control
        // (mux) connection or its forward.
        let _guard = lifecycle_lock()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let hosts = load_ssh_hosts()?;
        let session = connect_with(&hosts, &host, &path, ssh_run)?;
        // Phase 4: give remote agents the live MCP server by reverse-forwarding
        // the local socket over the SSH control (mux) connection. Best effort
        // — when it fails (no mux, old sshd, no home) the remote keeps the
        // file bridge.
        if let Some(local) = crate::mcp::running_socket_path() {
            if let Err(e) = mcp_forward_start(&session, Path::new(&local)) {
                eprintln!("remote MCP unavailable, using the file bridge: {e}");
            }
        }
        Ok(session)
    })
    .await
    .map_err(|e| format!("connect task failed: {e}"))?
}

/// Tear down the active session synchronously. Serialized against connect via
/// the lifecycle lock. Shared by the async command, the tests, and
/// [`shutdown`].
fn disconnect_now() {
    let _guard = lifecycle_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    watch_stop();
    if let Some(prev) = current_session() {
        mcp_forward_stop(&prev);
        // Shadow buffers (unsaved text) must not outlive the session.
        clear_all_context(&prev);
        close_mux(&prev.host);
    }
    set_session(None);
}

// Async + spawn_blocking: disconnect shells out to ssh (`-O cancel`, `-O exit`,
// `rm -rf`). A synchronous #[tauri::command] runs on the main thread in Tauri
// 2, so on a half-open control (mux) connection those calls would freeze the
// UI for minutes.
#[tauri::command]
pub async fn remote_disconnect() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(disconnect_now)
        .await
        .map_err(|e| format!("disconnect task failed: {e}"))
}

/// App-exit / crash-safe teardown hook. The ControlPersist control (mux)
/// connection and its `-R` MCP forward outlive the process otherwise; a
/// relaunch then finds the forward already registered on the warm mux and the
/// remote MCP is silently offline (see [`mcp_forward_start`]). main.rs calls
/// this on `RunEvent::Exit`. Best effort and synchronous.
pub fn shutdown() {
    disconnect_now();
}

#[tauri::command]
pub fn remote_session() -> Option<RemoteSession> {
    current_session()
}

const MAX_REMOTE_FILE_BYTES: u64 = 50 * 1024 * 1024;

pub fn read_file(path: &str) -> Result<String, AppError> {
    let session = current_session().ok_or_else(|| AppError::Other("no remote session".into()))?;
    validate_remote_path(path).map_err(AppError::Other)?;
    // One round trip: a status line, then (only on OK) the contents. The
    // old shape was two ssh calls (size probe, then cat) — every file open
    // paid the connection latency twice.
    let cmd = format!(
        "if [ -d {p} ]; then echo __SD_DIR__; \
         elif [ ! -f {p} ]; then echo __SD_NF__; \
         else s=$(wc -c < {p}); if [ \"$s\" -gt {max} ]; then echo __SD_BIG__ \"$s\"; \
         else echo __SD_OK__; cat -- {p}; fi; fi",
        p = shell_quote(path),
        max = MAX_REMOTE_FILE_BYTES
    );
    // Bytes, not lossy text: a lossy decode would swap invalid bytes for
    // U+FFFD and the next save would silently corrupt the file.
    let raw = ssh_run_bytes(&session.host, &cmd, None).map_err(AppError::Other)?;
    parse_read_payload(&raw, path)
}

/// Split a read_file payload into its status line + contents. Contents must
/// be valid UTF-8; otherwise this fails with the same error kind as the
/// local read_file (`fs::read_to_string` → InvalidData).
fn parse_read_payload(raw: &[u8], path: &str) -> Result<String, AppError> {
    let (status, rest) = match raw.iter().position(|&b| b == b'\n') {
        Some(i) => (&raw[..i], &raw[i + 1..]),
        None => (raw, &raw[raw.len()..]),
    };
    let status = String::from_utf8_lossy(status);
    let status = status.trim();
    if status == "__SD_OK__" {
        return String::from_utf8(rest.to_vec()).map_err(|_| {
            AppError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "stream did not contain valid UTF-8",
            ))
        });
    }
    if status == "__SD_DIR__" {
        return Err(AppError::InvalidPath(format!(
            "Path is a directory: {path}"
        )));
    }
    if let Some(size) = status.strip_prefix("__SD_BIG__") {
        let size: u64 = size.trim().parse().unwrap_or(0);
        return Err(AppError::FileTooLarge {
            size_mb: size / 1024 / 1024,
            max_mb: MAX_REMOTE_FILE_BYTES / 1024 / 1024,
        });
    }
    // __SD_NF__ or anything unexpected.
    Err(AppError::InvalidPath(format!(
        "Invalid or inaccessible path: {path}"
    )))
}

pub fn write_file(path: &str, content: &str) -> Result<(), AppError> {
    let session = current_session().ok_or_else(|| AppError::Other("no remote session".into()))?;
    validate_remote_path(path).map_err(AppError::Other)?;
    let parent = Path::new(path)
        .parent()
        .and_then(|p| p.to_str())
        .filter(|p| !p.is_empty())
        .unwrap_or(".");
    let cmd = remote_write_script(path, parent, content.len());
    ssh_run_stdin(&session.host, &cmd, Some(content.as_bytes())).map_err(AppError::Other)?;
    Ok(())
}

/// POSIX sh script that atomically replaces `path` with stdin.
///
/// - A symlinked target is resolved first (`readlink`, max 40 hops), so the
///   link stays a link and its target gets the new contents.
/// - The temp file lives in the target's directory (same filesystem, so the
///   final `mv -f` is a rename). For an existing file it starts as a
///   `cp` of the original under `umask 0`, so it gets the original's mode
///   bits without GNU-only `stat`/`chmod --reference`; `cat` then replaces
///   the contents. New files get the default umask, same as `cat >`.
/// - Length check: `len` is the exact payload size. If the SSH channel
///   closes early (network drop, ServerAlive kill, our write timeout), the
///   remote `cat` sees EOF and exits 0 with a short file; without a check
///   the partial file would replace the original. So the received size is
///   compared (`wc -c`, POSIX) with `len` before anything touches the
///   target, and a short/long temp file is removed with exit 1.
/// - The temp file is removed on any failure.
/// - Fallback when atomic replace is not possible (no temp file can be
///   created in the target's directory, e.g. directory not writable or
///   original not readable; or the symlink cannot be resolved, no
///   `readlink`): stdin is first staged in a private file in `$TMPDIR` (or
///   `/tmp`), size-checked, and only then copied in place with
///   `cat stage > target`. The network can no longer truncate the target.
///   Against a local error (disk full) during that last copy, the original
///   is first copied to a second private file (`.sparkdown-backup-$$`, same
///   `set -C` / `umask 077`, its size checked against the original); if the
///   in-place copy fails or the result is not `len` bytes, the original is
///   restored from that backup (`cat backup > target`, a partial new file
///   is removed) and the script exits 1. If the stage or backup file cannot
///   be made, the write fails before the target is touched: an unchecked
///   in-place `cat >` is never done. Both files are removed on every path,
///   except when the restore itself fails: then the backup is the only
///   intact copy, so it is kept and its path is printed on stderr.
///
/// Limits: the new file is owned by the SSH user (a file owned by another
/// user loses that owner), hard links to the old file are split off, and no
/// fsync is done on the remote side.
///
/// All in a subshell: an `exit` must not skip the output END marker.
pub(crate) fn remote_write_script(path: &str, parent: &str, len: usize) -> String {
    format!(
        "(\n\
         f={path}\n\
         N={len}\n\
         mkdir -p -- {parent} || exit 1\n\
         n=0\n\
         while [ -L \"$f\" ] && [ \"$n\" -lt 40 ]; do\n\
         l=$(readlink -- \"$f\" 2>/dev/null) || break\n\
         case \"$l\" in /*) f=$l ;; *) f=$(dirname -- \"$f\")/$l ;; esac\n\
         n=$((n + 1))\n\
         done\n\
         sd_sz() {{ wc -c < \"$1\" | tr -d ' \\t'; }}\n\
         sd_full() {{ [ \"$(sd_sz \"$1\")\" -eq \"$N\" ]; }}\n\
         if [ ! -L \"$f\" ]; then\n\
         t=\"$(dirname -- \"$f\")/.$(basename -- \"$f\").sparkdown-tmp-$$\"\n\
         rm -f -- \"$t\"\n\
         if {{ if [ -e \"$f\" ]; then (umask 0; cp -- \"$f\" \"$t\"); else : > \"$t\"; fi; }} 2>/dev/null; then\n\
         if cat > \"$t\" && sd_full \"$t\" && mv -f -- \"$t\" \"$f\"; then exit 0; fi\n\
         rm -f -- \"$t\"; exit 1\n\
         fi\n\
         rm -f -- \"$t\"\n\
         fi\n\
         s=\"${{TMPDIR:-/tmp}}/.sparkdown-stage-$$\"\n\
         b=\"${{TMPDIR:-/tmp}}/.sparkdown-backup-$$\"\n\
         (set -C; umask 077; : > \"$s\") 2>/dev/null || exit 1\n\
         if ! {{ cat > \"$s\" && sd_full \"$s\"; }}; then rm -f -- \"$s\"; exit 1; fi\n\
         had=0\n\
         if [ -e \"$f\" ]; then\n\
         had=1\n\
         (set -C; umask 077; : > \"$b\") 2>/dev/null || {{ rm -f -- \"$s\"; exit 1; }}\n\
         if ! {{ cat -- \"$f\" > \"$b\" && [ \"$(sd_sz \"$f\")\" -eq \"$(sd_sz \"$b\")\" ]; }}; then\n\
         rm -f -- \"$s\" \"$b\"; exit 1\n\
         fi\n\
         fi\n\
         if cat -- \"$s\" > \"$f\" && sd_full \"$f\"; then rm -f -- \"$s\" \"$b\"; exit 0; fi\n\
         rm -f -- \"$s\"\n\
         if [ \"$had\" = 1 ]; then\n\
         if cat -- \"$b\" > \"$f\" && [ \"$(sd_sz \"$f\")\" -eq \"$(sd_sz \"$b\")\" ]; then rm -f -- \"$b\"\n\
         else echo \"sparkdown: write failed; original kept in $b\" >&2; fi\n\
         elif [ ! -L \"$f\" ]; then rm -f -- \"$f\"; fi\n\
         exit 1\n\
         )",
        path = shell_quote(path),
        parent = shell_quote(parent),
    )
}

pub fn is_directory(path: &str) -> bool {
    let Some(session) = current_session() else {
        return false;
    };
    if validate_remote_path(path).is_err() {
        return false;
    }
    ssh_run(
        &session.host,
        &format!(
            "if [ -d {} ]; then echo yes; else echo no; fi",
            shell_quote(path)
        ),
    )
    .map(|s| s.trim() == "yes")
    .unwrap_or(false)
}

pub fn list_directory(path: &str, include_hidden: bool) -> Result<Vec<FileEntry>, AppError> {
    let session = current_session().ok_or_else(|| AppError::Other("no remote session".into()))?;
    validate_remote_path(path).map_err(AppError::Other)?;
    // type \t name  — d = dir, everything else = file. One level. `-H`
    // follows a symlinked path argument (e.g. /home/user → /local/home/user
    // on some hosts; without it find lists nothing). No GNU-only `-printf`:
    // `-exec sh -c` emits the type via `[ -d ]` (which dereferences, so a
    // symlinked child dir still browses as a dir) and the basename via
    // `${f##*/}`. NOTDIR is printed on stdout and the command exits 0, so the
    // sentinel is visible to the parser instead of being swallowed as an ssh
    // failure (a non-zero exit would surface the generic banner error).
    let cmd = format!(
        "if [ ! -d {p} ]; then printf '%s\\n' NOTDIR; else \
         find -H {p} -mindepth 1 -maxdepth 1 -exec sh -c \
         'for f do if [ -d \"$f\" ]; then printf \"d\\t%s\\n\" \"${{f##*/}}\"; else printf \"f\\t%s\\n\" \"${{f##*/}}\"; fi; done' sh {{}} +; fi",
        p = shell_quote(path)
    );
    let raw = match ssh_run(&session.host, &cmd) {
        Ok(s) => s,
        Err(e) => return Err(AppError::Other(e)),
    };
    if raw.trim_start().starts_with("NOTDIR") {
        return Err(AppError::InvalidPath(format!(
            "Path is not a directory: {path}"
        )));
    }
    let mut entries = Vec::new();
    for line in raw.lines() {
        let Some((kind, name)) = line.split_once('\t') else {
            continue;
        };
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        let child = format!("{}/{}", path.trim_end_matches('/'), name);
        entries.push(FileEntry {
            name: name.to_string(),
            path: child,
            is_dir: kind.starts_with('d'),
        });
    }
    // If find %y is 'l', we currently treat as file. Fine for v1.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// Single-quote `s` for the remote POSIX shell (for scripts built outside
/// this module, e.g. search.rs).
pub(crate) fn quote(s: &str) -> String {
    shell_quote(s)
}

/// Run a search script (see `search::remote_search_script`) for the folder
/// `root` on the active host and return its raw output.
pub fn search_in_files(root: &str, script: &str) -> Result<String, String> {
    let session = current_session().ok_or_else(|| "no remote session".to_string())?;
    validate_remote_path(root)?;
    ssh_run(&session.host, script)
}

/// One `find` for Quick open: every file under `root`, pruning the watcher's
/// ignored names (and dot-entries unless `include_hidden`), at most `cap + 1`
/// lines so the caller can tell a truncated list. POSIX only (`-H`, `-prune`,
/// `-path`). `! -path root` keeps the root itself from being pruned when its
/// own name is hidden or ignored (e.g. a workspace at `~/.config`).
pub(crate) fn workspace_files_script(root: &str, include_hidden: bool, cap: usize) -> String {
    let r = shell_quote(root);
    let mut names: Vec<String> = crate::watcher::IGNORED_DIR_NAMES
        .iter()
        .map(|n| format!("-name {}", shell_quote(n)))
        .collect();
    if !include_hidden {
        names.push("-name '.*'".to_string());
    }
    format!(
        "find -H {r} ! -path {r} \\( {names} \\) -prune -o -type f -print 2>/dev/null | head -n {limit}",
        names = names.join(" -o "),
        limit = cap + 1
    )
}

/// Parse [`workspace_files_script`] output into root-relative paths.
pub(crate) fn parse_workspace_files(raw: &str, root: &str, cap: usize) -> FileListing {
    let prefix = format!("{}/", root.trim_end_matches('/'));
    let mut files: Vec<String> = raw
        .lines()
        .filter_map(|l| l.strip_prefix(&prefix))
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    let truncated = files.len() > cap;
    files.truncate(cap);
    files.sort_unstable();
    FileListing { files, truncated }
}

/// Quick open's file list on the SSH host (see `file_index`).
pub fn list_workspace_files(
    root: &str,
    include_hidden: bool,
    cap: usize,
) -> Result<FileListing, AppError> {
    let session = current_session().ok_or_else(|| AppError::Other("no remote session".into()))?;
    validate_remote_path(root).map_err(AppError::Other)?;
    // `find /r/` would print `/r//a`; list from the slash-free form.
    let root = match root.trim_end_matches('/') {
        "" => "/",
        r => r,
    };
    let script = workspace_files_script(root, include_hidden, cap);
    let raw = ssh_run(&session.host, &script).map_err(AppError::Other)?;
    Ok(parse_workspace_files(&raw, root, cap))
}

const GIT_SECTION_SEP: &str = "__SD_SEP__";

pub fn git_status(root: &str) -> Result<GitStatus, String> {
    let session = current_session().ok_or_else(|| "no remote session".to_string())?;
    validate_remote_path(root)?;
    let raw = ssh_run(&session.host, &git_status_script(root))?;
    Ok(parse_status_sections(&raw, root))
}

fn git_status_script(root: &str) -> String {
    // One round trip for all the git questions (repo? top-level, the way up
    // to it, branch, porcelain status), sectioned by a sentinel line. The old
    // shape was up to four ssh calls — and the Changes badge asks on every
    // watcher tick. The `--show-cdup` section (see parse_status_sections)
    // lets the top level keep the root's spelling through symlinks.
    let r = shell_quote(root);
    format!(
        "env -u GIT_EXTERNAL_DIFF -u GIT_DIFF_OPTS -u GIT_PAGER GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c core.fsmonitor=false -c diff.external= -C {r} rev-parse --is-inside-work-tree 2>/dev/null; echo {sep}; \
         env -u GIT_EXTERNAL_DIFF -u GIT_DIFF_OPTS -u GIT_PAGER GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c core.fsmonitor=false -c diff.external= -C {r} rev-parse --show-toplevel 2>/dev/null; echo {sep}; \
         c=$(env -u GIT_EXTERNAL_DIFF -u GIT_DIFF_OPTS -u GIT_PAGER GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c core.fsmonitor=false -c diff.external= -C {r} rev-parse --show-cdup 2>/dev/null) && printf 'cdup=%s\\n' \"$c\" && (cd {r} && cd \"./$c\" && printf 'phys=%s\\n' \"$(pwd -P)\") 2>/dev/null; echo {sep}; \
         env -u GIT_EXTERNAL_DIFF -u GIT_DIFF_OPTS -u GIT_PAGER GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c core.fsmonitor=false -c diff.external= -C {r} rev-parse --abbrev-ref HEAD 2>/dev/null; echo {sep}; \
         env -u GIT_EXTERNAL_DIFF -u GIT_DIFF_OPTS -u GIT_PAGER GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c core.fsmonitor=false -c diff.external= -C {r} status --ignore-submodules=all --porcelain -z --untracked-files=all 2>/dev/null; true",
        sep = GIT_SECTION_SEP
    )
}

/// Parse the sectioned git_status payload (see GIT_SECTION_SEP script).
/// Sections: is-inside-work-tree, show-toplevel (canonical), `cdup=`/`phys=`
/// lines, branch, porcelain. The top level is reported in `root`'s spelling
/// (root + cdup, joined lexically) when that lands on the same physical
/// directory git named; otherwise git's canonical answer is kept (same rule
/// as the local `git::top_level_in_root_spelling`).
fn parse_status_sections(raw: &str, root: &str) -> GitStatus {
    let mut sections = raw.split(GIT_SECTION_SEP);
    let is_repo = sections.next().map(|s| s.trim() == "true").unwrap_or(false);
    if !is_repo {
        return GitStatus {
            is_repo: false,
            branch: None,
            top_level: None,
            changes: vec![],
        };
    }
    let clean = |s: Option<&str>| {
        s.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let canonical = clean(sections.next());
    let way_up = sections.next().unwrap_or("");
    let field = |key: &str| {
        way_up
            .lines()
            .find_map(|l| l.strip_prefix(key))
            .map(str::to_string)
    };
    let top_level = canonical.map(|canonical| match (field("cdup="), field("phys=")) {
        (Some(cdup), Some(phys)) if phys == canonical => {
            crate::git::lexical_join_posix(root, cdup.trim())
        }
        _ => canonical,
    });
    let branch = clean(sections.next());
    // Porcelain is NUL-separated; strip only the newlines the sentinel
    // echoes added around it.
    let porcelain = sections.next().unwrap_or("").trim_matches('\n');
    GitStatus {
        is_repo: true,
        branch,
        top_level,
        changes: parse_porcelain(porcelain),
    }
}

/// Branch + ahead/behind of the remote workspace (see git::git_branch_status).
/// Same read-only git questions over the hardened `ssh_git` runner; a failed
/// call means "unknown" (not a repo, no commit yet, no upstream).
pub fn git_branch_status(root: &str) -> Result<GitBranchStatus, String> {
    validate_remote_path(root)?;
    let abbrev = ssh_git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).ok();
    let detached = abbrev.as_deref().map(str::trim) == Some("HEAD");
    let short_head = if detached {
        ssh_git(root, &["rev-parse", "--short", "HEAD"]).ok()
    } else {
        None
    };
    let counts = if abbrev.is_some() && !detached {
        ssh_git(
            root,
            &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
        )
        .ok()
    } else {
        None
    };
    Ok(branch_status_from(
        abbrev.as_deref(),
        short_head.as_deref(),
        counts.as_deref(),
    ))
}

pub fn git_diff_file(root: &str, path: &str, untracked: bool) -> Result<String, String> {
    validate_remote_path(root)?;
    // `path` is a repository-relative path, so it must NOT be absolute — use
    // the input validator (control chars only) and keep the explicit
    // relative/traversal guard below.
    validate_remote_input(path)?;
    if path.starts_with('/') || path.split('/').any(|part| part == "..") {
        return Err("git path is outside the repository".into());
    }
    if untracked {
        ssh_git(
            root,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=all",
                "--no-index",
                "--",
                "/dev/null",
                path,
            ],
        )
    } else {
        ssh_git(
            root,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=all",
                "HEAD",
                "--",
                path,
            ],
        )
    }
}

pub fn watch_stop() {
    watch_stop_flag().store(true, Ordering::SeqCst);
    // Bump the generation so any sleeping poll thread exits on wake even if
    // a new watch_start clears the stop flag before it checks.
    watch_generation().fetch_add(1, Ordering::SeqCst);
}

pub fn watch_start(app: AppHandle, root: &str) -> Result<(), String> {
    let session = current_session().ok_or_else(|| "no remote session".to_string())?;
    validate_remote_path(root)?;
    watch_stop();
    watch_stop_flag().store(false, Ordering::SeqCst);
    // The thread polls only while it owns the current generation; a stale
    // thread (sleeping through the stop-flag flip above) sees the bump and
    // exits instead of double-polling the old root forever.
    let my_generation = watch_generation().load(Ordering::SeqCst);
    let host = session.host;
    let root = root.to_string();
    let script = watch_fingerprint_script(&root);
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            if watch_stop_flag().load(Ordering::SeqCst)
                || watch_generation().load(Ordering::SeqCst) != my_generation
            {
                break;
            }
            match ssh_run(&host, &script) {
                Ok(fp) => {
                    // Structure-only deltas remount the explorer; content/git
                    // "status ticks" emit modify so the UI flashes / refreshes
                    // Changes without wiping the file tree scroll position.
                    if let Some(kind) = classify_remote_watch_delta(&last, &fp) {
                        crate::file_index::invalidate_for_kinds([kind]);
                        let _ = app.emit(
                            "watcher://changes",
                            vec![crate::watcher::FsChange {
                                path: root.clone(),
                                kind: kind.to_string(),
                            }],
                        );
                    }
                    last = fp;
                }
                Err(_) => {
                    // Unreachable mid-session: emit nothing; next poll retries.
                }
            }
            std::thread::sleep(Duration::from_millis(1500));
        }
    });
    Ok(())
}

/// When a remote session is active, the embedded PTY runs `ssh -tt host`
/// (reattach tmux on the remote if a session name is provided).
pub fn terminal_command(
    cwd: Option<&str>,
    session_name: Option<&str>,
    launch: Option<&str>,
) -> Option<(CommandBuilder, &'static str)> {
    let sess = current_session()?;
    let dir = cwd.filter(|d| !d.is_empty()).unwrap_or(&sess.path);
    let launch = launch.filter(|s| !s.is_empty());
    let mut cmd = CommandBuilder::new("ssh");
    // Reuse the session's SSH control (mux) connection so new terminals open
    // in channel-setup time instead of a full SSH handshake.
    for opt in mux_options() {
        cmd.arg(opt);
    }
    cmd.args([
        "-tt",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        // Keepalive so a dropped link tears the PTY down promptly instead of
        // hanging on a half-open channel.
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=2",
        "-o",
        "PreferredAuthentications=publickey",
        "-o",
        "PubkeyAuthentication=yes",
    ]);
    for a in ssh::destination_args(&sess.host).ok()? {
        cmd.arg(a);
    }
    // Same contract as the local PTY (terminal.rs): an agent chip's command
    // runs as the shell's foreground process once the login shell is ready,
    // carried in $SPARKDOWN_LAUNCH so it needs no quoting into the wrapper.
    // The wrapper is single-quoted so the remote login shell passes it
    // verbatim to the inner shell that resolves the variable. We source the
    // interactive rc EXPLICITLY: a `-c` shell comes up non-interactive and
    // never reads ~/.zshrc, dropping the PATH additions that hold the agent
    // binary (so it would fail with "command not found"). The rc file is
    // chosen by the remote $SHELL; sourcing errors are dropped.
    const WRAP: &str = r#"${SHELL:-/bin/sh} -lic 'case "${SHELL:-}" in *zsh) [ -f "${ZDOTDIR:-$HOME}/.zshrc" ] && . "${ZDOTDIR:-$HOME}/.zshrc" 2>/dev/null;; *bash) [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" 2>/dev/null;; esac; eval "$SPARKDOWN_LAUNCH"; exec "${SHELL:-/bin/sh}" -l'"#;
    // Export the per-workspace env INSIDE the pane's command. A session made
    // on an already-running remote tmux server does NOT inherit the vars
    // exported before `tmux` (only the server's global env +
    // update-environment), so without this a second workspace's terminals
    // would see the first's SPARKDOWN_CONTEXT / miss SPARKDOWN_MCP. Unlike
    // `tmux -e` this works below tmux 3.2. The outer exports still cover the
    // non-tmux fallback shell. `=name` (below) forces exact target matching so
    // set-option can't hit a same-prefixed session.
    let pane_env = {
        let mut f = String::new();
        if let Some(ctx) = context_dir_for(dir) {
            f.push_str(&format!("export SPARKDOWN_CONTEXT={}; ", shell_quote(&ctx)));
        }
        if let Some(sock) = remote_mcp_socket() {
            f.push_str(&format!("export SPARKDOWN_MCP={}; ", shell_quote(&sock)));
        }
        f
    };
    let (remote, mode) = match session_name.filter(|s| !s.is_empty()) {
        Some(name) => {
            let safe: String = name
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() || c == '-' || c == '_' {
                        c
                    } else {
                        '-'
                    }
                })
                .collect();
            // Chained after new-session (re-applied on every `-A` reattach),
            // both scoped to this exact session, never `-g`: detach-on-destroy
            // so `exit` closes the tab, and `status off` because the pane
            // header already names the terminal (as in terminal.rs).
            let body = match launch {
                Some(cmd_str) => {
                    // No `tmux -e` (that needs tmux >= 3.2): have tmux run a
                    // POSIX sh that exports the pane env + launch var then
                    // execs the wrapper, so agent-chip persistence works on
                    // older tmux too. The same one-liner is the non-tmux
                    // fallback after `||`.
                    let inner = format!(
                        "{pane_env}export SPARKDOWN_LAUNCH={}; exec {WRAP}",
                        shell_quote(cmd_str)
                    );
                    format!(
                        "command -v tmux >/dev/null 2>&1 && tmux new-session -A -s {name} -- /bin/sh -c {q} \\; set-option -t ={name}: detach-on-destroy on \\; set-option -t ={name}: status off || ({inner})",
                        name = shell_quote(&safe),
                        q = shell_quote(&inner),
                        inner = inner,
                    )
                }
                None => {
                    let inner = format!("{pane_env}exec ${{SHELL:-/bin/sh}} -l");
                    format!(
                        "command -v tmux >/dev/null 2>&1 && tmux new-session -A -s {name} -- /bin/sh -c {q} \\; set-option -t ={name}: detach-on-destroy on \\; set-option -t ={name}: status off || exec ${{SHELL:-/bin/sh}} -l",
                        name = shell_quote(&safe),
                        q = shell_quote(&inner),
                    )
                }
            };
            (format!("cd {} && ({body})", shell_quote(dir)), "tmux")
        }
        None => {
            let body = match launch {
                Some(cmd_str) => format!(
                    "export SPARKDOWN_LAUNCH={}; exec {WRAP}",
                    shell_quote(cmd_str)
                ),
                None => "exec ${SHELL:-/bin/sh} -l".to_string(),
            };
            (format!("cd {} && {body}", shell_quote(dir)), "shell")
        }
    };
    // Agent context bridge, same contract as the local PTY (terminal.rs):
    // agents in this shell read $SPARKDOWN_CONTEXT/context.json. Exported
    // before tmux so a new tmux session inherits it.
    let remote = match context_dir_for(dir) {
        Some(ctx) => format!("export SPARKDOWN_CONTEXT={}; {remote}", shell_quote(&ctx)),
        None => remote,
    };
    // MCP gate, same as the local PTY: agents (and the remote shim) reach the
    // app only where this names a live socket — here the reverse-forwarded
    // one. Unset when the forward is down, so they fall back to the bridge.
    let remote = match remote_mcp_socket() {
        Some(sock) => format!("export SPARKDOWN_MCP={}; {remote}", shell_quote(&sock)),
        None => remote,
    };
    cmd.arg(remote);
    Some((cmd, mode))
}

// --- Remote MCP (phase 4): the app's socket, reverse-forwarded over SSH ------

/// POSIX shell script installed on the remote as the agents' stdio MCP
/// server; it bridges to the forwarded socket (see the file's header).
pub(crate) const REMOTE_SHIM_SCRIPT: &str = include_str!("mcp_shim.sh");

static REMOTE_MCP: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn remote_mcp_lock() -> &'static Mutex<Option<String>> {
    REMOTE_MCP.get_or_init(|| Mutex::new(None))
}

/// The remote socket path while the reverse forward is live, else None.
pub fn remote_mcp_socket() -> Option<String> {
    remote_mcp_lock().lock().ok()?.clone()
}

fn remote_cache_dir(session: &RemoteSession) -> String {
    client_cache_dir(session)
}

/// Where the forwarded socket lands on the remote (per-user, 0700 dir).
pub fn remote_mcp_socket_path(session: &RemoteSession) -> String {
    format!("{}/mcp.sock", remote_cache_dir(session))
}

/// The shim script's path on the remote — what agent configs point at.
pub fn remote_mcp_shim_path(session: &RemoteSession) -> String {
    format!("{}/mcp-shim", remote_cache_dir(session))
}

/// `ssh` arguments (after the mux options) that ask the live control (mux)
/// connection to open, or cancel, the reverse Unix-socket forward
/// `remote_sock` → `local_sock`.
pub(crate) fn forward_args(
    host: &str,
    remote_sock: &str,
    local_sock: &str,
    cancel: bool,
) -> Vec<String> {
    let mut v = vec![
        "-O".into(),
        if cancel { "cancel" } else { "forward" }.into(),
        "-R".into(),
        format!("{remote_sock}:{local_sock}"),
    ];
    // An invalid host never gets here (connect validated it); fall back to
    // the raw string only for the unit test's plain alias.
    v.extend(ssh::destination_args(host).unwrap_or_else(|_| vec![host.into()]));
    v
}

/// Install the shim on the remote and reverse-forward the local MCP socket
/// to it over the session's SSH control (mux) connection. Returns the remote
/// socket path.
pub fn mcp_forward_start(session: &RemoteSession, local_sock: &Path) -> Result<String, String> {
    if session.home.is_empty() {
        return Err("remote home directory unknown".into());
    }
    let opts = mux_options();
    if opts.is_empty() {
        return Err("SSH multiplexing is unavailable on this platform".into());
    }
    let sock = remote_mcp_socket_path(session);
    let shim = remote_mcp_shim_path(session);
    // 1. Private dir, fresh shim, and no stale socket file (sshd refuses to
    //    bind over one unless StreamLocalBindUnlink is set).
    let setup = format!(
        "umask 077; mkdir -p {d} && rm -f {s} && cat > {sh} && chmod 700 {sh}",
        d = shell_quote(&remote_cache_dir(session)),
        s = shell_quote(&sock),
        sh = shell_quote(&shim),
    );
    ssh_run_stdin(&session.host, &setup, Some(REMOTE_SHIM_SCRIPT.as_bytes()))?;
    // 2. Cancel any forward for this exact spec first. A previous run that
    //    quit without disconnecting can leave the `-R` forward registered on
    //    a still-warm ControlPersist mux; the mux answers a duplicate
    //    `-O forward` with "already forwarded" WITHOUT re-listening on the
    //    (now-deleted) socket, so the remote MCP would be silently offline.
    //    Best effort — "cancel" of a missing forward just errors and is fine.
    let _ = crate::proc::command("ssh")
        .args(&opts)
        .args(forward_args(
            &session.host,
            &sock,
            &local_sock.to_string_lossy(),
            true,
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    // 3. Ask the control (mux) connection (kept warm by ControlPersist) to
    //    add the forward.
    let out = crate::proc::command("ssh")
        .args(&opts)
        .args(forward_args(
            &session.host,
            &sock,
            &local_sock.to_string_lossy(),
            false,
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("failed to run ssh: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ssh -O forward failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    // 4. A success exit from the mux is not proof the remote actually bound
    //    the socket (see the stale-forward case above), so confirm it is a
    //    listening socket before advertising it to agents.
    let listening = ssh_run(
        &session.host,
        &format!("test -S {} && printf ok", shell_quote(&sock)),
    )
    .map(|s| s.trim() == "ok")
    .unwrap_or(false);
    if !listening {
        return Err(
            "reverse MCP forward reported success but no listening socket appeared on the remote"
                .into(),
        );
    }
    if let Ok(mut g) = remote_mcp_lock().lock() {
        *g = Some(sock.clone());
    }
    Ok(sock)
}

/// Cancel the forward and remove the socket + shim on the remote. Best effort.
pub fn mcp_forward_stop(session: &RemoteSession) {
    let Some(sock) = remote_mcp_lock().lock().ok().and_then(|mut g| g.take()) else {
        return;
    };
    if let Some(local) = crate::mcp::running_socket_path() {
        let _ = crate::proc::command("ssh")
            .args(mux_options())
            .args(forward_args(
                &session.host,
                &sock,
                &local.to_string_lossy(),
                true,
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let shim = remote_mcp_shim_path(session);
    let _ = ssh_run(
        &session.host,
        &format!("rm -f {} {}", shell_quote(&sock), shell_quote(&shim)),
    );
}

/// Run `cmd` in the remote user's interactive login shell (so agent binaries
/// on a profile-only PATH resolve). Used for `mcp add` / `mcp remove`.
pub fn run_in_login_shell(cmd: &str) -> Result<String, String> {
    let session = current_session().ok_or_else(|| "no remote session".to_string())?;
    ssh_run(
        &session.host,
        &format!("cd /tmp && ${{SHELL:-/bin/sh}} -lic {}", shell_quote(cmd)),
    )
}

/// Contents of `<remote home>/<rel>`, or None if absent / unreadable.
pub fn read_home_file(rel: &str) -> Option<String> {
    let session = current_session()?;
    if session.home.is_empty() {
        return None;
    }
    let path = format!("{}/{rel}", session.home.trim_end_matches('/'));
    validate_remote_path(&path).ok()?;
    ssh_run(
        &session.host,
        &format!("cat {} 2>/dev/null", shell_quote(&path)),
    )
    .ok()
}

/// Absolute path of `<remote home>/<rel>`, validated.
fn home_path(session: &RemoteSession, rel: &str) -> Result<String, String> {
    if session.home.is_empty() {
        return Err("the remote home directory is unknown".into());
    }
    let path = format!("{}/{rel}", session.home.trim_end_matches('/'));
    validate_remote_path(&path)?;
    Ok(path)
}

/// POSIX sh: print a status line for `path`, then (only on `__SD_OK__`) its
/// contents. `__SD_NF__` means nothing exists at the path (not even a
/// dangling link); the other states are those of `read_file`.
fn read_for_edit_script(path: &str) -> String {
    format!(
        "if [ ! -e {p} ] && [ ! -L {p} ]; then echo __SD_NF__; \
         elif [ -d {p} ]; then echo __SD_DIR__; \
         elif [ ! -f {p} ]; then echo __SD_BAD__; \
         else s=$(wc -c < {p}); if [ \"$s\" -gt {max} ]; then echo __SD_BIG__ \"$s\"; \
         else echo __SD_OK__; cat -- {p}; fi; fi",
        p = shell_quote(path),
        max = MAX_REMOTE_FILE_BYTES
    )
}

/// `<remote home>/<rel>` for a read-modify-write: `Ok(None)` when the file
/// does not exist, an error when it exists but cannot be read as UTF-8 text
/// (so the caller never mistakes an unreadable file for a missing one and
/// overwrites it).
pub fn read_home_file_for_edit(rel: &str) -> Result<Option<String>, String> {
    let session = current_session().ok_or_else(|| "no remote session".to_string())?;
    let path = home_path(&session, rel)?;
    let raw = ssh_run_bytes(&session.host, &read_for_edit_script(&path), None)?;
    if raw.starts_with(b"__SD_NF__") {
        return Ok(None);
    }
    parse_read_payload(&raw, &path)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// POSIX sh: create the parent dir owner-only if missing, and an empty
/// owner-only file if nothing exists at `path`, so the atomic write that
/// follows (which keeps an existing file's mode) yields 0600. Existing dirs
/// and files keep their permissions.
fn prepare_private_file_script(path: &str, parent: &str) -> String {
    format!(
        "umask 077 && mkdir -p -- {d} && {{ [ -e {p} ] || [ -L {p} ] || : > {p}; }}",
        d = shell_quote(parent),
        p = shell_quote(path)
    )
}

/// Replace `<remote home>/<rel>` with `content` (atomic, size-checked via
/// `write_file`). A missing parent directory / file is created owner-only.
pub fn write_home_file(rel: &str, content: &str) -> Result<(), String> {
    let session = current_session().ok_or_else(|| "no remote session".to_string())?;
    let path = home_path(&session, rel)?;
    let parent = Path::new(&path)
        .parent()
        .and_then(|p| p.to_str())
        .ok_or("the remote path has no parent directory")?
        .to_string();
    ssh_run(&session.host, &prepare_private_file_script(&path, &parent))?;
    write_file(&path, content).map_err(|e| e.to_string())
}

pub fn tmux_sessions(prefix: &str) -> Vec<String> {
    let Some(sess) = current_session() else {
        return vec![];
    };
    let Ok(out) = ssh_run(
        &sess.host,
        "tmux list-sessions -F '#{session_name}' 2>/dev/null",
    ) else {
        return vec![];
    };
    out.lines()
        .filter(|l| l.starts_with(prefix))
        .map(str::to_string)
        .collect()
}

pub fn tmux_send_keys(session: &str, text: &str) -> Result<(), String> {
    let sess = current_session().ok_or_else(|| "no remote session".to_string())?;
    // `=session` forces an exact target match so keys can't land in a
    // same-prefixed session's active pane (e.g. sd-..-1 vs sd-..-10).
    let cmd = format!(
        "tmux send-keys -t ={}: -l -- {}",
        shell_quote(session),
        shell_quote(text)
    );
    ssh_run(&sess.host, &cmd).map(|_| ())
}

pub fn tmux_kill_session(session: &str) -> Result<(), String> {
    let Some(sess) = current_session() else {
        return Ok(());
    };
    // `=session` forces an exact target match so we can't kill a same-prefixed
    // session (e.g. sd-..-1 vs sd-..-10).
    let cmd = format!("tmux kill-session -t ={} 2>/dev/null", shell_quote(session));
    let _ = ssh_run(&sess.host, &cmd);
    Ok(())
}

/// Serializes tests that touch the process-global remote session. Shared
/// with commands.rs tests: a session left set (even briefly) reroutes local
/// read_file/list_directory through the remote transport mid-test.
#[cfg(test)]
pub(crate) static TEST_SESSION_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::ssh::{
        classify_remote_watch_delta, parse_ssh_config, split_watch_fingerprint, ssh_argv,
    };
    use super::*;

    use super::TEST_SESSION_LOCK as TEST_LOCK;

    const SAMPLE: &str = r#"
# comment
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519

Host *
  ForwardAgent yes
  IdentityFile ~/.ssh/id_ed25519

Host dev box.internal
  HostName 10.0.0.5
  User ubuntu
  IdentityFile ~/.ssh/dev

Host passwordbox
  HostName 10.0.0.9
  PreferredAuthentications password
  PubkeyAuthentication no

Host kbd
  PreferredAuthentications keyboard-interactive,password

Host mixed
  PreferredAuthentications publickey,password
  IdentityFile ~/.ssh/id_ed25519

Host *.example.com
  User deploy
"#;

    #[test]
    fn parse_lists_concrete_hosts_skips_wildcards() {
        let hosts = parse_ssh_config(SAMPLE);
        let aliases: Vec<&str> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert!(aliases.contains(&"github.com"));
        assert!(aliases.contains(&"dev"));
        assert!(aliases.contains(&"box.internal"));
        assert!(aliases.contains(&"passwordbox"));
        assert!(aliases.contains(&"kbd"));
        assert!(aliases.contains(&"mixed"));
        assert!(!aliases.iter().any(|a| a.contains('*')));
        assert_eq!(
            hosts
                .iter()
                .find(|h| h.alias == "dev")
                .unwrap()
                .user
                .as_deref(),
            Some("ubuntu")
        );
    }

    #[test]
    fn parse_flags_password_only() {
        let hosts = parse_ssh_config(SAMPLE);
        assert!(
            hosts
                .iter()
                .find(|h| h.alias == "passwordbox")
                .unwrap()
                .password_only
        );
        assert!(
            hosts
                .iter()
                .find(|h| h.alias == "kbd")
                .unwrap()
                .password_only
        );
        assert!(
            !hosts
                .iter()
                .find(|h| h.alias == "mixed")
                .unwrap()
                .password_only
        );
        assert!(
            !hosts
                .iter()
                .find(|h| h.alias == "dev")
                .unwrap()
                .password_only
        );
        assert!(
            !hosts
                .iter()
                .find(|h| h.alias == "github.com")
                .unwrap()
                .password_only
        );
    }

    #[test]
    fn parse_equals_and_quotes() {
        let hosts = parse_ssh_config("Host x\n  HostName=\"example.com\"\n  User = me\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].hostname.as_deref(), Some("example.com"));
        assert_eq!(hosts[0].user.as_deref(), Some("me"));
    }

    #[test]
    fn shell_quote_wraps_and_escapes() {
        assert_eq!(shell_quote("abc"), "'abc'");
        // POSIX quoting of a'b uses nested single quotes and a backslash.
        assert_eq!(
            shell_quote("a'b").as_bytes(),
            [39, b'a', 39, b'\\', 39, 39, b'b', 39]
        );
        assert_eq!(shell_quote("/home/u/proj"), "'/home/u/proj'");
    }

    #[test]
    fn detect_agent_probe_exits_zero_when_last_bin_missing() {
        // Regression: the for-loop's exit status is the last `command -v`.
        // Without a trailing `true`, ssh_run treated that as failure and
        // detect_agents reported zero agents even when earlier bins existed.
        let missing = "sparkdown-no-such-agent-bin-xyzzy";
        let script = detect_agent_probe_inner(&["ls", missing]);
        assert!(
            script.trim_end().ends_with("; true"),
            "probe must force exit 0: {script}"
        );
        let out = crate::proc::command("sh")
            .arg("-c")
            .arg(&script)
            .output()
            .expect("sh");
        assert!(
            out.status.success(),
            "probe exit {:?}; stderr={}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        );
        let found: Vec<&str> = std::str::from_utf8(&out.stdout)
            .unwrap()
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        assert_eq!(found, vec!["ls"]);
    }

    #[test]
    fn ssh_argv_is_batchmode_publickey() {
        let argv = ssh_argv("dev");
        assert_eq!(argv[0], "ssh");
        assert!(argv.windows(2).any(|w| w == ["-o", "BatchMode=yes"]));
        assert!(argv
            .windows(2)
            .any(|w| w == ["-o", "PreferredAuthentications=publickey"]));
        assert_eq!(argv.last().unwrap(), "dev");
    }

    #[test]
    fn watch_and_git_scripts_run_on_remote() {
        let watch = watch_fingerprint_script("/home/u/proj");
        assert!(watch.contains("core.fsmonitor=false"));
        // -H: follow a symlinked root (e.g. /home/user) or the
        // fingerprint is permanently empty and changes never surface.
        assert!(watch.contains("find -H '/home/u/proj'"));
        // Structure vs content sections + sorted find (stable across readdir).
        assert!(watch.contains("__SD_STRUCT__"));
        assert!(watch.contains("__SD_CONTENT__"));
        assert!(watch.contains("LC_ALL=C sort"));
        // #28: one batched stat per find group, never a process per file
        // (minutes on a home-sized tree, past the SSH timeout).
        assert!(watch.contains("-exec stat -c '%Y %s %n' {} +"), "{watch}");
        assert!(watch.contains("-exec stat -f '%m %z %N' {} +"), "{watch}");
        assert!(!watch.contains("for f do"), "{watch}");
        let argv = ssh_argv("dev");
        assert_eq!(argv[0], "ssh");
        assert!(argv.contains(&"dev".to_string()));
    }

    /// Run the generated fingerprint script under the local `sh` (BSD-ish on
    /// macOS = a real portability check) to prove the POSIX rewrite has no
    /// GNU-only `-printf`/`stat` dependency and still separates structure from
    /// content deltas.
    #[cfg(unix)]
    #[test]
    fn watch_fingerprint_script_runs_under_local_sh() {
        let dir = std::env::temp_dir().join(format!("sd-watch-fp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let dir = dir.canonicalize().unwrap();
        std::fs::write(dir.join("a.md"), "hello").unwrap();

        let run = || {
            let script = watch_fingerprint_script(dir.to_str().unwrap());
            let out = crate::proc::command("sh")
                .arg("-c")
                .arg(&script)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "stderr={}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).into_owned()
        };

        let fp1 = run();
        let (structure, _content) = split_watch_fingerprint(&fp1);
        assert!(
            structure.contains(&format!("f {}/a.md", dir.display())),
            "{structure}"
        );
        assert!(
            structure.contains(&format!("d {}/sub", dir.display())),
            "{structure}"
        );

        // A new file is a structural change (remount the explorer).
        std::fs::write(dir.join("b.md"), "x").unwrap();
        let fp2 = run();
        assert_eq!(classify_remote_watch_delta(&fp1, &fp2), Some("other"));

        // Growing an existing file is a content-only tick.
        std::fs::write(dir.join("b.md"), "xxxxxxxx").unwrap();
        let fp3 = run();
        assert_eq!(classify_remote_watch_delta(&fp2, &fp3), Some("modify"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remote_watch_delta_ignores_content_only_ticks() {
        let struct_a = "d /home/u/proj\nf /home/u/proj/a.md\n";
        let struct_b = "d /home/u/proj\nf /home/u/proj/a.md\nf /home/u/proj/b.md\n";
        let content_1 = "git1\n1.0 10 /home/u/proj/a.md\n";
        let content_2 = "git2\n2.0 11 /home/u/proj/a.md\n";
        let fp = |s: &str, c: &str| format!("__SD_STRUCT__\n{s}__SD_CONTENT__\n{c}");
        let first = fp(struct_a, content_1);
        let content_tick = fp(struct_a, content_2);
        let structural = fp(struct_b, content_2);

        assert_eq!(split_watch_fingerprint(&first).0, struct_a);
        assert_eq!(classify_remote_watch_delta("", &first), None);
        assert_eq!(classify_remote_watch_delta(&first, &first), None);
        assert_eq!(
            classify_remote_watch_delta(&first, &content_tick),
            Some("modify")
        );
        assert_eq!(
            classify_remote_watch_delta(&content_tick, &structural),
            Some("other")
        );
    }

    #[test]
    fn password_only_fails_without_probe() {
        let _guard = TEST_LOCK.lock().unwrap();
        let hosts = parse_ssh_config(SAMPLE);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let err = connect_with(&hosts, "passwordbox", "/tmp", |_h, _c| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok("/tmp".into())
        })
        .unwrap_err();
        assert!(err.to_ascii_lowercase().contains("password"), "{err}");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(current_session().is_none() || current_session().unwrap().host != "passwordbox");
    }

    #[test]
    fn typed_host_not_in_config_connects_through_ssh() {
        // #22: a host typed in the dialog (not in ~/.ssh/config) goes to ssh,
        // which applies the user's normal config, keys and agent.
        let _guard = TEST_LOCK.lock().unwrap();
        let seen = std::sync::Mutex::new(Vec::new());
        let s = connect_with(&[], "me@127.0.0.1:2222", "/", |h, _| {
            seen.lock().unwrap().push(h.to_string());
            Ok("/\n/home/me\n".into())
        })
        .unwrap();
        assert_eq!(s.host, "me@127.0.0.1:2222");
        assert_eq!(seen.lock().unwrap()[0], "me@127.0.0.1:2222");
        // Don't leave a global session behind: other modules' tests (review)
        // would route their calls over ssh to it.
        disconnect_now();
        let err = connect_with(&[], "-oProxyCommand=x", "/", |_, _| Ok("/".into())).unwrap_err();
        assert!(err.contains("Invalid SSH host"), "{err}");
    }

    /// Live check (#28): a save over ssh must move the watch fingerprint
    /// (so the UI refreshes Changes) and show up in remote git status.
    /// `SPARKDOWN_SSH_TEST_DEST=me@127.0.0.1:2223 SPARKDOWN_SSH_TEST_REPO=/abs/repo
    /// cargo test live_remote_save -- --ignored`; the repo needs a committed `a.md`.
    #[test]
    #[ignore]
    fn live_remote_save_shows_in_changes() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dest = std::env::var("SPARKDOWN_SSH_TEST_DEST").expect("SPARKDOWN_SSH_TEST_DEST");
        let repo = std::env::var("SPARKDOWN_SSH_TEST_REPO").expect("SPARKDOWN_SSH_TEST_REPO");
        let s = connect_with(&[], &dest, &repo, ssh_run).unwrap();
        let script = watch_fingerprint_script(&s.path);
        let before = ssh_run(&dest, &script).unwrap();
        let status0 = git_status(&s.path).unwrap();
        assert!(status0.is_repo, "not a repo");
        let file = format!("{}/a.md", s.path);
        write_file(&file, "edited over ssh\n").unwrap();
        let after = ssh_run(&dest, &script).unwrap();
        let kind = classify_remote_watch_delta(&before, &after);
        let status1 = git_status(&s.path).unwrap();
        disconnect_now();
        assert_eq!(kind, Some("modify"));
        assert!(
            status1.changes.iter().any(|c| c.path.ends_with("a.md")),
            "changes: {:?}",
            status1.changes.iter().map(|c| &c.path).collect::<Vec<_>>()
        );
    }

    /// Live check against a real sshd (#22), e.g.
    /// `SPARKDOWN_SSH_TEST_DEST=me@127.0.0.1:2223 cargo test live_typed_host -- --ignored`.
    /// Needs a key the server accepts and the host in known_hosts.
    #[test]
    #[ignore]
    fn live_typed_host_round_trip() {
        let dest = std::env::var("SPARKDOWN_SSH_TEST_DEST").expect("SPARKDOWN_SSH_TEST_DEST");
        let out = ssh_run(&dest, "printf typed-host-ok").unwrap();
        assert_eq!(out.trim(), "typed-host-ok");
        close_mux(&dest);
    }

    #[test]
    fn destinations_parse_strictly() {
        use super::ssh::{destination_args, parse_destination};
        let ok = |s: &str| destination_args(s).unwrap();
        assert_eq!(ok("myhost"), ["myhost"]);
        assert_eq!(ok("dev_box.lan"), ["dev_box.lan"]);
        assert_eq!(ok("localhost"), ["localhost"]);
        assert_eq!(ok("me@host-1.example"), ["me@host-1.example"]);
        assert_eq!(ok("me@127.0.0.1:2222"), ["-p", "2222", "me@127.0.0.1"]);
        assert_eq!(ok("host:22"), ["-p", "22", "host"]);
        assert_eq!(ok("me@[::1]:2200"), ["-p", "2200", "me@::1"]);
        assert_eq!(ok("[fe80::1]"), ["fe80::1"]);
        let d = parse_destination("a.b@c:65535").unwrap();
        assert_eq!(
            (d.user.as_deref(), d.host.as_str(), d.port),
            (Some("a.b"), "c", Some(65535))
        );
        for bad in [
            "",
            "-G",
            "-oProxyCommand=sh",
            "me@-oProxyCommand=x",
            "-p22 host",
            "host -p 22",
            " host",
            "host ",
            "ho st",
            "host\t",
            "host\n",
            "host;id",
            "host|id",
            "host&",
            "$(id)",
            "`id`",
            "host$HOME",
            "me@host'",
            "me@host\"",
            "a@b@c",
            "@host",
            "me@",
            "host:",
            "host:0",
            "host:65536",
            "host:-1",
            "host:+22",
            "host:22:33",
            "host:abc",
            "[::1",
            "::1",
            "[host]",
            "[::1]x",
            "me@[::1]:",
            "ho[st",
            ".hidden",
            "me@-host",
            "-me@host",
            "host/path",
            "host,x",
            "host*",
            "host?",
            "host=1",
            "~host",
            "x\u{0}y",
        ] {
            assert!(parse_destination(bad).is_err(), "should reject {bad:?}");
        }
        assert!(parse_destination(&"a".repeat(256)).is_err());
    }

    #[test]
    fn unreachable_maps_clear_error() {
        let _guard = TEST_LOCK.lock().unwrap();
        let hosts = parse_ssh_config("Host box\n  IdentityFile ~/.ssh/id_ed25519\n");
        let err = connect_with(&hosts, "box", "/tmp", |_h, _c| {
            Err("ssh: connect to host 10.255.255.1 port 22: Connection timed out".into())
        })
        .unwrap_err();
        assert!(err.contains("unreachable"), "{err}");
        assert!(err.contains("box"), "{err}");
    }

    #[test]
    fn permission_denied_maps_to_password_error() {
        let msg = map_ssh_failure("dev", "Permission denied (publickey,password).");
        assert!(msg.to_ascii_lowercase().contains("password"), "{msg}");
        assert!(!msg.to_ascii_lowercase().contains("unreachable"));
    }

    #[test]
    fn one_workspace_at_a_time() {
        let _guard = TEST_LOCK.lock().unwrap();
        let hosts =
            parse_ssh_config("Host a\n  IdentityFile ~/.ssh/a\nHost b\n  IdentityFile ~/.ssh/b\n");
        disconnect_now();
        let s1 = connect_with(&hosts, "a", "/one", |_, _| Ok("/one\n".into())).unwrap();
        assert_eq!(s1.host, "a");
        let s2 = connect_with(&hosts, "b", "/two", |_, _| Ok("/two\n".into())).unwrap();
        assert_eq!(s2.host, "b");
        assert_eq!(s2.path, "/two");
        let cur = current_session().unwrap();
        assert_eq!(cur, s2);
        assert_ne!(cur.host, "a");
        disconnect_now();
        assert!(current_session().is_none());
    }

    #[test]
    fn map_ssh_failure_connection_refused() {
        let msg = map_ssh_failure(
            "dev",
            "ssh: connect to host 1.2.3.4 port 22: Connection refused",
        );
        assert!(msg.contains("unreachable"), "{msg}");
    }

    #[test]
    fn marked_output_survives_login_banners() {
        // A .bashrc banner (e.g. a corporate session wrapper) prints to stdout
        // before the payload; extraction must drop it and keep the payload exact.
        let wrapped = ssh::wrap_marked("cat -- '/proj/a.md'");
        assert!(wrapped.contains("cat -- '/proj/a.md'"));
        let with_banner =
            b"***session forwarding enabled***\n__SPARKDOWN_OUT_BEGIN__\nline1\nline2\n\n__SPARKDOWN_OUT_END__\n";
        assert_eq!(ssh::extract_marked(with_banner).unwrap(), b"line1\nline2\n");
        // Payload without a trailing newline stays byte-exact.
        let no_trailing = b"__SPARKDOWN_OUT_BEGIN__\nabc\n__SPARKDOWN_OUT_END__\n";
        assert_eq!(ssh::extract_marked(no_trailing).unwrap(), b"abc");
        // No markers (connection failed before the shell ran) → None.
        assert!(ssh::extract_marked(b"Permission denied").is_none());
    }

    #[test]
    fn marked_output_keeps_invalid_utf8_and_marker_like_payload_bytes() {
        // Latin-1 bytes (0xE9, 0xFF) are not UTF-8: they must pass through
        // unchanged, never as U+FFFD.
        let mut raw = b"banner \xff\n__SPARKDOWN_OUT_BEGIN__\n".to_vec();
        let payload: &[u8] =
            b"caf\xe9 \xff\n__SPARKDOWN_OUT_BEGIN__\nfake\n__SPARKDOWN_OUT_END__\ntail";
        raw.extend_from_slice(payload);
        raw.extend_from_slice(b"\n__SPARKDOWN_OUT_END__\n");
        // First BEGIN, last END: the marker-like lines stay in the payload.
        assert_eq!(ssh::extract_marked(&raw).unwrap(), payload);
        // Only a BEGIN marker (shell died mid-output) → None.
        assert!(ssh::extract_marked(b"__SPARKDOWN_OUT_BEGIN__\nabc").is_none());
    }

    #[test]
    fn read_payload_rejects_invalid_utf8_like_local_read() {
        let err = parse_read_payload(b"__SD_OK__\ncaf\xe9\n", "/p").unwrap_err();
        match err {
            AppError::Io(e) => assert_eq!(e.kind(), std::io::ErrorKind::InvalidData),
            other => panic!("expected InvalidData, got {other:?}"),
        }
        // Same error kind as the local fs::read_to_string path.
        let local = std::env::temp_dir().join(format!("sd-bad-utf8-{}", std::process::id()));
        std::fs::write(&local, b"caf\xe9\n").unwrap();
        let local_err = std::fs::read_to_string(&local).unwrap_err();
        let _ = std::fs::remove_file(&local);
        assert_eq!(local_err.kind(), std::io::ErrorKind::InvalidData);
        // Valid multibyte UTF-8 is fine.
        assert_eq!(
            parse_read_payload("__SD_OK__\ncafé\n".as_bytes(), "/p").unwrap(),
            "café\n"
        );
    }

    #[test]
    fn remote_write_script_is_atomic_and_posix() {
        let s = remote_write_script("/home/u/it's.md", "/home/u", 1234);
        assert!(s.starts_with("(\n") && s.ends_with("\n)"), "{s}");
        assert!(s.contains("f='/home/u/it'\\''s.md'\n"), "{s}");
        assert!(s.contains("N=1234\n"), "{s}");
        assert!(s.contains("mkdir -p -- '/home/u' || exit 1"), "{s}");
        assert!(s.contains(".sparkdown-tmp-$$"), "{s}");
        assert!(s.contains("(umask 0; cp -- \"$f\" \"$t\")"), "{s}");
        // The size check sits between the receive and the rename.
        assert!(
            s.contains("sd_sz() { wc -c < \"$1\" | tr -d ' \\t'; }"),
            "{s}"
        );
        assert!(s.contains("[ \"$(sd_sz \"$1\")\" -eq \"$N\" ]"), "{s}");
        assert!(
            s.contains("cat > \"$t\" && sd_full \"$t\" && mv -f -- \"$t\" \"$f\""),
            "{s}"
        );
        assert!(s.contains("rm -f -- \"$t\"; exit 1"), "{s}");
        // Fallback: staged + checked before the in-place copy; never a bare
        // `cat > "$f"` straight from stdin.
        assert!(s.contains("${TMPDIR:-/tmp}/.sparkdown-stage-$$"), "{s}");
        assert!(s.contains("cat > \"$s\" && sd_full \"$s\"; }"), "{s}");
        assert!(!s.contains("cat > \"$f\""), "{s}");
        // The original is backed up (private, no-clobber) before the
        // in-place copy, and the copy is size-checked; on failure it is
        // restored from the backup.
        assert!(s.contains("${TMPDIR:-/tmp}/.sparkdown-backup-$$"), "{s}");
        assert!(s.contains("(set -C; umask 077; : > \"$b\")"), "{s}");
        assert!(s.contains("cat -- \"$f\" > \"$b\""), "{s}");
        assert!(
            s.contains(
                "cat -- \"$s\" > \"$f\" && sd_full \"$f\"; then rm -f -- \"$s\" \"$b\"; exit 0"
            ),
            "{s}"
        );
        assert!(s.contains("cat -- \"$b\" > \"$f\""), "{s}");
        let backup_at = s.find("cat -- \"$f\" > \"$b\"").unwrap();
        let copy_at = s.find("cat -- \"$s\" > \"$f\"").unwrap();
        assert!(backup_at < copy_at, "{s}");
        // No GNU-only tools.
        for gnu in ["stat ", "--reference", "realpath", "mktemp", "head -c"] {
            assert!(!s.contains(gnu), "{gnu} in {s}");
        }
    }

    /// Run the remote write script with the local `sh`: the script is told
    /// `declared` bytes are coming, but only `content` is sent before stdin
    /// closes (a short send = an SSH channel that closed early).
    #[cfg(unix)]
    fn run_write_script(
        path: &Path,
        declared: usize,
        content: &[u8],
        tmpdir: Option<&Path>,
    ) -> std::process::Output {
        run_write_script_with(path, declared, content, tmpdir, "")
    }

    /// Same as `run_write_script`, with shell code (`prelude`) run before
    /// the script: a test hook to simulate local failures (the production
    /// script has no hook).
    #[cfg(unix)]
    fn run_write_script_with(
        path: &Path,
        declared: usize,
        content: &[u8],
        tmpdir: Option<&Path>,
        prelude: &str,
    ) -> std::process::Output {
        use std::io::Write;
        let parent = path.parent().unwrap().to_str().unwrap();
        let script = remote_write_script(path.to_str().unwrap(), parent, declared);
        let mut cmd = crate::proc::command("sh");
        cmd.arg("-c")
            .arg(format!("{prelude}\n{script}"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(t) = tmpdir {
            cmd.env("TMPDIR", t);
        }
        let mut child = cmd.spawn().unwrap();
        // EPIPE is fine: a failing script may exit before it reads stdin.
        let _ = child.stdin.take().unwrap().write_all(content);
        child.wait_with_output().unwrap()
    }

    #[cfg(unix)]
    fn write_leftovers(d: &Path) -> usize {
        std::fs::read_dir(d)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                n.contains("sparkdown-tmp") || n.contains("sparkdown-stage")
            })
            .count()
    }

    #[cfg(unix)]
    fn fresh_test_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sd-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    /// The read-for-edit script tells "missing" from "present" (and from a
    /// directory), so a merge never overwrites an unreadable file.
    #[cfg(unix)]
    #[test]
    fn read_for_edit_script_distinguishes_missing_files() {
        let dir = fresh_test_dir("remote-read-edit");
        let sh = |p: &std::path::Path| {
            let out = crate::proc::command("/bin/sh")
                .arg("-c")
                .arg(read_for_edit_script(p.to_str().unwrap()))
                .output()
                .unwrap();
            assert!(out.status.success());
            out.stdout
        };
        let missing = dir.join("none.json");
        assert!(sh(&missing).starts_with(b"__SD_NF__"));
        let file = dir.join("mcp.json");
        std::fs::write(&file, "{\"a\":1}").unwrap();
        let raw = sh(&file);
        assert_eq!(parse_read_payload(&raw, "x").unwrap(), "{\"a\":1}");
        assert!(sh(&dir).starts_with(b"__SD_DIR__"));
        // A dangling symlink is not "missing": it must not be replaced.
        let link = dir.join("dangling.json");
        std::os::unix::fs::symlink(dir.join("nowhere"), &link).unwrap();
        let raw = sh(&link);
        assert!(!raw.starts_with(b"__SD_NF__"));
        assert!(parse_read_payload(&raw, "x").is_err());
    }

    /// The prepare script makes a missing dir + file owner-only and leaves
    /// existing ones (and their modes) alone.
    #[cfg(unix)]
    #[test]
    fn prepare_private_file_script_is_owner_only_and_non_destructive() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fresh_test_dir("remote-prep");
        let sub = dir.join(".cursor");
        let file = sub.join("mcp.json");
        let run = || {
            let st = crate::proc::command("/bin/sh")
                .arg("-c")
                .arg(prepare_private_file_script(
                    file.to_str().unwrap(),
                    sub.to_str().unwrap(),
                ))
                .status()
                .unwrap();
            assert!(st.success());
        };
        run();
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&sub), 0o700);
        assert_eq!(mode(&file), 0o600);
        assert_eq!(std::fs::read(&file).unwrap(), b"");
        // Existing content and a looser existing mode are kept.
        std::fs::write(&file, "keep").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        run();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep");
        assert_eq!(mode(&file), 0o644);
    }

    /// Short stdin (channel closed early) must never replace the original.
    #[cfg(unix)]
    #[test]
    fn remote_write_script_rejects_truncated_payload() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fresh_test_dir("remote-write-trunc");
        let file = dir.join("a.md");
        std::fs::write(&file, "original contents").unwrap();

        // Truncated: 5 of 100 bytes arrive.
        let out = run_write_script(&file, 100, b"trunc", None);
        assert!(!out.status.success());
        assert_eq!(std::fs::read(&file).unwrap(), b"original contents");
        assert_eq!(write_leftovers(&dir), 0);

        // Empty payload declared as non-empty: same.
        let out = run_write_script(&file, 17, b"", None);
        assert!(!out.status.success());
        assert_eq!(std::fs::read(&file).unwrap(), b"original contents");

        // More bytes than declared: also rejected.
        let out = run_write_script(&file, 2, b"abc", None);
        assert!(!out.status.success());
        assert_eq!(std::fs::read(&file).unwrap(), b"original contents");

        // A new file that arrives truncated is not created.
        let fresh = dir.join("new.md");
        let out = run_write_script(&fresh, 10, b"abc", None);
        assert!(!out.status.success());
        assert!(!fresh.exists());
        assert_eq!(write_leftovers(&dir), 0);

        // Full payload (also an empty file): replaced.
        let out = run_write_script(&file, 0, b"", None);
        assert!(out.status.success());
        assert_eq!(std::fs::read(&file).unwrap(), b"");

        // Fallback route (directory not writable, file writable): staged in
        // TMPDIR, size-checked, then copied in place. Root ignores mode
        // bits, so skip there.
        let is_root = crate::proc::command("id")
            .arg("-u")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
            .unwrap_or(false);
        if !is_root {
            let ro = dir.join("ro");
            let stage = dir.join("stage");
            std::fs::create_dir_all(&ro).unwrap();
            std::fs::create_dir_all(&stage).unwrap();
            let target = ro.join("t.md");
            std::fs::write(&target, "keep me").unwrap();
            std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o555)).unwrap();

            let out = run_write_script(&target, 50, b"short", Some(&stage));
            assert!(!out.status.success());
            assert_eq!(std::fs::read(&target).unwrap(), b"keep me");
            assert_eq!(write_leftovers(&stage), 0);
            assert_eq!(write_leftovers(&ro), 0);

            let out = run_write_script(&target, 9, b"full body", Some(&stage));
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            assert_eq!(std::fs::read(&target).unwrap(), b"full body");
            assert_eq!(write_leftovers(&stage), 0);

            // No stage dir possible: fail, original intact.
            let out = run_write_script(&target, 3, b"new", Some(&dir.join("missing")));
            assert!(!out.status.success());
            assert_eq!(std::fs::read(&target).unwrap(), b"full body");

            std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Fallback route: a local failure during the final in-place copy
    /// (simulated by a `cat` shell function that fails or writes the wrong
    /// size when it copies the stage file) restores the original from the
    /// backup, exits non-zero and leaves no stage/backup file.
    #[cfg(unix)]
    #[test]
    fn remote_write_script_fallback_restores_original_on_copy_failure() {
        use std::os::unix::fs::PermissionsExt;
        let is_root = crate::proc::command("id")
            .arg("-u")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
            .unwrap_or(false);
        if is_root {
            return; // root ignores the read-only directory
        }
        let dir = fresh_test_dir("remote-write-restore");
        let ro = dir.join("ro");
        let stage = dir.join("stage");
        std::fs::create_dir_all(&ro).unwrap();
        std::fs::create_dir_all(&stage).unwrap();
        let target = ro.join("t.md");
        std::fs::write(&target, "the original body").unwrap();
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o555)).unwrap();

        // Copy dies halfway (disk full): partial write, then an error.
        let fail_mid = r#"cat() { case "$2" in *sparkdown-stage-*) command cat -- "$2" | command head -n 1 | command cut -c1-3; return 1 ;; esac; command cat "$@"; }"#;
        let out = run_write_script_with(&target, 12, b"new contents", Some(&stage), fail_mid);
        assert!(!out.status.success());
        assert_eq!(std::fs::read(&target).unwrap(), b"the original body");
        assert_eq!(write_leftovers(&stage), 0);
        assert_eq!(write_leftovers(&ro), 0);

        // Copy "succeeds" but the result has the wrong size.
        let wrong_size = r#"cat() { case "$2" in *sparkdown-stage-*) command cat -- "$2"; printf 'x' ;; *) command cat "$@" ;; esac; }"#;
        let out = run_write_script_with(&target, 12, b"new contents", Some(&stage), wrong_size);
        assert!(!out.status.success());
        assert_eq!(std::fs::read(&target).unwrap(), b"the original body");
        assert_eq!(write_leftovers(&stage), 0);

        // Restore also fails: the backup is kept (the only intact copy) and
        // its path is reported on stderr.
        let all_fail = r#"cat() { case "$2" in *sparkdown-stage-*|*sparkdown-backup-*) printf 'x'; return 1 ;; esac; command cat "$@"; }"#;
        let out = run_write_script_with(&target, 12, b"new contents", Some(&stage), all_fail);
        assert!(!out.status.success());
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(err.contains("original kept in"), "{err}");
        let kept: Vec<_> = std::fs::read_dir(&stage)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .collect();
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert!(kept[0].to_string_lossy().contains("sparkdown-backup-"));
        assert_eq!(std::fs::read(&kept[0]).unwrap(), b"the original body");
        let mode = std::fs::metadata(&kept[0]).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::remove_file(&kept[0]).unwrap();

        // A pre-existing backup name (squatter / stale file) is not
        // clobbered: the write fails before the target is touched.
        std::fs::write(&target, "the original body").unwrap();
        // Hook: pre-create the backup file for this shell's $$.
        let squat = r#"touch "$TMPDIR/.sparkdown-backup-$$""#;
        let out = run_write_script_with(&target, 12, b"new contents", Some(&stage), squat);
        assert!(!out.status.success());
        assert_eq!(std::fs::read(&target).unwrap(), b"the original body");
        // Only the squatter's file remains; our stage file is gone.
        let left: Vec<_> = std::fs::read_dir(&stage)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left.len(), 1, "{left:?}");
        assert!(left[0].starts_with(".sparkdown-backup-"), "{left:?}");

        // Normal fallback still works and cleans up.
        let _ = std::fs::remove_file(stage.join(&left[0]));
        let out = run_write_script(&target, 12, b"new contents", Some(&stage));
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"new contents");
        assert_eq!(write_leftovers(&stage), 0);

        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn remote_write_script_replaces_file_keeps_mode_and_symlink() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fresh_test_dir("remote-write");
        let run = |path: &Path, content: &[u8]| {
            let out = run_write_script(path, content.len(), content, None);
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        let leftovers = write_leftovers;

        // Existing file: content replaced, mode kept, no temp left.
        let file = dir.join("a.md");
        std::fs::write(&file, "old contents, longer than new").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
        run(&file, b"new \xff bytes");
        assert_eq!(std::fs::read(&file).unwrap(), b"new \xff bytes");
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o640);
        assert_eq!(leftovers(&dir), 0);

        // New file in a new subdirectory.
        let fresh = dir.join("sub").join("new.md");
        run(&fresh, b"hello");
        assert_eq!(std::fs::read(&fresh).unwrap(), b"hello");

        // Symlink (relative target): the link stays, the target is updated.
        let link = dir.join("link.md");
        std::os::unix::fs::symlink("a.md", &link).unwrap();
        run(&link, b"through the link");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&file).unwrap(), b"through the link");
        assert_eq!(leftovers(&dir), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tilde_paths_expand_in_the_connect_probe() {
        // `cd '~'` fails (quoting suppresses tilde expansion) and `~` is the
        // dialog's default; the probe must expand it and resolve symlinks.
        assert_eq!(ssh::quote_cd_target("~"), "\"$HOME\"");
        assert_eq!(ssh::quote_cd_target("~/notes"), "\"$HOME\"/'notes'");
        assert_eq!(ssh::quote_cd_target("/abs/path"), "'/abs/path'");

        let _guard = TEST_LOCK.lock().unwrap();
        let hosts = parse_ssh_config("Host dev\n  IdentityFile ~/.ssh/id\n");
        disconnect_now();
        let seen = std::cell::RefCell::new(String::new());
        let s = connect_with(&hosts, "dev", "~", |_h, cmd| {
            *seen.borrow_mut() = cmd.to_string();
            Ok("/local/home/u\n".into())
        })
        .unwrap();
        assert_eq!(
            *seen.borrow(),
            "CDPATH= cd -- \"$HOME\" >/dev/null && pwd -P && printf '%s\\n' \"$HOME\""
        );
        // The session stores the physical (symlink-resolved) pwd.
        assert_eq!(s.path, "/local/home/u");
        disconnect_now();
    }

    #[test]
    fn read_payload_status_lines_parse() {
        // Single round-trip protocol: status line, then contents on OK.
        assert_eq!(
            parse_read_payload(b"__SD_OK__\nline1\nline2\n", "/p").unwrap(),
            "line1\nline2\n"
        );
        assert_eq!(parse_read_payload(b"__SD_OK__\n", "/p").unwrap(), "");
        assert!(matches!(
            parse_read_payload(b"__SD_NF__\n", "/p"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(matches!(
            parse_read_payload(b"__SD_DIR__\n", "/p"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(matches!(
            parse_read_payload(b"__SD_BIG__ 104857600\n", "/p"),
            Err(AppError::FileTooLarge { size_mb: 100, .. })
        ));
    }

    #[test]
    fn sectioned_git_status_parses_in_one_round_trip() {
        let raw = format!(
            "true\n{sep}\n/local/home/u/proj\n{sep}\ncdup=\nphys=/local/home/u/proj\n{sep}\nmain\n{sep}\n M src/a.ts\0?? notes.md\0",
            sep = GIT_SECTION_SEP
        );
        let status = parse_status_sections(&raw, "/local/home/u/proj");
        assert!(status.is_repo);
        assert_eq!(status.top_level.as_deref(), Some("/local/home/u/proj"));
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.changes.len(), 2);
        assert_eq!(status.changes[0].path, "src/a.ts");
        assert_eq!(status.changes[1].status, "untracked");

        // Not a repo: first section is empty (rev-parse printed nothing).
        let raw = format!(
            "\n{sep}\n\n{sep}\n\n{sep}\n\n{sep}\n",
            sep = GIT_SECTION_SEP
        );
        let status = parse_status_sections(&raw, "/p");
        assert!(!status.is_repo);
        assert!(status.changes.is_empty());
    }

    #[test]
    fn remote_top_level_keeps_the_root_spelling_through_symlinks() {
        // `/home/u` -> `/local/home/u`: git answers canonically, but the
        // workspace (and every tab) is `/home/u/proj/docs`.
        let payload = |cdup: &str, phys: &str| {
            format!(
                "true\n{sep}\n/local/home/u/proj\n{sep}\ncdup={cdup}\nphys={phys}\n{sep}\nmain\n{sep}\n M a.md\0",
                sep = GIT_SECTION_SEP
            )
        };
        let raw = payload("../", "/local/home/u/proj");
        let status = parse_status_sections(&raw, "/home/u/proj/docs");
        assert_eq!(status.top_level.as_deref(), Some("/home/u/proj"));
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.changes[0].path, "a.md");
        // The lexical walk reached another directory (a symlink below the top
        // level): keep git's canonical answer.
        let raw = payload("../", "/elsewhere");
        let status = parse_status_sections(&raw, "/home/u/proj/docs");
        assert_eq!(status.top_level.as_deref(), Some("/local/home/u/proj"));
        // No cdup section (old git / failure): canonical as before.
        let raw = format!(
            "true\n{sep}\n/local/home/u/proj\n{sep}\n{sep}\nmain\n{sep}\n",
            sep = GIT_SECTION_SEP
        );
        let status = parse_status_sections(&raw, "/home/u/proj");
        assert_eq!(status.top_level.as_deref(), Some("/local/home/u/proj"));
    }

    /// Run the real remote script through a local `/bin/sh` against a repo
    /// reached via a symlink: the parsed top level keeps the link spelling.
    #[cfg(unix)]
    #[test]
    fn remote_git_status_script_runs_through_a_symlink() {
        use std::fs;
        let git_ok = crate::proc::command("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !git_ok {
            return;
        }
        let base =
            std::env::temp_dir().join(format!("sparkdown_remote_symlink_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("real/docs")).unwrap();
        let base = base.canonicalize().unwrap();
        let real = base.join("real");
        let init = crate::proc::command("git")
            .current_dir(&real)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args(["init", "-q"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(init, "git init failed");
        fs::write(real.join("docs/a.md"), "x\n").unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let root = format!("{}/docs", link.to_string_lossy());
        let out = crate::proc::command("/bin/sh")
            .args(["-c", &git_status_script(&root)])
            .output()
            .unwrap();
        let _ = fs::remove_dir_all(&base);
        let raw = String::from_utf8_lossy(&out.stdout).into_owned();
        let status = parse_status_sections(&raw, &root);
        assert!(status.is_repo, "{raw}");
        let want = link.to_string_lossy().into_owned();
        assert_eq!(status.top_level.as_deref(), Some(want.as_str()), "{raw}");
        assert!(
            status.changes.iter().any(|c| c.path == "docs/a.md"),
            "{raw}"
        );
    }

    #[test]
    fn remote_git_status_script_asks_for_the_way_up() {
        let script = git_status_script("/tmp/x");
        assert_eq!(script.matches(GIT_SECTION_SEP).count(), 4, "{script}");
        assert!(script.contains("rev-parse --show-cdup"), "{script}");
        assert!(script.contains("printf 'cdup=%s\\n'"), "{script}");
        assert!(script.contains("pwd -P"), "{script}");
        // An empty `cdup=` (root IS the top level) keeps the root, minus any
        // trailing slash.
        let raw = format!(
            "true\n{sep}\n/private/tmp/x\n{sep}\ncdup=\nphys=/private/tmp/x\n{sep}\nmain\n{sep}\n",
            sep = GIT_SECTION_SEP
        );
        let status = parse_status_sections(&raw, "/tmp/x/");
        assert_eq!(status.top_level.as_deref(), Some("/tmp/x"));
    }

    #[test]
    fn probe_captures_home_and_context_dir_lives_under_it() {
        let _guard = TEST_LOCK.lock().unwrap();
        let hosts = parse_ssh_config("Host dev\n  IdentityFile ~/.ssh/id\n");
        disconnect_now();
        let s = connect_with(&hosts, "dev", "~/proj", |_h, _c| {
            Ok("/local/home/u/proj\n/local/home/u\n".into())
        })
        .unwrap();
        assert_eq!(s.path, "/local/home/u/proj");
        assert_eq!(s.home, "/local/home/u");
        let dir = context_dir_for("/local/home/u/proj").unwrap();
        assert!(dir.starts_with("/local/home/u/.cache/sparkdown/"), "{dir}");
        // The PTY command exports the same dir before cd/exec.
        let (cmd, _mode) = terminal_command(Some("/local/home/u/proj"), None, None).unwrap();
        let argv = format!("{:?}", cmd.get_argv());
        assert!(argv.contains("export SPARKDOWN_CONTEXT="), "{argv}");
        assert!(argv.contains(".cache/sparkdown/"), "{argv}");
        disconnect_now();
    }

    #[test]
    fn remote_terminal_command_runs_launch_in_login_shell() {
        let _guard = TEST_LOCK.lock().unwrap();
        let hosts = parse_ssh_config("Host dev\n  IdentityFile ~/.ssh/id\n");
        disconnect_now();
        connect_with(&hosts, "dev", "~/proj", |_h, _c| {
            Ok("/local/home/u/proj\n/local/home/u\n".into())
        })
        .unwrap();
        // No tmux session: exports the command and execs an interactive login
        // shell that evals it (no typed keystrokes).
        let (cmd, mode) = terminal_command(Some("/proj"), None, Some("claude")).unwrap();
        assert_eq!(mode, "shell");
        let argv = format!("{:?}", cmd.get_argv());
        assert!(argv.contains("export SPARKDOWN_LAUNCH="), "{argv}");
        assert!(argv.contains("-lic"), "{argv}");
        assert!(argv.contains("eval \\\"$SPARKDOWN_LAUNCH\\\""), "{argv}");
        // With a tmux session: seeds the env by running a POSIX sh that
        // exports it then execs the wrapper (no `tmux -e`, which needs >=3.2).
        let (cmd, mode) =
            terminal_command(Some("/proj"), Some("sd-x-claude"), Some("claude")).unwrap();
        assert_eq!(mode, "tmux");
        let argv = format!("{:?}", cmd.get_argv());
        assert!(!argv.contains("-e SPARKDOWN_LAUNCH="), "{argv}");
        assert!(argv.contains("export SPARKDOWN_LAUNCH="), "{argv}");
        assert!(argv.contains("tmux new-session -A -s"), "{argv}");
        assert!(argv.contains("detach-on-destroy on"), "{argv}");
        // The per-workspace context dir is exported INSIDE the pane command
        // (a session created on an already-running tmux server would not
        // inherit the outer export), and set-option targets the exact name.
        let pane_cmd = argv.split("new-session").nth(1).unwrap_or_default();
        assert!(pane_cmd.contains("export SPARKDOWN_CONTEXT="), "{argv}");
        assert!(argv.contains("set-option -t ='sd-x-claude':"), "{argv}");
        // Without an agent launch the pane still gets the env.
        let (cmd, _) = terminal_command(Some("/proj"), Some("sd-x-zsh"), None).unwrap();
        let argv = format!("{:?}", cmd.get_argv());
        let pane_cmd = argv.split("new-session").nth(1).unwrap_or_default();
        assert!(pane_cmd.contains("export SPARKDOWN_CONTEXT="), "{argv}");
        disconnect_now();
    }

    #[test]
    fn remote_tmux_sessions_hide_the_status_line_session_scoped() {
        let _guard = TEST_LOCK.lock().unwrap();
        let hosts = parse_ssh_config("Host dev\n  IdentityFile ~/.ssh/id\n");
        disconnect_now();
        connect_with(&hosts, "dev", "~/proj", |_h, _c| {
            Ok("/local/home/u/proj\n/local/home/u\n".into())
        })
        .unwrap();
        for launch in [Some("claude"), None] {
            let (cmd, mode) = terminal_command(Some("/proj"), Some("sdtest-x-1"), launch).unwrap();
            assert_eq!(mode, "tmux");
            let argv = format!("{:?}", cmd.get_argv());
            assert!(
                argv.contains("\\\\; set-option -t ='sdtest-x-1': status off ||"),
                "{argv}"
            );
            // Never global: the user's own tmux sessions keep their bar.
            assert!(!argv.contains("set-option -g"), "{argv}");
            assert!(!argv.contains("status off -g"), "{argv}");
        }
        disconnect_now();
    }

    #[test]
    fn context_write_script_is_one_safe_heredoc_batch() {
        let files = vec![
            ("context.json".to_string(), "{\"a\":1}\n".to_string()),
            (
                "buffers/notes.md".to_string(),
                // Contains the default delimiter → a different one must be chosen.
                "line1\n__SPARKDOWN_EOF_0__\nit's quoted\n".to_string(),
            ),
        ];
        let s = context_write_script("/home/u/.cache/sparkdown/k", &files);
        assert!(s.starts_with("umask 077; mkdir -p '/home/u/.cache/sparkdown/k'/buffers"));
        assert!(s.contains("rm -f '/home/u/.cache/sparkdown/k'/buffers/*"));
        assert!(s.contains("<<'__SPARKDOWN_EOF_1__'"), "{s}");
        assert!(!s.contains("<<'__SPARKDOWN_EOF_0__'"));
        // Payload bytes are literal (quoted heredoc), single quote intact.
        assert!(s.contains("it's quoted\n__SPARKDOWN_EOF_1__\n"));
        // Exactly one trailing newline per file body.
        assert!(s.contains("{\"a\":1}\n__SPARKDOWN_EOF_1__\n"));
        assert!(!s.contains("{\"a\":1}\n\n__SPARKDOWN_EOF_1__"));
    }

    #[test]
    fn host_alias_with_leading_dash_is_rejected() {
        // An alias parsed as an ssh(1) flag (e.g. -G) must never reach argv.
        assert!(validate_host_alias("-G").is_err());
        assert!(validate_host_alias("-oProxyCommand").is_err());
        assert!(validate_host_alias("myhost").is_ok());
        assert!(validate_host_alias("user@host-1.example").is_ok());
    }
    #[test]
    fn remote_mcp_paths_live_under_the_per_user_cache_dir() {
        let session = RemoteSession {
            host: "dev".into(),
            path: "/local/home/u/proj".into(),
            home: "/local/home/u/".into(),
        };
        // Paths are now keyed by a per-client id under the cache dir so two
        // SparkDown clients on one remote user don't collide.
        let sock = remote_mcp_socket_path(&session);
        let shim = remote_mcp_shim_path(&session);
        assert!(
            sock.starts_with("/local/home/u/.cache/sparkdown/"),
            "{sock}"
        );
        assert!(sock.ends_with("/mcp.sock"), "{sock}");
        assert!(shim.ends_with("/mcp-shim"), "{shim}");
        // Both live in the same per-client dir.
        let sock_dir = sock.strip_suffix("/mcp.sock").unwrap();
        let shim_dir = shim.strip_suffix("/mcp-shim").unwrap();
        assert_eq!(sock_dir, shim_dir);
        // The client-id segment is a single non-empty path component.
        let id = sock_dir
            .strip_prefix("/local/home/u/.cache/sparkdown/")
            .unwrap();
        assert!(!id.is_empty() && !id.contains('/'), "id={id}");
    }

    #[test]
    fn forward_args_request_a_reverse_unix_socket_forward_on_the_mux() {
        let a = forward_args("dev", "/r/mcp.sock", "/l/mcp.sock", false);
        assert_eq!(a, ["-O", "forward", "-R", "/r/mcp.sock:/l/mcp.sock", "dev"]);
        let c = forward_args("dev", "/r/mcp.sock", "/l/mcp.sock", true);
        assert_eq!(c[1], "cancel");
    }

    #[test]
    fn remote_shim_script_is_posix_sh_and_gated_on_the_env_var() {
        let s = REMOTE_SHIM_SCRIPT;
        assert!(s.starts_with("#!/bin/sh\n"));
        assert!(s.contains("SPARKDOWN_MCP"), "gate on the env var");
        assert!(s.contains("UNIX-CONNECT"), "socat bridge");
        assert!(s.contains("AF_UNIX"), "python bridge");
        assert!(
            s.contains("\"tools\": []"),
            "offline mode advertises zero tools"
        );
        assert!(
            s.contains("2025-06-18"),
            "same protocol version as the local shim"
        );
        // Every heredoc that holds Python is quoted so the shell leaves it alone.
        assert_eq!(s.matches("<<'PY'").count(), s.matches("\nPY\n").count());
    }

    #[test]
    fn remote_terminal_exports_the_mcp_socket_only_while_the_forward_is_live() {
        let _guard = TEST_LOCK.lock().unwrap();
        let hosts = parse_ssh_config("Host dev\n  IdentityFile ~/.ssh/id\n");
        disconnect_now();
        connect_with(&hosts, "dev", "~/proj", |_h, _c| {
            Ok("/local/home/u/proj\n/local/home/u\n".into())
        })
        .unwrap();
        let (cmd, _) = terminal_command(Some("/proj"), None, None).unwrap();
        let argv = format!("{:?}", cmd.get_argv());
        assert!(!argv.contains("SPARKDOWN_MCP"), "{argv}");

        *remote_mcp_lock().lock().unwrap() = Some("/local/home/u/.cache/sparkdown/mcp.sock".into());
        let (cmd, _) = terminal_command(Some("/proj"), None, Some("claude")).unwrap();
        let argv = format!("{:?}", cmd.get_argv());
        assert!(
            argv.contains("export SPARKDOWN_MCP='/local/home/u/.cache/sparkdown/mcp.sock'"),
            "{argv}"
        );
        assert!(argv.contains("export SPARKDOWN_CONTEXT="), "{argv}");
        *remote_mcp_lock().lock().unwrap() = None;
        disconnect_now();
    }
    /// Live end-to-end check of phase 4 against a real host. Ignored by
    /// default; run with:
    ///   SPARKDOWN_LIVE_HOST=myhost cargo test --release -- --ignored live_remote
    /// A stand-in MCP server listens on a local Unix socket; the test connects,
    /// installs the shim and the reverse forward exactly as the app does, then
    /// runs the shim ON THE HOST and checks the reply came from the local server.
    #[cfg(unix)]
    #[test]
    #[ignore]
    fn live_remote_mcp_forward_roundtrip() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixListener;
        let Ok(host) = std::env::var("SPARKDOWN_LIVE_HOST") else {
            eprintln!("SPARKDOWN_LIVE_HOST not set; skipping");
            return;
        };
        let _guard = TEST_LOCK.lock().unwrap();

        // Stand-in for the app's MCP server: answers tools/list with a marker.
        let local = std::env::temp_dir().join(format!("sd-live-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&local);
        let listener = UnixListener::bind(&local).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut w = stream.try_clone().unwrap();
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { break };
                let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let Some(id) = msg.get("id") else { continue };
                let result = if msg["method"] == "tools/list" {
                    serde_json::json!({ "tools": [{ "name": "sparkdown_live_marker" }] })
                } else {
                    serde_json::json!({ "serverInfo": { "name": "sparkdown-live-test" } })
                };
                let reply = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result });
                let _ = writeln!(w, "{reply}");
            }
        });

        let hosts = load_ssh_hosts().unwrap();
        disconnect_now();
        let session = connect_with(&hosts, &host, "~", ssh_run).expect("connect");
        let sock = mcp_forward_start(&session, &local).expect("forward");
        assert!(sock.ends_with("/.cache/sparkdown/mcp.sock"), "{sock}");
        assert_eq!(remote_mcp_socket().as_deref(), Some(sock.as_str()));

        // The exact command an agent config would run, in a SparkDown shell.
        let shim = remote_mcp_shim_path(&session);
        let reqs = concat!(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            "\n",
        );
        let cmd = format!(
            "test -S {s} && test -x {sh} && SPARKDOWN_MCP={s} {sh}",
            s = shell_quote(&sock),
            sh = shell_quote(&shim)
        );
        let out = ssh_run_stdin(&session.host, &cmd, Some(reqs.as_bytes())).expect("shim run");
        assert!(
            out.contains("sparkdown-live-test"),
            "initialize reply missing: {out}"
        );
        assert!(
            out.contains("sparkdown_live_marker"),
            "tools/list reply missing: {out}"
        );

        // Outside a SparkDown shell the same shim must be silent (zero tools).
        let off = ssh_run_stdin(
            &session.host,
            &format!("env -u SPARKDOWN_MCP {}", shell_quote(&shim)),
            Some(reqs.as_bytes()),
        )
        .expect("offline shim run");
        assert!(
            off.contains("\"tools\": []"),
            "offline must advertise no tools: {off}"
        );
        assert!(!off.contains("sparkdown_live_marker"), "{off}");

        // Teardown removes the forward and the files.
        mcp_forward_stop(&session);
        assert!(remote_mcp_socket().is_none());
        let left = ssh_run(
            &session.host,
            &format!(
                "ls {} {} 2>&1 || true",
                shell_quote(&sock),
                shell_quote(&shim)
            ),
        )
        .unwrap();
        assert!(
            left.contains("No such file"),
            "files should be gone: {left}"
        );
        disconnect_now();
        let _ = std::fs::remove_file(&local);
        let _ = server.join();
    }
}

/// Largest remote image the preview fetches over SSH (10 MB).
pub const MAX_REMOTE_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// Shell script behind [`read_image`]: one round trip that resolves symlinks
/// (`readlink -f`, falling back to the path itself), refuses a resolved path
/// without an image extension, a non-regular file or an oversize file, and
/// only then prints `__SD_OK__` and the raw bytes.
pub(crate) fn remote_image_script(path: &str) -> String {
    let exts = crate::commands::PREVIEW_IMAGE_EXTS
        .iter()
        .map(|e| format!("*.{e}"))
        .collect::<Vec<_>>()
        .join("|");
    format!(
        "r=$(readlink -f -- {p} 2>/dev/null); [ -n \"$r\" ] || r={p}; \
         case \"$(printf '%s' \"$r\" | tr '[:upper:]' '[:lower:]')\" in {exts}) ;; \
         *) echo __SD_EXT__; exit 0;; esac; \
         if [ ! -f \"$r\" ]; then echo __SD_NF__; \
         else s=$(wc -c < \"$r\"); if [ \"$s\" -gt {max} ]; then echo __SD_BIG__ \"$s\"; \
         else echo __SD_OK__; cat -- \"$r\"; fi; fi",
        p = shell_quote(path),
        max = MAX_REMOTE_IMAGE_BYTES
    )
}

/// Split a [`read_image`] payload into its status line and the image bytes.
pub(crate) fn parse_image_payload(raw: &[u8], path: &str) -> Result<Vec<u8>, AppError> {
    let (status, rest) = match raw.iter().position(|&b| b == b'\n') {
        Some(i) => (&raw[..i], &raw[i + 1..]),
        None => (raw, &raw[raw.len()..]),
    };
    let status = String::from_utf8_lossy(status);
    let status = status.trim();
    if status == "__SD_OK__" {
        // Defence in depth: the script already checked the size, but a file
        // that grew between `wc` and `cat` must not slip past the cap.
        if rest.len() as u64 > MAX_REMOTE_IMAGE_BYTES {
            return Err(AppError::FileTooLarge {
                size_mb: rest.len() as u64 / 1024 / 1024,
                max_mb: MAX_REMOTE_IMAGE_BYTES / 1024 / 1024,
            });
        }
        return Ok(rest.to_vec());
    }
    if status == "__SD_EXT__" {
        return Err(AppError::InvalidPath(format!("Not an image file: {path}")));
    }
    if let Some(size) = status.strip_prefix("__SD_BIG__") {
        let size: u64 = size.trim().parse().unwrap_or(0);
        return Err(AppError::FileTooLarge {
            size_mb: size / 1024 / 1024,
            max_mb: MAX_REMOTE_IMAGE_BYTES / 1024 / 1024,
        });
    }
    Err(AppError::InvalidPath(format!(
        "Invalid or inaccessible path: {path}"
    )))
}

/// Read a remote preview image as exact bytes (byte-safe `ssh_run_bytes`).
/// The requested path must already carry an image extension; the resolved
/// target is checked again on the host (see [`remote_image_script`]).
pub fn read_image(path: &str) -> Result<Vec<u8>, AppError> {
    validate_remote_path(path).map_err(AppError::Other)?;
    if !crate::commands::has_image_extension(Path::new(path)) {
        return Err(AppError::InvalidPath(format!("Not an image file: {path}")));
    }
    let session = current_session().ok_or_else(|| AppError::Other("no remote session".into()))?;
    let raw =
        ssh_run_bytes(&session.host, &remote_image_script(path), None).map_err(AppError::Other)?;
    parse_image_payload(&raw, path)
}

#[cfg(test)]
mod image_tests {
    use super::*;

    #[test]
    fn parse_image_payload_keeps_exact_bytes() {
        let mut raw = b"__SD_OK__\n".to_vec();
        let bytes = [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00];
        raw.extend_from_slice(&bytes);
        assert_eq!(parse_image_payload(&raw, "/a.png").unwrap(), bytes);
    }

    #[test]
    fn parse_image_payload_maps_refusals() {
        assert!(matches!(
            parse_image_payload(b"__SD_EXT__\n", "/a.png"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(matches!(
            parse_image_payload(b"__SD_NF__\n", "/a.png"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(matches!(
            parse_image_payload(b"__SD_BIG__ 20971520\n", "/a.png"),
            Err(AppError::FileTooLarge {
                size_mb: 20,
                max_mb: 10
            })
        ));
        assert!(parse_image_payload(b"", "/a.png").is_err());
    }

    #[test]
    fn parse_image_payload_enforces_cap_on_streamed_bytes() {
        let mut raw = b"__SD_OK__\n".to_vec();
        raw.resize(raw.len() + MAX_REMOTE_IMAGE_BYTES as usize + 1, 0);
        assert!(matches!(
            parse_image_payload(&raw, "/a.png"),
            Err(AppError::FileTooLarge { .. })
        ));
    }

    #[test]
    fn remote_image_script_quotes_path_and_lists_extensions() {
        let s = remote_image_script("/home/u/it's a.png");
        assert!(s.contains(&shell_quote("/home/u/it's a.png")));
        assert!(s.contains("*.png|*.jpg|*.jpeg"));
        assert!(s.contains(&MAX_REMOTE_IMAGE_BYTES.to_string()));
        assert!(s.contains("cat -- \"$r\""));
    }

    #[test]
    fn read_image_rejects_non_image_path_before_ssh() {
        let err = read_image("/home/u/.ssh/id_rsa").unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn remote_image_script_runs_under_sh() {
        let dir = std::env::temp_dir().join("sparkdown_test_remote_image_script");
        std::fs::create_dir_all(&dir).unwrap();
        let img = dir.join("pic.PNG");
        std::fs::write(&img, [0u8, 1, 2, 255]).unwrap();
        let secret = dir.join("secret");
        std::fs::write(&secret, "key").unwrap();
        let link = dir.join("link.png");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let run = |p: &std::path::Path| {
            crate::proc::command("sh")
                .arg("-c")
                .arg(remote_image_script(p.to_str().unwrap()))
                .output()
                .unwrap()
                .stdout
        };
        assert_eq!(
            parse_image_payload(&run(&img), "x").unwrap(),
            vec![0u8, 1, 2, 255]
        );
        assert!(matches!(
            parse_image_payload(&run(&link), "x"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(parse_image_payload(&run(&dir.join("none.png")), "x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// POSIX sh behind [`remote_create_dir`]: `mkdir -p` (an existing folder is
/// fine), quoted, with `--` so a name is never read as an option.
pub(crate) fn remote_mkdir_script(path: &str) -> String {
    format!("mkdir -p -- {}", shell_quote(path))
}

/// Create a folder (and any missing parents) on the remote host, for the
/// in-app picker's "New Folder" and "Create folder and save". Async +
/// spawn_blocking: it is an SSH round trip, so it must not block the main
/// thread.
#[tauri::command]
pub async fn remote_create_dir(path: String) -> Result<(), String> {
    validate_remote_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = current_session().ok_or_else(|| "no remote session".to_string())?;
        ssh_run(&session.host, &remote_mkdir_script(&path)).map(|_| ())
    })
    .await
    .map_err(|e| format!("create folder task failed: {e}"))?
}

#[cfg(test)]
mod mkdir_tests {
    use super::*;

    #[test]
    fn remote_mkdir_script_quotes_and_ends_options() {
        assert_eq!(
            remote_mkdir_script("/home/u/new dir"),
            "mkdir -p -- '/home/u/new dir'"
        );
        assert_eq!(
            remote_mkdir_script("/home/u/it's; rm -rf ~"),
            "mkdir -p -- '/home/u/it'\\''s; rm -rf ~'"
        );
    }

    #[test]
    fn remote_create_dir_rejects_relative_and_control_paths() {
        let run = |p: &str| tauri::async_runtime::block_on(remote_create_dir(p.to_string()));
        assert!(run("rel/dir").unwrap_err().contains("absolute"));
        assert!(run("/bad\npath").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn remote_mkdir_script_runs_under_sh() {
        let dir = std::env::temp_dir().join("sparkdown_test_remote_mkdir_script");
        let _ = std::fs::remove_dir_all(&dir);
        let target = dir.join("a b").join("-c");
        for _ in 0..2 {
            // The second run hits an existing folder: still a success.
            let status = crate::proc::command("sh")
                .arg("-c")
                .arg(remote_mkdir_script(target.to_str().unwrap()))
                .status()
                .unwrap();
            assert!(status.success());
            assert!(target.is_dir());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod workspace_files_tests {
    use super::*;

    #[test]
    fn script_prunes_ignored_and_hidden_names_and_caps_output() {
        let s = workspace_files_script("/home/u/it's", false, 10);
        assert!(s.starts_with("find -H '/home/u/it'\\''s' ! -path '/home/u/it'\\''s' \\( "));
        for name in crate::watcher::IGNORED_DIR_NAMES {
            assert!(s.contains(&format!("-name '{name}'")), "{name} not pruned");
        }
        assert!(s.contains("-name '.*' \\) -prune -o -type f -print"));
        assert!(s.ends_with("| head -n 11"));
        assert!(!workspace_files_script("/r", true, 10).contains("-name '.*'"));
    }

    #[test]
    fn parse_strips_the_root_and_flags_truncation() {
        let raw = "/r/b.md\n/r/a/c.md\n/other/x\n/r/d.md\n";
        let l = parse_workspace_files(raw, "/r", 5);
        assert_eq!(l.files, vec!["a/c.md", "b.md", "d.md"]);
        assert!(!l.truncated);
        let l = parse_workspace_files(raw, "/r/", 2);
        assert_eq!(l.files, vec!["a/c.md", "b.md"]);
        assert!(l.truncated);
    }

    #[test]
    fn list_without_a_session_errors() {
        assert!(list_workspace_files("/r", false, 10).is_err());
    }

    /// The exact script the SSH host runs, run by the local `sh` + `find`.
    #[cfg(unix)]
    #[test]
    fn script_runs_under_sh() {
        let root = std::env::temp_dir().join(format!("sd_ws_files_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for rel in [
            "a.md",
            "docs/b.md",
            "node_modules/p/i.js",
            "x/target/t",
            ".git/HEAD",
            ".env",
        ] {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "x").unwrap();
        }
        let r = root.to_str().unwrap();
        let run = |hidden: bool, cap: usize| {
            let out = crate::proc::command("sh")
                .arg("-c")
                .arg(workspace_files_script(r, hidden, cap))
                .output()
                .unwrap();
            parse_workspace_files(&String::from_utf8_lossy(&out.stdout), r, cap)
        };
        assert_eq!(run(false, 100).files, vec!["a.md", "docs/b.md"]);
        assert_eq!(run(true, 100).files, vec![".env", "a.md", "docs/b.md"]);
        let capped = run(false, 1);
        assert_eq!(capped.files.len(), 1);
        assert!(capped.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// Line counts + fingerprints for the review queue in one ssh round trip
/// (see `review::remote_stats_script`). `changes` are already validated as
/// repo-relative by the caller; each is still checked for control chars.
pub fn git_change_stats(
    root: &str,
    changes: &[crate::review::ChangeRef],
) -> Result<Vec<crate::review::ChangeStat>, String> {
    use crate::review::{parse_remote_stats, remote_plan, remote_stats_from, remote_stats_script};
    let session = current_session().ok_or_else(|| "no remote session".to_string())?;
    validate_remote_path(root)?;
    let changes: Vec<crate::review::ChangeRef> = changes
        .iter()
        .filter(|c| validate_remote_input(&c.path).is_ok())
        .cloned()
        .collect();
    if changes.is_empty() {
        return Ok(Vec::new());
    }
    let (tracked, hashed, untracked) = remote_plan(&changes);
    let script = remote_stats_script(root, tracked, &hashed, &untracked, shell_quote);
    let raw = ssh_run(&session.host, &script)?;
    let parsed = parse_remote_stats(&raw, hashed.len(), untracked.len());
    Ok(remote_stats_from(&changes, &hashed, &parsed))
}
