//! Workspace file listing for Quick open (⌘P).
//!
//! One flat list of the workspace's files, as paths relative to the root.
//! Local: a breadth-first walk that skips the watcher's ignored directories
//! and `.gitignore`d paths (see `gitignore.rs`), and never follows symlinked
//! directories. The streaming command sends the first level as soon as it is
//! read, then further batches while the walk goes on. Remote: one `find` over SSH with the
//! same names pruned (see `remote::workspace_files_script`). Both stop at
//! [`MAX_FILES`] entries.
//!
//! Results are cached per (machine, root, hidden) and dropped when the
//! watcher reports a structural change (create / remove / rename / other) —
//! a content-only `modify` keeps the list, since no path changed.

use crate::commands::AppError;
use crate::gitignore::{root_rules, Rules};
use crate::watcher::{ignored_dir_name, FsChange};
use serde::Serialize;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// How often the streaming walk sends what it found since the last batch.
const BATCH_EVERY: Duration = Duration::from_millis(150);

/// Hard cap on listed files. A 50k-file tree lists in well under a second
/// locally; past that, Quick open is not the right tool anyway.
pub const MAX_FILES: usize = 50_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileListing {
    /// Paths relative to the root, `/`-separated, sorted.
    pub files: Vec<String>,
    /// True when the walk stopped at [`MAX_FILES`].
    pub truncated: bool,
}

#[derive(Clone, PartialEq, Eq)]
struct CacheKey {
    /// `None` = this machine; `Some(host)` = the active SSH session.
    host: Option<String>,
    root: String,
    include_hidden: bool,
}

struct Cache {
    key: CacheKey,
    listing: FileListing,
}

static CACHE: OnceLock<Mutex<Option<Cache>>> = OnceLock::new();

fn cache() -> MutexGuard<'static, Option<Cache>> {
    CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Forget the cached listing. Called on every structural watcher event.
pub fn invalidate() {
    *cache() = None;
}

/// Invalidate when a batch of watcher change kinds contains a structural one.
pub fn invalidate_for_kinds<'a>(kinds: impl IntoIterator<Item = &'a str>) {
    if kinds.into_iter().any(|k| k != "modify") {
        invalidate();
    }
}

/// Invalidate for a batch of watcher changes: a structural kind, or any
/// change to a `.gitignore` (it changes which files are listed).
pub fn invalidate_for_changes(changes: &[FsChange]) {
    let ignore_file = changes.iter().any(|c| {
        Path::new(&c.path)
            .file_name()
            .is_some_and(|n| n == crate::gitignore::IGNORE_FILE)
    });
    if ignore_file {
        invalidate();
    } else {
        invalidate_for_kinds(changes.iter().map(|c| c.kind.as_str()));
    }
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// Walk `root` and return files relative to it. Skips ignored directory
/// names, `.gitignore`d paths (and, unless `include_hidden`, dot-entries);
/// does not descend into symlinked directories (a symlinked file is
/// listed). Stops at `cap`.
#[cfg(test)]
pub fn walk_local(root: &Path, include_hidden: bool, cap: usize) -> FileListing {
    walk_local_streaming(root, include_hidden, cap, &mut |_| {})
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(parts.join("/"))
}

/// [`walk_local`], breadth-first, handing new files to `on_batch` as it goes:
/// once after the first level, then every [`BATCH_EVERY`]. The batches
/// together are the returned files, unsorted; the return value is sorted.
pub fn walk_local_streaming(
    root: &Path,
    include_hidden: bool,
    cap: usize,
    on_batch: &mut dyn FnMut(&[String]),
) -> FileListing {
    let mut files: Vec<String> = Vec::new();
    let mut sent = 0;
    let mut last_sent = Instant::now();
    let mut truncated = false;
    let mut first_level = true;
    let mut queue: VecDeque<(PathBuf, Rules)> =
        VecDeque::from([(root.to_path_buf(), root_rules(root))]);
    'walk: while let Some((dir, rules)) = queue.pop_front() {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if ignored_dir_name(&name) || (!include_hidden && is_hidden(&name)) {
                    continue;
                }
                let Ok(ft) = entry.file_type() else {
                    continue;
                };
                let path = entry.path();
                if ft.is_dir() {
                    if !rules.is_ignored(&path, true) {
                        let child = rules.child(&path);
                        queue.push_back((path, child));
                    }
                    continue;
                }
                // Files and symlinks. A symlink to a directory is not walked (no
                // cycles) and not listed (it cannot be opened as a document).
                if ft.is_symlink() && path.is_dir() {
                    continue;
                }
                if rules.is_ignored(&path, false) {
                    continue;
                }
                if files.len() >= cap {
                    truncated = true;
                    break 'walk;
                }
                if let Some(rel) = relative(root, &path) {
                    files.push(rel);
                }
            }
        }
        if first_level || last_sent.elapsed() >= BATCH_EVERY {
            first_level = false;
            if files.len() > sent {
                on_batch(&files[sent..]);
                sent = files.len();
            }
            last_sent = Instant::now();
        }
    }
    files.sort_unstable();
    FileListing { files, truncated }
}

fn list_uncached(
    root: &str,
    include_hidden: bool,
    remote: bool,
    on_batch: &mut dyn FnMut(&[String]),
) -> Result<FileListing, AppError> {
    if remote {
        return crate::remote::list_workspace_files(root, include_hidden, MAX_FILES);
    }
    let path = Path::new(root);
    if !path.is_dir() {
        return Err(AppError::InvalidPath(format!("Not a directory: {root}")));
    }
    Ok(walk_local_streaming(
        path,
        include_hidden,
        MAX_FILES,
        on_batch,
    ))
}

/// The cached listing for this key, or a fresh walk (stored in the cache).
fn listing(
    root: String,
    include_hidden: bool,
    on_batch: &mut dyn FnMut(&[String]),
) -> Result<FileListing, AppError> {
    let host = crate::remote::current_session().map(|s| s.host);
    let key = CacheKey {
        host: host.clone(),
        root: root.clone(),
        include_hidden,
    };
    if let Some(c) = cache().as_ref() {
        if c.key == key {
            return Ok(c.listing.clone());
        }
    }
    let listing = list_uncached(&root, include_hidden, host.is_some(), on_batch)?;
    *cache() = Some(Cache {
        key,
        listing: listing.clone(),
    });
    Ok(listing)
}

/// All files under `root` (relative paths) for Quick open. Local or remote
/// per the active session; cached until the watcher reports a structural
/// change. Runs off the main thread (the remote path is a blocking ssh call).
#[tauri::command]
pub async fn list_workspace_files(
    webview_window: tauri::WebviewWindow,
    root: String,
    include_hidden: Option<bool>,
) -> Result<FileListing, AppError> {
    let include_hidden = include_hidden.unwrap_or(false);
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        listing(root, include_hidden, &mut |_| {})
    })
    .await
    .map_err(|e| AppError::Other(format!("list task failed: {e}")))?
}

/// [`list_workspace_files`] that also sends partial results over `on_batch`
/// while a local walk runs: the first level right away, then more files as
/// they are found (each batch holds only new paths, unsorted). A cached or
/// remote listing sends no batches. The return value is the full listing.
#[tauri::command]
pub async fn list_workspace_files_stream(
    webview_window: tauri::WebviewWindow,
    root: String,
    include_hidden: Option<bool>,
    on_batch: tauri::ipc::Channel<Vec<String>>,
) -> Result<FileListing, AppError> {
    let include_hidden = include_hidden.unwrap_or(false);
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        listing(root, include_hidden, &mut |batch| {
            let _ = on_batch.send(batch.to_vec());
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("list task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sparkdown_file_index_{name}_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "x").unwrap();
    }

    #[test]
    fn walk_skips_ignored_dirs_and_hidden_entries() {
        let root = tree("ignore");
        touch(&root, "README.md");
        touch(&root, "docs/a.md");
        touch(&root, "src/deep/b.rs");
        touch(&root, "node_modules/pkg/index.js");
        touch(&root, "target/debug/app");
        touch(&root, ".git/HEAD");
        touch(&root, "sub/dist/out.js");
        touch(&root, ".env");
        touch(&root, ".config/x.toml");

        let l = walk_local(&root, false, MAX_FILES);
        assert_eq!(l.files, vec!["README.md", "docs/a.md", "src/deep/b.rs"]);
        assert!(!l.truncated);

        // Hidden files show with the setting; ignored dirs never do.
        let l = walk_local(&root, true, MAX_FILES);
        assert_eq!(
            l.files,
            vec![
                ".config/x.toml",
                ".env",
                "README.md",
                "docs/a.md",
                "src/deep/b.rs"
            ]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_skips_gitignored_paths_with_nested_files() {
        let root = tree("gitignore");
        fs::write(root.join(".gitignore"), "*.log\ngenerated/\n/local.md\n").unwrap();
        touch(&root, "README.md");
        touch(&root, "local.md");
        touch(&root, "run.log");
        touch(&root, "generated/a.md");
        touch(&root, "docs/generated/b.md");
        touch(&root, "docs/local.md");
        touch(&root, "docs/keep.log");
        fs::write(root.join("docs/.gitignore"), "!keep.log\ndraft-*.md\n").unwrap();
        touch(&root, "docs/draft-1.md");
        touch(&root, "docs/guide.md");

        let l = walk_local(&root, false, MAX_FILES);
        assert_eq!(
            l.files,
            vec![
                "README.md",
                "docs/guide.md",
                "docs/keep.log",
                "docs/local.md"
            ]
        );
        let l = walk_local(&root, true, MAX_FILES);
        assert_eq!(
            l.files,
            vec![
                ".gitignore",
                "README.md",
                "docs/.gitignore",
                "docs/guide.md",
                "docs/keep.log",
                "docs/local.md"
            ]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn streaming_sends_the_first_level_first() {
        let root = tree("stream");
        touch(&root, "top.md");
        touch(&root, "a/b/c/deep.md");
        touch(&root, "z.md");
        let mut batches: Vec<Vec<String>> = Vec::new();
        let l = walk_local_streaming(&root, false, MAX_FILES, &mut |b| batches.push(b.to_vec()));
        let mut first = batches[0].clone();
        first.sort();
        assert_eq!(first, vec!["top.md", "z.md"]);
        // The batches add up to the result; the walk is breadth-first.
        let mut all: Vec<String> = batches.concat();
        all.sort();
        assert!(all.len() <= l.files.len());
        assert_eq!(l.files, vec!["a/b/c/deep.md", "top.md", "z.md"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_stops_at_the_cap() {
        let root = tree("cap");
        for i in 0..25 {
            touch(&root, &format!("d{}/f{i}.md", i % 3));
        }
        let l = walk_local(&root, false, 10);
        assert_eq!(l.files.len(), 10);
        assert!(l.truncated);
        let l = walk_local(&root, false, 25);
        assert_eq!(l.files.len(), 25);
        assert!(!l.truncated);
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn walk_does_not_follow_symlinked_dirs() {
        let root = tree("symlink");
        touch(&root, "real/a.md");
        std::os::unix::fs::symlink(root.join("real"), root.join("loop")).unwrap();
        std::os::unix::fs::symlink(root.join("real/a.md"), root.join("link.md")).unwrap();
        let l = walk_local(&root, false, MAX_FILES);
        assert_eq!(l.files, vec!["link.md", "real/a.md"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn structural_kinds_invalidate_and_modify_keeps_the_cache() {
        let put = || {
            *cache() = Some(Cache {
                key: CacheKey {
                    host: None,
                    root: "/r".into(),
                    include_hidden: false,
                },
                listing: FileListing {
                    files: vec!["a".into()],
                    truncated: false,
                },
            })
        };
        put();
        invalidate_for_kinds(["modify", "modify"]);
        assert!(cache().is_some());
        invalidate_for_kinds(["modify", "create"]);
        assert!(cache().is_none());
        put();
        invalidate_for_kinds(["other"]);
        assert!(cache().is_none());

        // Any change to a .gitignore changes which files are listed.
        let change = |path: &str, kind: &str| FsChange {
            path: path.into(),
            kind: kind.into(),
            ignored: false,
        };
        put();
        invalidate_for_changes(&[change("/r/a.md", "modify")]);
        assert!(cache().is_some());
        invalidate_for_changes(&[change("/r/sub/.gitignore", "modify")]);
        assert!(cache().is_none());
    }
}
