//! SSH config parse + BatchMode `ssh` helpers for remote sessions v1 (#36).

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// One workspace on one SSH config host. v1 allows only this, globally.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteSession {
    pub host: String,
    pub path: String,
    /// The remote user's `$HOME` (physical path), captured by the connect
    /// probe. The agent context bridge lives under `<home>/.cache/sparkdown`
    /// on the remote — per-user by construction, unlike a shared /tmp.
    #[serde(default)]
    pub home: String,
}

/// A concrete `Host` alias from `~/.ssh/config` (wildcards omitted).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshHost {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    /// True when the config cannot authenticate with a key (password /
    /// keyboard-interactive only, or PubkeyAuthentication no with no
    /// IdentityFile). v1 refuses these with a clear error — no password UI.
    pub password_only: bool,
}

#[derive(Default, Clone)]
struct HostBuilder {
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
    pubkey_authentication: Option<bool>,
    preferred_authentications: Option<String>,
}

impl HostBuilder {
    fn finish(&self, alias: String) -> SshHost {
        let password_only = is_password_only(
            self.pubkey_authentication,
            self.preferred_authentications.as_deref(),
        );
        SshHost {
            alias,
            hostname: self.hostname.clone(),
            user: self.user.clone(),
            port: self.port,
            identity_file: self.identity_file.clone(),
            password_only,
        }
    }
}

/// Password-only when the host cannot use an existing key.
fn is_password_only(
    pubkey_authentication: Option<bool>,
    preferred_authentications: Option<&str>,
) -> bool {
    if pubkey_authentication == Some(false) {
        return true;
    }
    if let Some(pref) = preferred_authentications {
        let methods: Vec<String> = pref
            .split(',')
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        if !methods.is_empty() {
            let key_ok = methods.iter().any(|m| m == "publickey");
            if !key_ok {
                return true;
            }
        }
    }
    false
}

fn is_wildcard_alias(alias: &str) -> bool {
    alias.contains('*') || alias.contains('?') || alias.contains('!')
}

fn strip_comment(line: &str) -> &str {
    match line.find('#') {
        Some(i) => &line[..i],
        None => line,
    }
}

fn split_kv(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let (key, rest) = if let Some(idx) = line.find('=') {
        let (k, v) = line.split_at(idx);
        (k, v[1..].trim())
    } else {
        let mut parts = line.splitn(2, char::is_whitespace);
        (parts.next()?, parts.next().unwrap_or("").trim())
    };
    let key = key.trim();
    let value = unquote(rest);
    if key.is_empty() {
        None
    } else {
        Some((key, value))
    }
}

fn unquote(value: &str) -> &str {
    let v = value.trim();
    if v.len() >= 2 {
        let b = v.as_bytes();
        let first = b[0];
        let last = b[v.len() - 1];
        // ASCII 39 is the single-quote byte.
        if (first == b'"' && last == b'"') || (first == 39 && last == 39) {
            return &v[1..v.len() - 1];
        }
    }
    v
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "yes" | "true" | "on" => Some(true),
        "no" | "false" | "off" => Some(false),
        _ => None,
    }
}

/// Parse OpenSSH `~/.ssh/config` text into concrete (non-wildcard) Host aliases.
pub fn parse_ssh_config(text: &str) -> Vec<SshHost> {
    let mut hosts = Vec::new();
    let mut aliases: Vec<String> = Vec::new();
    let mut builder = HostBuilder::default();
    let mut in_match = false;

    let flush = |aliases: &mut Vec<String>, builder: &mut HostBuilder, hosts: &mut Vec<SshHost>| {
        if !aliases.is_empty() {
            for alias in aliases.iter() {
                if !is_wildcard_alias(alias) {
                    hosts.push(builder.finish(alias.clone()));
                }
            }
        }
        aliases.clear();
        *builder = HostBuilder::default();
    };

    for raw in text.lines() {
        let line = strip_comment(raw).trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = split_kv(line) else {
            continue;
        };
        let key_l = key.to_ascii_lowercase();
        match key_l.as_str() {
            "host" => {
                flush(&mut aliases, &mut builder, &mut hosts);
                in_match = false;
                aliases = value
                    .split_whitespace()
                    .map(std::string::ToString::to_string)
                    .collect();
            }
            "match" => {
                flush(&mut aliases, &mut builder, &mut hosts);
                in_match = true;
            }
            _ if in_match || aliases.is_empty() => {}
            "hostname" => builder.hostname = Some(value.to_string()),
            "user" => builder.user = Some(value.to_string()),
            "port" => builder.port = value.parse().ok(),
            "identityfile" => {
                if builder.identity_file.is_none() {
                    builder.identity_file = Some(value.to_string());
                }
            }
            "pubkeyauthentication" => builder.pubkey_authentication = parse_bool(value),
            "preferredauthentications" => {
                builder.preferred_authentications = Some(value.to_string());
            }
            _ => {}
        }
    }
    flush(&mut aliases, &mut builder, &mut hosts);
    hosts
}

/// A shell expression for `cd` that honors a leading tilde. shell_quote()
/// alone would produce `cd '~'`, and quoting suppresses tilde expansion —
/// the number-one path users type into the remote dialog is `~`.
pub fn quote_cd_target(path: &str) -> String {
    if path == "~" {
        return "\"$HOME\"".to_string();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return format!("\"$HOME\"/{}", shell_quote(rest));
    }
    shell_quote(path)
}

/// Single-quote a string for a POSIX remote shell.
pub fn shell_quote(s: &str) -> String {
    let mut out = String::from("'");
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// argv[0..] for an SSH call: BatchMode so we never prompt for a password.
#[cfg(test)]
pub(crate) fn ssh_argv(host: &str) -> Vec<String> {
    vec![
        "ssh".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=8".into(),
        // Keepalive on the channel: ConnectTimeout only covers opening the TCP
        // connection, not a channel on an already-open control (mux)
        // connection. Without these a Wi-Fi drop leaves a half-open mux and
        // the next call hangs until the OS TCP timeout (minutes).
        "-o".into(),
        "ServerAliveInterval=5".into(),
        "-o".into(),
        "ServerAliveCountMax=2".into(),
        "-o".into(),
        "PreferredAuthentications=publickey".into(),
        "-o".into(),
        "PubkeyAuthentication=yes".into(),
        host.into(),
    ]
}

pub(crate) fn validate_host_alias(host: &str) -> Result<(), String> {
    if host.is_empty()
        || host.len() > 128
        // A leading '-' would let the alias be parsed as an ssh(1) flag
        // instead of a destination (e.g. `-G`), so reject it outright.
        || host.starts_with('-')
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || c == '@')
    {
        return Err("Invalid SSH host alias.".into());
    }
    Ok(())
}

/// Reject empty / control-char paths. Used for the raw connect-dialog input,
/// which may legitimately still be `~` or `~/sub` before the probe resolves
/// it to a physical path — so it does NOT require a leading `/`.
pub(crate) fn validate_remote_input(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\u{0}') || path.contains('\n') || path.contains('\r') {
        return Err("Invalid remote path.".into());
    }
    Ok(())
}

/// An absolute, control-char-free remote path. Every routed op
/// (read/write/list/git-root/watch/context) must pass this: a relative or
/// option-like root (e.g. `-delete`) handed to `find` or `git -C` would act
/// on the wrong tree — and a leading `/` also makes `find <root>` unparseable
/// as an option, guarding the fingerprint/list roots.
pub(crate) fn validate_remote_path(path: &str) -> Result<(), String> {
    validate_remote_input(path)?;
    if !path.starts_with('/') {
        return Err("Remote path must be absolute (start with '/').".into());
    }
    Ok(())
}

/// Map ssh(1) failure text into the v1 user-facing errors.
pub fn map_ssh_failure(host: &str, stderr: &str) -> String {
    let s = stderr.to_ascii_lowercase();
    if s.contains("permission denied")
        || s.contains("password")
        || s.contains("keyboard-interactive")
        || s.contains("too many authentication")
        || s.contains("no password")
        || s.contains("cannot authenticate")
    {
        return format!(
            "Host '{host}' requires a password or rejected the SSH key. SparkDown v1 uses existing keys only and will not prompt for a password. Add an IdentityFile (or load a key in ssh-agent) in ~/.ssh/config."
        );
    }
    if s.contains("timed out")
        || s.contains("timeout")
        || s.contains("could not resolve")
        || s.contains("name or service not known")
        || s.contains("no route to host")
        || s.contains("network is unreachable")
        || s.contains("connection refused")
        || s.contains("connection reset")
        || s.contains("connection closed")
        || s.contains("host is down")
    {
        let detail = stderr.trim();
        if detail.is_empty() {
            return format!("Host '{host}' is unreachable.");
        }
        return format!("Host '{host}' is unreachable. {detail}");
    }
    let detail = stderr.trim();
    if detail.is_empty() {
        format!("SSH to '{host}' failed.")
    } else {
        format!("SSH to '{host}' failed: {detail}")
    }
}

/// Connection-multiplexing options: the first ssh call opens a control (mux)
/// connection that later commands (and the PTY) reuse as cheap channels.
/// Measured against a real WAN host: ~1.7s per fresh connection vs ~0.25s
/// over the mux — and every editor action is at least one ssh call.
/// The socket dir is 0700 under ~/.ssh; %C hashes host+port+user so the
/// path stays short (unix sockets cap at ~104 bytes). Unix-only: Windows
/// OpenSSH does not implement multiplexing (falls back to fresh sessions).
///
/// The `ControlMaster=auto` option name is OpenSSH's — an external protocol
/// identifier we don't get to rename. It is the only occurrence of the term
/// left in this file (see also `-O exit` in [`close_mux`]).
#[cfg(unix)]
pub(crate) fn mux_options() -> Vec<String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = home_dir().join(".ssh").join("sparkdown");
    if std::fs::create_dir_all(&dir).is_err() {
        return vec![];
    }
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    vec![
        "-o".into(),
        // OpenSSH option name — cannot be renamed here.
        "ControlMaster=auto".into(),
        "-o".into(),
        format!("ControlPath={}/%C", dir.display()),
        "-o".into(),
        "ControlPersist=600".into(),
    ]
}

#[cfg(not(unix))]
pub(crate) fn mux_options() -> Vec<String> {
    vec![]
}

/// Best-effort shutdown of the SSH control (mux) connection for `host`
/// (explicit disconnect); without this the mux would linger for
/// ControlPersist. Sends the OpenSSH `-O exit` command — the literal option
/// string is external OpenSSH surface and cannot be renamed.
pub(crate) fn close_mux(host: &str) {
    if validate_host_alias(host).is_err() {
        return;
    }
    let opts = mux_options();
    if opts.is_empty() {
        return;
    }
    let _ = Command::new("ssh")
        .args(&opts)
        .args(["-O", "exit", host])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn ssh_config_path() -> PathBuf {
    if let Ok(p) = std::env::var("SPARKDOWN_SSH_CONFIG") {
        return PathBuf::from(p);
    }
    home_dir().join(".ssh").join("config")
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub(crate) fn load_ssh_hosts() -> Result<Vec<SshHost>, String> {
    let path = ssh_config_path();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("Cannot read {}: {e}", path.display())),
    };
    Ok(parse_ssh_config(&text))
}

struct SshResult {
    status: i32,
    /// Raw payload bytes (between the markers when present). Never decoded
    /// here: file reads must see the exact bytes, so decoding is the caller's
    /// choice (lossy for listings/status, strict for file contents).
    stdout: Vec<u8>,
    stderr: String,
}

impl SshResult {
    fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    fn failure_text(&self) -> String {
        if self.stderr.trim().is_empty() {
            self.stdout_lossy()
        } else {
            self.stderr.clone()
        }
    }
}

// Remote shells commonly print login noise to STDOUT for non-interactive
// commands (a .bashrc banner, corporate session wrappers). Unfiltered, that
// noise would be prepended to every file read and break the connect probe.
// So every remote command is bracketed by
// marker lines and only the bytes between them are the payload.
const OUT_BEGIN: &str = "__SPARKDOWN_OUT_BEGIN__";
const OUT_END: &str = "__SPARKDOWN_OUT_END__";

/// Bracket `remote_cmd`'s stdout with marker lines, preserving its exit
/// status. The trailing marker gets a leading newline so payloads without a
/// final newline still split cleanly; extract_marked() undoes it.
pub(crate) fn wrap_marked(remote_cmd: &str) -> String {
    // The payload runs in a subshell `( … )`, not a group `{ …; }`: a bare
    // `exit` inside remote_cmd (e.g. an early-return branch) would otherwise
    // terminate the whole shell and skip the END marker, so extract_marked()
    // would return None and the call be misread as a connection failure.
    format!(
        "printf '%s\\n' {b}; ( {remote_cmd}\n); __sd_status=$?; printf '\\n%s\\n' {e}; exit $__sd_status",
        b = shell_quote(OUT_BEGIN),
        e = shell_quote(OUT_END),
    )
}

/// The payload between the marker lines, or None when the markers never made
/// it out (e.g. the connection failed before the remote shell ran anything).
/// Works on raw bytes so non-UTF-8 payloads pass through unchanged. The
/// first BEGIN line and the last END line win, so marker-like text inside
/// the payload is kept.
pub(crate) fn extract_marked(stdout: &[u8]) -> Option<&[u8]> {
    let begin = format!("{OUT_BEGIN}\n");
    let end = format!("\n{OUT_END}");
    let start = find_bytes(stdout, begin.as_bytes())? + begin.len();
    let rest = &stdout[start..];
    let stop = rfind_bytes(rest, end.as_bytes())?;
    Some(&rest[..stop])
}

fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn rfind_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).rposition(|w| w == needle)
}

/// Wall-clock backstop for a remote command. ServerAlive* usually drops a
/// dead connection in ~10s, but a remote command that hangs while the TCP
/// link stays up needs its own ceiling so a routed Tauri call cannot block
/// forever. Writes send the whole file body, so they get a longer ceiling.
const SSH_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_WRITE_TIMEOUT: Duration = Duration::from_secs(120);

/// Output of [`run_with_deadline`].
struct ChildOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    /// Error from writing stdin (e.g. EPIPE when the child exited early).
    stdin_err: Option<std::io::Error>,
}

#[derive(Debug)]
enum ExecError {
    Spawn(std::io::Error),
    Wait(std::io::Error),
    Timeout,
}

/// How long to wait for the helper threads (all together) after the child
/// is gone. Their pipe ends are normally closed by then, so they return at
/// once; if some other process still holds a pipe, detach the thread
/// instead of blocking.
const THREAD_GRACE: Duration = Duration::from_secs(2);

/// Join `h` if it finishes before `until`; else detach it (`None`).
fn join_within<T>(h: JoinHandle<T>, until: Instant) -> Option<T> {
    while !h.is_finished() {
        if Instant::now() >= until {
            // Detach: the thread ends by itself when its pipe closes.
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    h.join().ok()
}

/// Run `cmd`, feed it `stdin`, collect stdout/stderr, and kill it when
/// `timeout` passes. The deadline covers the whole call, the stdin write
/// included: on a half-open link ssh stops reading stdin once the SSH
/// channel window (about 2 MB) is full, so a blocking write on the calling
/// thread would hang forever (and with it save and quit). Stdin, stdout and
/// stderr each get their own thread; killing the child closes its pipe
/// ends, so a blocked writer gets EPIPE and the readers get EOF.
fn run_with_deadline(
    mut cmd: Command,
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<ChildOutput, ExecError> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    if stdin.is_some() {
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }
    let deadline = Instant::now() + timeout;
    let mut child = cmd.spawn().map_err(ExecError::Spawn)?;
    // Drain both pipes on their own threads: a payload larger than the pipe
    // buffer would otherwise deadlock the try_wait() poll below (the child
    // blocks writing, we block polling).
    let out_pipe = child.stdout.take();
    let err_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = out_pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = err_pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let writer = match (stdin, child.stdin.take()) {
        (Some(bytes), Some(mut h)) => {
            // Owned copy: the thread may outlive this call (join_within).
            let bytes = bytes.to_vec();
            Some(std::thread::spawn(move || {
                // `h` drops when the thread ends, closing the pipe so the
                // remote sees EOF. A write error (ssh exited early: auth
                // error, remote command died) is reported after the child
                // is reaped; its stderr says why far better than EPIPE.
                h.write_all(&bytes)
            }))
        }
        _ => None,
    };
    // Failure path: kill, reap, then give all helpers one shared grace
    // period (a grandchild that inherited a pipe keeps it open).
    fn abandon(
        mut child: std::process::Child,
        writer: Option<JoinHandle<std::io::Result<()>>>,
        readers: [JoinHandle<Vec<u8>>; 2],
    ) {
        let _ = child.kill();
        let _ = child.wait();
        let until = Instant::now() + THREAD_GRACE;
        if let Some(w) = writer {
            let _ = join_within(w, until);
        }
        for r in readers {
            let _ = join_within(r, until);
        }
    }
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    // Kill the half-open ssh so a Wi-Fi drop can't freeze the
                    // UI; the helper threads unblock once the pipes close.
                    abandon(child, writer, [out_reader, err_reader]);
                    return Err(ExecError::Timeout);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                abandon(child, writer, [out_reader, err_reader]);
                return Err(ExecError::Wait(e));
            }
        }
    };
    let until = Instant::now() + THREAD_GRACE;
    let stdin_err = writer.and_then(|w| match join_within(w, until) {
        Some(Ok(())) => None,
        Some(Err(e)) => Some(e),
        None => Some(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "stdin writer did not finish",
        )),
    });
    Ok(ChildOutput {
        status,
        // Full join: a detached reader would silently truncate file data.
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
        stdin_err,
    })
}

fn ssh_exec(host: &str, remote_cmd: &str, stdin: Option<&[u8]>) -> Result<SshResult, String> {
    validate_host_alias(host)?;
    // Single choke point: hand the script to `/bin/sh`, never the user's login
    // shell. ssh passes the command string to the remote login shell, which
    // may be fish/csh/tcsh and would choke on the POSIX `( … )`, `$?`,
    // `${VAR:-x}` constructs every remote command uses. `exec` replaces the
    // login shell so exit status still propagates.
    let sh_arg = format!("exec /bin/sh -c {}", shell_quote(&wrap_marked(remote_cmd)));
    let mut cmd = Command::new("ssh");
    cmd.args(mux_options());
    cmd.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=2",
        "-o",
        "PreferredAuthentications=publickey",
        "-o",
        "PubkeyAuthentication=yes",
        "-T",
        host,
        "--",
        &sh_arg,
    ]);
    let timeout = if stdin.is_some() {
        SSH_WRITE_TIMEOUT
    } else {
        SSH_TIMEOUT
    };
    let out = match run_with_deadline(cmd, stdin, timeout) {
        Ok(out) => out,
        Err(ExecError::Spawn(e)) => return Err(format!("failed to run ssh: {e}")),
        Err(ExecError::Wait(e)) => return Err(format!("ssh wait: {e}")),
        Err(ExecError::Timeout) => {
            return Err(format!(
                "SSH to '{host}' timed out after {}s; the connection may be half-open.",
                timeout.as_secs()
            ))
        }
    };
    let status = out.status;
    let stdout_raw = out.stdout;
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if let Some(e) = out.stdin_err {
        return Err(format!(
            "{} (ssh stdin: {e})",
            map_ssh_failure(host, &stderr)
        ));
    }
    // Markers absent means the remote shell never ran (connect/auth failure):
    // pass the raw stream through so the error mapping sees it.
    let stdout = match extract_marked(&stdout_raw) {
        Some(payload) => payload.to_vec(),
        None => stdout_raw,
    };
    Ok(SshResult {
        status: status.code().unwrap_or(255),
        stdout,
        stderr,
    })
}

pub(crate) fn ssh_run(host: &str, remote_cmd: &str) -> Result<String, String> {
    ssh_run_stdin(host, remote_cmd, None)
}

/// Text output (lossy UTF-8). Fine for listings and status lines; file
/// contents must use [`ssh_run_bytes`] so no byte is ever replaced.
pub(crate) fn ssh_run_stdin(
    host: &str,
    remote_cmd: &str,
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    ssh_run_bytes(host, remote_cmd, stdin).map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// Exact stdout bytes of a successful remote command.
pub(crate) fn ssh_run_bytes(
    host: &str,
    remote_cmd: &str,
    stdin: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let result = ssh_exec(host, remote_cmd, stdin)?;
    if result.status != 0 {
        return Err(map_ssh_failure(host, &result.failure_text()));
    }
    Ok(result.stdout)
}

/// `git -C <root> <args…>` over SSH. Diffs may exit 1 when there are changes;
/// we still return stdout in that case (same as a working `git diff`).
pub(crate) fn ssh_git(root: &str, args: &[&str]) -> Result<String, String> {
    let session = super::current_session().ok_or_else(|| "no remote session".to_string())?;
    validate_remote_path(root)?;
    let prefix = if args.contains(&"--no-index") {
        let requested = args.last().copied().unwrap_or("");
        // POSIX resolution of the repo root and the requested file's directory
        // (no GNU-only `realpath -e`): `cd … && pwd -P` canonicalizes through
        // symlinks, and `CDPATH=` stops a set CDPATH from making `cd` print
        // and from resolving against the wrong base. The confinement check
        // then rejects any path that escaped the repo.
        format!(
            "repo=$(CDPATH= cd -- {r} && pwd -P) && \
             dir=$(CDPATH= cd -- {r} && CDPATH= cd -- \"$(dirname -- {p})\" && pwd -P) && \
             file=\"$dir/$(basename -- {p})\" && \
             case \"$file\" in \"$repo\"/*) ;; *) echo \"git path is outside the repository\" >&2; exit 2;; esac && ",
            r = shell_quote(root),
            p = shell_quote(requested)
        )
    } else {
        String::new()
    };
    let mut remote = format!("{prefix}env -u GIT_EXTERNAL_DIFF -u GIT_DIFF_OPTS -u GIT_PAGER GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git -c core.fsmonitor=false -c diff.external= -c core.pager=cat -C {} ", shell_quote(root));
    for a in args {
        remote.push_str(&shell_quote(a));
        remote.push(' ');
    }
    let result = ssh_exec(&session.host, remote.trim_end(), None)?;
    if result.status == 0 {
        return Ok(result.stdout_lossy());
    }
    // `git diff` / `--no-index` exit 1 when files differ — that's the payload.
    if result.status == 1 && args.contains(&"diff") {
        return Ok(result.stdout_lossy());
    }
    Err(map_ssh_failure(&session.host, &result.failure_text()))
}

/// Fingerprint script used by the remote file watcher.
///
/// Output is two sorted sections so the poller can tell *tree shape* changes
/// apart from content/git "status ticks":
///   __SD_STRUCT__  — path + type only (dirs + files), LC_ALL=C sorted
///   __SD_CONTENT__ — git porcelain + file mtime/size lines, sorted
///
/// `-H` follows a symlinked root (`/home/user` on many hosts) — without it
/// find reports the link itself and the fingerprint never changes. Sorting
/// keeps the blob stable across readdir order.
///
/// No GNU-only `-printf`: the struct lines use `-exec printf` (a byte-exact
/// replacement for `%p`) and the content lines use `-exec sh -c` with
/// `stat -c` (GNU) falling back to `stat -f` (BSD/macOS). The exact mtime
/// format is irrelevant — the content section is only ever compared for
/// equality between two polls of the *same* host, never parsed.
pub fn watch_fingerprint_script(root: &str) -> String {
    let root = shell_quote(root);
    format!(
        "printf '%s\\n' '__SD_STRUCT__'; \
         find -H {root} \\( -name .git -o -name node_modules -o -name target -o -name dist \\) -prune \
         -o \\( -type d -exec printf 'd %s\\n' {{}} + -o -type f -exec printf 'f %s\\n' {{}} + \\) 2>/dev/null | LC_ALL=C sort; \
         printf '%s\\n' '__SD_CONTENT__'; \
         env -u GIT_EXTERNAL_DIFF -u GIT_DIFF_OPTS -u GIT_PAGER GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
           git -c core.fsmonitor=false -c diff.external= -C {root} status --ignore-submodules=all --porcelain -z --untracked-files=all 2>/dev/null; \
         find -H {root} \\( -name .git -o -name node_modules -o -name target -o -name dist \\) -prune \
         -o -type f -exec sh -c 'for f do if m=$(stat -c \"%Y %s\" \"$f\" 2>/dev/null); then printf \"%s %s\\n\" \"$m\" \"$f\"; elif m=$(stat -f \"%m %z\" \"$f\" 2>/dev/null); then printf \"%s %s\\n\" \"$m\" \"$f\"; fi; done' sh {{}} + 2>/dev/null | LC_ALL=C sort",
        root = root
    )
}

pub fn split_watch_fingerprint(fp: &str) -> (&str, &str) {
    const STRUCT: &str = "__SD_STRUCT__\n";
    const CONTENT: &str = "__SD_CONTENT__\n";
    let Some(rest) = fp.strip_prefix(STRUCT) else {
        return (fp, "");
    };
    let Some(idx) = rest.find(CONTENT) else {
        return (fp, "");
    };
    (&rest[..idx], &rest[idx + CONTENT.len()..])
}

/// Classify a remote poll delta for the frontend watcher pipeline.
/// `None` = no event (first sample or identical). `"modify"` = content/git
/// only (do not remount explorer). Any other kind triggers a tree refresh.
pub fn classify_remote_watch_delta(prev: &str, next: &str) -> Option<&'static str> {
    if prev.is_empty() || prev == next {
        return None;
    }
    let (prev_struct, prev_content) = split_watch_fingerprint(prev);
    let (next_struct, next_content) = split_watch_fingerprint(next);
    if prev_struct != next_struct {
        Some("other")
    } else if prev_content != next_content {
        Some("modify")
    } else {
        None
    }
}

#[cfg(all(test, unix))]
mod exec_tests {
    use super::*;

    /// A child that never reads stdin (a half-open link) with a payload far
    /// larger than any pipe/channel buffer: the deadline must still fire.
    #[test]
    fn stdin_write_is_covered_by_the_deadline() {
        // `exec`: like ssh, the direct child is the one holding the pipes.
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "exec sleep 30"]);
        let payload = vec![b'x'; 5 * 1024 * 1024];
        let start = Instant::now();
        let r = run_with_deadline(cmd, Some(&payload), Duration::from_millis(500));
        assert!(matches!(r, Err(ExecError::Timeout)), "{:?}", r.err());
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "took {:?}",
            start.elapsed()
        );
    }

    /// A grandchild that inherited the pipes survives the kill; the helper
    /// threads must be detached after one shared grace period, not hang.
    #[test]
    fn inherited_pipes_do_not_block_past_the_grace() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30; :"]);
        let payload = vec![b'x'; 5 * 1024 * 1024];
        let start = Instant::now();
        let r = run_with_deadline(cmd, Some(&payload), Duration::from_millis(300));
        assert!(matches!(r, Err(ExecError::Timeout)), "{:?}", r.err());
        let limit = Duration::from_millis(300) + THREAD_GRACE + Duration::from_secs(2);
        assert!(start.elapsed() < limit, "took {:?}", start.elapsed());
    }

    #[test]
    fn large_stdin_round_trips_before_the_deadline() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "wc -c | tr -d ' '"]);
        let payload = vec![b'y'; 5 * 1024 * 1024];
        let out = run_with_deadline(cmd, Some(&payload), Duration::from_secs(30)).unwrap();
        assert!(out.status.success());
        assert!(out.stdin_err.is_none());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "5242880");
    }

    #[test]
    fn early_exit_reports_the_stdin_error() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "exit 3"]);
        let payload = vec![b'z'; 5 * 1024 * 1024];
        let out = run_with_deadline(cmd, Some(&payload), Duration::from_secs(30)).unwrap();
        assert_eq!(out.status.code(), Some(3));
        assert!(out.stdin_err.is_some());
    }
}
