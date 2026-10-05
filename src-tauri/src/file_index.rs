//! Workspace file listing for Quick open (⌘P).
//!
//! One flat list of the workspace's files, as paths relative to the root.
//! Local: an iterative walk that skips the watcher's ignored directories and
//! never follows symlinked directories. Remote: one `find` over SSH with the
//! same names pruned (see `remote::workspace_files_script`). Both stop at
//! [`MAX_FILES`] entries.
//!
//! Results are cached per (machine, root, hidden) and dropped when the
//! watcher reports a structural change (create / remove / rename / other) —
//! a content-only `modify` keeps the list, since no path changed.

use crate::commands::AppError;
use crate::watcher::ignored_dir_name;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

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

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// Walk `root` and return files relative to it. Skips ignored directory
/// names (and, unless `include_hidden`, dot-entries); does not descend into
/// symlinked directories (a symlinked file is listed). Stops at `cap`.
pub fn walk_local(root: &Path, include_hidden: bool, cap: usize) -> FileListing {
    let mut files = Vec::new();
    let mut truncated = false;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    'walk: while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
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
                stack.push(path);
                continue;
            }
            // Files and symlinks. A symlink to a directory is not walked (no
            // cycles) and not listed (it cannot be opened as a document).
            if ft.is_symlink() && path.is_dir() {
                continue;
            }
            if files.len() >= cap {
                truncated = true;
                break 'walk;
            }
            if let Ok(rel) = path.strip_prefix(root) {
                let rel: Vec<String> = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect();
                files.push(rel.join("/"));
            }
        }
    }
    files.sort_unstable();
    FileListing { files, truncated }
}

fn list_uncached(root: &str, include_hidden: bool, remote: bool) -> Result<FileListing, AppError> {
    if remote {
        return crate::remote::list_workspace_files(root, include_hidden, MAX_FILES);
    }
    let path = Path::new(root);
    if !path.is_dir() {
        return Err(AppError::InvalidPath(format!("Not a directory: {root}")));
    }
    Ok(walk_local(path, include_hidden, MAX_FILES))
}

/// All files under `root` (relative paths) for Quick open. Local or remote
/// per the active session; cached until the watcher reports a structural
/// change. Runs off the main thread (the remote path is a blocking ssh call).
#[tauri::command]
pub async fn list_workspace_files(
    root: String,
    include_hidden: Option<bool>,
) -> Result<FileListing, AppError> {
    let include_hidden = include_hidden.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
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
        let listing = list_uncached(&root, include_hidden, host.is_some())?;
        *cache() = Some(Cache {
            key,
            listing: listing.clone(),
        });
        Ok(listing)
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
    }
}
