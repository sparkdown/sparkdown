//! Auto-update, kept small on purpose.
//!
//! No HTTP/TLS crates: the network goes through the system `curl` (macOS,
//! every target Linux, and Windows 10+ ship it), always over HTTPS. What
//! makes an update trustworthy is not the transport but the signature: every
//! artifact is signed with the maintainer's minisign key (`tauri signer
//! sign`, same format as the Tauri updater), and is verified here with
//! `minisign-verify` against the public key compiled into the app
//! (`src-tauri/updater-pubkey.txt`) before anything touches the install.
//!
//! Flow (driven by frontend/src/updater.ts):
//! 1. `update_support`: is the key real, and how does this build install?
//! 2. `update_check`: fetch `latest.json`, compare versions.
//! 3. `update_download`: download + verify (size when announced, signature,
//!    signed version).
//! 4. `update_install`: swap the new bundle / AppImage into place (only after
//!    the frontend's unsaved-changes flow has passed).
//! 5. `update_restart`: relaunch the new version and exit.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// The update manifest (the Tauri updater's `latest.json` format).
pub const ENDPOINT: &str =
    "https://github.com/sparkdown/sparkdown/releases/latest/download/latest.json";
/// Where "Download" sends users whose install can't update itself.
pub const RELEASES_PAGE: &str = "https://github.com/sparkdown/sparkdown/releases/latest";
/// The literal content of updater-pubkey.txt until the owner pastes the key.
pub const PUBKEY_PLACEHOLDER: &str = "REPLACE_WITH_UPDATER_PUBLIC_KEY";
/// Updater public key: the content of `~/.tauri/sparkdown-updater.key.pub`
/// (base64 of a minisign public key file). scripts/release.sh reads the
/// same file to check the release signatures.
const PUBKEY: &str = include_str!("../updater-pubkey.txt");

/// Event carrying a [`DownloadProgress`] while an artifact downloads.
pub const PROGRESS_EVENT: &str = "update-progress";

const MANIFEST_TIMEOUT_SECS: u64 = 30;
const MANIFEST_MAX_BYTES: u64 = 1024 * 1024;
const ARTIFACT_TIMEOUT_SECS: u64 = 15 * 60;
const ARTIFACT_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// Slack on top of the manifest's `size` for curl's `--max-filesize`; the
/// exact length is checked after the download.
const SIZE_MARGIN_BYTES: u64 = 64 * 1024;
/// Prefix of our staging dirs, created next to the install target.
const STAGING_PREFIX: &str = ".sparkdown-update-";

// ------------------------------------------------------------ versions ----

/// A semantic version (MAJOR.MINOR.PATCH[-pre][+build]); build metadata is
/// ignored for ordering, as semver specifies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    core: [u64; 3],
    pre: Vec<String>,
}

impl Version {
    pub fn parse(s: &str) -> Option<Version> {
        let s = s.trim();
        let s = s.strip_prefix('v').unwrap_or(s);
        let s = s.split('+').next()?;
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (s, None),
        };
        let mut parts = core.split('.');
        let mut out = [0u64; 3];
        for slot in &mut out {
            let p = parts.next()?;
            if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            *slot = p.parse().ok()?;
        }
        if parts.next().is_some() {
            return None;
        }
        let pre = match pre {
            Some(p) => {
                let ids: Vec<String> = p.split('.').map(str::to_owned).collect();
                if ids.iter().any(|i| i.is_empty()) {
                    return None;
                }
                ids
            }
            None => vec![],
        };
        Some(Version { core: out, pre })
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.core.cmp(&other.core).then_with(|| {
            // A release sorts after its pre-releases.
            match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => cmp_pre(&self.pre, &other.pre),
            }
        })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn cmp_pre(a: &[String], b: &[String]) -> Ordering {
    for (x, y) in a.iter().zip(b) {
        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(m), Ok(n)) => m.cmp(&n),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => x.cmp(y),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    a.len().cmp(&b.len())
}

/// True only when `remote` parses and is strictly newer than `current`
/// (never installs the same or an older version).
pub fn is_newer(remote: &str, current: &str) -> bool {
    match (Version::parse(remote), Version::parse(current)) {
        (Some(r), Some(c)) => r > c,
        _ => false,
    }
}

// ------------------------------------------------------------ manifest ----

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub platforms: HashMap<String, PlatformEntry>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PlatformEntry {
    pub signature: String,
    pub url: String,
    /// Artifact length in bytes (written by scripts/release.sh). Optional:
    /// older manifests have none, and then progress shows MB only and the
    /// download is capped at `ARTIFACT_MAX_BYTES`.
    #[serde(default)]
    pub size: Option<u64>,
}

pub fn parse_manifest(json: &str) -> Result<Manifest, String> {
    let m: Manifest =
        serde_json::from_str(json).map_err(|e| format!("invalid update manifest: {e}"))?;
    if Version::parse(&m.version).is_none() {
        return Err(format!("invalid version in update manifest: {}", m.version));
    }
    Ok(m)
}

/// Manifest keys to look up for this platform, most specific first (the
/// Tauri convention: `{os}-{arch}-{installer}`, then `{os}-{arch}`).
pub fn platform_keys(os: &str, arch: &str, install: InstallKind) -> Vec<String> {
    let os = match os {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        _ => return vec![],
    };
    let base = format!("{os}-{arch}");
    let mut keys = vec![];
    match install {
        InstallKind::AppImage => keys.push(format!("{base}-appimage")),
        InstallKind::App => keys.push(format!("{base}-app")),
        _ => {}
    }
    keys.push(base);
    keys
}

pub fn select_platform<'a>(m: &'a Manifest, keys: &[String]) -> Option<&'a PlatformEntry> {
    keys.iter().find_map(|k| m.platforms.get(k))
}

// ----------------------------------------------------------- signature ----

/// Standard base64 (with or without padding). minisign-verify keeps its own
/// decoder private, and this is all we need it for.
pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    }
    let bytes: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let body = bytes
        .strip_suffix(b"==")
        .or_else(|| bytes.strip_suffix(b"="))
        .unwrap_or(&bytes);
    if body.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    for chunk in body.chunks(4) {
        let mut acc = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            acc |= val(c)? << (18 - 6 * i);
        }
        let n = chunk.len() - 1;
        out.extend_from_slice(&acc.to_be_bytes()[1..1 + n]);
    }
    Some(out)
}

/// Decode a Tauri-format public key (base64 of the minisign `.pub` file).
pub fn parse_pubkey(key: &str) -> Option<minisign_verify::PublicKey> {
    let key = key.trim();
    if key.is_empty() || key == PUBKEY_PLACEHOLDER {
        return None;
    }
    let text = String::from_utf8(base64_decode(key)?).ok()?;
    minisign_verify::PublicKey::decode(&text).ok()
}

/// Read `version:` from a signature's trusted comment, which `tauri signer
/// sign --app-version` writes as tab-separated `key:value` pairs.
pub fn signed_version(trusted_comment: &str) -> Option<&str> {
    trusted_comment
        .split('\t')
        .find_map(|kv| kv.strip_prefix("version:"))
        .map(str::trim)
}

/// Verify `path` against a Tauri-format `.sig` (base64 of the minisign
/// signature file) and require that the signature was made for
/// `expected_version`. The trusted comment is covered by minisign's global
/// signature, so it is only read after `finalize()` succeeds. Requiring the
/// signed version stops a tampered manifest from pairing a new version number
/// with an older (validly signed) release.
pub fn verify_file(
    path: &Path,
    signature_b64: &str,
    pubkey: &minisign_verify::PublicKey,
    expected_version: &str,
) -> Result<(), String> {
    let sig_text = base64_decode(signature_b64)
        .and_then(|b| String::from_utf8(b).ok())
        .ok_or("update signature is not valid base64")?;
    let sig = minisign_verify::Signature::decode(&sig_text)
        .map_err(|e| format!("update signature is malformed: {e}"))?;
    let mut verifier = pubkey
        .verify_stream(&sig)
        .map_err(|e| format!("update signature does not match the app's key: {e}"))?;
    let mut file = fs::File::open(path).map_err(|e| format!("cannot read the update: {e}"))?;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("cannot read the update: {e}"))?;
        if n == 0 {
            break;
        }
        verifier.update(&buf[..n]);
    }
    verifier
        .finalize()
        .map_err(|_| "update signature verification failed".to_owned())?;
    let signed =
        signed_version(sig.trusted_comment()).ok_or("update signature does not name a version")?;
    match (Version::parse(signed), Version::parse(expected_version)) {
        (Some(s), Some(e)) if s == e => Ok(()),
        _ => Err(format!(
            "update was signed for version {signed}, but {expected_version} was announced"
        )),
    }
}

// ---------------------------------------------------------------- curl ----

/// argv for one HTTPS download (without the program name). HTTPS only, also
/// for redirects (GitHub redirects release assets to its CDN); the URL goes
/// through `--url` so it can never be read as an option.
pub fn curl_args(url: &str, out: &Path, max_time_secs: u64, max_bytes: u64) -> Vec<OsString> {
    let mut v: Vec<OsString> = [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--tlsv1.2",
        "--connect-timeout",
        "15",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    v.push("--max-time".into());
    v.push(max_time_secs.to_string().into());
    v.push("--max-filesize".into());
    v.push(max_bytes.to_string().into());
    v.push("--user-agent".into());
    v.push(format!("SparkDown/{}", env!("CARGO_PKG_VERSION")).into());
    v.push("--output".into());
    v.push(out.as_os_str().to_owned());
    v.push("--url".into());
    v.push(url.into());
    v
}

fn curl_program() -> &'static str {
    if cfg!(windows) {
        "curl.exe"
    } else if Path::new("/usr/bin/curl").exists() {
        // Absolute path on macOS / most Linux: no PATH lookup.
        "/usr/bin/curl"
    } else {
        "curl"
    }
}

/// Download `url` to `out` with the system curl. Blocking: call it off the
/// main thread. Reports the bytes written so far to `on_progress`; kills
/// curl if it outlives its own `--max-time` by a margin.
fn download(
    url: &str,
    out: &Path,
    max_time_secs: u64,
    max_bytes: u64,
    mut on_progress: impl FnMut(u64),
) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err(format!("refusing a non-HTTPS update URL: {url}"));
    }
    let _ = fs::remove_file(out);
    let mut cmd = crate::proc::command(curl_program());
    cmd.args(curl_args(url, out, max_time_secs, max_bytes))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("cannot run curl: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(max_time_secs + 15);
    let mut last = 0;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => return Err(format!("curl failed: {e}")),
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(out);
            return Err("the download timed out".to_owned());
        }
        if let Ok(meta) = fs::metadata(out) {
            if meta.len() != last {
                last = meta.len();
                on_progress(last);
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    if status.success() {
        if let Ok(meta) = fs::metadata(out) {
            on_progress(meta.len());
        }
        return Ok(());
    }
    let mut err = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut err);
    }
    let _ = fs::remove_file(out);
    let err = err.trim();
    Err(if err.is_empty() {
        format!("curl exited with {status}")
    } else {
        err.to_owned()
    })
}

/// Payload of `PROGRESS_EVENT`: bytes on disk so far, and the expected total
/// when the manifest gives one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DownloadProgress {
    pub received: u64,
    pub total: Option<u64>,
}

/// curl's `--max-filesize` for an artifact: the announced size plus a small
/// margin, or the generic cap when the manifest has no size.
pub fn artifact_limit(size: Option<u64>) -> Result<u64, String> {
    match size {
        None => Ok(ARTIFACT_MAX_BYTES),
        Some(0) => Err("the update manifest gives a size of 0 bytes".to_owned()),
        Some(s) if s > ARTIFACT_MAX_BYTES => Err(format!(
            "the update is too large ({s} bytes; the limit is {ARTIFACT_MAX_BYTES})"
        )),
        Some(s) => Ok(s + SIZE_MARGIN_BYTES),
    }
}

/// Reject a download whose length is not the announced size (a truncated or
/// swapped file), before spending time on the signature. No size: no check.
pub fn check_size(path: &Path, expected: Option<u64>) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let len = fs::metadata(path)
        .map_err(|e| format!("cannot read the update: {e}"))?
        .len();
    if len == expected {
        Ok(())
    } else {
        Err(format!(
            "the update is {len} bytes, but the manifest says {expected}"
        ))
    }
}

/// How `stage_update` gets the artifact: `(url, out, max_bytes, on_bytes)`.
/// The app passes the curl download; tests pass a local copy.
pub type Fetch<'a> = dyn FnOnce(&str, &Path, u64, &mut dyn FnMut(u64)) -> Result<(), String> + 'a;

/// Download `entry` into a fresh staging dir next to `target`, then check its
/// size and signature. Returns `(staging dir, artifact)`; on any failure the
/// staging dir is removed and nothing else on disk has changed.
pub fn stage_update(
    target: &Path,
    entry: &PlatformEntry,
    version: &str,
    pubkey: &minisign_verify::PublicKey,
    fetch: Box<Fetch<'_>>,
    mut on_progress: impl FnMut(DownloadProgress),
) -> Result<(PathBuf, PathBuf), String> {
    let limit = artifact_limit(entry.size)?;
    if let Some(parent) = target.parent() {
        sweep_staging(parent);
    }
    let staging = create_staging(target).map_err(|e| e.to_string())?;
    let file = staging.join("download");
    let total = entry.size;
    let res = fetch(&entry.url, &file, limit, &mut |received| {
        on_progress(DownloadProgress { received, total })
    })
    .and_then(|()| check_size(&file, entry.size))
    .and_then(|()| verify_file(&file, &entry.signature, pubkey, version));
    match res {
        Ok(()) => Ok((staging, file)),
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            Err(e)
        }
    }
}

// -------------------------------------------------------- install kind ----

/// How an update gets onto this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallKind {
    /// macOS .app in a folder we can write: swap the bundle in place.
    App,
    /// Linux AppImage in a folder we can write: replace the file.
    AppImage,
    /// Linux .deb / AUR / other system package: the package manager owns the
    /// files; we only say an update exists.
    PackageManager,
    /// Show the update and a link to the release page (Windows, a read-only
    /// /Applications, a translocated or DMG-mounted app, a dev build).
    Manual,
}

/// The install kind from the OS and `APPIMAGE` (set by the AppImage runtime
/// to the running AppImage), before checking the target is writable.
pub fn install_kind(os: &str, appimage: Option<&OsStr>) -> InstallKind {
    match os {
        "macos" => InstallKind::App,
        "linux" => match appimage {
            Some(p) if !p.is_empty() => InstallKind::AppImage,
            _ => InstallKind::PackageManager,
        },
        _ => InstallKind::Manual,
    }
}

/// The .app bundle containing `exe` (…/X.app/Contents/MacOS/x).
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let ok = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    ok.then(|| bundle.to_path_buf())
}

/// What an update replaces: the .app bundle or the AppImage file.
fn install_target(kind: InstallKind) -> Option<PathBuf> {
    match kind {
        InstallKind::App => bundle_of(&std::env::current_exe().ok()?),
        InstallKind::AppImage => std::env::var_os("APPIMAGE").map(PathBuf::from),
        _ => None,
    }
}

/// Create a fresh staging dir next to `target` (same filesystem, so the
/// final rename is atomic). Fails when the folder is not writable.
fn create_staging(target: &Path) -> io::Result<PathBuf> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("install target has no parent folder"))?;
    let dir = parent.join(format!("{STAGING_PREFIX}{}", std::process::id()));
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    fs::create_dir(&dir)?;
    Ok(dir)
}

/// Remove staging dirs left by earlier runs (crash, cancelled restart).
fn sweep_staging(parent: &Path) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy().starts_with(STAGING_PREFIX) {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

/// Downgrade App / AppImage to Manual when the target is missing or its
/// folder is not writable (we never escalate privileges).
fn resolve_install(kind: InstallKind) -> (InstallKind, Option<String>) {
    if !matches!(kind, InstallKind::App | InstallKind::AppImage) {
        return (kind, None);
    }
    let Some(target) = install_target(kind) else {
        return (
            InstallKind::Manual,
            Some("not running from an installed app".to_owned()),
        );
    };
    match create_staging(&target) {
        Ok(dir) => {
            let _ = fs::remove_dir(&dir);
            (kind, None)
        }
        Err(e) => (
            InstallKind::Manual,
            Some(format!(
                "cannot write to {}: {e}",
                target.parent().unwrap_or(&target).display()
            )),
        ),
    }
}

/// Move `new` to `target`, keeping the old copy until the move succeeded:
/// target → backup, new → target, remove backup. On failure the backup is
/// renamed back, so the installed app is never left missing. Works for the
/// .app directory and for the AppImage file.
#[cfg_attr(not(unix), allow(dead_code))] // install/relaunch are Unix-only
pub fn swap_into_place(target: &Path, new: &Path) -> io::Result<()> {
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::other("bad install target"))?
        .to_string_lossy()
        .into_owned();
    let backup = target.with_file_name(format!(".{name}.old-{}", std::process::id()));
    remove_any(&backup)?;
    fs::rename(target, &backup)?;
    if let Err(e) = fs::rename(new, target) {
        return match fs::rename(&backup, target) {
            Ok(()) => Err(e),
            Err(r) => Err(io::Error::other(format!(
                "{e}; restoring the old copy also failed ({r}); it is at {}",
                backup.display()
            ))),
        };
    }
    let _ = remove_any(&backup);
    Ok(())
}

#[cfg_attr(not(unix), allow(dead_code))] // install/relaunch are Unix-only
fn remove_any(p: &Path) -> io::Result<()> {
    match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(p),
        Ok(_) => fs::remove_file(p),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// The single top-level `.app` directory an extracted update contains.
#[cfg_attr(not(unix), allow(dead_code))] // install/relaunch are Unix-only
pub fn find_extracted_app(dir: &Path) -> Result<PathBuf, String> {
    let apps: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension() == Some(OsStr::new("app")) && p.is_dir())
        .collect();
    match apps.as_slice() {
        [one] if one.join("Contents/MacOS").is_dir() => Ok(one.clone()),
        [_] => Err("the update archive has no Contents/MacOS".to_owned()),
        _ => Err("the update archive must contain exactly one .app".to_owned()),
    }
}

// ------------------------------------------------------------ commands ----

#[derive(Debug, Clone, Serialize)]
pub struct UpdateSupport {
    /// False when checks must not run (placeholder / malformed public key).
    pub enabled: bool,
    pub install: InstallKind,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub install: InstallKind,
    /// Why `install` is `manual`, if it is.
    pub reason: Option<String>,
    pub release_url: String,
}

struct Pending {
    version: String,
    entry: PlatformEntry,
    install: InstallKind,
    target: PathBuf,
}

#[derive(Default)]
struct Inner {
    pending: Option<Pending>,
    /// Staging dir holding the verified artifact.
    staged: Option<(PathBuf, PathBuf)>,
    busy: bool,
}

/// Shared updater state (`app.manage`).
#[derive(Default)]
pub struct UpdateState(Mutex<Inner>);

pub fn support(pubkey: &str, install: InstallKind) -> UpdateSupport {
    let reason = if parse_pubkey(pubkey).is_none() {
        Some("the updater public key is a placeholder or malformed".to_owned())
    } else {
        None
    };
    UpdateSupport {
        enabled: reason.is_none(),
        install,
        reason,
    }
}

fn current_kind() -> InstallKind {
    install_kind(
        std::env::consts::OS,
        std::env::var_os("APPIMAGE").as_deref(),
    )
}

#[tauri::command]
pub fn update_support() -> UpdateSupport {
    let s = support(PUBKEY, current_kind());
    if let Some(reason) = &s.reason {
        eprintln!("Warning: update checks disabled: {reason}");
    }
    s
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Fetch latest.json; `None` when this version is current.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    if parse_pubkey(PUBKEY).is_none() {
        return Err("update checks are disabled (no updater public key)".to_owned());
    }
    blocking(move || {
        let tmp =
            std::env::temp_dir().join(format!("sparkdown-latest-{}.json", std::process::id()));
        let fetched = download(
            ENDPOINT,
            &tmp,
            MANIFEST_TIMEOUT_SECS,
            MANIFEST_MAX_BYTES,
            |_| {},
        );
        let json = fetched.and_then(|()| fs::read_to_string(&tmp).map_err(|e| e.to_string()));
        let _ = fs::remove_file(&tmp);
        let manifest = parse_manifest(&json?)?;
        let current = app.package_info().version.to_string();
        if !is_newer(&manifest.version, &current) {
            return Ok(None);
        }
        let (mut install, mut reason) = resolve_install(current_kind());
        let keys = platform_keys(std::env::consts::OS, std::env::consts::ARCH, install);
        let entry = select_platform(&manifest, &keys).cloned();
        let state = app.state::<UpdateState>();
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        inner.pending = None;
        if matches!(install, InstallKind::App | InstallKind::AppImage) {
            match (entry, install_target(install)) {
                (Some(entry), Some(target)) => {
                    inner.pending = Some(Pending {
                        version: manifest.version.clone(),
                        entry,
                        install,
                        target,
                    });
                }
                _ => {
                    install = InstallKind::Manual;
                    reason = Some(format!("no update package for {}", keys.join(" / ")));
                }
            }
        }
        Ok(Some(UpdateInfo {
            version: manifest.version,
            notes: manifest.notes,
            install,
            reason,
            release_url: RELEASES_PAGE.to_owned(),
        }))
    })
    .await
}

/// Download and verify the pending update. Emits `update-progress`
/// ([`DownloadProgress`]).
#[tauri::command]
pub async fn update_download(app: AppHandle) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<UpdateState>();
        let (version, entry, target) = {
            let mut inner = state.0.lock().map_err(|e| e.to_string())?;
            if inner.busy {
                return Err("an update is already in progress".to_owned());
            }
            let p = inner.pending.as_ref().ok_or("no update to download")?;
            let job = (p.version.clone(), p.entry.clone(), p.target.clone());
            inner.busy = true;
            inner.staged = None;
            job
        };
        let result = parse_pubkey(PUBKEY)
            .ok_or_else(|| "no updater public key".to_owned())
            .and_then(|key| {
                stage_update(
                    &target,
                    &entry,
                    &version,
                    &key,
                    Box::new(|url, out, max_bytes, on_bytes| {
                        download(url, out, ARTIFACT_TIMEOUT_SECS, max_bytes, on_bytes)
                    }),
                    |p| {
                        let _ = app.emit(PROGRESS_EVENT, p);
                    },
                )
            });
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        inner.busy = false;
        inner.staged = Some(result?);
        Ok(())
    })
    .await
}

/// Put the verified update in place. The running app keeps working (its
/// files stay open); the new version starts on `update_restart`.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<UpdateState>();
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        let (staging, file) = inner.staged.take().ok_or("the update is not downloaded")?;
        let p = inner.pending.as_ref().ok_or("no pending update")?;
        install_and_clean(p.install, &p.target, &staging, &file)
    })
    .await
}

/// Install the staged artifact, then remove the staging dir whatever the
/// outcome (a failed install means downloading again).
fn install_and_clean(
    kind: InstallKind,
    target: &Path,
    staging: &Path,
    file: &Path,
) -> Result<(), String> {
    let res = install_staged(kind, target, staging, file);
    let _ = fs::remove_dir_all(staging);
    res
}

#[cfg(unix)]
fn install_staged(
    kind: InstallKind,
    target: &Path,
    staging: &Path,
    file: &Path,
) -> Result<(), String> {
    match kind {
        InstallKind::App => {
            let out = staging.join("x");
            fs::create_dir(&out).map_err(|e| e.to_string())?;
            // bsdtar refuses absolute paths and `..` members by default; the
            // archive is also signature-verified at this point. Downloads by
            // curl carry no quarantine attribute, so nothing to clear.
            let status = crate::proc::command("/usr/bin/tar")
                .arg("-xzf")
                .arg(file)
                .arg("-C")
                .arg(&out)
                .stdin(Stdio::null())
                .status()
                .map_err(|e| format!("cannot run tar: {e}"))?;
            if !status.success() {
                return Err(format!("extracting the update failed ({status})"));
            }
            let new_app = find_extracted_app(&out)?;
            swap_into_place(target, &new_app).map_err(|e| e.to_string())?;
            // Nudge Launch Services to re-read the new Info.plist.
            let _ = crate::proc::command("/usr/bin/touch").arg(target).status();
            Ok(())
        }
        InstallKind::AppImage => {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(file, fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
            swap_into_place(target, file).map_err(|e| e.to_string())
        }
        _ => Err("this install cannot update itself".to_owned()),
    }
}

#[cfg(not(unix))]
fn install_staged(_: InstallKind, _: &Path, _: &Path, _: &Path) -> Result<(), String> {
    Err("this install cannot update itself".to_owned())
}

/// Start the installed version once this process has exited, then exit.
/// The helper is a detached `sh` that waits for our PID to go away (so the
/// new instance never races the old one for the MCP socket).
#[tauri::command]
pub fn update_restart(app: AppHandle, state: tauri::State<'_, UpdateState>) -> Result<(), String> {
    let (kind, target) = {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        let p = inner.pending.as_ref().ok_or("no installed update")?;
        (p.install, p.target.clone())
    };
    spawn_relaunch(kind, &target)?;
    app.exit(0);
    Ok(())
}

/// argv for the relaunch helper: `sh -c <script> sh <pid> <launcher> <target>`.
#[cfg_attr(not(unix), allow(dead_code))] // install/relaunch are Unix-only
pub fn relaunch_args(pid: u32, kind: InstallKind, target: &Path) -> Option<Vec<OsString>> {
    // Wait up to ~20 s for the old process, then launch.
    const SCRIPT: &str = "i=0; while kill -0 \"$1\" 2>/dev/null && [ $i -lt 200 ]; do \
                          sleep 0.1; i=$((i+1)); done; shift; exec \"$@\"";
    let mut v: Vec<OsString> = vec![
        "-c".into(),
        SCRIPT.into(),
        "sh".into(),
        pid.to_string().into(),
    ];
    match kind {
        InstallKind::App => {
            v.push("/usr/bin/open".into());
            v.push("-n".into());
        }
        InstallKind::AppImage => {}
        _ => return None,
    }
    v.push(target.as_os_str().to_owned());
    Some(v)
}

#[cfg(unix)]
fn spawn_relaunch(kind: InstallKind, target: &Path) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let args =
        relaunch_args(std::process::id(), kind, target).ok_or("cannot relaunch this install")?;
    let mut cmd = crate::proc::command("/bin/sh");
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Own process group: not tied to ours when we exit.
        .process_group(0);
    // The AppImage runtime sets these for the running image; the new one
    // sets its own.
    for var in ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] {
        cmd.env_remove(var);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("cannot relaunch: {e}"))
}

#[cfg(not(unix))]
fn spawn_relaunch(_: InstallKind, _: &Path) -> Result<(), String> {
    Err("this install cannot relaunch itself".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Throwaway key pair made with `tauri signer generate`; the private key
    // is not kept anywhere. FIXTURE_SIG signs b"hello\n" for version 1.2.3.
    const FIXTURE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDE1MkRGOTc0QzE1NkQyOEYKUldTUDBsYkJkUGt0RlRXd0JlYnVNNEw1alJyUzA0VFE2RHppdGRhM3NoWHpEYmkrUHNrZFFvVVEK";
    const FIXTURE_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTUDBsYkJkUGt0RlFIRldFM1NOOXZmYjdsM3VuMnZsVTB4WTdYVi81RGFURk44L2xUYTJTNmwvaUMwc2h1aXJWQUVVRmhtcUpTRHl4T0xUMlNsN3daODk4NVEvdGdsaHdrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwMjg0ODM3CWZpbGU6Zi5iaW4JdmVyc2lvbjoxLjIuMwprbEdjMmVsTnF6SjZpUGk3c1M5SHgvU1FjeE1ZbDBaQzdRTm04MGNsWWtjYU1lVkZZR2o3T3czRnR5YmRKb200QlpnSWJQMXNtQnk5TWdrVVJEN0hDUT09Cg==";
    // Same key, same data, signed WITHOUT --app-version (no version field).
    const FIXTURE_SIG_NO_VERSION: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTUDBsYkJkUGt0RmR6ODZ5OTRsdVZtWHEzV0JMeHg0Ui9MUHJTUHlWMkxwYnBoU0ZlUHZjczVDUnhHTS9pV3E3MW0vMXNKZ3huYnExQnFJY2FwR0x0N3g0T0FORmdqc3dzPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwMzU5NjMyCWZpbGU6bm92ZXIuYmluCmVna3V4Y3RDUWpCaTdqNzFtM1ZHWDFremZTbnFRam1RZGJSMFhibGhoUFpzdDB6UjFkNzRmODFuaUpwalFmRXRPQjNZekhCQ3oxTlR2aEZHQnNDdkJRPT0K";
    // Same data and version, signed by a DIFFERENT throwaway key.
    const FIXTURE_SIG_OTHER_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUTXo3dTBRZVlkWkw2dm8yZTNsTTJGb1ZYaStza3hVUlNRWTcydnNhM0JtZzYwK05UNGsxS3BSeVRvMnZLUUJTSW01bk1JWUx5NDl1dEdLUXRINEMzMkh6cy9qTXMvN3drPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwMzU5NjMyCWZpbGU6b3RoZXIuYmluCXZlcnNpb246MS4yLjMKUW9JRm1wNkF4UTBPNTl0N0gyeU1ubzI0T09NN3Q2dnhlZnM3ZHNxbGtrVTJBbVBDZlRwQUJWVG9TM3NBTVh4RWwzMUJ3VDJ0Nm82OG15bmxuZ3FkQ0E9PQo=";

    /// A unique scratch dir under the system temp dir, removed on drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Scratch {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let p =
                std::env::temp_dir().join(format!("sd-upd-{tag}-{}-{nanos}", std::process::id()));
            fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn signed_file(dir: &Path, content: &[u8]) -> PathBuf {
        let p = dir.join("f.bin");
        fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn versions_compare_as_semver() {
        assert!(is_newer("0.4.0", "0.3.0"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(is_newer("0.3.10", "0.3.9"));
        assert!(!is_newer("0.3.0", "0.3.0"));
        assert!(!is_newer("0.2.9", "0.3.0"));
        assert!(is_newer("1.0.0", "1.0.0-rc.1"));
        assert!(!is_newer("1.0.0-rc.1", "1.0.0"));
        assert!(is_newer("1.0.0-rc.10", "1.0.0-rc.2"));
        assert!(is_newer("1.0.0-beta", "1.0.0-alpha"));
        assert!(is_newer("1.0.0-alpha.1", "1.0.0-alpha"));
        assert!(!is_newer("1.0.0+build.9", "1.0.0"));
    }

    #[test]
    fn garbage_versions_are_never_newer() {
        for bad in [
            "", "1", "1.2", "1.2.3.4", "a.b.c", "1.2.x", "1..2", "1.2.3-", "-1.2.3",
        ] {
            assert!(Version::parse(bad).is_none(), "{bad}");
            assert!(!is_newer(bad, "0.1.0"), "{bad}");
        }
    }

    #[test]
    fn manifest_parses_the_tauri_format() {
        let m = parse_manifest(
            r#"{"version":"0.4.0","notes":"n","pub_date":"2026-01-01T00:00:00Z",
               "platforms":{"darwin-aarch64":{"signature":"S","url":"https://x/a.tar.gz"},
                            "linux-x86_64":{"signature":"T","url":"https://x/b.AppImage"}}}"#,
        )
        .unwrap();
        assert_eq!(m.version, "0.4.0");
        assert_eq!(m.notes.as_deref(), Some("n"));
        assert_eq!(m.platforms["linux-x86_64"].url, "https://x/b.AppImage");
        assert!(parse_manifest("{}").is_err());
        assert!(parse_manifest(r#"{"version":"soon"}"#).is_err());
        assert!(parse_manifest("<html>404</html>").is_err());
        // Platforms are optional (a notify-only manifest).
        assert!(parse_manifest(r#"{"version":"1.0.0"}"#)
            .unwrap()
            .platforms
            .is_empty());
    }

    #[test]
    fn platform_keys_follow_the_tauri_convention() {
        assert_eq!(
            platform_keys("macos", "aarch64", InstallKind::App),
            ["darwin-aarch64-app", "darwin-aarch64"]
        );
        assert_eq!(
            platform_keys("linux", "x86_64", InstallKind::AppImage),
            ["linux-x86_64-appimage", "linux-x86_64"]
        );
        assert_eq!(
            platform_keys("linux", "x86_64", InstallKind::PackageManager),
            ["linux-x86_64"]
        );
        assert!(platform_keys("haiku", "x86_64", InstallKind::Manual).is_empty());

        let m = parse_manifest(
            r#"{"version":"1.0.0","platforms":{
               "linux-x86_64":{"signature":"generic","url":"https://x/g"},
               "linux-x86_64-appimage":{"signature":"specific","url":"https://x/s"}}}"#,
        )
        .unwrap();
        let keys = platform_keys("linux", "x86_64", InstallKind::AppImage);
        assert_eq!(select_platform(&m, &keys).unwrap().signature, "specific");
        let keys = platform_keys("darwin", "aarch64", InstallKind::App);
        assert!(select_platform(&m, &keys).is_none());
    }

    #[test]
    fn base64_round_trips_known_values() {
        assert_eq!(base64_decode("aGVsbG8K").unwrap(), b"hello\n");
        assert_eq!(base64_decode("aGk=").unwrap(), b"hi");
        assert_eq!(base64_decode("aA==").unwrap(), b"h");
        assert_eq!(base64_decode("aGk").unwrap(), b"hi");
        assert_eq!(base64_decode(" aGVs\nbG8K ").unwrap(), b"hello\n");
        assert!(base64_decode("a").is_none());
        assert!(base64_decode("a$==").is_none());
    }

    #[test]
    fn placeholder_and_junk_keys_are_rejected() {
        assert!(parse_pubkey(PUBKEY_PLACEHOLDER).is_none());
        assert!(parse_pubkey("").is_none());
        assert!(parse_pubkey("not-a-key").is_none());
        // base64 of "untrusted comment: x\n" — right prefix, no key line.
        assert!(parse_pubkey("dW50cnVzdGVkIGNvbW1lbnQ6IHgK").is_none());
        assert!(parse_pubkey(FIXTURE_PUBKEY).is_some());
        assert!(!support(PUBKEY_PLACEHOLDER, InstallKind::App).enabled);
        assert!(support(FIXTURE_PUBKEY, InstallKind::App).enabled);
    }

    #[test]
    fn bundled_pubkey_is_the_placeholder_or_a_real_key() {
        assert!(PUBKEY.trim() == PUBKEY_PLACEHOLDER || parse_pubkey(PUBKEY).is_some());
    }

    #[test]
    fn a_valid_signature_for_the_announced_version_verifies() {
        let s = Scratch::new("sig-ok");
        let f = signed_file(&s.0, b"hello\n");
        let key = parse_pubkey(FIXTURE_PUBKEY).unwrap();
        verify_file(&f, FIXTURE_SIG, &key, "1.2.3").unwrap();
        verify_file(&f, FIXTURE_SIG, &key, "v1.2.3").unwrap();
    }

    #[test]
    fn tampered_data_fails_verification() {
        let s = Scratch::new("sig-bad");
        let f = signed_file(&s.0, b"hellO\n");
        let key = parse_pubkey(FIXTURE_PUBKEY).unwrap();
        assert!(verify_file(&f, FIXTURE_SIG, &key, "1.2.3").is_err());
    }

    #[test]
    fn a_signature_from_another_key_fails() {
        let s = Scratch::new("sig-key");
        let f = signed_file(&s.0, b"hello\n");
        let key = parse_pubkey(FIXTURE_PUBKEY).unwrap();
        let err = verify_file(&f, FIXTURE_SIG_OTHER_KEY, &key, "1.2.3").unwrap_err();
        assert!(err.contains("key"), "{err}");
    }

    #[test]
    fn signed_version_must_match_the_announced_version() {
        let s = Scratch::new("sig-ver");
        let f = signed_file(&s.0, b"hello\n");
        let key = parse_pubkey(FIXTURE_PUBKEY).unwrap();
        // Downgrade attack: manifest says 9.9.9, artifact was signed as 1.2.3.
        let err = verify_file(&f, FIXTURE_SIG, &key, "9.9.9").unwrap_err();
        assert!(err.contains("signed for version 1.2.3"), "{err}");
        // Signatures without a version are rejected outright.
        let err = verify_file(&f, FIXTURE_SIG_NO_VERSION, &key, "1.2.3").unwrap_err();
        assert!(err.contains("does not name a version"), "{err}");
        assert!(verify_file(&f, "!!!", &key, "1.2.3").is_err());
    }

    #[test]
    fn signed_version_reads_the_trusted_comment() {
        assert_eq!(
            signed_version("timestamp:1\tfile:a.tar.gz\tversion:1.2.3"),
            Some("1.2.3")
        );
        assert_eq!(signed_version("timestamp:1\tfile:a"), None);
    }

    #[test]
    fn curl_argv_is_https_only_and_url_is_not_an_option() {
        let args = curl_args("https://example.com/x", Path::new("/tmp/o"), 30, 1024);
        let s: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let pair = |flag: &str| {
            let i = s
                .iter()
                .position(|a| a == flag)
                .unwrap_or_else(|| panic!("{flag}"));
            s[i + 1].clone()
        };
        assert_eq!(pair("--proto"), "=https");
        assert_eq!(pair("--proto-redir"), "=https");
        assert_eq!(pair("--max-time"), "30");
        assert_eq!(pair("--max-filesize"), "1024");
        assert_eq!(pair("--output"), "/tmp/o");
        assert_eq!(s.last().unwrap(), "https://example.com/x");
        assert_eq!(s[s.len() - 2], "--url");
        for f in ["--fail", "--location", "--tlsv1.2", "--show-error"] {
            assert!(s.iter().any(|a| a == f), "{f}");
        }
    }

    #[test]
    fn non_https_downloads_are_refused_before_running_curl() {
        let s = Scratch::new("http");
        let err = download("http://example.com/x", &s.0.join("o"), 5, 10, |_| {}).unwrap_err();
        assert!(err.contains("non-HTTPS"), "{err}");
    }

    #[test]
    fn install_kind_detection() {
        assert_eq!(install_kind("macos", None), InstallKind::App);
        let p = OsStr::new("/home/u/Apps/SparkDown.AppImage");
        assert_eq!(install_kind("linux", Some(p)), InstallKind::AppImage);
        assert_eq!(install_kind("linux", None), InstallKind::PackageManager);
        assert_eq!(
            install_kind("linux", Some(OsStr::new(""))),
            InstallKind::PackageManager
        );
        assert_eq!(install_kind("windows", None), InstallKind::Manual);
    }

    #[test]
    fn bundle_is_found_only_inside_an_app() {
        assert_eq!(
            bundle_of(Path::new(
                "/Applications/SparkDown.app/Contents/MacOS/sparkdown"
            )),
            Some(PathBuf::from("/Applications/SparkDown.app"))
        );
        assert_eq!(
            bundle_of(Path::new("/repo/src-tauri/target/debug/sparkdown")),
            None
        );
        assert_eq!(bundle_of(Path::new("/x/Contents/MacOS/sparkdown")), None);
    }

    #[test]
    fn swap_replaces_a_bundle_and_removes_the_backup() {
        let s = Scratch::new("swap-ok");
        let target = s.0.join("SparkDown.app");
        fs::create_dir_all(target.join("Contents")).unwrap();
        fs::write(target.join("Contents/v"), "old").unwrap();
        let new = s.0.join("stage/SparkDown.app");
        fs::create_dir_all(new.join("Contents")).unwrap();
        fs::write(new.join("Contents/v"), "new").unwrap();

        swap_into_place(&target, &new).unwrap();
        assert_eq!(
            fs::read_to_string(target.join("Contents/v")).unwrap(),
            "new"
        );
        assert!(!new.exists());
        let leftovers: Vec<_> = fs::read_dir(&s.0)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".old-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn swap_rolls_back_when_the_new_copy_cannot_be_moved() {
        let s = Scratch::new("swap-fail");
        let target = s.0.join("SparkDown.app");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("v"), "old").unwrap();
        let missing = s.0.join("stage/SparkDown.app");

        assert!(swap_into_place(&target, &missing).is_err());
        assert_eq!(fs::read_to_string(target.join("v")).unwrap(), "old");
    }

    #[test]
    fn swap_replaces_a_file_like_an_appimage() {
        let s = Scratch::new("swap-file");
        let target = s.0.join("SparkDown.AppImage");
        fs::write(&target, "old").unwrap();
        let new = s.0.join("new.AppImage");
        fs::write(&new, "new").unwrap();
        swap_into_place(&target, &new).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
    }

    #[test]
    fn extracted_archive_must_hold_exactly_one_app() {
        let s = Scratch::new("extract");
        assert!(find_extracted_app(&s.0).is_err());
        fs::create_dir_all(s.0.join("SparkDown.app/Contents/MacOS")).unwrap();
        assert_eq!(find_extracted_app(&s.0).unwrap(), s.0.join("SparkDown.app"));
        fs::create_dir_all(s.0.join("Other.app/Contents/MacOS")).unwrap();
        assert!(find_extracted_app(&s.0).is_err());
    }

    #[test]
    fn staging_sits_next_to_the_target_and_is_swept() {
        let s = Scratch::new("staging");
        let target = s.0.join("SparkDown.app");
        let dir = create_staging(&target).unwrap();
        assert_eq!(dir.parent().unwrap(), s.0);
        fs::write(dir.join("download"), "x").unwrap();
        sweep_staging(&s.0);
        assert!(!dir.exists());
    }

    #[test]
    fn relaunch_waits_for_our_pid_then_opens_the_target() {
        let a = relaunch_args(
            42,
            InstallKind::App,
            Path::new("/Applications/SparkDown.app"),
        )
        .unwrap();
        let s: Vec<String> = a.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        assert_eq!(s[0], "-c");
        assert!(s[1].contains("kill -0"));
        assert_eq!(
            &s[2..],
            [
                "sh",
                "42",
                "/usr/bin/open",
                "-n",
                "/Applications/SparkDown.app"
            ]
        );
        let a = relaunch_args(7, InstallKind::AppImage, Path::new("/h/S.AppImage")).unwrap();
        assert_eq!(a.last().unwrap(), "/h/S.AppImage");
        assert!(relaunch_args(7, InstallKind::PackageManager, Path::new("/x")).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn relaunch_script_runs_the_command_after_the_pid_is_gone() {
        let s = Scratch::new("relaunch");
        let marker = s.0.join("launched");
        // PID 0x7ffffffe is not a live process, so the wait loop ends at once.
        let mut args = relaunch_args(
            0x7fff_fffe,
            InstallKind::AppImage,
            Path::new("/usr/bin/touch"),
        )
        .unwrap();
        args.push(marker.as_os_str().to_owned());
        let status = crate::proc::command("/bin/sh").args(args).status().unwrap();
        assert!(status.success());
        assert!(marker.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn app_install_extracts_the_tarball_and_swaps_the_bundle() {
        let s = Scratch::new("install-app");
        // The "running" app.
        let target = s.0.join("SparkDown.app");
        fs::create_dir_all(target.join("Contents/MacOS")).unwrap();
        fs::write(target.join("Contents/MacOS/sparkdown"), "old").unwrap();
        // A release tarball with one top-level SparkDown.app, as
        // package-macos.sh makes it.
        let src = s.0.join("src");
        fs::create_dir_all(src.join("SparkDown.app/Contents/MacOS")).unwrap();
        fs::write(src.join("SparkDown.app/Contents/MacOS/sparkdown"), "new").unwrap();
        let staging = create_staging(&target).unwrap();
        let tgz = staging.join("download");
        let ok = crate::proc::command("/usr/bin/tar")
            .arg("-czf")
            .arg(&tgz)
            .arg("-C")
            .arg(&src)
            .arg("SparkDown.app")
            .status()
            .unwrap();
        assert!(ok.success());

        install_staged(InstallKind::App, &target, &staging, &tgz).unwrap();
        assert_eq!(
            fs::read_to_string(target.join("Contents/MacOS/sparkdown")).unwrap(),
            "new"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn app_install_keeps_the_old_bundle_when_the_archive_is_wrong() {
        let s = Scratch::new("install-bad");
        let target = s.0.join("SparkDown.app");
        fs::create_dir_all(target.join("Contents/MacOS")).unwrap();
        fs::write(target.join("Contents/MacOS/sparkdown"), "old").unwrap();
        let staging = create_staging(&target).unwrap();
        let junk = staging.join("download");
        fs::write(&junk, "not a tarball").unwrap();
        assert!(install_staged(InstallKind::App, &target, &staging, &junk).is_err());
        assert_eq!(
            fs::read_to_string(target.join("Contents/MacOS/sparkdown")).unwrap(),
            "old"
        );
    }

    #[cfg(unix)]
    #[test]
    fn appimage_install_replaces_the_file_and_makes_it_executable() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new("install-appimage");
        let target = s.0.join("SparkDown.AppImage");
        fs::write(&target, "old").unwrap();
        let staging = create_staging(&target).unwrap();
        let file = staging.join("download");
        fs::write(&file, "new").unwrap();
        install_staged(InstallKind::AppImage, &target, &staging, &file).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        let mode = fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111);
    }

    // ------------------------------------------------- size / progress ----

    #[test]
    fn manifest_size_is_optional_and_backward_compatible() {
        let m = parse_manifest(
            r#"{"version":"0.5.0","platforms":{
               "darwin-aarch64":{"signature":"S","url":"https://x/a.tar.gz","size":12345},
               "linux-x86_64":{"signature":"T","url":"https://x/b.AppImage"}}}"#,
        )
        .unwrap();
        assert_eq!(m.platforms["darwin-aarch64"].size, Some(12345));
        assert_eq!(m.platforms["linux-x86_64"].size, None);
        // A size that is not a byte count is a malformed manifest.
        assert!(parse_manifest(
            r#"{"version":"0.5.0","platforms":{"linux-x86_64":
               {"signature":"T","url":"https://x/b","size":-1}}}"#
        )
        .is_err());
    }

    #[test]
    fn the_download_cap_follows_the_announced_size() {
        assert_eq!(artifact_limit(None).unwrap(), ARTIFACT_MAX_BYTES);
        assert_eq!(
            artifact_limit(Some(1000)).unwrap(),
            1000 + SIZE_MARGIN_BYTES
        );
        assert!(artifact_limit(Some(0)).is_err());
        assert!(artifact_limit(Some(ARTIFACT_MAX_BYTES + 1)).is_err());
        assert_eq!(
            artifact_limit(Some(ARTIFACT_MAX_BYTES)).unwrap(),
            ARTIFACT_MAX_BYTES + SIZE_MARGIN_BYTES
        );
    }

    #[test]
    fn a_download_of_the_wrong_length_is_rejected() {
        let s = Scratch::new("size");
        let f = signed_file(&s.0, b"hello\n");
        check_size(&f, Some(6)).unwrap();
        check_size(&f, None).unwrap();
        let err = check_size(&f, Some(7)).unwrap_err();
        assert!(err.contains("6 bytes") && err.contains("says 7"), "{err}");
        assert!(check_size(&s.0.join("missing"), Some(1)).is_err());
    }

    #[test]
    fn progress_serializes_for_the_frontend() {
        let v = serde_json::to_value(DownloadProgress {
            received: 5,
            total: Some(10),
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({"received": 5, "total": 10}));
        let v = serde_json::to_value(DownloadProgress {
            received: 5,
            total: None,
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({"received": 5, "total": null}));
    }

    // ------------------------------------------ end-to-end local flow ----

    /// Standard base64 with padding (tests only; the app only decodes).
    fn base64_encode(data: &[u8]) -> String {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for c in data.chunks(3) {
            let n = (c[0] as u32) << 16
                | (*c.get(1).unwrap_or(&0) as u32) << 8
                | *c.get(2).unwrap_or(&0) as u32;
            for i in 0..4 {
                if i <= c.len() {
                    out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    #[test]
    fn test_base64_encoder_round_trips() {
        for data in [&b""[..], b"h", b"hi", b"hello\n", &[0u8, 255, 128, 7]] {
            assert_eq!(base64_decode(&base64_encode(data)).unwrap(), data);
        }
    }

    #[cfg(unix)]
    /// A throwaway minisign key pair made for one test (never stored).
    struct TestKey(minisign::KeyPair);

    #[cfg(unix)]
    impl TestKey {
        fn new() -> TestKey {
            TestKey(minisign::KeyPair::generate_unencrypted_keypair().unwrap())
        }

        /// The public key as the app reads it (Tauri format: base64 of the
        /// minisign .pub file), decoded through the app's own parser.
        fn pubkey(&self) -> minisign_verify::PublicKey {
            let text = self.0.pk.to_box().unwrap().into_string();
            parse_pubkey(&base64_encode(text.as_bytes())).unwrap()
        }

        /// A Tauri-format signature of `path` for `version`, as `tauri signer
        /// sign --app-version` writes it.
        fn sign(&self, path: &Path, version: &str) -> String {
            let comment = format!("timestamp:1790000000\tfile:download\tversion:{version}");
            let sig = minisign::sign(
                Some(&self.0.pk),
                &self.0.sk,
                fs::File::open(path).unwrap(),
                Some(&comment),
                Some("signature from tauri secret key"),
            )
            .unwrap();
            base64_encode(sig.into_string().as_bytes())
        }
    }

    #[cfg(unix)]
    /// The manifest entry for a local artifact (signed for `version`).
    fn entry_for(key: &TestKey, artifact: &Path, version: &str) -> PlatformEntry {
        PlatformEntry {
            signature: key.sign(artifact, version),
            url: "https://example.invalid/artifact".to_owned(),
            size: Some(fs::metadata(artifact).unwrap().len()),
        }
    }

    #[cfg(unix)]
    /// Stand-in for the curl download: copies `src` to the staging file in
    /// two steps (reporting progress) and honours the byte cap, as curl's
    /// `--max-filesize` would. Records the cap it was given.
    fn local_fetch(src: PathBuf, cap_seen: Option<&std::cell::Cell<u64>>) -> Box<Fetch<'_>> {
        Box::new(move |url, out, max_bytes, on_bytes| {
            assert!(url.starts_with("https://"));
            if let Some(c) = cap_seen {
                c.set(max_bytes);
            }
            let data = fs::read(&src).map_err(|e| e.to_string())?;
            if data.len() as u64 > max_bytes {
                return Err("curl: (63) Maximum file size exceeded".to_owned());
            }
            let half = data.len() / 2;
            fs::write(out, &data[..half]).map_err(|e| e.to_string())?;
            on_bytes(half as u64);
            fs::write(out, &data).map_err(|e| e.to_string())?;
            on_bytes(data.len() as u64);
            Ok(())
        })
    }

    #[cfg(unix)]
    /// Nothing but `keep` is left next to the target: no staging dir, no
    /// `.old-` backup.
    fn assert_no_leftovers(parent: &Path, keep: &[&str]) {
        let names: Vec<String> = fs::read_dir(parent)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !keep.contains(&n.as_str()))
            .collect();
        assert!(names.is_empty(), "leftovers: {names:?}");
    }

    /// Makes `dir` read-only; restores it on drop so Scratch can clean up.
    #[cfg(unix)]
    struct ReadOnly(PathBuf);

    #[cfg(unix)]
    impl ReadOnly {
        /// None when the read-only bit does not stop us (running as root).
        fn new(dir: &Path) -> Option<ReadOnly> {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o555)).unwrap();
            let guard = ReadOnly(dir.to_path_buf());
            let probe = dir.join(".probe");
            if fs::write(&probe, "x").is_ok() {
                let _ = fs::remove_file(&probe);
                eprintln!(
                    "skipping: {} is writable even read-only (root?)",
                    dir.display()
                );
                return None;
            }
            Some(guard)
        }
    }

    #[cfg(unix)]
    impl Drop for ReadOnly {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
        }
    }

    /// A fake SparkDown.app: Info.plist with `version` plus an executable
    /// stub that prints it.
    #[cfg(unix)]
    fn make_bundle(dir: &Path, version: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let app = dir.join("SparkDown.app");
        fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        fs::write(
            app.join("Contents/Info.plist"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\
                 <key>CFBundleIdentifier</key><string>dev.sparkdown.test</string>\
                 <key>CFBundleShortVersionString</key><string>{version}</string>\
                 </dict></plist>\n"
            ),
        )
        .unwrap();
        let bin = app.join("Contents/MacOS/sparkdown");
        fs::write(&bin, format!("#!/bin/sh\necho {version}\n")).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        app
    }

    #[cfg(unix)]
    fn bundle_version(app: &Path) -> String {
        let plist = fs::read_to_string(app.join("Contents/Info.plist")).unwrap();
        let rest = plist
            .split("CFBundleShortVersionString</key><string>")
            .nth(1);
        rest.unwrap().split('<').next().unwrap().to_owned()
    }

    /// The release tarball, as package-macos.sh makes it: one top-level
    /// SparkDown.app, gzipped by the system tar.
    #[cfg(unix)]
    fn make_tarball(dir: &Path, version: &str) -> PathBuf {
        let src = dir.join(format!("build-{version}"));
        make_bundle(&src, version);
        let tgz = dir.join(format!("SparkDown_{version}.app.tar.gz"));
        let ok = crate::proc::command("tar")
            .arg("-czf")
            .arg(&tgz)
            .arg("-C")
            .arg(&src)
            .arg("SparkDown.app")
            .status()
            .unwrap();
        assert!(ok.success());
        fs::remove_dir_all(&src).unwrap();
        tgz
    }

    /// An installed 1.0.0 bundle in `<scratch>/Applications`, and a signed
    /// 2.0.0 release tarball elsewhere.
    #[cfg(unix)]
    struct AppFixture {
        _s: Scratch,
        apps: PathBuf,
        target: PathBuf,
        tgz: PathBuf,
        key: TestKey,
    }

    #[cfg(unix)]
    impl AppFixture {
        fn new(tag: &str) -> AppFixture {
            let s = Scratch::new(tag);
            let apps = s.0.join("Applications");
            let target = make_bundle(&apps, "1.0.0");
            let dl = s.0.join("release");
            fs::create_dir(&dl).unwrap();
            let tgz = make_tarball(&dl, "2.0.0");
            AppFixture {
                _s: s,
                apps,
                target,
                tgz,
                key: TestKey::new(),
            }
        }

        /// Stage (download + size + signature), then install.
        fn run(&self, entry: &PlatformEntry, version: &str) -> Result<(), String> {
            let (staging, file) = stage_update(
                &self.target,
                entry,
                version,
                &self.key.pubkey(),
                local_fetch(self.tgz.clone(), None),
                |_| {},
            )?;
            install_and_clean(InstallKind::App, &self.target, &staging, &file)
        }

        fn assert_original_intact(&self) {
            assert_eq!(bundle_version(&self.target), "1.0.0");
            let out = crate::proc::command(self.target.join("Contents/MacOS/sparkdown"))
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "1.0.0");
            assert_no_leftovers(&self.apps, &["SparkDown.app"]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn app_update_end_to_end_replaces_the_bundle() {
        let f = AppFixture::new("e2e-app");
        let entry = entry_for(&f.key, &f.tgz, "2.0.0");
        let size = entry.size.unwrap();
        let cap = std::cell::Cell::new(0);
        let mut seen = vec![];
        let (staging, file) = stage_update(
            &f.target,
            &entry,
            "2.0.0",
            &f.key.pubkey(),
            local_fetch(f.tgz.clone(), Some(&cap)),
            |p| seen.push(p),
        )
        .unwrap();
        assert_eq!(cap.get(), size + SIZE_MARGIN_BYTES);
        assert_eq!(seen.last().unwrap().received, size);
        assert!(seen.iter().all(|p| p.total == Some(size)));
        assert!(seen.len() >= 2 && seen[0].received < size);
        // Staged next to the target (same filesystem: atomic rename), and
        // the installed bundle is untouched until install.
        assert_eq!(staging.parent().unwrap(), f.apps);
        assert_eq!(bundle_version(&f.target), "1.0.0");

        install_and_clean(InstallKind::App, &f.target, &staging, &file).unwrap();
        assert_eq!(bundle_version(&f.target), "2.0.0");
        let out = crate::proc::command(f.target.join("Contents/MacOS/sparkdown"))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "2.0.0");
        assert_no_leftovers(&f.apps, &["SparkDown.app"]);
    }

    #[cfg(unix)]
    #[test]
    fn app_update_without_a_size_still_works() {
        let f = AppFixture::new("e2e-nosize");
        let mut entry = entry_for(&f.key, &f.tgz, "2.0.0");
        entry.size = None;
        f.run(&entry, "2.0.0").unwrap();
        assert_eq!(bundle_version(&f.target), "2.0.0");
    }

    #[cfg(unix)]
    #[test]
    fn app_update_with_a_bad_signature_leaves_the_bundle() {
        let f = AppFixture::new("e2e-badsig");
        // Signed by another throwaway key.
        let mut entry = entry_for(&TestKey::new(), &f.tgz, "2.0.0");
        let err = f.run(&entry, "2.0.0").unwrap_err();
        assert!(err.contains("key"), "{err}");
        f.assert_original_intact();
        // Right key, but the signature is for other bytes.
        let other = f.tgz.with_extension("other");
        fs::write(&other, b"other bytes").unwrap();
        entry.signature = f.key.sign(&other, "2.0.0");
        let err = f.run(&entry, "2.0.0").unwrap_err();
        assert!(err.contains("verification failed"), "{err}");
        f.assert_original_intact();
    }

    #[cfg(unix)]
    #[test]
    fn app_update_signed_for_another_version_leaves_the_bundle() {
        let f = AppFixture::new("e2e-ver");
        // The manifest announces 3.0.0, the artifact was signed as 2.0.0.
        let entry = entry_for(&f.key, &f.tgz, "2.0.0");
        let err = f.run(&entry, "3.0.0").unwrap_err();
        assert!(err.contains("signed for version 2.0.0"), "{err}");
        f.assert_original_intact();
    }

    #[cfg(unix)]
    #[test]
    fn app_update_of_the_wrong_size_is_rejected_before_the_signature() {
        let f = AppFixture::new("e2e-size");
        let mut entry = entry_for(&f.key, &f.tgz, "2.0.0");
        let real = entry.size.unwrap();
        // Garbage signature: the size check must fire first.
        entry.signature = "!!!".to_owned();
        entry.size = Some(real + 1);
        let err = f.run(&entry, "2.0.0").unwrap_err();
        assert!(err.contains("manifest says"), "{err}");
        f.assert_original_intact();
        // Far larger than the announced size + margin: the download cap
        // (curl's --max-filesize) stops it.
        fs::write(&f.tgz, vec![0u8; 4 * SIZE_MARGIN_BYTES as usize]).unwrap();
        entry.size = Some(1000);
        let err = f.run(&entry, "2.0.0").unwrap_err();
        assert!(err.contains("Maximum file size"), "{err}");
        f.assert_original_intact();
    }

    #[cfg(unix)]
    #[test]
    fn app_update_with_a_corrupt_archive_leaves_the_bundle() {
        let f = AppFixture::new("e2e-corrupt");
        // Validly signed, but not a tarball: passes verification, fails
        // extraction.
        let mut data = fs::read(&f.tgz).unwrap();
        data.truncate(data.len() / 2);
        fs::write(&f.tgz, &data).unwrap();
        let entry = entry_for(&f.key, &f.tgz, "2.0.0");
        let err = f.run(&entry, "2.0.0").unwrap_err();
        assert!(err.contains("extracting"), "{err}");
        f.assert_original_intact();
    }

    #[cfg(unix)]
    #[test]
    fn app_update_whose_archive_has_no_app_leaves_the_bundle() {
        let f = AppFixture::new("e2e-noapp");
        let src = f.tgz.with_file_name("junk");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("README"), "no app here").unwrap();
        let ok = crate::proc::command("tar")
            .arg("-czf")
            .arg(&f.tgz)
            .arg("-C")
            .arg(&src)
            .arg("README")
            .status()
            .unwrap();
        assert!(ok.success());
        let entry = entry_for(&f.key, &f.tgz, "2.0.0");
        let err = f.run(&entry, "2.0.0").unwrap_err();
        assert!(err.contains("exactly one .app"), "{err}");
        f.assert_original_intact();
    }

    #[cfg(unix)]
    #[test]
    fn app_update_into_an_unwritable_folder_leaves_the_bundle() {
        let f = AppFixture::new("e2e-ro");
        let entry = entry_for(&f.key, &f.tgz, "2.0.0");
        // Read-only before the download: staging cannot even be created.
        {
            let Some(_ro) = ReadOnly::new(&f.apps) else {
                return;
            };
            assert!(f.run(&entry, "2.0.0").is_err());
        }
        f.assert_original_intact();
        // Read-only between download and install: the swap fails.
        let (staging, file) = stage_update(
            &f.target,
            &entry,
            "2.0.0",
            &f.key.pubkey(),
            local_fetch(f.tgz.clone(), None),
            |_| {},
        )
        .unwrap();
        {
            let _ro = ReadOnly::new(&f.apps).unwrap();
            assert!(install_staged(InstallKind::App, &f.target, &staging, &file).is_err());
            assert_eq!(bundle_version(&f.target), "1.0.0");
        }
        let _ = fs::remove_dir_all(&staging);
        f.assert_original_intact();
    }

    /// An installed 1.0.0 AppImage (a shell stub) and a signed 2.0.0 one.
    #[cfg(unix)]
    struct AppImageFixture {
        _s: Scratch,
        home: PathBuf,
        target: PathBuf,
        new: PathBuf,
        key: TestKey,
    }

    #[cfg(unix)]
    impl AppImageFixture {
        fn new(tag: &str) -> AppImageFixture {
            use std::os::unix::fs::PermissionsExt;
            let s = Scratch::new(tag);
            let home = s.0.join("Apps");
            fs::create_dir(&home).unwrap();
            let target = home.join("SparkDown.AppImage");
            fs::write(&target, "#!/bin/sh\necho 1.0.0\n").unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
            // Downloaded files are not executable; install sets the bits.
            let new = s.0.join("SparkDown_2.0.0_amd64.AppImage");
            fs::write(&new, "#!/bin/sh\necho 2.0.0\n").unwrap();
            AppImageFixture {
                _s: s,
                home,
                target,
                new,
                key: TestKey::new(),
            }
        }

        fn run(&self, entry: &PlatformEntry, version: &str) -> Result<(), String> {
            let (staging, file) = stage_update(
                &self.target,
                entry,
                version,
                &self.key.pubkey(),
                local_fetch(self.new.clone(), None),
                |_| {},
            )?;
            install_and_clean(InstallKind::AppImage, &self.target, &staging, &file)
        }

        fn runs_as(&self) -> String {
            let out = crate::proc::command(&self.target).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_owned()
        }

        fn assert_original_intact(&self) {
            assert_eq!(self.runs_as(), "1.0.0");
            assert_no_leftovers(&self.home, &["SparkDown.AppImage"]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn appimage_update_end_to_end_replaces_the_file() {
        let f = AppImageFixture::new("e2e-ai");
        let entry = entry_for(&f.key, &f.new, "2.0.0");
        f.run(&entry, "2.0.0").unwrap();
        assert_eq!(f.runs_as(), "2.0.0");
        assert_no_leftovers(&f.home, &["SparkDown.AppImage"]);
    }

    #[cfg(unix)]
    #[test]
    fn appimage_update_failures_leave_the_file() {
        let f = AppImageFixture::new("e2e-ai-bad");
        // Another key.
        let entry = entry_for(&TestKey::new(), &f.new, "2.0.0");
        assert!(f.run(&entry, "2.0.0").is_err());
        f.assert_original_intact();
        // Signed for another version.
        let entry = entry_for(&f.key, &f.new, "2.0.0");
        assert!(f.run(&entry, "2.0.1").is_err());
        f.assert_original_intact();
        // Wrong size.
        let mut sized = entry.clone();
        sized.size = Some(sized.size.unwrap() - 1);
        assert!(f.run(&sized, "2.0.0").is_err());
        f.assert_original_intact();
        // Unwritable folder.
        if let Some(_ro) = ReadOnly::new(&f.home) {
            assert!(f.run(&entry, "2.0.0").is_err());
        }
        f.assert_original_intact();
    }

    /// Live network check of the curl path (not run in CI):
    /// `cargo test live_ -- --ignored`.
    #[test]
    #[ignore]
    fn live_https_download_and_http_error() {
        let s = Scratch::new("live");
        let out = s.0.join("o");
        download("https://example.com/", &out, 30, 10 * 1024 * 1024, |_| {}).unwrap();
        assert!(fs::metadata(&out).unwrap().len() > 0);
        let err = download(ENDPOINT, &out, 30, MANIFEST_MAX_BYTES, |_| {}).unwrap_err();
        // The repo is private until launch, so the manifest is a 404.
        assert!(err.contains("404"), "{err}");
    }
}
