//! Review queue support for the Changes view (docs/ui-revamp, item 7).
//!
//! Two read-mostly pieces:
//! 1. `git_change_stats`: per changed file, the `+adds / −dels` line counts
//!    (`git diff --numstat` for tracked files, a line count for untracked
//!    ones) and a content fingerprint of the change. The frontend keys its
//!    "reviewed" marks by path + fingerprint, so a file that changes again
//!    after review reads as pending again.
//! 2. `review_state_load` / `review_state_save`: the reviewed marks, kept in
//!    a small JSON file of their own (not AppConfig), one entry per workspace
//!    (origin + repo root, hashed), with caps on workspaces and entries.
//!
//! Git access goes through the same hardened runner as the rest of the
//! Changes view (`git::run_git`); remote workspaces use one ssh round trip.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// One changed path as the frontend knows it from `git_status`.
#[derive(Deserialize, Clone, Debug)]
pub struct ChangeRef {
    pub path: String,
    /// "modified" | "added" | "deleted" | "renamed" | "untracked"
    pub status: String,
}

/// Line counts and fingerprint for one changed path.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ChangeStat {
    pub path: String,
    /// Added lines; `None` when unknown or binary.
    pub adds: Option<u64>,
    /// Removed lines; `None` when unknown or binary.
    pub dels: Option<u64>,
    /// git reports the file as binary (numstat `-\t-`, or NUL bytes).
    pub binary: bool,
    /// Changes whenever the file's change changes (content or counts).
    pub fingerprint: String,
}

/// At most this many paths get stats in one call (the rest are ignored).
const MAX_PATHS: usize = 2000;
/// Remote: at most this many files are hashed / line-counted per call (each
/// is one git process on the host). Beyond it the fingerprint is counts-only.
const MAX_REMOTE_FILES: usize = 400;
/// Local: files larger than this are fingerprinted by size + mtime, not read.
const MAX_HASH_BYTES: u64 = 16 * 1024 * 1024;
/// git's own binary sniff: a NUL in the first 8000 bytes.
const BINARY_SNIFF: usize = 8000;

const REMOTE_SEP: &str = "__SD_SEP__";

/// Parse `git diff --numstat -z` output into path → (adds, dels). Binary
/// files report `-\t-` (→ `None, None`). A rename record (only with rename
/// detection on) has an empty path field followed by `old\0new\0`; the new
/// path is kept. Malformed records are skipped, never a panic.
pub(crate) fn parse_numstat_z(raw: &str) -> HashMap<String, (Option<u64>, Option<u64>)> {
    let mut out = HashMap::new();
    let mut fields = raw.split('\0');
    while let Some(rec) = fields.next() {
        let rec = rec.trim_start_matches('\n');
        if rec.is_empty() {
            continue;
        }
        let mut cols = rec.splitn(3, '\t');
        let (Some(a), Some(d), Some(path)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        let path = if path.is_empty() {
            let _old = fields.next();
            match fields.next() {
                Some(new) => new.to_string(),
                None => continue,
            }
        } else {
            path.to_string()
        };
        out.insert(path, (a.parse().ok(), d.parse().ok()));
    }
    out
}

/// Parse a "<adds>\t<dels>" pair ("-\t-" for binary).
fn parse_pair(s: &str) -> Option<(Option<u64>, Option<u64>)> {
    let mut cols = s.trim().split('\t');
    let a = cols.next()?;
    let d = cols.next()?;
    if a.is_empty() || d.is_empty() {
        return None;
    }
    Some((a.parse().ok(), d.parse().ok()))
}

/// Lines in a new (untracked) file, as git would count its additions; `None`
/// if the content looks binary.
pub(crate) fn count_lines(bytes: &[u8]) -> Option<u64> {
    let sniff = &bytes[..bytes.len().min(BINARY_SNIFF)];
    if sniff.contains(&0) {
        return None;
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count() as u64;
    let trailing = u64::from(!bytes.is_empty() && bytes.last() != Some(&b'\n'));
    Some(newlines + trailing)
}

/// FNV-1a 64: tiny, stable across builds and platforms (std's hasher is not
/// guaranteed stable, and the marks persist across app updates).
pub(crate) fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// The fingerprint string. Content hash plus status and counts, so a change
/// that keeps the bytes but moves the base (a commit, a revert of the index)
/// still reads as new.
pub(crate) fn fingerprint(
    status: &str,
    adds: Option<u64>,
    dels: Option<u64>,
    content: Option<&str>,
) -> String {
    let n = |v: Option<u64>| v.map_or("-".to_string(), |v| v.to_string());
    format!(
        "{status}:{}:{}:{}",
        n(adds),
        n(dels),
        content.unwrap_or("-")
    )
}

/// A repo-relative path that cannot escape the repo.
pub(crate) fn is_safe_rel_path(path: &str) -> bool {
    if path.is_empty() || path.contains('\0') {
        return false;
    }
    let p = Path::new(path);
    if p.is_absolute() {
        return false;
    }
    p.components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

/// Numstat of the working tree against HEAD, for tracked files.
const NUMSTAT_ARGS: [&str; 8] = [
    "diff",
    "--numstat",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=all",
    "HEAD",
];

#[tauri::command]
pub async fn git_change_stats(
    root: String,
    changes: Vec<ChangeRef>,
) -> Result<Vec<ChangeStat>, String> {
    tauri::async_runtime::spawn_blocking(move || git_change_stats_impl(&root, changes))
        .await
        .map_err(|e| format!("git_change_stats task failed: {e}"))?
}

fn sanitize(changes: Vec<ChangeRef>) -> Vec<ChangeRef> {
    changes
        .into_iter()
        .filter(|c| is_safe_rel_path(&c.path))
        .take(MAX_PATHS)
        .collect()
}

pub(crate) fn git_change_stats_impl(
    root: &str,
    changes: Vec<ChangeRef>,
) -> Result<Vec<ChangeStat>, String> {
    let changes = sanitize(changes);
    if crate::remote::is_active() {
        return crate::remote::git_change_stats(root, &changes);
    }
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let numstat = if changes.iter().any(|c| c.status != "untracked") {
        // No HEAD yet (fresh repo) or another failure: counts unknown.
        crate::git::run_git(root_path, &NUMSTAT_ARGS)
            .map(|s| parse_numstat_z(&s))
            .unwrap_or_default()
    } else {
        HashMap::new()
    };
    Ok(changes
        .iter()
        .map(|c| local_stat(root_path, c, &numstat))
        .collect())
}

/// What we could read of a working-tree path for hashing.
enum Content {
    Bytes(Vec<u8>),
    /// Too large to read: size + mtime stand in for the hash.
    Large(String),
    Missing,
}

fn read_content(path: &Path) -> Content {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return Content::Missing;
    };
    if meta.file_type().is_symlink() {
        // git diffs the link itself, not its target.
        return match fs::read_link(path) {
            Ok(t) => Content::Bytes(t.to_string_lossy().into_owned().into_bytes()),
            Err(_) => Content::Missing,
        };
    }
    if !meta.is_file() {
        return Content::Missing;
    }
    if meta.len() > MAX_HASH_BYTES {
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos());
        return Content::Large(format!("size{}-{}", meta.len(), mtime));
    }
    match fs::read(path) {
        Ok(b) => Content::Bytes(b),
        Err(_) => Content::Missing,
    }
}

fn local_stat(
    root: &Path,
    c: &ChangeRef,
    numstat: &HashMap<String, (Option<u64>, Option<u64>)>,
) -> ChangeStat {
    let content = if c.status == "deleted" {
        Content::Missing
    } else {
        read_content(&root.join(&c.path))
    };
    let (adds, dels, binary) = if c.status == "untracked" {
        match &content {
            Content::Bytes(b) => match count_lines(b) {
                Some(n) => (Some(n), Some(0), false),
                None => (None, None, true),
            },
            _ => (None, None, false),
        }
    } else {
        match numstat.get(&c.path) {
            Some(&(a, d)) => (a, d, a.is_none() && d.is_none()),
            None => (None, None, false),
        }
    };
    let hash = match &content {
        Content::Bytes(b) => Some(format!("{:016x}", fnv1a64(b))),
        Content::Large(s) => Some(s.clone()),
        Content::Missing => None,
    };
    ChangeStat {
        path: c.path.clone(),
        adds,
        dels,
        binary,
        fingerprint: fingerprint(&c.status, adds, dels, hash.as_deref()),
    }
}

// --- Remote -------------------------------------------------------------

/// The one-round-trip script for a remote workspace: tracked numstat, then a
/// `hash-object` line per hashed file, then a numstat pair per untracked
/// file, split by sentinel lines. `quote` is the remote shell quoter. Every
/// git call runs with the same env/config hardening as `ssh_git`, and
/// `hash-object --no-filters` so no repo clean filter runs.
pub(crate) fn remote_stats_script(
    root: &str,
    tracked: bool,
    hashed: &[&str],
    untracked: &[&str],
    quote: impl Fn(&str) -> String,
) -> String {
    let mut s = format!(
        "g() {{ env -u GIT_EXTERNAL_DIFF -u GIT_DIFF_OPTS -u GIT_PAGER GIT_CONFIG_NOSYSTEM=1 \
         GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git -c core.fsmonitor=false \
         -c diff.external= -c core.pager=cat -C {} \"$@\"; }}\n",
        quote(root)
    );
    if tracked {
        s.push_str("g ");
        s.push_str(&NUMSTAT_ARGS.join(" "));
        s.push_str(" 2>/dev/null\n");
    }
    s.push_str(&format!("echo; echo {REMOTE_SEP}\n"));
    if !hashed.is_empty() {
        let list: Vec<String> = hashed.iter().map(|p| quote(p)).collect();
        s.push_str(&format!(
            "for f in {}; do h=$(g hash-object --no-filters -- \"$f\" 2>/dev/null) || h=-; printf '%s\\n' \"${{h:--}}\"; done\n",
            list.join(" ")
        ));
    }
    s.push_str(&format!("echo {REMOTE_SEP}\n"));
    if !untracked.is_empty() {
        let list: Vec<String> = untracked.iter().map(|p| quote(p)).collect();
        s.push_str(&format!(
            "for f in {}; do n=$(g diff --no-index --numstat --no-ext-diff --no-textconv -- /dev/null \"$f\" 2>/dev/null | head -n 1 | cut -f1,2); printf '%s\\n' \"${{n:--}}\"; done\n",
            list.join(" ")
        ));
    }
    s.push_str("true\n");
    s
}

/// Parsed remote script output.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct RemoteStats {
    pub numstat: HashMap<String, (Option<u64>, Option<u64>)>,
    /// One per hashed file, in order; `None` when hashing failed.
    pub hashes: Vec<Option<String>>,
    /// One per untracked file, in order; `None` when counting failed.
    pub untracked: Vec<Option<(Option<u64>, Option<u64>)>>,
}

pub(crate) fn parse_remote_stats(raw: &str, n_hashed: usize, n_untracked: usize) -> RemoteStats {
    let mut sections = raw.split(REMOTE_SEP);
    let numstat = parse_numstat_z(sections.next().unwrap_or(""));
    let lines = |s: Option<&str>| -> Vec<String> {
        s.unwrap_or("")
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect()
    };
    let hash_lines = lines(sections.next());
    let count_lines = lines(sections.next());
    let hashes = (0..n_hashed)
        .map(|i| {
            hash_lines
                .get(i)
                .filter(|h| h.as_str() != "-" && h.chars().all(|c| c.is_ascii_hexdigit()))
                .cloned()
        })
        .collect();
    let untracked = (0..n_untracked)
        .map(|i| count_lines.get(i).and_then(|l| parse_pair(l)))
        .collect();
    RemoteStats {
        numstat,
        hashes,
        untracked,
    }
}

/// Assemble the per-file stats from the remote answers (pure; tested).
pub(crate) fn remote_stats_from(
    changes: &[ChangeRef],
    hashed: &[&str],
    r: &RemoteStats,
) -> Vec<ChangeStat> {
    let hash_of: HashMap<&str, &Option<String>> =
        hashed.iter().copied().zip(r.hashes.iter()).collect();
    let mut untracked_iter = r.untracked.iter();
    let mut untracked_seen = 0usize;
    changes
        .iter()
        .map(|c| {
            let (adds, dels, binary) = if c.status == "untracked" {
                let pair = if untracked_seen < MAX_REMOTE_FILES {
                    untracked_seen += 1;
                    untracked_iter.next().cloned().flatten()
                } else {
                    None
                };
                match pair {
                    Some((a, d)) => (a, d, a.is_none() && d.is_none()),
                    None => (None, None, false),
                }
            } else {
                match r.numstat.get(&c.path) {
                    Some(&(a, d)) => (a, d, a.is_none() && d.is_none()),
                    None => (None, None, false),
                }
            };
            let hash = hash_of.get(c.path.as_str()).and_then(|h| h.as_deref());
            ChangeStat {
                path: c.path.clone(),
                adds,
                dels,
                binary,
                fingerprint: fingerprint(&c.status, adds, dels, hash),
            }
        })
        .collect()
}

/// Which paths the remote script hashes and line-counts (capped).
pub(crate) fn remote_plan(changes: &[ChangeRef]) -> (bool, Vec<&str>, Vec<&str>) {
    let tracked = changes.iter().any(|c| c.status != "untracked");
    let hashed: Vec<&str> = changes
        .iter()
        .filter(|c| c.status != "deleted")
        .map(|c| c.path.as_str())
        .take(MAX_REMOTE_FILES)
        .collect();
    let untracked: Vec<&str> = changes
        .iter()
        .filter(|c| c.status == "untracked")
        .map(|c| c.path.as_str())
        .take(MAX_REMOTE_FILES)
        .collect();
    (tracked, hashed, untracked)
}

// --- Reviewed marks -----------------------------------------------------

/// Most workspaces remembered; the least recently touched go first.
const MAX_WORKSPACES: usize = 64;
/// Most reviewed marks kept per workspace.
pub(crate) const MAX_ENTRIES: usize = 2000;

#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceMarks {
    #[serde(default)]
    pub touched_ms: u64,
    /// Repo-relative path → fingerprint the user reviewed.
    #[serde(default)]
    pub entries: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReviewStore {
    #[serde(default)]
    pub workspaces: BTreeMap<String, WorkspaceMarks>,
}

/// Stable key for a workspace id ("<origin>\n<repo root>").
pub(crate) fn workspace_key(workspace: &str) -> String {
    format!("{:016x}", fnv1a64(workspace.as_bytes()))
}

impl ReviewStore {
    pub(crate) fn get(&self, workspace: &str) -> BTreeMap<String, String> {
        self.workspaces
            .get(&workspace_key(workspace))
            .map(|w| w.entries.clone())
            .unwrap_or_default()
    }

    /// Replace a workspace's marks (empty removes it), apply the caps.
    pub(crate) fn put(&mut self, workspace: &str, entries: HashMap<String, String>, now_ms: u64) {
        let key = workspace_key(workspace);
        if entries.is_empty() {
            self.workspaces.remove(&key);
            return;
        }
        let entries: BTreeMap<String, String> = entries
            .into_iter()
            .filter(|(p, f)| is_safe_rel_path(p) && f.len() <= 256)
            .take(MAX_ENTRIES)
            .collect();
        self.workspaces.insert(
            key,
            WorkspaceMarks {
                touched_ms: now_ms,
                entries,
            },
        );
        while self.workspaces.len() > MAX_WORKSPACES {
            let Some(oldest) = self
                .workspaces
                .iter()
                .min_by_key(|(_, w)| w.touched_ms)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            self.workspaces.remove(&oldest);
        }
    }
}

/// Read the store; a missing or malformed file is an empty store.
pub(crate) fn load_store(path: &Path) -> ReviewStore {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Write the store atomically (temp file + rename).
pub(crate) fn save_store(path: &Path, store: &ReviewStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(store).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("review-state.json"))
        .map_err(|e| e.to_string())
}

/// Serializes load-modify-write of the store file.
static STORE_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub fn review_state_load(
    app: AppHandle,
    workspace: String,
) -> Result<BTreeMap<String, String>, String> {
    let path = store_path(&app)?;
    let _g = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(load_store(&path).get(&workspace))
}

#[tauri::command]
pub fn review_state_save(
    app: AppHandle,
    workspace: String,
    entries: HashMap<String, String>,
) -> Result<(), String> {
    let path = store_path(&app)?;
    let _g = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load_store(&path);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    store.put(&workspace, entries, now);
    save_store(&path, &store)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(path: &str, status: &str) -> ChangeRef {
        ChangeRef {
            path: path.into(),
            status: status.into(),
        }
    }

    #[test]
    fn numstat_parses_counts_binary_and_renames() {
        let raw = "3\t1\tsrc/a.ts\0-\t-\tlogo.png\x000\t12\tgone.md\x002\t0\t\0old.md\0new.md\0";
        let m = parse_numstat_z(raw);
        assert_eq!(m.get("src/a.ts"), Some(&(Some(3), Some(1))));
        assert_eq!(m.get("logo.png"), Some(&(None, None)));
        assert_eq!(m.get("gone.md"), Some(&(Some(0), Some(12))));
        assert_eq!(m.get("new.md"), Some(&(Some(2), Some(0))));
        assert!(!m.contains_key("old.md"));
        // Garbage and paths with tabs / multibyte chars.
        let m = parse_numstat_z("junk\0\n1\t2\tcafé\tx.md\0");
        assert_eq!(m.len(), 1);
        assert_eq!(m.get("café\tx.md"), Some(&(Some(1), Some(2))));
        assert!(parse_numstat_z("").is_empty());
    }

    #[test]
    fn counts_lines_like_git() {
        assert_eq!(count_lines(b""), Some(0));
        assert_eq!(count_lines(b"a"), Some(1));
        assert_eq!(count_lines(b"a\nb\n"), Some(2));
        assert_eq!(count_lines(b"a\nb"), Some(2));
        assert_eq!(count_lines(b"\x89PNG\0\0"), None);
    }

    #[test]
    fn fingerprint_changes_with_content_and_counts() {
        let a = fingerprint("modified", Some(1), Some(0), Some("abc"));
        assert_eq!(a, fingerprint("modified", Some(1), Some(0), Some("abc")));
        assert_ne!(a, fingerprint("modified", Some(1), Some(0), Some("abd")));
        assert_ne!(a, fingerprint("modified", Some(2), Some(0), Some("abc")));
        assert_ne!(a, fingerprint("added", Some(1), Some(0), Some("abc")));
        assert_eq!(fingerprint("deleted", None, Some(4), None), "deleted:-:4:-");
    }

    #[test]
    fn rejects_escaping_paths() {
        assert!(is_safe_rel_path("docs/a.md"));
        assert!(is_safe_rel_path("./a.md"));
        assert!(!is_safe_rel_path("../a.md"));
        assert!(!is_safe_rel_path("a/../../b"));
        assert!(!is_safe_rel_path("/etc/passwd"));
        assert!(!is_safe_rel_path(""));
    }

    #[test]
    fn local_stats_on_a_real_repo_and_fingerprint_invalidation() {
        // Other tests install a fake remote session; hold them off.
        let _session = crate::remote::TEST_SESSION_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("sd-review-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            Command::new("git")
                .current_dir(&dir)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .args(args)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        if !git(&["init", "-q"]) {
            return; // no usable git here
        }
        fs::write(dir.join("a.md"), "one\ntwo\nthree\n").unwrap();
        fs::write(dir.join("gone.md"), "x\ny\n").unwrap();
        fs::write(dir.join("bin.dat"), b"\0\x01\x02").unwrap();
        assert!(git(&["add", "."]));
        assert!(git(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-q",
            "-m",
            "init"
        ]));
        fs::write(dir.join("a.md"), "one\nTWO\nthree\nfour\n").unwrap();
        fs::remove_file(dir.join("gone.md")).unwrap();
        fs::write(dir.join("bin.dat"), b"\0\x01\x03").unwrap();
        fs::write(dir.join("new.md"), "a\nb\nc").unwrap();
        let root = dir.to_string_lossy().to_string();
        let changes = vec![
            ch("a.md", "modified"),
            ch("gone.md", "deleted"),
            ch("bin.dat", "modified"),
            ch("new.md", "untracked"),
            ch("../escape.md", "untracked"),
        ];
        let stats = git_change_stats_impl(&root, changes.clone()).unwrap();
        assert_eq!(stats.len(), 4, "the escaping path is dropped");
        let by: HashMap<_, _> = stats.iter().map(|s| (s.path.as_str(), s)).collect();
        assert_eq!((by["a.md"].adds, by["a.md"].dels), (Some(2), Some(1)));
        assert_eq!((by["gone.md"].adds, by["gone.md"].dels), (Some(0), Some(2)));
        assert!(by["bin.dat"].binary);
        assert_eq!((by["new.md"].adds, by["new.md"].dels), (Some(3), Some(0)));

        // Same tree → same fingerprints; edit a file → only its print moves.
        let again = git_change_stats_impl(&root, changes.clone()).unwrap();
        assert_eq!(stats, again);
        fs::write(dir.join("new.md"), "a\nb\nC").unwrap();
        let after = git_change_stats_impl(&root, changes).unwrap();
        let after_by: HashMap<_, _> = after.iter().map(|s| (s.path.as_str(), s)).collect();
        assert_ne!(after_by["new.md"].fingerprint, by["new.md"].fingerprint);
        assert_eq!(after_by["a.md"].fingerprint, by["a.md"].fingerprint);

        // The remote script, run by a local POSIX sh against the same repo,
        // gives the same counts (proves the script is valid shell).
        let remote_changes = vec![
            ch("a.md", "modified"),
            ch("gone.md", "deleted"),
            ch("bin.dat", "modified"),
            ch("new.md", "untracked"),
        ];
        let (tracked, hashed, untracked) = remote_plan(&remote_changes);
        let script = remote_stats_script(&root, tracked, &hashed, &untracked, q);
        if let Ok(out) = Command::new("sh").arg("-c").arg(&script).output() {
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let raw = String::from_utf8_lossy(&out.stdout);
            let parsed = parse_remote_stats(&raw, hashed.len(), untracked.len());
            let rs = remote_stats_from(&remote_changes, &hashed, &parsed);
            assert_eq!((rs[0].adds, rs[0].dels), (Some(2), Some(1)));
            assert_eq!((rs[1].adds, rs[1].dels), (Some(0), Some(2)));
            assert!(rs[2].binary);
            assert_eq!((rs[3].adds, rs[3].dels), (Some(3), Some(0)));
            assert!(parsed.hashes.iter().all(Option::is_some));
        }
        let _ = fs::remove_dir_all(&dir);
    }

    fn q(s: &str) -> String {
        format!("'{}'", s.replace('\'', "'\\''"))
    }

    #[test]
    fn remote_script_quotes_every_path_and_skips_empty_loops() {
        let s = remote_stats_script("/srv/repo", true, &["a b.md", "it's.md"], &["new.md"], q);
        assert!(s.contains("-C '/srv/repo'"));
        assert!(s.contains("diff --numstat -z --no-renames"));
        assert!(s.contains("hash-object --no-filters"));
        assert!(s.contains("'a b.md' 'it'\\''s.md'"));
        assert!(s.contains("--no-index --numstat"));
        assert!(s.contains("GIT_CONFIG_GLOBAL=/dev/null"));
        assert!(s.trim_end().ends_with("true"));
        let empty = remote_stats_script("/r", false, &[], &[], q);
        assert!(!empty.contains("for f in"));
        assert!(!empty.contains("--numstat"));
    }

    #[test]
    fn remote_output_parses_into_stats() {
        let changes = vec![
            ch("a.md", "modified"),
            ch("img.png", "modified"),
            ch("gone.md", "deleted"),
            ch("new.md", "untracked"),
            ch("blob.bin", "untracked"),
        ];
        let (tracked, hashed, untracked) = remote_plan(&changes);
        assert!(tracked);
        assert_eq!(hashed, vec!["a.md", "img.png", "new.md", "blob.bin"]);
        assert_eq!(untracked, vec!["new.md", "blob.bin"]);
        let raw = "4\t2\ta.md\0-\t-\timg.png\x000\t5\tgone.md\0\n__SD_SEP__\n\
                   aaaa1111\nbbbb2222\ncccc3333\n-\n__SD_SEP__\n7\t0\n-\t-\n";
        let r = parse_remote_stats(raw, hashed.len(), untracked.len());
        assert_eq!(r.hashes[3], None);
        let stats = remote_stats_from(&changes, &hashed, &r);
        assert_eq!((stats[0].adds, stats[0].dels), (Some(4), Some(2)));
        assert!(stats[0].fingerprint.ends_with("aaaa1111"));
        assert!(stats[1].binary);
        assert_eq!((stats[2].adds, stats[2].dels), (Some(0), Some(5)));
        assert_eq!(stats[2].fingerprint, "deleted:0:5:-");
        assert_eq!((stats[3].adds, stats[3].dels), (Some(7), Some(0)));
        assert!(stats[4].binary);
        // Truncated output (ssh cut short) never panics; counts go unknown.
        let r = parse_remote_stats("", 4, 2);
        let stats = remote_stats_from(&changes, &hashed, &r);
        assert!(stats.iter().all(|s| s.adds.is_none()));
    }

    #[test]
    fn store_round_trip_caps_and_cleanup() {
        let dir = std::env::temp_dir().join(format!("sd-review-store-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("review-state.json");
        assert_eq!(load_store(&path), ReviewStore::default());

        let mut store = ReviewStore::default();
        let ws = "local\n/home/u/repo";
        store.put(
            ws,
            HashMap::from([
                ("a.md".to_string(), "modified:1:0:ff".to_string()),
                ("../x".to_string(), "bad".to_string()),
            ]),
            10,
        );
        save_store(&path, &store).unwrap();
        let back = load_store(&path);
        assert_eq!(back, store);
        let marks = back.get(ws);
        assert_eq!(marks.len(), 1, "unsafe paths are dropped");
        assert_eq!(marks["a.md"], "modified:1:0:ff");
        assert!(
            back.get("ssh-host\n/home/u/repo").is_empty(),
            "origin is part of the key"
        );

        // Entry cap.
        let many: HashMap<String, String> = (0..MAX_ENTRIES + 50)
            .map(|i| (format!("f{i}.md"), "x".to_string()))
            .collect();
        store.put(ws, many, 11);
        assert_eq!(store.get(ws).len(), MAX_ENTRIES);

        // Workspace cap: the least recently touched go.
        for i in 0..MAX_WORKSPACES + 3 {
            store.put(
                &format!("local\n/r{i}"),
                HashMap::from([("a".to_string(), "x".to_string())]),
                100 + i as u64,
            );
        }
        assert_eq!(store.workspaces.len(), MAX_WORKSPACES);
        assert!(store.get(ws).is_empty(), "oldest workspace evicted");
        assert!(!store
            .get(&format!("local\n/r{}", MAX_WORKSPACES + 2))
            .is_empty());

        // Empty marks remove the workspace.
        let last = format!("local\n/r{}", MAX_WORKSPACES + 2);
        store.put(&last, HashMap::new(), 999);
        assert!(!store.workspaces.contains_key(&workspace_key(&last)));

        // A corrupt file reads as empty rather than failing.
        fs::write(&path, "{not json").unwrap();
        assert_eq!(load_store(&path), ReviewStore::default());
        let _ = fs::remove_dir_all(&dir);
    }
}
