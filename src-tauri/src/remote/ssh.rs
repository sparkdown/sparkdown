//! SSH config parse + BatchMode `ssh` helpers for remote sessions v1 (#36).

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
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
    parse_destination(host).map(|_| ())
}

/// A connect target: a `~/.ssh/config` alias, or a typed `[user@]host[:port]`
/// (#22). IPv6 goes in brackets: `user@[::1]:2222`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Destination {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
}

impl Destination {
    /// The `[user@]host` operand handed to ssh (IPv6 without brackets, which
    /// ssh accepts as a destination).
    pub fn ssh_target(&self) -> String {
        match &self.user {
            Some(u) => format!("{u}@{}", self.host),
            None => self.host.clone(),
        }
    }
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_'
}

/// Strictly parse a host alias or `[user@]host[:port]`. Everything else is
/// rejected: a leading '-' (would be parsed as an ssh option, e.g. `-G`,
/// `-oProxyCommand=`), whitespace, control characters, shell
/// metacharacters, a second '@', an empty part, a port outside 1-65535.
/// The result only ever reaches ssh as separate argv entries (never a shell
/// string), so it cannot inject options or commands.
pub(crate) fn parse_destination(input: &str) -> Result<Destination, String> {
    let bad = || {
        Err::<Destination, String>(format!(
            "Invalid SSH host '{}'. Use a ~/.ssh/config host or user@host[:port].",
            input.escape_debug()
        ))
    };
    if input.is_empty() || input.len() > 255 || input.starts_with('-') {
        return bad();
    }
    if !input
        .chars()
        .all(|c| is_name_char(c) || matches!(c, '@' | ':' | '[' | ']'))
    {
        return bad();
    }
    let (user, rest) = match input.split_once('@') {
        Some((u, r)) => (Some(u), r),
        None => (None, input),
    };
    if let Some(u) = user {
        if u.is_empty() || u.len() > 64 || u.starts_with('-') || !u.chars().all(is_name_char) {
            return bad();
        }
    }
    let (host, port) = if let Some(after) = rest.strip_prefix('[') {
        let Some((v6, tail)) = after.split_once(']') else {
            return bad();
        };
        if v6.is_empty()
            || !v6.contains(':')
            || !v6
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
        {
            return bad();
        }
        let port = match tail {
            "" => None,
            t => match t.strip_prefix(':') {
                Some(p) => Some(p),
                None => return bad(),
            },
        };
        (v6, port)
    } else {
        if rest.contains('[') || rest.contains(']') {
            return bad();
        }
        match rest.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (rest, None),
        }
    };
    if host.is_empty()
        || host.len() > 253
        || host.starts_with('-')
        || host.starts_with('.')
        || (!host.contains(':') && !host.chars().all(is_name_char))
    {
        return bad();
    }
    let port = match port {
        None => None,
        Some(p) => {
            if p.is_empty() || p.len() > 5 || !p.chars().all(|c| c.is_ascii_digit()) {
                return bad();
            }
            match p.parse::<u16>() {
                Ok(n) if n > 0 => Some(n),
                _ => return bad(),
            }
        }
    };
    Ok(Destination {
        user: user.map(str::to_string),
        host: host.to_string(),
        port,
    })
}

/// The ssh argv for a destination: `["-p", "2222", "user@host"]` with a
/// port, else `["user@host"]` / `["alias"]`. ssh's normal config, keys and
/// agent still apply (a typed host also matches `Host` blocks).
pub(crate) fn destination_args(host: &str) -> Result<Vec<String>, String> {
    let d = parse_destination(host)?;
    let mut v = Vec::new();
    if let Some(p) = d.port {
        v.push("-p".into());
        v.push(p.to_string());
    }
    v.push(d.ssh_target());
    Ok(v)
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

/// Error-code prefixes the frontend acts on (remote.ts `remoteErrorCode`).
/// Unknown host key: offer the scan + confirm flow (#24).
pub const ERR_HOSTKEY_UNKNOWN: &str = "[hostkey-unknown] ";
/// Changed host key: a hard stop, never an accept button (#24).
pub const ERR_HOSTKEY_CHANGED: &str = "[hostkey-changed] ";
/// A passphrase-protected key that no agent holds (#25).
pub const ERR_KEY_NEEDS_AGENT: &str = "[key-needs-agent] ";
/// Docs section linked from the agent message.
pub const AGENT_DOCS_URL: &str =
    "https://github.com/sparkdown/sparkdown/blob/main/docs/remote-ssh.md#passphrase-protected-keys";

const CODES: &[&str] = &[
    ERR_HOSTKEY_UNKNOWN,
    ERR_HOSTKEY_CHANGED,
    ERR_KEY_NEEDS_AGENT,
];

/// The known_hosts entry to pass to `ssh-keygen -R` for a changed key,
/// shell-quoted when needed: `'[host]:port'` off port 22 (#52). Prefers the
/// name ssh itself printed ("remove with: ssh-keygen ... -R ..."), then the
/// resolved HostName/HostKeyAlias and Port, then the typed destination.
pub(crate) fn changed_key_entry(
    host: &str,
    stderr: &str,
    resolve: impl FnOnce() -> Option<(String, u16)>,
) -> String {
    let from_ssh = stderr.lines().find_map(|line| {
        let (_, rest) = line.split_once("ssh-keygen ")?;
        let (_, after) = rest.split_once("-R ")?;
        let name = after
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .to_string();
        (!name.is_empty() && !name.contains(char::is_whitespace)).then_some(name)
    });
    let name = from_ssh
        .or_else(|| resolve().map(|(n, p)| super::hostkey::known_hosts_name(&n, p)))
        .or_else(|| {
            parse_destination(host)
                .ok()
                .map(|d| super::hostkey::known_hosts_name(&d.host, d.port.unwrap_or(22)))
        })
        .unwrap_or_else(|| host.to_string());
    if name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '%'))
    {
        name
    } else {
        format!("'{}'", name.replace('\'', ""))
    }
}

/// Map ssh(1) failure text into the v1 user-facing errors.
pub fn map_ssh_failure(host: &str, stderr: &str) -> String {
    // Already mapped (connect maps the probe's error again): keep the code.
    if CODES.iter().any(|c| stderr.starts_with(c)) {
        return stderr.to_string();
    }
    let s = stderr.to_ascii_lowercase();
    // Before the password check: this warning itself mentions "Password
    // authentication is disabled to avoid man-in-the-middle attacks".
    //
    // A key the admin has marked `@revoked` (or that `RevokedHostKeys` lists)
    // is a hard stop too: ssh refuses and SparkDown must NOT offer to append.
    let revoked = s.contains("revoked host key detected")
        || s.contains("is marked as revoked")
        || s.contains("host key revoked");
    if revoked {
        let target = changed_key_entry(host, stderr, || {
            super::hostkey::resolve(host)
                .ok()
                .map(|r| (r.host_key_alias.unwrap_or(r.hostname), r.port))
        });
        return format!(
            "{ERR_HOSTKEY_CHANGED}WARNING: the host key for '{host}' is REVOKED. The administrator has marked this key as no longer trusted. \
             SparkDown will not connect and will not accept the server's key. Check with the server's administrator; \
             only if the change is expected, remove the old key with `ssh-keygen -R {target}` and connect again."
        );
    }
    if s.contains("remote host identification has changed") {
        let target = changed_key_entry(host, stderr, || {
            super::hostkey::resolve(host)
                .ok()
                .map(|r| (r.host_key_alias.unwrap_or(r.hostname), r.port))
        });
        return format!(
            "{ERR_HOSTKEY_CHANGED}WARNING: the host key for '{host}' has CHANGED since you last connected. \
             Someone may be intercepting the connection (a man-in-the-middle attack), or the server was reinstalled. \
             SparkDown will not connect and will not replace the key. Check with the server's administrator; \
             only if the change is expected, remove the old key with `ssh-keygen -R {target}` and connect again."
        );
    }
    // OpenSSH's "strict checking" banner covers a first connect and a host
    // that is stored under another key type; scan() tells the two apart.
    if s.contains("host key verification failed")
        || (s.contains("host key is known for") && s.contains("strict checking"))
    {
        return format!("{ERR_HOSTKEY_UNKNOWN}'{host}' is not in your known_hosts yet.");
    }
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

/// The key-auth refusal `map_ssh_failure` produces.
pub(crate) fn is_key_refusal(host: &str, msg: &str) -> bool {
    msg.starts_with(&format!(
        "Host '{host}' requires a password or rejected the SSH key"
    ))
}

/// The #25 message for a passphrase-protected key no agent holds.
pub(crate) fn needs_agent_message(key: &str) -> String {
    format!(
        "{ERR_KEY_NEEDS_AGENT}Your key needs an SSH agent: run ssh-add and relaunch SparkDown. \
         (Key: {key}, protected by a passphrase, and no running SSH agent holds it.) See {AGENT_DOCS_URL}"
    )
}

/// After a key refusal, look for the likely cause: a passphrase-protected
/// identity file that no reachable agent holds (BatchMode can't ask for the
/// passphrase). Returns the refined message, or `msg` unchanged. Connects
/// use `passphrase_outcome_message` (#50); this is the no-askpass case
/// the live tests check.
#[cfg(test)]
pub(crate) fn refine_key_refusal(host: &str, msg: String) -> String {
    if !is_key_refusal(host, &msg) {
        return msg;
    }
    match encrypted_key_without_agent(host) {
        Some(key) => needs_agent_message(&key),
        None => msg,
    }
}

/// The keys ssh would have offered `host` (#50): the identity files from
/// `ssh -G` that exist, shown with `~`, then a count of ssh-agent keys.
pub(crate) fn tried_keys(host: &str) -> Vec<String> {
    let mut keys = Vec::new();
    if let Ok(dest) = destination_args(host) {
        if let Ok(out) = crate::proc::command("ssh")
            .arg("-G")
            .args(&dest)
            .stdin(Stdio::null())
            .output()
        {
            let home = home_dir();
            for key in identity_files(&String::from_utf8_lossy(&out.stdout), &home) {
                if key.is_file() {
                    keys.push(
                        key.strip_prefix(&home)
                            .map(|r| format!("~/{}", r.display()))
                            .unwrap_or_else(|_| key.display().to_string()),
                    );
                }
            }
        }
    }
    match agent_fingerprints().map(|l| l.len()).unwrap_or(0) {
        0 => {}
        1 => keys.push("1 key in ssh-agent".into()),
        n => keys.push(format!("{n} keys in ssh-agent")),
    }
    keys
}

/// The server refused every key it was offered (#50): not a passphrase or
/// agent problem. Names the keys tried when known.
pub(crate) fn key_rejected_message(host: &str, tried: &[String]) -> String {
    if tried.is_empty() {
        return format!(
            "Not connected to '{host}': the server did not accept any SSH key, and no key was found to offer. \
             Add an IdentityFile for this host in ~/.ssh/config, or load a key in ssh-agent."
        );
    }
    format!(
        "Not connected to '{host}': the server rejected your SSH key (tried: {}). \
         Check that the matching public key is in ~/.ssh/authorized_keys for that account on the server, \
         and that the account is allowed to log in.",
        tried.join(", ")
    )
}

/// `identityfile` entries of `ssh -G` output, `~`/`%d` expanded.
pub(crate) fn identity_files(ssh_g: &str, home: &Path) -> Vec<PathBuf> {
    ssh_g
        .lines()
        .filter_map(|l| l.trim().strip_prefix("identityfile "))
        .map(|p| super::hostkey::expand_home(p.trim(), home))
        .collect()
}

/// `SHA256:…` of a `.pub` file's key.
pub(crate) fn pub_fingerprint(pub_text: &str) -> Option<String> {
    use base64::Engine as _;
    let b64 = pub_text.split_whitespace().nth(1)?;
    let blob = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    Some(super::hostkey::fingerprint(&blob))
}

/// Whether `ssh-keygen` says this private key needs a passphrase. The key
/// is only read by ssh-keygen (empty passphrase, stdin closed); nothing of
/// it reaches SparkDown.
fn key_is_encrypted(path: &Path) -> bool {
    let Ok(out) = crate::proc::command("ssh-keygen")
        .arg("-y")
        .arg("-P")
        .arg("")
        .arg("-f")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .output()
    else {
        return false;
    };
    !out.status.success()
        && String::from_utf8_lossy(&out.stderr)
            .to_ascii_lowercase()
            .contains("passphrase")
}

/// Fingerprints the running agent holds; `None` when no agent is reachable.
fn agent_fingerprints() -> Option<Vec<String>> {
    let out = crate::proc::command("ssh-add")
        .args(["-l", "-E", "sha256"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    match out.status.code() {
        // 0: keys listed; 1: agent reachable but empty.
        Some(0) | Some(1) => Some(
            String::from_utf8_lossy(&out.stdout)
                .split_whitespace()
                .filter(|w| w.starts_with("SHA256:"))
                .map(str::to_string)
                .collect(),
        ),
        _ => None,
    }
}

/// The first passphrase-protected identity for `host` that no agent holds,
/// shown with `~` for the home dir.
pub(crate) fn encrypted_key_without_agent(host: &str) -> Option<String> {
    let dest = destination_args(host).ok()?;
    let out = crate::proc::command("ssh")
        .arg("-G")
        .args(&dest)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let home = home_dir();
    let agent = agent_fingerprints();
    for key in identity_files(&String::from_utf8_lossy(&out.stdout), &home) {
        if !key.is_file() || !key_is_encrypted(&key) {
            continue;
        }
        let mut pub_path = key.clone().into_os_string();
        pub_path.push(".pub");
        let fp = std::fs::read_to_string(&pub_path)
            .ok()
            .and_then(|t| pub_fingerprint(&t));
        let held = match (&agent, &fp) {
            (Some(list), Some(fp)) => list.contains(fp),
            // Agent up but no .pub to compare: assume it may hold the key.
            (Some(list), None) => !list.is_empty(),
            (None, _) => false,
        };
        if !held {
            let shown = key
                .strip_prefix(&home)
                .map(|r| format!("~/{}", r.display()))
                .unwrap_or_else(|_| key.display().to_string());
            return Some(shown);
        }
    }
    None
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
        // One control connection per window (#60 decision 6): two windows
        // on the same host must not share (or close) each other's mux.
        format!("ControlPath={}/{}", dir.display(), control_name()),
        "-o".into(),
        "ControlPersist=600".into(),
    ]
}

/// `%C` (ssh's hash of host/port/user), prefixed per window. The unscoped
/// default keeps the plain `%C` used before multi-window.
#[cfg(unix)]
fn control_name() -> String {
    let label = crate::windows::current_label();
    if label == crate::windows::DEFAULT_LABEL {
        "%C".into()
    } else {
        format!("{}-%C", crate::windows::label_tag(&label))
    }
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
    let Ok(dest) = destination_args(host) else {
        return;
    };
    let _ = crate::proc::command("ssh")
        .args(&opts)
        .args(["-O", "exit"])
        .args(&dest)
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

/// `path` with the home dir shown as `~` (for prompts and messages).
pub fn display_home_path(path: &str) -> String {
    let home = home_dir();
    let home = home.to_string_lossy();
    match path.strip_prefix(home.as_ref()) {
        Some(rest) if !home.is_empty() && home != "/" && rest.starts_with(['/', '\\']) => {
            format!("~{rest}")
        }
        _ => path.to_string(),
    }
}

pub(crate) fn home_dir() -> PathBuf {
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
    let dest = destination_args(host)?;
    // Single choke point: hand the script to `/bin/sh`, never the user's login
    // shell. ssh passes the command string to the remote login shell, which
    // may be fish/csh/tcsh and would choke on the POSIX `( … )`, `$?`,
    // `${VAR:-x}` constructs every remote command uses. `exec` replaces the
    // login shell so exit status still propagates.
    let sh_arg = format!("exec /bin/sh -c {}", shell_quote(&wrap_marked(remote_cmd)));
    let mut cmd = crate::proc::command("ssh");
    cmd.args(mux_options());
    // #27: with a session askpass broker, ssh may ask SparkDown for a KEY
    // passphrase (BatchMode=no is required for askpass), and can never ask
    // for the server password: password and keyboard-interactive auth are
    // off and only publickey is tried. Without a broker, BatchMode as before.
    match crate::askpass::current() {
        Some(broker) => {
            cmd.envs(broker.ssh_env());
            cmd.args([
                "-o",
                "BatchMode=no",
                "-o",
                "PasswordAuthentication=no",
                "-o",
                "KbdInteractiveAuthentication=no",
                // DISPLAY may be a placeholder for old ssh (see ssh_env).
                "-o",
                "ForwardX11=no",
            ]);
        }
        None => {
            cmd.args(["-o", "BatchMode=yes"]);
        }
    }
    cmd.args([
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
    ]);
    cmd.args(&dest);
    cmd.args(["--", &sh_arg]);
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

/// Run `remote_cmd` and return (exit status, stdout, stderr) even when the
/// command fails, so a caller can show the command's own error and code.
/// Only an ssh failure (status 255) is an Err.
pub(crate) fn ssh_run_status(
    host: &str,
    remote_cmd: &str,
) -> Result<(i32, String, String), String> {
    let result = ssh_exec(host, remote_cmd, None)?;
    if result.status == 255 {
        return Err(map_ssh_failure(host, &result.failure_text()));
    }
    Ok((result.status, result.stdout_lossy(), result.stderr))
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

/// Build shell environment variable assignments for filter/diff driver neutralization.
/// Returns a string like "GIT_CONFIG_COUNT=N GIT_CONFIG_KEY_0=... GIT_CONFIG_VALUE_0=... "
pub(crate) fn remote_filter_neutralizers_env(
    filters: &BTreeSet<String>,
    diffs: &BTreeSet<String>,
) -> String {
    let mut pairs = Vec::new();
    for f in filters {
        pairs.push((format!("filter.{f}.clean"), String::new()));
        pairs.push((format!("filter.{f}.smudge"), String::new()));
        pairs.push((format!("filter.{f}.process"), String::new()));
        pairs.push((format!("filter.{f}.required"), "false".to_string()));
    }
    for d in diffs {
        pairs.push((format!("diff.{d}.command"), String::new()));
        pairs.push((format!("diff.{d}.textconv"), String::new()));
    }
    if pairs.is_empty() {
        return String::new();
    }
    let mut result = format!("GIT_CONFIG_COUNT={} ", pairs.len());
    for (i, (key, value)) in pairs.iter().enumerate() {
        result.push_str(&format!("GIT_CONFIG_KEY_{}={} ", i, shell_quote(key)));
        result.push_str(&format!("GIT_CONFIG_VALUE_{}={} ", i, shell_quote(value)));
    }
    result
}

/// Collect filter and diff driver names from local and worktree git config over SSH.
/// Uses the same enumeration logic as local_exec_neutralisers in git.rs.
pub(crate) fn remote_collect_driver_names(
    root: &str,
) -> Result<(BTreeSet<String>, BTreeSet<String>), String> {
    let Some(session) = super::current_session() else {
        return Ok((BTreeSet::new(), BTreeSet::new()));
    };
    validate_remote_path(root)?;
    collect_driver_names_with(root, |cmd| ssh_exec(&session.host, cmd, None))
}

/// True when a `git config <scope>` failure only means that scope does not
/// exist here: a folder that is not a repository, or a linked worktree whose
/// repository has no `extensions.worktreeConfig`. Any other failure is a real
/// error and must not be treated as "no drivers".
fn config_scope_absent(result: &SshResult) -> bool {
    if result.status == 1 && result.stdout.is_empty() {
        return true;
    }
    result.stderr.contains("not a git repository")
        || result
            .stderr
            .contains("can only be used inside a git repository")
        || (result.status == 128
            && result
                .stderr
                .contains("cannot be used with multiple working trees")
            && result.stderr.contains("worktreeConfig"))
}

/// Enumeration behind [`remote_collect_driver_names`], with the command runner
/// injected so it can be exercised against a local shell. Each scope is
/// handled on its own: a scope that is absent contributes nothing, but names
/// found in the other scope are kept.
fn collect_driver_names_with(
    root: &str,
    exec: impl Fn(&str) -> Result<SshResult, String>,
) -> Result<(BTreeSet<String>, BTreeSet<String>), String> {
    let mut filters = BTreeSet::new();
    let mut diffs = BTreeSet::new();

    for scope in ["--local", "--worktree"] {
        let cmd = format!(
            "LC_ALL=C LANG=C git -C {} config {} --includes --name-only --get-regexp '^(filter|diff)\\.'",
            shell_quote(root),
            scope
        );
        let result = exec(&cmd)?;
        if result.status != 0 {
            if config_scope_absent(&result) {
                continue;
            }
            return Err(format!(
                "{} config enumeration failed: {}",
                scope,
                result.failure_text()
            ));
        }

        for line in result.stdout_lossy().lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("filter.") {
                if let Some((name, sub)) = rest.rsplit_once('.') {
                    if !name.is_empty()
                        && matches!(sub, "clean" | "smudge" | "process" | "required")
                    {
                        filters.insert(name.to_string());
                    }
                }
            } else if let Some(rest) = line.strip_prefix("diff.") {
                if let Some((name, sub)) = rest.rsplit_once('.') {
                    if !name.is_empty() && matches!(sub, "command" | "textconv") {
                        diffs.insert(name.to_string());
                    }
                }
            }
        }
    }

    Ok((filters, diffs))
}

/// `git -C <root> <args…>` over SSH. Diffs may exit 1 when there are changes;
/// we still return stdout in that case (same as a working `git diff`).
pub(crate) fn ssh_git(root: &str, args: &[&str]) -> Result<String, String> {
    let session = super::current_session().ok_or_else(|| "no remote session".to_string())?;
    validate_remote_path(root)?;

    let (filters, diffs) = remote_collect_driver_names(root)?;
    let neutralizers = remote_filter_neutralizers_env(&filters, &diffs);

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
    let mut remote = format!("{prefix}env -u GIT_EXTERNAL_DIFF -u GIT_DIFF_OPTS -u GIT_PAGER GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL= {neutralizers}git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c diff.external= -c core.pager=cat -c protocol.allow=never -c fetch.negotiationAlgorithm=noop -C {} ", shell_quote(root));
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
/// replacement for `%p`) and the content lines use one batched `stat -c`
/// (GNU) or `stat -f` (BSD/macOS) per `-exec … {} +` group. Never one
/// process per file: on a home-sized tree (~170k files) a per-file
/// `stat` took 2.5 minutes, every poll hit the 30 s SSH timeout, and no
/// change ever reached the explorer or Changes (#28). The exact mtime
/// format is irrelevant — the content section is only ever compared for
/// equality between two polls of the *same* host, never parsed.
pub fn watch_fingerprint_script(root: &str) -> Result<String, String> {
    let (filters, diffs) = remote_collect_driver_names(root)?;
    let neutralizers = remote_filter_neutralizers_env(&filters, &diffs);
    let root = shell_quote(root);
    Ok(format!(
        "printf '%s\\n' '__SD_STRUCT__'; \
         find -H {root} \\( -name .git -o -name node_modules -o -name target -o -name dist \\) -prune \
         -o \\( -type d -exec printf 'd %s\\n' {{}} + -o -type f -exec printf 'f %s\\n' {{}} + \\) 2>/dev/null | LC_ALL=C sort; \
         printf '%s\\n' '__SD_CONTENT__'; \
         env -u GIT_EXTERNAL_DIFF -u GIT_DIFF_OPTS -u GIT_PAGER GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL= {neutralizers}\
           git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c diff.external= -c protocol.allow=never -c fetch.negotiationAlgorithm=noop -C {root} status --ignore-submodules=all --porcelain -z --untracked-files=all 2>/dev/null; \
         if stat -c %Y / >/dev/null 2>&1; then \
           find -H {root} \\( -name .git -o -name node_modules -o -name target -o -name dist \\) -prune \
           -o -type f -exec stat -c '%Y %s %n' {{}} + 2>/dev/null; \
         else \
           find -H {root} \\( -name .git -o -name node_modules -o -name target -o -name dist \\) -prune \
           -o -type f -exec stat -f '%m %z %N' {{}} + 2>/dev/null; \
         fi | LC_ALL=C sort",
        root = root
    ))
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
        let mut cmd = crate::proc::command("sh");
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
        let mut cmd = crate::proc::command("sh");
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
        let mut cmd = crate::proc::command("sh");
        cmd.args(["-c", "wc -c | tr -d ' '"]);
        let payload = vec![b'y'; 5 * 1024 * 1024];
        let out = run_with_deadline(cmd, Some(&payload), Duration::from_secs(30)).unwrap();
        assert!(out.status.success());
        assert!(out.stdin_err.is_none());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "5242880");
    }

    #[test]
    fn early_exit_reports_the_stdin_error() {
        let mut cmd = crate::proc::command("sh");
        cmd.args(["-c", "exit 3"]);
        let payload = vec![b'z'; 5 * 1024 * 1024];
        let out = run_with_deadline(cmd, Some(&payload), Duration::from_secs(30)).unwrap();
        assert_eq!(out.status.code(), Some(3));
        assert!(out.stdin_err.is_some());
    }

    // --- driver enumeration, run against a local shell instead of ssh ---

    #[cfg(unix)]
    fn local_exec(cmd: &str) -> Result<SshResult, String> {
        let out = crate::proc::command("sh")
            .arg("-c")
            .arg(cmd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .map_err(|e| e.to_string())?;
        Ok(SshResult {
            status: out.status.code().unwrap_or(-1),
            stdout: out.stdout,
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }

    #[cfg(unix)]
    fn git_in(dir: &Path, args: &[&str]) {
        let out = crate::proc::command("git")
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[cfg(unix)]
    fn scratch_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sd_drivers_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn driver_names_empty_for_a_folder_that_is_not_a_repo() {
        let dir = scratch_dir("nonrepo");
        let (filters, diffs) = collect_driver_names_with(dir.to_str().unwrap(), local_exec)
            .expect("a folder that is not a repository has no drivers, not an error");
        assert!(filters.is_empty() && diffs.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn driver_names_empty_for_a_folder_whose_gitfile_points_nowhere() {
        let dir = scratch_dir("gitfile");
        std::fs::write(dir.join(".git"), "gitdir: /nonexistent/sd-drivers\n").unwrap();
        let (filters, diffs) = collect_driver_names_with(dir.to_str().unwrap(), local_exec)
            .expect("a dangling gitfile is a folder that is not a repository");
        assert!(filters.is_empty() && diffs.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn driver_names_found_in_a_plain_repo() {
        let dir = scratch_dir("plain");
        git_in(&dir, &["init", "-q"]);
        git_in(&dir, &["config", "filter.demo.clean", "cat"]);
        git_in(&dir, &["config", "diff.viewer.textconv", "cat"]);
        let (filters, diffs) =
            collect_driver_names_with(dir.to_str().unwrap(), local_exec).unwrap();
        assert_eq!(filters.into_iter().collect::<Vec<_>>(), ["demo"]);
        assert_eq!(diffs.into_iter().collect::<Vec<_>>(), ["viewer"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn driver_names_failure_other_than_a_missing_scope_is_an_error() {
        let dir = scratch_dir("broken");
        git_in(&dir, &["init", "-q"]);
        // An unreadable config makes git exit 128 with a message that is
        // neither "not a repository" nor the worktree-config one.
        std::fs::write(dir.join(".git/config"), "[core\n").unwrap();
        let err = collect_driver_names_with(dir.to_str().unwrap(), local_exec)
            .expect_err("a real failure must not read as 'no drivers'");
        assert!(err.contains("config enumeration failed"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn driver_names_survive_a_linked_worktree_without_worktree_config() {
        let base = scratch_dir("linked");
        let main = base.join("main");
        std::fs::create_dir_all(&main).unwrap();
        git_in(&main, &["init", "-q"]);
        git_in(&main, &["config", "filter.demo.clean", "touch MARKER; cat"]);
        std::fs::write(main.join(".gitattributes"), "*.txt filter=demo\n").unwrap();
        std::fs::write(main.join("a.txt"), "hello\n").unwrap();
        git_in(&main, &["add", ".gitattributes", "a.txt"]);
        git_in(&main, &["commit", "-q", "-m", "init"]);
        let wt = base.join("wt");
        git_in(&main, &["worktree", "add", "-q", wt.to_str().unwrap()]);
        let wt_str = wt.to_str().unwrap();

        // Precondition: in this worktree --worktree exits 128 while --local
        // lists the driver, which is the case under test.
        let probe_worktree = local_exec(&format!(
            "git -C {} config --worktree --get-regexp '^filter\\.'",
            shell_quote(wt_str)
        ))
        .unwrap();
        assert_eq!(probe_worktree.status, 128, "{}", probe_worktree.stderr);
        let probe_local = local_exec(&format!(
            "git -C {} config --local --get-regexp '^filter\\.'",
            shell_quote(wt_str)
        ))
        .unwrap();
        assert_eq!(probe_local.status, 0);

        let (filters, diffs) = collect_driver_names_with(wt_str, local_exec)
            .expect("worktree scope being absent is not an error");
        assert_eq!(
            filters.iter().map(String::as_str).collect::<Vec<_>>(),
            ["demo"]
        );

        // The overrides built from those names really stop the driver.
        let env = remote_filter_neutralizers_env(&filters, &diffs);
        assert!(env.contains("filter.demo.clean"), "{env}");
        let run = |prefix: &str| {
            let _ = std::fs::remove_file(wt.join("MARKER"));
            let out = local_exec(&format!(
                "cd {} && {prefix}git hash-object --path=a.txt a.txt",
                shell_quote(wt_str)
            ))
            .unwrap();
            assert_eq!(out.status, 0, "{}", out.stderr);
            wt.join("MARKER").exists()
        };
        assert!(run(""), "control: the driver runs without the overrides");
        assert!(!run(&env), "the driver must not run with the overrides");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn map_ssh_failure_strict_checking_is_hostkey_unknown() {
        // OpenSSH prints "No <TYPE> host key is known for <host> and you have
        // requested strict checking." for a first connect under
        // StrictHostKeyChecking=yes. That must map to [hostkey-unknown] so
        // scan() can offer to accept the key; only when scan() finds an
        // existing entry is it a changed-key hard stop.
        let banner =
            "No ED25519 host key is known for example.com and you have requested strict checking.";
        let result = map_ssh_failure("example.com", banner);
        assert!(
            result.starts_with(ERR_HOSTKEY_UNKNOWN),
            "Expected [hostkey-unknown], got: {result}"
        );
    }
}
