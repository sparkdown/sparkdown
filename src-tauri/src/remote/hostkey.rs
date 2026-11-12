//! First connect to a host that is not in known_hosts yet (#24).
//!
//! ssh runs with BatchMode, so an unknown host key fails with "Host key
//! verification failed." instead of a yes/no prompt. SparkDown then:
//!
//! 1. scans the host's keys with `ssh-keyscan` (argv only, the port ssh
//!    would use, resolved by `ssh -G` so `~/.ssh/config` HostName / Port /
//!    HostKeyAlias apply),
//! 2. shows each key's type and SHA256 fingerprint for the user to confirm
//!    (never accepted silently),
//! 3. on accept, appends exactly those scanned lines to the user's
//!    known_hosts, as `host` or `[host]:port`, hashed when `HashKnownHosts`
//!    is on,
//! 4. connects again with ssh's normal strict checking (no accept-new).
//!
//! A *changed* key ("REMOTE HOST IDENTIFICATION HAS CHANGED") is never
//! offered for acceptance: see `map_ssh_failure`.
//!
//! The scan result stays in this process (keyed by a one-time id); the
//! frontend only says "trust scan N", so it cannot smuggle other lines in.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::ssh::{destination_args, home_dir, parse_destination};

/// One scanned host key, as shown in the confirm dialog.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ScannedKey {
    pub key_type: String,
    /// `SHA256:…`, the same text `ssh` and `ssh-keygen -l` print.
    pub fingerprint: String,
}

/// What the confirm dialog shows.
#[derive(Debug, Clone, Serialize)]
pub struct HostKeyScan {
    pub scan_id: String,
    /// The known_hosts name: `host` or `[host]:port`.
    pub known_hosts_name: String,
    pub keys: Vec<ScannedKey>,
    /// Where the lines will be appended (display only).
    pub known_hosts_file: String,
    pub hashed: bool,
}

struct PendingScan {
    /// The known_hosts entry name (`host` or `[host]:port`). Carried so
    /// `trust_scan` can re-verify absence at append time.
    name: String,
    lines: Vec<String>,
    known_hosts_file: PathBuf,
    /// Every known_hosts file ssh would check for this host (user + global),
    /// expanded paths. Used to re-run the "already pinned?" / "revoked?"
    /// check at trust time.
    known_hosts_checked: Vec<PathBuf>,
    hashed: bool,
}

fn pending() -> &'static Mutex<HashMap<String, PendingScan>> {
    static P: std::sync::OnceLock<Mutex<HashMap<String, PendingScan>>> = std::sync::OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Key types SparkDown will write to known_hosts.
const KEY_TYPES: &[&str] = &[
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-rsa",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
];

/// The parts of `ssh -G` output the scan needs.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ResolvedHost {
    /// `ssh -G` user (empty when ssh did not print one).
    pub user: String,
    pub hostname: String,
    pub port: u16,
    pub host_key_alias: Option<String>,
    pub user_known_hosts: Option<String>,
    /// Every `userknownhostsfile` path from `ssh -G`, in order (ssh consults
    /// each of them when verifying a key).
    pub user_known_hosts_all: Vec<String>,
    /// Every `globalknownhostsfile` path from `ssh -G`, in order.
    pub global_known_hosts_all: Vec<String>,
    pub hash_known_hosts: bool,
    /// ProxyJump / ProxyCommand in effect: ssh-keyscan can't follow them.
    pub proxied: bool,
}

/// Parse `ssh -G` (one lowercase `key value` per line).
pub(crate) fn parse_ssh_g(out: &str) -> ResolvedHost {
    let mut r = ResolvedHost {
        port: 22,
        ..Default::default()
    };
    for line in out.lines() {
        let Some((k, v)) = line.trim().split_once(' ') else {
            continue;
        };
        let v = v.trim();
        match k {
            "hostname" => r.hostname = v.to_string(),
            "user" => r.user = v.to_string(),
            "port" => r.port = v.parse().unwrap_or(22),
            "hostkeyalias" if v != "none" => r.host_key_alias = Some(v.to_string()),
            "userknownhostsfile" => {
                // Space-separated list; ssh writes new keys to the first,
                // but it checks EVERY one when verifying a server's key.
                let all: Vec<String> = v.split_whitespace().map(str::to_string).collect();
                r.user_known_hosts = all.first().cloned();
                r.user_known_hosts_all = all;
            }
            "globalknownhostsfile" => {
                r.global_known_hosts_all = v.split_whitespace().map(str::to_string).collect();
            }
            "hashknownhosts" => r.hash_known_hosts = v == "yes",
            "proxyjump" if v != "none" => r.proxied = true,
            "proxycommand" if v != "none" => r.proxied = true,
            _ => {}
        }
    }
    r
}

/// All `UserKnownHostsFile` paths resolved against `$HOME`, defaulting to
/// the ssh default (`~/.ssh/known_hosts`) when `ssh -G` printed nothing.
pub(crate) fn resolved_known_hosts_files(r: &ResolvedHost, home: &Path) -> Vec<PathBuf> {
    let raw: Vec<String> = if r.user_known_hosts_all.is_empty() {
        vec!["~/.ssh/known_hosts".to_string()]
    } else {
        r.user_known_hosts_all.clone()
    };
    raw.into_iter()
        .filter(|s| !s.is_empty() && s != "none")
        .map(|s| expand_home(&s, home))
        .collect()
}

/// Key types already stored for `name` across `files`, in the order ssh
/// would read them. Uses `ssh-keygen -F <name> -f <file>` so hashed hosts
/// are matched correctly. Lines that don't parse are skipped.
pub(crate) fn stored_key_types_in(name: &str, files: &[PathBuf]) -> Result<Vec<String>, String> {
    stored_key_types_with("ssh-keygen", name, files)
}

fn stored_key_types_with(
    keygen: &str,
    name: &str,
    files: &[PathBuf],
) -> Result<Vec<String>, String> {
    // Restrict the name to ssh/known_hosts characters including the
    // `[host]:port` bracket form and the IPv6 `::` separator. This never
    // reaches a shell — it's passed as an argv entry to ssh-keygen — but
    // we still refuse a leading '-' so it is never read as an option.
    if name.is_empty()
        || name.starts_with('-')
        || name.len() > 255
        || !name.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '%' | '[' | ']')
        })
    {
        return Ok(Vec::new());
    }
    let mut types = Vec::new();
    for file in files {
        if !file.exists() {
            continue;
        }
        let out = crate::proc::command(keygen)
            .arg("-F")
            .arg(name)
            .arg("-f")
            .arg(file)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|e| format!("ssh-keygen -F failed: {e}"))?;
        // `ssh-keygen -F` exits 0 when a match is found. The output interleaves
        // comment lines (`# Host <name> found: ...`) with the matching
        // known_hosts lines (`<name-pattern> <type> <base64> [comment]` or
        // `|1|salt|hmac <type> <base64> ...`).
        if !out.status.success() {
            continue;
        }
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            // `@cert-authority` / `@revoked` markers prepend one extra token.
            let mut parts = line.split_whitespace();
            let Some(first) = parts.next() else { continue };
            let kt = if first.starts_with('@') {
                // skip marker, then skip name, then take type
                parts.next();
                parts.next()
            } else {
                // skip name, then take type
                parts.next()
            };
            if let Some(kt) = kt {
                if KEY_TYPES.contains(&kt) && !types.iter().any(|t: &String| t == kt) {
                    types.push(kt.to_string());
                }
            }
        }
    }
    Ok(types)
}

/// Convenience: resolve `host` and return the key types already trusted
/// for it in the user's `UserKnownHostsFile`(s). An empty vector means the
/// host is not stored anywhere (a genuine first connect) OR that `ssh -G` /
/// `ssh-keygen` could not be run; callers that need to tell those apart
/// should use [`resolve`] + [`stored_key_types_in`] directly.
///
/// The result is cached per host string for the lifetime of the process so
/// that the per-call overhead on `ssh_exec` stays flat (every remote
/// op — read, list, git, watch — goes through `ssh_exec`). The cache is
/// cleared on explicit [`invalidate_stored_key_types_cache`], which the
/// trust-scan path calls after writing new entries so the next connect
/// picks up the freshly added algorithms.
pub(crate) fn stored_key_types_for(host: &str) -> Vec<String> {
    if let Some(cached) = cache_get(host) {
        return cached;
    }
    let types = compute_stored_key_types_for(host);
    cache_put(host, types.clone());
    types
}

fn compute_stored_key_types_for(host: &str) -> Vec<String> {
    let Ok(r) = resolve(host) else {
        return Vec::new();
    };
    let name = r.host_key_alias.as_deref().unwrap_or(&r.hostname);
    let full = known_hosts_name(name, r.port);
    let home = home_dir();
    let files = resolved_known_hosts_files(&r, &home);
    // Try both the port-qualified form (`[host]:port`) and the bare name:
    // ssh-keygen -F looks up either depending on how the entry was written.
    let mut types = stored_key_types_in(&full, &files).unwrap_or_default();
    if full != name {
        for t in stored_key_types_in(name, &files).unwrap_or_default() {
            if !types.iter().any(|x| x == &t) {
                types.push(t);
            }
        }
    }
    types
}

fn stored_cache() -> &'static Mutex<HashMap<String, Vec<String>>> {
    static C: std::sync::OnceLock<Mutex<HashMap<String, Vec<String>>>> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_get(host: &str) -> Option<Vec<String>> {
    stored_cache().lock().ok()?.get(host).cloned()
}

fn cache_put(host: &str, types: Vec<String>) {
    if let Ok(mut c) = stored_cache().lock() {
        c.insert(host.to_string(), types);
    }
}

/// Tests: pretend `host` has these key types stored.
#[cfg(test)]
pub(crate) fn seed_stored_key_types(host: &str, types: &[&str]) {
    cache_put(host, types.iter().map(|t| t.to_string()).collect());
}

/// Drop any cached known_hosts lookups: callers (e.g. [`trust_scan`]) must
/// invoke this after mutating known_hosts so later connects see the write.
pub(crate) fn invalidate_stored_key_types_cache() {
    if let Ok(mut c) = stored_cache().lock() {
        c.clear();
    }
}

/// `host` on the default port, `[host]:port` otherwise (ssh's own format).
pub(crate) fn known_hosts_name(name: &str, port: u16) -> String {
    if port == 22 {
        name.to_string()
    } else {
        format!("[{name}]:{port}")
    }
}

/// `SHA256:<base64, no padding>` of the decoded key blob.
pub(crate) fn fingerprint(blob: &[u8]) -> String {
    let digest = Sha256::digest(blob);
    format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)
    )
}

/// Parse `ssh-keyscan` stdout into (key type, base64 blob, fingerprint),
/// dropping comments, unknown key types and malformed lines. The blob's own
/// type string must match the declared type.
pub(crate) fn parse_keyscan(out: &str) -> Vec<(String, String, String)> {
    let mut keys = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(_name), Some(kt), Some(b64)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if !KEY_TYPES.contains(&kt) {
            continue;
        }
        let Ok(blob) = base64::engine::general_purpose::STANDARD.decode(b64) else {
            continue;
        };
        if blob_type(&blob) != Some(kt) {
            continue;
        }
        if keys
            .iter()
            .any(|(_, b, _): &(String, String, String)| b == b64)
        {
            continue;
        }
        keys.push((kt.to_string(), b64.to_string(), fingerprint(&blob)));
    }
    keys
}

/// The first SSH string in a key blob: its algorithm name.
fn blob_type(blob: &[u8]) -> Option<&str> {
    let len = u32::from_be_bytes(blob.get(..4)?.try_into().ok()?) as usize;
    std::str::from_utf8(blob.get(4..4 + len)?).ok()
}

/// Expand `~/` and `%d` (ssh's home-dir token) in a known_hosts path.
pub(crate) fn expand_home(path: &str, home: &Path) -> PathBuf {
    let home_s = home.to_string_lossy();
    let p = path.replace("%d", &home_s);
    if let Some(rest) = p.strip_prefix("~/") {
        home.join(rest)
    } else if p == "~" {
        home.to_path_buf()
    } else {
        PathBuf::from(p)
    }
}

/// A host name ssh-keyscan may be pointed at: DNS / IPv4 / IPv6 characters
/// only, never an option.
fn safe_scan_target(h: &str) -> bool {
    !h.is_empty()
        && !h.starts_with('-')
        && h.len() <= 255
        && h.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '%'))
}

pub(crate) fn resolve(host: &str) -> Result<ResolvedHost, String> {
    let dest = destination_args(host)?;
    let out = crate::proc::command("ssh")
        .arg("-G")
        .args(&dest)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run ssh -G: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ssh -G {host} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let mut r = parse_ssh_g(&String::from_utf8_lossy(&out.stdout));
    if r.hostname.is_empty() {
        // Old ssh without -G hostname: fall back to the typed host.
        r.hostname = parse_destination(host)?.host;
    }
    Ok(r)
}

/// A handle for a pending scan. Not a secret: the scanned lines never leave
/// this process, the user confirms them, and an id works once.
fn random_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let n = NEXT.fetch_add(1, Ordering::SeqCst);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{n}-{t:x}-{}", std::process::id())
}

/// Expand (and dedup) every `userknownhostsfile` + `globalknownhostsfile`
/// entry `ssh` would consult. The first user file is also the write target;
/// it is kept first so callers can rely on that invariant.
pub(crate) fn expanded_known_hosts_files(r: &ResolvedHost, home: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let user: Vec<String> = if r.user_known_hosts_all.is_empty() {
        r.user_known_hosts
            .clone()
            .map(|s| vec![s])
            .unwrap_or_else(|| vec!["~/.ssh/known_hosts".to_string()])
    } else {
        r.user_known_hosts_all.clone()
    };
    for p in user.iter().chain(r.global_known_hosts_all.iter()) {
        let path = expand_home(p, home);
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

/// What `existing_entries` found for a host name in `known_hosts`: either a
/// normal pinned key, or an explicit `@revoked` marker. The `file` is the
/// known_hosts path that matched (for messages / `ssh-keygen -R`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExistingEntry {
    pub file: PathBuf,
    pub revoked: bool,
}

/// Does any known_hosts file ssh would consult already contain an entry for
/// `name` (including hashed names)? Uses `ssh-keygen -F`, which also
/// recognises `|1|...` hashed lines; a `-f ... <name>` query that prints
/// `# Host <name> found: ... type REVOKED` tells us the key is revoked.
///
/// Files that do not exist are skipped silently. Any entry — revoked or not
/// — is reported, because a peer offering an unpinned algorithm (or offering
/// the explicitly revoked key) must not be shown as a first connection.
#[cfg(test)]
pub(crate) fn existing_entries(
    name: &str,
    files: &[PathBuf],
) -> Result<Vec<ExistingEntry>, String> {
    existing_entries_with("ssh-keygen", name, files)
}

fn existing_entries_with(
    keygen: &str,
    name: &str,
    files: &[PathBuf],
) -> Result<Vec<ExistingEntry>, String> {
    let mut hits = Vec::new();
    for file in files {
        if !file.exists() {
            continue;
        }
        let out = crate::proc::command(keygen)
            .arg("-F")
            .arg(name)
            .arg("-f")
            .arg(file)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|e| format!("ssh-keygen -F failed: {e}"))?;
        // ssh-keygen -F exits 0 and prints the matching line(s) when found,
        // and exits non-zero with no stdout when not. A `@revoked` or
        // `@cert-authority` marker is reflected both in the leading
        // `# Host ... found: ... type REVOKED` comment and in the printed
        // line itself (`@revoked <name> <type> <key>`).
        let text = String::from_utf8_lossy(&out.stdout);
        if !out.status.success() && text.trim().is_empty() {
            continue;
        }
        let text_lc = text.to_ascii_lowercase();
        let revoked = text_lc.contains("@revoked") || text_lc.contains("type revoked");
        // Any non-comment, non-blank line is a real entry (ssh-keygen -F
        // prints key lines even when it only matches via a hashed form).
        let has_entry = text
            .lines()
            .any(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'));
        if has_entry || revoked {
            hits.push(ExistingEntry {
                file: file.clone(),
                revoked,
            });
        }
    }
    Ok(hits)
}

/// Build the user-visible, `[hostkey-changed]`-prefixed error for a host
/// that is already pinned (or revoked) when the current peer offered a
/// different / revoked key. The frontend recognises the prefix and shows
/// the hard-stop message instead of the "first connection" accept dialog.
fn already_pinned_error(host: &str, name: &str, hits: &[ExistingEntry]) -> String {
    let any_revoked = hits.iter().any(|h| h.revoked);
    let where_ = hits
        .iter()
        .map(|h| h.file.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let lead = if any_revoked {
        format!(
            "'{host}' has a REVOKED host key entry in your known_hosts ({where_}). The server offered a key that is either revoked or does not match the pinned entries. \
             SparkDown will not connect and will not add the key."
        )
    } else {
        format!(
            "'{host}' is already pinned in your known_hosts ({where_}), but the server offered a key that does not match a pinned entry (for example, a key type you have not pinned). \
             The server's key may have been replaced, or the server was reconfigured. SparkDown will not connect and will not add the key."
        )
    };
    format!(
        "{code}{lead} Check with the server's administrator; only if the change is expected, remove the old entry with `ssh-keygen -R {name}` and connect again.",
        code = super::ssh::ERR_HOSTKEY_CHANGED,
    )
}

/// Scan `host`'s keys and remember them for [`trust_scan`].
pub fn scan(host: &str) -> Result<HostKeyScan, String> {
    let r = resolve(host)?;
    scan_resolved("ssh-keygen", host, &r, &home_dir())
}

/// `scan` after `ssh -G`: the part that decides, and can be tested without ssh.
fn scan_resolved(
    keygen: &str,
    host: &str,
    r: &ResolvedHost,
    home: &Path,
) -> Result<HostKeyScan, String> {
    if r.proxied {
        return Err(format!(
            "'{host}' goes through ProxyJump/ProxyCommand, which SparkDown can't scan. Run `ssh {host}` once in a terminal to check and accept its host key, then connect again."
        ));
    }
    if !safe_scan_target(&r.hostname) {
        return Err(format!("Can't scan host name '{}'.", r.hostname));
    }
    let name = known_hosts_name(r.host_key_alias.as_deref().unwrap_or(&r.hostname), r.port);
    let checked = expanded_known_hosts_files(r, home);
    // Before offering a scan: if any known_hosts file ssh would consult
    // already pins this host (any key type, including a `@revoked` marker),
    // refuse.
    let hits = existing_entries_with(keygen, &name, &checked)?;
    if !hits.is_empty() {
        return Err(already_pinned_error(host, &name, &hits));
    }
    let out = crate::proc::command("ssh-keyscan")
        .args(["-T", "8", "-p", &r.port.to_string(), "--", &r.hostname])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run ssh-keyscan: {e}"))?;
    let keys = parse_keyscan(&String::from_utf8_lossy(&out.stdout));
    if keys.is_empty() {
        return Err(format!(
            "Could not read any host key from {}:{}.",
            r.hostname, r.port
        ));
    }
    let file = expand_home(
        r.user_known_hosts
            .as_deref()
            .unwrap_or("~/.ssh/known_hosts"),
        home,
    );
    let lines: Vec<String> = keys
        .iter()
        .map(|(kt, b64, _)| format!("{name} {kt} {b64}"))
        .collect();
    let scan_id = random_id();
    let result = HostKeyScan {
        scan_id: scan_id.clone(),
        known_hosts_name: name.clone(),
        keys: keys
            .into_iter()
            .map(|(key_type, _, fingerprint)| ScannedKey {
                key_type,
                fingerprint,
            })
            .collect(),
        known_hosts_file: file.display().to_string(),
        hashed: r.hash_known_hosts,
    };
    if let Ok(mut p) = pending().lock() {
        p.insert(
            scan_id,
            PendingScan {
                name,
                lines,
                known_hosts_file: file,
                known_hosts_checked: checked,
                hashed: r.hash_known_hosts,
            },
        );
    }
    Ok(result)
}

/// Append the confirmed scan's lines to known_hosts (once; the id is spent).
pub fn trust_scan(scan_id: &str) -> Result<(), String> {
    trust_scan_with("ssh-keygen", scan_id)
}

fn trust_scan_with(keygen: &str, scan_id: &str) -> Result<(), String> {
    let scan = pending()
        .lock()
        .map_err(|_| "scan store unavailable".to_string())?
        .remove(scan_id)
        .ok_or_else(|| "That host-key scan expired. Connect again.".to_string())?;
    // Re-verify absence at append time: if a known_hosts entry for the host
    // appeared between `scan` and now (another window, another process, a
    // stale frontend reusing an old scan id), refuse. We never want
    // to append a second co-equal line to a host that is already pinned.
    let hits = existing_entries_with(keygen, &scan.name, &scan.known_hosts_checked)?;
    if !hits.is_empty() {
        return Err(already_pinned_error(&scan.name, &scan.name, &hits));
    }
    let lines = if scan.hashed {
        hash_lines(&scan.lines)?
    } else {
        scan.lines
    };
    let result = append_known_hosts(&scan.known_hosts_file, &lines);
    // The in-process cache of stored key types is now stale: a later
    // `ssh_exec` would miss the just-written algorithm and fail to pin it.
    invalidate_stored_key_types_cache();
    result
}

/// Drop a scan the user declined.
pub fn forget_scan(scan_id: &str) {
    if let Ok(mut p) = pending().lock() {
        p.remove(scan_id);
    }
}

/// Hash host names the way ssh does (`|1|salt|hmac`), via `ssh-keygen -H`
/// on a private temp copy, so the format is exactly ssh's.
pub(crate) fn hash_lines(lines: &[String]) -> Result<Vec<String>, String> {
    let dir = std::env::temp_dir().join(format!("sparkdown-kh-{}", random_id()));
    create_private_dir(&dir).map_err(|e| format!("temp dir: {e}"))?;
    let file = dir.join("known_hosts");
    let result = (|| {
        std::fs::write(&file, lines.join("\n") + "\n").map_err(|e| e.to_string())?;
        let st = crate::proc::command("ssh-keygen")
            .arg("-H")
            .arg("-f")
            .arg(&file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("failed to run ssh-keygen: {e}"))?;
        if !st.success() {
            return Err("ssh-keygen -H failed".to_string());
        }
        let text = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
        let out: Vec<String> = text
            .lines()
            .filter(|l| l.starts_with("|1|"))
            .map(str::to_string)
            .collect();
        if out.len() != lines.len() {
            return Err("ssh-keygen -H returned unexpected output".to_string());
        }
        Ok(out)
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Append `lines` to `file`, creating it (0600, parent 0700) if needed and
/// starting on a fresh line.
pub(crate) fn append_known_hosts(file: &Path, lines: &[String]) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = file.parent() {
        if !parent.exists() {
            create_private_dir(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
    }
    let needs_newline = std::fs::read(file)
        .map(|b| !b.is_empty() && !b.ends_with(b"\n"))
        .unwrap_or(false);
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(file)
        .map_err(|e| format!("{}: {e}", file.display()))?;
    let mut text = String::new();
    if needs_newline {
        text.push('\n');
    }
    for l in lines {
        text.push_str(l);
        text.push('\n');
    }
    f.write_all(text.as_bytes())
        .map_err(|e| format!("{}: {e}", file.display()))
}

#[tauri::command]
pub async fn remote_hostkey_scan(host: String) -> Result<HostKeyScan, String> {
    tauri::async_runtime::spawn_blocking(move || scan(&host))
        .await
        .map_err(|e| format!("scan task failed: {e}"))?
}

#[tauri::command]
pub async fn remote_hostkey_trust(scan_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || trust_scan(&scan_id))
        .await
        .map_err(|e| format!("trust task failed: {e}"))?
}

#[tauri::command]
pub fn remote_hostkey_forget(scan_id: String) {
    forget_scan(&scan_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED_LINE: &str = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

    #[test]
    fn ssh_g_output_resolves_name_port_alias_and_policy() {
        let out = "user me\nhostname 10.0.0.5\nport 2222\nhostkeyalias none\n\
                   userknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\n\
                   hashknownhosts yes\nproxyjump none\nidentityfile ~/.ssh/id_ed25519\n";
        let r = parse_ssh_g(out);
        assert_eq!(r.hostname, "10.0.0.5");
        assert_eq!(r.port, 2222);
        assert_eq!(r.host_key_alias, None);
        assert_eq!(r.user_known_hosts.as_deref(), Some("~/.ssh/known_hosts"));
        assert_eq!(
            r.user_known_hosts_all,
            vec![
                "~/.ssh/known_hosts".to_string(),
                "~/.ssh/known_hosts2".to_string(),
            ]
        );
        assert!(r.hash_known_hosts);
        assert!(!r.proxied);
        let r = parse_ssh_g("hostname h\nport 22\nproxyjump bastion\nhostkeyalias box1\n");
        assert!(r.proxied);
        assert_eq!(r.host_key_alias.as_deref(), Some("box1"));
        assert!(!r.hash_known_hosts);
        assert!(parse_ssh_g("hostname h\nproxycommand nc %h %p\n").proxied);
    }

    #[test]
    fn known_hosts_names_follow_ssh_format() {
        assert_eq!(known_hosts_name("example.com", 22), "example.com");
        assert_eq!(known_hosts_name("127.0.0.1", 2222), "[127.0.0.1]:2222");
        assert_eq!(known_hosts_name("::1", 2200), "[::1]:2200");
    }

    #[test]
    fn keyscan_output_is_filtered_and_fingerprinted() {
        let out = format!(
            "# github.com:22 SSH-2.0-babeld\n{ED_LINE}\n{ED_LINE}\n\
             github.com ssh-dss AAAAB3NzaC1kc3MAAACBAP\n\
             github.com ssh-rsa AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n\
             github.com ssh-ed25519 !!notbase64!!\n"
        );
        let keys = parse_keyscan(&out);
        // One ed25519 (deduped); the dss type, the rsa line whose blob is
        // really ed25519, and the garbage line are all dropped.
        assert_eq!(keys.len(), 1, "{keys:?}");
        assert_eq!(keys[0].0, "ssh-ed25519");
        // GitHub's published ed25519 fingerprint.
        assert_eq!(
            keys[0].2,
            "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"
        );
    }

    #[test]
    fn expands_home_tokens() {
        let home = Path::new("/home/u");
        assert_eq!(
            expand_home("~/.ssh/known_hosts", home),
            PathBuf::from("/home/u/.ssh/known_hosts")
        );
        assert_eq!(
            expand_home("%d/.ssh/kh", home),
            PathBuf::from("/home/u/.ssh/kh")
        );
        assert_eq!(expand_home("/etc/kh", home), PathBuf::from("/etc/kh"));
    }

    #[test]
    fn scan_targets_reject_options_and_metacharacters() {
        assert!(safe_scan_target("example.com"));
        assert!(safe_scan_target("::1"));
        assert!(!safe_scan_target("-oProxyCommand=x"));
        assert!(!safe_scan_target("a;b"));
        assert!(!safe_scan_target("a b"));
        assert!(!safe_scan_target(""));
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sd-hk-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn append_creates_private_file_and_keeps_existing_lines() {
        let dir = tmp("append");
        let file = dir.join(".ssh").join("known_hosts");
        append_known_hosts(&file, &["a ssh-ed25519 AAAA".into()]).unwrap();
        // A file without a trailing newline still gets a clean new line.
        std::fs::write(&file, "a ssh-ed25519 AAAA").unwrap();
        append_known_hosts(&file, &["[b]:2222 ssh-ed25519 BBBB".into()]).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "a ssh-ed25519 AAAA\n[b]:2222 ssh-ed25519 BBBB\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dmode = std::fs::metadata(dir.join(".ssh"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(dmode & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Hashed lines are ssh's own format: `ssh-keygen -F` finds the host.
    #[test]
    fn hashed_lines_are_found_by_ssh_keygen() {
        let probe = crate::proc::command("ssh-keygen").arg("-?").output();
        if probe.is_err() {
            return; // no OpenSSH here
        }
        let line = ED_LINE.replacen("github.com", "[127.0.0.1]:2222", 1);
        let hashed = hash_lines(&[line]).unwrap();
        assert_eq!(hashed.len(), 1);
        assert!(hashed[0].starts_with("|1|"), "{}", hashed[0]);
        assert!(!hashed[0].contains("127.0.0.1"));
        let dir = tmp("hash");
        let file = dir.join("known_hosts");
        append_known_hosts(&file, &hashed).unwrap();
        let out = crate::proc::command("ssh-keygen")
            .args(["-F", "[127.0.0.1]:2222", "-f"])
            .arg(&file)
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("ssh-ed25519"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[serial_test::serial(hostkey_cache)]
    fn a_scan_id_is_spent_once_and_unknown_ids_fail() {
        let dir = tmp("trust");
        let file = dir.join("known_hosts");
        let id = random_id();
        pending().lock().unwrap().insert(
            id.clone(),
            PendingScan {
                name: "[h]:2".into(),
                lines: vec!["[h]:2 ssh-ed25519 AAAA".into()],
                known_hosts_file: file.clone(),
                // Empty: no pre-existing file to re-check. The file about to
                // be written does not yet exist, so re-verification passes.
                known_hosts_checked: vec![file.clone()],
                hashed: false,
            },
        );
        // A lookup cached before the write must not outlive it.
        seed_stored_key_types("[h]:2", &["ssh-rsa"]);
        trust_scan(&id).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "[h]:2 ssh-ed25519 AAAA\n"
        );
        assert_eq!(
            cache_get("[h]:2"),
            None,
            "trusting a key drops cached key types"
        );
        assert!(trust_scan(&id).is_err(), "an id works once");
        assert!(trust_scan("nope").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ssh_g_collects_all_known_hosts_files() {
        let out = "hostname h\nport 22\n\
                   userknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\n\
                   globalknownhostsfile /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2\n";
        let r = parse_ssh_g(out);
        assert_eq!(r.user_known_hosts.as_deref(), Some("~/.ssh/known_hosts"));
        assert_eq!(
            r.user_known_hosts_all,
            vec![
                "~/.ssh/known_hosts".to_string(),
                "~/.ssh/known_hosts2".to_string()
            ]
        );
        assert_eq!(
            r.global_known_hosts_all,
            vec![
                "/etc/ssh/ssh_known_hosts".to_string(),
                "/etc/ssh/ssh_known_hosts2".to_string()
            ]
        );
        let files = expanded_known_hosts_files(&r, Path::new("/home/u"));
        assert_eq!(
            files,
            vec![
                PathBuf::from("/home/u/.ssh/known_hosts"),
                PathBuf::from("/home/u/.ssh/known_hosts2"),
                PathBuf::from("/etc/ssh/ssh_known_hosts"),
                PathBuf::from("/etc/ssh/ssh_known_hosts2"),
            ]
        );
    }

    /// A host already pinned (any key type) is NOT a first connection:
    /// `existing_entries` must find it so `scan` / `trust_scan` can refuse.
    #[test]
    fn existing_entries_detect_pinned_and_revoked_hosts_including_hashed() {
        let probe = crate::proc::command("ssh-keygen").arg("-?").output();
        if probe.is_err() {
            return; // no OpenSSH here
        }
        let dir = tmp("exist-hashed");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let plain = dir.join("plain");
        // One pinned RSA line (hypothetical key material: ssh-keygen -F does
        // not care about the key blob, only the name match).
        std::fs::write(
            &plain,
            "example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ\n",
        )
        .unwrap();
        let hits = existing_entries("example.com", &[plain]).unwrap();
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(!hits[0].revoked);

        // A hashed line (|1|...) must still be found by `ssh-keygen -F`.
        let hashed_file = dir.join("hashed");
        let line = ED_LINE.replacen("github.com", "pinned.example", 1);
        let hashed = hash_lines(&[line]).unwrap();
        append_known_hosts(&hashed_file, &hashed).unwrap();
        let hits = existing_entries("pinned.example", &[hashed_file]).unwrap();
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(!hits[0].revoked);

        // A `@revoked` marker is reported with `revoked=true`.
        let revoked_file = dir.join("revoked");
        std::fs::write(
            &revoked_file,
            "@revoked revoked.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
        )
        .unwrap();
        let hits = existing_entries("revoked.example", &[revoked_file]).unwrap();
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].revoked, "{hits:?}");

        // A clean file / unknown host returns nothing.
        let empty = dir.join("empty");
        std::fs::write(&empty, "").unwrap();
        assert!(existing_entries("nope.example", &[empty])
            .unwrap()
            .is_empty());
        // A path that does not exist is simply skipped.
        let missing = dir.join("does-not-exist");
        assert!(existing_entries("example.com", &[missing])
            .unwrap()
            .is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// If a host is already pinned, `trust_scan` must refuse to append a
    /// second co-equal line. The error must carry the `[hostkey-changed]`
    /// code so the UI shows the hard-stop message instead of the "first
    /// connection" dialog.
    #[test]
    fn trust_scan_refuses_when_an_entry_appeared_between_scan_and_trust() {
        let probe = crate::proc::command("ssh-keygen").arg("-?").output();
        if probe.is_err() {
            return;
        }
        let dir = tmp("retrust");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("known_hosts");
        // A pre-existing pinned RSA line for the host.
        std::fs::write(&file, "pinned.example ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB\n").unwrap();
        let id = random_id();
        pending().lock().unwrap().insert(
            id.clone(),
            PendingScan {
                name: "pinned.example".into(),
                // The ed25519 line the frontend thought
                // we were about to append.
                lines: vec!["pinned.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl".to_string()],
                known_hosts_file: file.clone(),
                known_hosts_checked: vec![file.clone()],
                hashed: false,
            },
        );
        let err = trust_scan(&id).unwrap_err();
        assert!(
            err.starts_with(super::super::ssh::ERR_HOSTKEY_CHANGED),
            "{err}"
        );
        // And the file is unchanged.
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "pinned.example ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `stored_key_types_in` finds every stored key type for a host across
    /// multiple known_hosts files, including hashed and `@cert-authority`
    /// lines, and reports nothing for a host that isn't present.
    #[test]
    fn stored_key_types_reads_all_known_hosts_files() {
        let probe = crate::proc::command("ssh-keygen").arg("-?").output();
        if probe.is_err() {
            return; // no OpenSSH here
        }
        let dir = tmp("stored");
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("known_hosts_a");
        let b = dir.join("known_hosts_b");
        std::fs::write(
            &a,
            "example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
        )
        .unwrap();
        std::fs::write(
            &b,
            "@cert-authority example.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSmVjQmlFd/5EgT5uTE4RNVYsiOIa0bq6EXCeiiTeVZeVC1y3P/Yj8h5fS2A8rC9UzSdq6R2EH6nM4LxJg3U=\n",
        )
        .unwrap();
        let types = stored_key_types_in("example.com", &[a.clone(), b.clone()]).unwrap();
        assert!(types.iter().any(|t| t == "ssh-ed25519"), "{types:?}");
        assert!(
            types.iter().any(|t| t == "ecdsa-sha2-nistp256"),
            "{types:?}"
        );
        // Hosts that are not in any file produce nothing.
        assert!(stored_key_types_in("never-stored.example", &[a, b])
            .unwrap()
            .is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Verify that existing_entries finds pinned hosts (called by scan() at line 524).
    #[test]
    fn existing_entries_detect_pinned_hosts() {
        let probe = crate::proc::command("ssh-keygen").arg("-?").output();
        if probe.is_err() {
            return; // no OpenSSH here
        }
        let dir = tmp("scan-refuse");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let kh = dir.join("known_hosts");
        std::fs::write(
            &kh,
            "example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
        )
        .unwrap();
        let hits = existing_entries("example.com", std::slice::from_ref(&kh)).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(!hits[0].revoked);
        let _ = std::fs::remove_dir_all(&dir);
    }

    const NO_KEYGEN: &str = "/nonexistent-dir/ssh-keygen";

    #[test]
    fn existing_entries_fail_closed_when_ssh_keygen_cannot_run() {
        let dir = tmp("keygen-missing-a");
        std::fs::create_dir_all(&dir).unwrap();
        let kh = dir.join("known_hosts");
        std::fs::write(&kh, "host ssh-ed25519 AAAA\n").unwrap();
        let err = existing_entries_with(NO_KEYGEN, "host", std::slice::from_ref(&kh)).unwrap_err();
        assert!(err.contains("ssh-keygen"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stored_key_types_fail_closed_when_ssh_keygen_cannot_run() {
        let dir = tmp("keygen-missing-b");
        std::fs::create_dir_all(&dir).unwrap();
        let kh = dir.join("known_hosts");
        std::fs::write(&kh, "host ssh-ed25519 AAAA\n").unwrap();
        let err = stored_key_types_with(NO_KEYGEN, "host", std::slice::from_ref(&kh)).unwrap_err();
        assert!(err.contains("ssh-keygen"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn resolved_with(files: &str, host: &str) -> ResolvedHost {
        parse_ssh_g(&format!(
            "hostname {host}\nport 22\nuserknownhostsfile {files}\nglobalknownhostsfile /nonexistent-dir/none\n"
        ))
    }

    /// `scan()`'s own decision: an already-pinned host is a hard stop and
    /// never reaches ssh-keyscan.
    #[test]
    fn scan_refuses_a_pinned_host_before_scanning() {
        let dir = tmp("scan-pinned");
        std::fs::create_dir_all(&dir).unwrap();
        let kh = dir.join("known_hosts");
        std::fs::write(
            &kh,
            "pinned.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
        )
        .unwrap();
        let r = resolved_with(kh.to_str().unwrap(), "pinned.example");
        let err = scan_resolved("ssh-keygen", "pinned", &r, &dir).unwrap_err();
        assert!(
            err.starts_with(super::super::ssh::ERR_HOSTKEY_CHANGED),
            "{err}"
        );
        assert!(err.contains("already pinned"), "{err}");

        let rev = dir.join("revoked");
        std::fs::write(
            &rev,
            "@revoked gone.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
        )
        .unwrap();
        let r = resolved_with(rev.to_str().unwrap(), "gone.example");
        let err = scan_resolved("ssh-keygen", "gone", &r, &dir).unwrap_err();
        assert!(
            err.starts_with(super::super::ssh::ERR_HOSTKEY_CHANGED),
            "{err}"
        );
        assert!(err.contains("REVOKED"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A missing ssh-keygen is an error, not a first connect: scan() must
    /// stop before ssh-keyscan and say why.
    #[test]
    fn scan_fails_closed_when_ssh_keygen_cannot_run() {
        let dir = tmp("scan-nokeygen");
        std::fs::create_dir_all(&dir).unwrap();
        let kh = dir.join("known_hosts");
        std::fs::write(&kh, "other.example ssh-ed25519 AAAA\n").unwrap();
        let r = resolved_with(kh.to_str().unwrap(), "new.example");
        let err = scan_resolved(NO_KEYGEN, "new", &r, &dir).unwrap_err();
        assert!(err.contains("ssh-keygen -F failed"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trust_scan_fails_closed_when_ssh_keygen_cannot_run() {
        let dir = tmp("trust-nokeygen");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("known_hosts");
        std::fs::write(&file, "other.example ssh-ed25519 AAAA\n").unwrap();
        let id = random_id();
        pending().lock().unwrap().insert(
            id.clone(),
            PendingScan {
                name: "new.example".into(),
                lines: vec!["new.example ssh-ed25519 AAAA".into()],
                known_hosts_file: file.clone(),
                known_hosts_checked: vec![file.clone()],
                hashed: false,
            },
        );
        let err = trust_scan_with(NO_KEYGEN, &id).unwrap_err();
        assert!(err.contains("ssh-keygen -F failed"), "{err}");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "other.example ssh-ed25519 AAAA\n",
            "nothing may be appended"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
