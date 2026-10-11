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
    lines: Vec<String>,
    known_hosts_file: PathBuf,
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
    pub hostname: String,
    pub port: u16,
    pub host_key_alias: Option<String>,
    pub user_known_hosts: Option<String>,
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
            "port" => r.port = v.parse().unwrap_or(22),
            "hostkeyalias" if v != "none" => r.host_key_alias = Some(v.to_string()),
            "userknownhostsfile" => {
                // Space-separated list; ssh writes new keys to the first.
                r.user_known_hosts = v.split_whitespace().next().map(str::to_string)
            }
            "hashknownhosts" => r.hash_known_hosts = v == "yes",
            "proxyjump" if v != "none" => r.proxied = true,
            "proxycommand" if v != "none" => r.proxied = true,
            _ => {}
        }
    }
    r
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

fn resolve(host: &str) -> Result<ResolvedHost, String> {
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

/// Scan `host`'s keys and remember them for [`trust_scan`].
pub fn scan(host: &str) -> Result<HostKeyScan, String> {
    let r = resolve(host)?;
    if r.proxied {
        return Err(format!(
            "'{host}' goes through ProxyJump/ProxyCommand, which SparkDown can't scan. Run `ssh {host}` once in a terminal to check and accept its host key, then connect again."
        ));
    }
    if !safe_scan_target(&r.hostname) {
        return Err(format!("Can't scan host name '{}'.", r.hostname));
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
    let name = known_hosts_name(r.host_key_alias.as_deref().unwrap_or(&r.hostname), r.port);
    let home = home_dir();
    let file = expand_home(
        r.user_known_hosts
            .as_deref()
            .unwrap_or("~/.ssh/known_hosts"),
        &home,
    );
    let lines = keys
        .iter()
        .map(|(kt, b64, _)| format!("{name} {kt} {b64}"))
        .collect();
    let scan_id = random_id();
    let result = HostKeyScan {
        scan_id: scan_id.clone(),
        known_hosts_name: name,
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
                lines,
                known_hosts_file: file,
                hashed: r.hash_known_hosts,
            },
        );
    }
    Ok(result)
}

/// Append the confirmed scan's lines to known_hosts (once; the id is spent).
pub fn trust_scan(scan_id: &str) -> Result<(), String> {
    let scan = pending()
        .lock()
        .map_err(|_| "scan store unavailable".to_string())?
        .remove(scan_id)
        .ok_or_else(|| "That host-key scan expired. Connect again.".to_string())?;
    let lines = if scan.hashed {
        hash_lines(&scan.lines)?
    } else {
        scan.lines
    };
    append_known_hosts(&scan.known_hosts_file, &lines)
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
    fn a_scan_id_is_spent_once_and_unknown_ids_fail() {
        let dir = tmp("trust");
        let file = dir.join("known_hosts");
        let id = random_id();
        pending().lock().unwrap().insert(
            id.clone(),
            PendingScan {
                lines: vec!["[h]:2 ssh-ed25519 AAAA".into()],
                known_hosts_file: file.clone(),
                hashed: false,
            },
        );
        trust_scan(&id).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "[h]:2 ssh-ed25519 AAAA\n"
        );
        assert!(trust_scan(&id).is_err(), "an id works once");
        assert!(trust_scan("nope").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
