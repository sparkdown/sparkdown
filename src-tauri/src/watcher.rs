//! Filesystem watcher.
//!
//! The agent-agnostic heart of the cockpit: rather than integrating with each
//! agent's API (claude-code, codex, cursor-cli, grok…), we watch the working
//! directory. Every agent ultimately edits files on disk, so watching the tree
//! captures what ANY of them does, for free and for all future tools.
//!
//! Change batches are emitted to the frontend as `watcher://changes`;
//! the explorer refreshes, an open editor reloads the changed file, and the
//! preview re-renders. One watched root at a time (the current project).
//!
//! Recursive inotify still *would* enter those ignored dirs. We therefore
//! register NonRecursive watches only on directories that are not named
//! `.git` / `node_modules` / `target` / `dist` / `.DS_Store` / `.cache` /
//! `.next` / `build` / `__pycache__` / `.turbo`, and we never descend into
//! them (#70). Ignored dirs are never walked: `collect_watch_dirs` may see an
//! ignored entry while listing its parent, but skips pushing that child onto
//! the stack, so it never calls `read_dir` inside it or registers a watch
//! there.
//!
//! macOS is the exception: FSEvents is recursive in the kernel and costs one
//! stream no matter how big the tree is, whereas one NonRecursive watch per
//! directory restarts the stream per directory (O(N^2), events lost during
//! each restart). There we watch the root Recursive and drop ignored paths in
//! the callback.
//!
//! Locking rules (notify 8): `watch()` must never run on the watcher's own
//! event thread (inotify waits for a reply from that thread; FSEvents stops
//! the busy run loop), and `watched_dirs` is never held across `watch()`. The
//! event callback therefore only *queues* new directories; a registrar thread
//! owned by the watch session calls `watch()`.

use notify::{
    event::{EventKind, ModifyKind, RenameMode},
    RecursiveMode,
};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

type FsWatcher = notify::RecommendedWatcher;

/// FSEvents watches a whole tree with one stream; see the module docs.
const RECURSIVE_ROOT: bool = cfg!(target_os = "macos");

/// How often an idle registrar checks whether its session was replaced.
const REGISTRAR_POLL: Duration = Duration::from_secs(1);

#[derive(Default)]
pub struct WatcherState {
    pub watcher: Arc<Mutex<Option<FsWatcher>>>,
    /// Bumped by every watch_start / watch_stop. A session thread parks its
    /// watcher, registers dirs, and emits changes only while its generation
    /// is still current, so a slow scan of an old folder can never replace
    /// the new folder's watcher or undo a watch_stop.
    generation: Arc<AtomicU64>,
}

/// One filesystem change, flattened for the frontend. Access events (open,
/// read, and close) are intentionally discarded because the frontend reads
/// files in response to changes; forwarding them would create a read -> event
/// -> read loop. Mutation kinds let the frontend avoid remounting the tree for
/// content-only edits.
#[derive(Serialize, Clone)]
pub struct FsChange {
    pub path: String,
    pub kind: String,
}

/// Directory names that are VCS / dependency / build noise. Not the agent's
/// product, and watching them on a real cargo/npm tree is thousands of inotify
/// watches and a memory spike (#70). These directories are never walked:
/// `collect_watch_dirs` skips pushing ignored child dirs onto its stack, so it
/// never reads inside them or registers watches on them. The parent directory
/// listing may see an ignored entry once to skip it; that is not walking the
/// ignored tree.
pub(crate) const IGNORED_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".DS_Store",
    ".cache",
    ".next",
    "build",
    "__pycache__",
    ".turbo",
];

pub(crate) fn ignored_dir_name(name: &str) -> bool {
    IGNORED_DIR_NAMES.contains(&name)
}

/// True if any path component is an ignored directory name.
pub(crate) fn is_ignored(path: &Path) -> bool {
    path.components()
        .any(|c| ignored_dir_name(&c.as_os_str().to_string_lossy()))
}

/// Like [`is_ignored`], but only looks at components *under* `root`. Opening
/// a folder named `target` still receives events from its non-ignored children.
pub(crate) fn is_ignored_under(root: &Path, path: &Path) -> bool {
    is_ignored(path.strip_prefix(root).unwrap_or(path))
}

/// Directories under `root` that should get a NonRecursive watch.
/// Does not descend into ignored names and does not follow symlinks.
pub(crate) fn collect_watch_dirs(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        out.push(dir.clone());
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if !ft.is_dir() || ft.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            if ignored_dir_name(&name.to_string_lossy()) {
                continue;
            }
            stack.push(entry.path());
        }
    }
    out
}

fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn collect_unwatched_dirs(path: &Path, watched_dirs: &HashSet<PathBuf>) -> Vec<PathBuf> {
    if watched_dirs.contains(path) || !is_real_dir(path) {
        return Vec::new();
    }
    collect_watch_dirs(path)
        .into_iter()
        .filter(|dir| !watched_dirs.contains(dir))
        .collect()
}

/// Forget `path` and every watched directory below it. inotify drops the
/// kernel watch when a directory is deleted, so a stale entry would stop
/// `rm -rf docs && mkdir docs` (or a branch switch) from re-watching `docs/`.
fn prune_watched(watched_dirs: &mut HashSet<PathBuf>, path: &Path) {
    watched_dirs.retain(|dir| !dir.starts_with(path));
}

/// True if the event says `event.paths[index]` is gone from its old place:
/// a removal, the "from" half of a rename, or any path that no longer
/// exists (FSEvents reports both halves of a rename as `RenameMode::Any`).
fn path_was_removed(kind: EventKind, index: usize, path: &Path) -> bool {
    match kind {
        EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => true,
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if index == 0 => true,
        _ => fs::symlink_metadata(path).is_err(),
    }
}

/// Poison-tolerant lock: a panic elsewhere must not stop the watcher.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Convert notify events into mutations meaningful to the application.
///
/// Linux inotify reports file reads as `EventKind::Access`; these are not
/// workspace changes and must never reach the frontend. In particular,
/// onFsChanges reads the active file to reload it, so forwarding access
/// events would recursively trigger more reads and explorer refreshes.
fn relevant_event_kind(kind: EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Access(_) => None,
        EventKind::Create(_) => Some("create"),
        EventKind::Modify(ModifyKind::Name(_)) => Some("rename"),
        EventKind::Modify(_) => Some("modify"),
        EventKind::Remove(_) => Some("remove"),
        EventKind::Any | EventKind::Other => Some("other"),
    }
}

/// `path` under `canonical` rewritten to sit under `spelled` instead (the
/// same directory, reached through a symlink). Paths outside `canonical`,
/// or when both spellings are equal, come back unchanged.
fn respell_under(path: &str, canonical: &Path, spelled: &Path) -> String {
    if canonical == spelled {
        return path.to_string();
    }
    match Path::new(path).strip_prefix(canonical) {
        Ok(rest) if rest.as_os_str().is_empty() => spelled.to_string_lossy().into_owned(),
        Ok(rest) => spelled.join(rest).to_string_lossy().into_owned(),
        Err(_) => path.to_string(),
    }
}

/// Turn one notify event into frontend changes plus directories that still
/// need a watch. Updates `watched_dirs` for removed paths. Takes the lock only
/// briefly and never calls `watch()`, so it is safe on the event thread.
fn process_event(
    root: &Path,
    event: &notify::Event,
    watched_dirs: &Mutex<HashSet<PathBuf>>,
) -> (Vec<FsChange>, Vec<PathBuf>) {
    let mut changes: Vec<FsChange> = Vec::new();
    let mut new_dirs: Vec<PathBuf> = Vec::new();
    let Some(kind) = relevant_event_kind(event.kind) else {
        return (changes, new_dirs);
    };
    for (index, path) in event.paths.iter().enumerate() {
        if is_ignored_under(root, path) {
            continue;
        }
        {
            let mut watched = lock(watched_dirs);
            if path_was_removed(event.kind, index, path) {
                prune_watched(&mut watched, path);
            }
            // Access events are filtered above; this guard avoids
            // treating a watched directory as a file change.
            if watched.contains(path) && is_real_dir(path) {
                continue;
            }
            new_dirs.extend(collect_unwatched_dirs(path, &watched));
        }
        changes.push(FsChange {
            path: path.to_string_lossy().into_owned(),
            kind: kind.to_string(),
        });
    }
    (changes, new_dirs)
}

/// Add a NonRecursive watch for each dir not yet watched. The set is locked
/// per lookup / insert only, never across `watch()` (see module docs).
fn watch_dirs(
    watcher: &mut impl notify::Watcher,
    dirs: &[PathBuf],
    watched_dirs: &Mutex<HashSet<PathBuf>>,
) {
    for dir in dirs {
        if lock(watched_dirs).contains(dir) {
            continue;
        }
        if let Err(e) = watcher.watch(dir, RecursiveMode::NonRecursive) {
            eprintln!("watch failed for {}: {e}", dir.display());
        } else if is_real_dir(dir) {
            lock(watched_dirs).insert(dir.clone());
        }
    }
}

/// Park `watcher` in `slot` only if session `my_gen` is still current.
/// Returns the watcher back when the session is stale, so the caller can
/// drop it outside the lock.
fn park_if_current<W>(
    slot: &Mutex<Option<W>>,
    generation: &AtomicU64,
    my_gen: u64,
    watcher: W,
) -> Result<(), W> {
    let mut guard = lock(slot);
    if generation.load(Ordering::SeqCst) != my_gen {
        return Err(watcher);
    }
    *guard = Some(watcher);
    Ok(())
}

/// Start a new watch session: bump the generation, drop the old watcher, and
/// spawn the session thread. Split from the Tauri command so tests can run it
/// without an `AppHandle`.
fn start_session(
    state: &WatcherState,
    root: PathBuf,
    emit: impl Fn(Vec<FsChange>) + Send + 'static,
) {
    let (my_gen, old) = {
        let mut guard = lock(&state.watcher);
        let my_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        (my_gen, guard.take())
    };
    drop(old);
    let slot = state.watcher.clone();
    let generation = state.generation.clone();
    std::thread::spawn(move || run_session(slot, generation, my_gen, root, emit));
}

/// Stop the current session (drops the watcher) and invalidate any session
/// thread that is still scanning.
fn stop_session(state: &WatcherState) {
    let old = {
        let mut guard = lock(&state.watcher);
        state.generation.fetch_add(1, Ordering::SeqCst);
        guard.take()
    };
    drop(old);
}

/// Body of the session thread: build the watcher, register the tree, park
/// the watcher, then act as the registrar for directories created later.
fn run_session(
    slot: Arc<Mutex<Option<FsWatcher>>>,
    generation: Arc<AtomicU64>,
    my_gen: u64,
    root: PathBuf,
    emit: impl Fn(Vec<FsChange>) + Send + 'static,
) {
    let watched_dirs: Arc<Mutex<HashSet<PathBuf>>> = Arc::default();
    let (dir_tx, dir_rx) = mpsc::channel::<Vec<PathBuf>>();

    let watched_for_events = watched_dirs.clone();
    let generation_for_events = generation.clone();
    let root_for_events = root.clone();
    let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        if generation_for_events.load(Ordering::SeqCst) != my_gen {
            return;
        }
        let (changes, new_dirs) = process_event(&root_for_events, &event, &watched_for_events);
        if !new_dirs.is_empty() {
            if RECURSIVE_ROOT {
                // Already covered by the Recursive root watch; just track them.
                lock(&watched_for_events).extend(new_dirs);
            } else {
                // Never watch() here: this is the watcher's own event thread.
                let _ = dir_tx.send(new_dirs);
            }
        }
        if !changes.is_empty() {
            emit(changes);
        }
    });

    let mut watcher = match watcher {
        Ok(watcher) => watcher,
        Err(e) => {
            eprintln!("watcher init failed: {e}");
            return;
        }
    };

    let dirs = collect_watch_dirs(&root);
    if RECURSIVE_ROOT {
        if let Err(e) = notify::Watcher::watch(&mut watcher, &root, RecursiveMode::Recursive) {
            eprintln!("watch failed for {}: {e}", root.display());
            return;
        }
        lock(&watched_dirs).extend(dirs);
    } else {
        watch_dirs(&mut watcher, &dirs, &watched_dirs);
    }

    // Hold the watcher alive by parking it in shared state (dropping it
    // stops the watch) -- unless a newer watch_start / watch_stop won.
    if let Err(stale) = park_if_current(&slot, &generation, my_gen, watcher) {
        drop(stale);
        return;
    }
    if RECURSIVE_ROOT {
        return;
    }

    // Registrar: watch directories the callback queued. Ends when the
    // session is replaced or the watcher (and so the sender) is dropped.
    loop {
        match dir_rx.recv_timeout(REGISTRAR_POLL) {
            Ok(new_dirs) => {
                let mut guard = lock(&slot);
                if generation.load(Ordering::SeqCst) != my_gen {
                    break;
                }
                let Some(watcher) = guard.as_mut() else { break };
                watch_dirs(watcher, &new_dirs, &watched_dirs);
            }
            Err(RecvTimeoutError::Timeout) => {
                if generation.load(Ordering::SeqCst) != my_gen {
                    break;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// Begin watching `root` recursively. Replaces any existing watch. The actual
/// registration runs on a background thread so a large tree never stalls the
/// UI; the command returns immediately.
#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    state: tauri::State<'_, WatcherState>,
    root: String,
) -> Result<(), String> {
    if crate::remote::is_active() {
        // The remote poller replaces the local notify session: a local file
        // event must not refresh (or re-sync tabs of) the remote workspace.
        stop_session(&state);
        return crate::remote::watch_start(app, &root);
    }
    let root_path = std::path::PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    // FSEvents/inotify report real paths. Watch (and apply the ignore rules)
    // on the canonical root, then re-spell event paths in the caller's
    // spelling of the root (/tmp/x, not /private/tmp/x) so they match tabs
    // and the file tree.
    let canonical = root_path
        .canonicalize()
        .unwrap_or_else(|_| root_path.clone());
    let spelled = root_path.clone();
    start_session(&state, canonical.clone(), move |mut changes| {
        for c in &mut changes {
            c.path = respell_under(&c.path, &canonical, &spelled);
        }
        crate::file_index::invalidate_for_kinds(changes.iter().map(|c| c.kind.as_str()));
        let _ = app.emit("watcher://changes", changes);
    });
    Ok(())
}

/// Stop watching (drops the watcher).
#[tauri::command]
pub fn watch_stop(state: tauri::State<'_, WatcherState>) -> Result<(), String> {
    crate::remote::watch_stop();
    stop_session(&state);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn respell_under_maps_canonical_paths_to_the_opened_spelling() {
        let canon = Path::new("/private/tmp/x");
        let spelled = Path::new("/tmp/x");
        assert_eq!(
            respell_under("/private/tmp/x/docs/a.md", canon, spelled),
            "/tmp/x/docs/a.md"
        );
        assert_eq!(respell_under("/private/tmp/x", canon, spelled), "/tmp/x");
        // Outside the root, or same spelling: unchanged.
        assert_eq!(
            respell_under("/private/tmp/y/a.md", canon, spelled),
            "/private/tmp/y/a.md"
        );
        assert_eq!(
            respell_under("/a/b.md", Path::new("/a"), Path::new("/a")),
            "/a/b.md"
        );
        // A sibling whose name only shares a prefix is not inside the root.
        assert_eq!(
            respell_under("/private/tmp/xy/a.md", canon, spelled),
            "/private/tmp/xy/a.md"
        );
    }
    use std::fs;

    fn test_tree(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("frontend/src")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.join("target/debug")).unwrap();
        fs::create_dir_all(dir.join(".git/objects")).unwrap();
        fs::create_dir_all(dir.join("dist")).unwrap();
        fs::create_dir_all(dir.join(".cache/tmp")).unwrap();
        fs::create_dir_all(dir.join(".next/cache")).unwrap();
        fs::create_dir_all(dir.join("build/assets")).unwrap();
        fs::create_dir_all(dir.join("__pycache__/nested")).unwrap();
        fs::create_dir_all(dir.join(".turbo/cache")).unwrap();
        fs::write(dir.join("src/main.rs"), "").unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), "").unwrap();
        fs::write(dir.join("target/debug/sparkdown"), "").unwrap();
        dir
    }

    #[test]
    fn is_ignored_matches_dependency_and_build_dirs() {
        assert!(is_ignored(Path::new("/proj/node_modules/pkg/index.js")));
        assert!(is_ignored(Path::new("/proj/target/debug/sparkdown")));
        assert!(is_ignored(Path::new("/proj/.git/HEAD")));
        assert!(is_ignored(Path::new("/proj/dist/index.js")));
        assert!(is_ignored(Path::new("/proj/.cache/tmp")));
        assert!(is_ignored(Path::new("/proj/.next/cache")));
        assert!(is_ignored(Path::new("/proj/build/assets")));
        assert!(is_ignored(Path::new("/proj/__pycache__/nested")));
        assert!(is_ignored(Path::new("/proj/.turbo/cache")));
        assert!(!is_ignored(Path::new("/proj/src/main.rs")));
        assert!(!is_ignored(Path::new("/proj/frontend/src/app.ts")));
    }

    #[test]
    fn is_ignored_under_does_not_treat_the_root_name_as_noise() {
        let root = Path::new("/proj/target");
        assert!(!is_ignored_under(root, Path::new("/proj/target/debug/foo")));
        assert!(is_ignored_under(
            root,
            Path::new("/proj/target/node_modules/pkg")
        ));
        assert!(is_ignored_under(
            Path::new("/proj"),
            Path::new("/proj/target/debug/foo")
        ));
    }

    #[test]
    fn collect_watch_dirs_skips_ignored_trees() {
        let dir = test_tree("sparkdown_test_watch_dirs");
        let watched = collect_watch_dirs(&dir);
        let as_str: Vec<String> = watched
            .iter()
            .map(|p| {
                p.strip_prefix(&dir)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();

        assert!(as_str.iter().any(|p| p.is_empty() || p == "."));
        assert!(as_str.iter().any(|p| p == "src"));
        assert!(as_str.iter().any(|p| p == "frontend"));
        assert!(as_str
            .iter()
            .any(|p| p == "frontend/src" || p.ends_with("frontend/src")));
        assert!(!as_str.iter().any(|p| p.contains("node_modules")));
        assert!(!as_str.iter().any(|p| p.contains("target")));
        assert!(!as_str.iter().any(|p| p.contains(".git")));
        assert!(!as_str.iter().any(|p| p.contains("dist")));
        assert!(!as_str.iter().any(|p| p.contains(".cache")));
        assert!(!as_str.iter().any(|p| p.contains(".next")));
        assert!(!as_str
            .iter()
            .any(|p| p == "build" || p.starts_with("build/")));
        assert!(!as_str.iter().any(|p| p.contains("__pycache__")));
        assert!(!as_str.iter().any(|p| p.contains(".turbo")));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_watch_dirs_still_watches_an_ignored_name_used_as_root() {
        // Open Folder on `target/` itself should watch that root, just not
        // nested ignored names.
        let parent = std::env::temp_dir().join("sparkdown_test_watch_root_parent");
        let dir = parent.join("target");
        let _ = fs::remove_dir_all(&parent);
        fs::create_dir_all(dir.join("debug")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        let watched = collect_watch_dirs(&dir);
        assert!(watched.contains(&dir));
        assert!(watched.iter().any(|p| p.ends_with("debug")));
        assert!(!watched.iter().any(|p| p.ends_with("node_modules")));
        let _ = fs::remove_dir_all(&parent);
    }

    #[cfg(unix)]
    #[test]
    fn is_real_dir_rejects_symlink() {
        use std::os::unix::fs::symlink;

        let parent = std::env::temp_dir().join("sparkdown_test_watcher_symlink");
        let real = parent.join("real");
        let link = parent.join("link");
        let _ = fs::remove_dir_all(&parent);
        fs::create_dir_all(&real).unwrap();
        symlink(&real, &link).unwrap();

        assert!(is_real_dir(&real));
        assert!(!is_real_dir(&link));
        assert!(collect_unwatched_dirs(&link, &HashSet::new()).is_empty());

        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn access_events_are_not_workspace_changes() {
        use notify::event::{AccessKind, AccessMode, DataChange, ModifyKind};

        assert_eq!(
            relevant_event_kind(EventKind::Access(AccessKind::Open(AccessMode::Read))),
            None
        );
        assert_eq!(
            relevant_event_kind(EventKind::Access(AccessKind::Read)),
            None
        );
        assert_eq!(
            relevant_event_kind(EventKind::Access(AccessKind::Close(AccessMode::Write))),
            None
        );
        assert_eq!(
            relevant_event_kind(EventKind::Create(notify::event::CreateKind::File)),
            Some("create")
        );
        assert_eq!(
            relevant_event_kind(EventKind::Modify(ModifyKind::Data(DataChange::Any))),
            Some("modify")
        );
        assert_eq!(
            relevant_event_kind(EventKind::Remove(notify::event::RemoveKind::File)),
            Some("remove")
        );
    }

    #[test]
    fn collect_unwatched_dirs_skips_paths_already_watched() {
        let dir = test_tree("sparkdown_test_unwatched_watch_dirs");
        let child = dir.join("src");
        let mut watched = HashSet::new();

        watched.insert(dir.clone());
        assert!(collect_unwatched_dirs(&dir, &watched).is_empty());

        watched.clear();
        watched.insert(child.clone());
        let extra = collect_unwatched_dirs(&dir, &watched);
        assert!(!extra.contains(&child));
        assert!(extra.contains(&dir));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_watched_drops_path_and_descendants_only() {
        let mut watched: HashSet<PathBuf> = [
            "/proj",
            "/proj/docs",
            "/proj/docs/a",
            "/proj/docs/a/b",
            "/proj/docsx",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        prune_watched(&mut watched, Path::new("/proj/docs"));
        assert!(watched.contains(Path::new("/proj")));
        assert!(watched.contains(Path::new("/proj/docsx")));
        assert!(!watched.contains(Path::new("/proj/docs")));
        assert!(!watched.contains(Path::new("/proj/docs/a")));
        assert!(!watched.contains(Path::new("/proj/docs/a/b")));
    }

    #[test]
    fn removed_dir_is_rewatched_after_recreate() {
        use notify::event::RemoveKind;

        // rm -rf docs && mkdir docs: the Remove event arrives after docs/
        // already exists again. It must still prune so the recreated docs/
        // is queued for a fresh watch.
        let dir = test_tree("sparkdown_test_watch_recreate");
        let docs = dir.join("src");
        let watched = Mutex::new(collect_watch_dirs(&dir).into_iter().collect());
        let event =
            notify::Event::new(EventKind::Remove(RemoveKind::Folder)).add_path(docs.clone());
        let (changes, new_dirs) = process_event(&dir, &event, &watched);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, "remove");
        assert!(new_dirs.contains(&docs));
        assert!(!lock(&watched).contains(&docs));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_from_prunes_old_path() {
        let watched: Mutex<HashSet<PathBuf>> =
            Mutex::new([PathBuf::from("/proj"), PathBuf::from("/proj/old")].into());
        let event = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
            .add_path(PathBuf::from("/proj/old"));
        let (changes, new_dirs) = process_event(Path::new("/proj"), &event, &watched);
        assert_eq!(changes[0].kind, "rename");
        assert!(new_dirs.is_empty());
        assert!(!lock(&watched).contains(Path::new("/proj/old")));
        assert!(lock(&watched).contains(Path::new("/proj")));
    }

    #[test]
    fn stale_session_does_not_park_its_watcher() {
        let slot: Mutex<Option<u32>> = Mutex::new(None);
        let generation = AtomicU64::new(1);
        // A newer watch_start / watch_stop bumped the generation.
        generation.fetch_add(1, Ordering::SeqCst);
        assert_eq!(park_if_current(&slot, &generation, 1, 7), Err(7));
        assert_eq!(*lock(&slot), None);
        assert_eq!(park_if_current(&slot, &generation, 2, 8), Ok(()));
        assert_eq!(*lock(&slot), Some(8));
    }

    #[test]
    fn stop_during_scan_is_not_undone() {
        let dir = test_tree("sparkdown_test_watch_stop_race");
        let state = WatcherState::default();
        start_session(&state, dir.clone(), |_| {});
        stop_session(&state);
        std::thread::sleep(Duration::from_millis(500));
        assert!(lock(&state.watcher).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Runs `f` on a helper thread and fails if it does not finish in time.
    fn within(timeout: Duration, f: impl FnOnce() + Send + 'static) {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            f();
            let _ = tx.send(());
        });
        rx.recv_timeout(timeout).expect("watcher operation hung");
    }

    #[test]
    fn nested_dir_created_under_watched_root_does_not_hang() {
        let dir = test_tree("sparkdown_test_watch_nested_mkdir");
        let dir = fs::canonicalize(&dir).unwrap();
        let state = Arc::new(WatcherState::default());
        let (tx, rx) = mpsc::channel::<Vec<FsChange>>();
        let tx = Mutex::new(tx);
        start_session(&state, dir.clone(), move |changes| {
            let _ = lock(&tx).send(changes);
        });
        // Wait for the session to park its watcher.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while lock(&state.watcher).is_none() {
            assert!(std::time::Instant::now() < deadline, "watcher never parked");
            std::thread::sleep(Duration::from_millis(20));
        }

        // `mkdir -p docs/new` used to deadlock the event thread. Keep writing
        // files into the nested dir until one is reported: that proves the
        // new dir got watched and the event thread is still alive.
        let nested = dir.join("docs/new");
        fs::create_dir_all(&nested).unwrap();
        let from_nested = |changes: &[FsChange]| {
            changes
                .iter()
                .any(|c| Path::new(&c.path).starts_with(&nested) && c.path.ends_with(".md"))
        };
        let mut seen = false;
        for n in 0..100 {
            fs::write(nested.join(format!("f{n}.md")), "x").unwrap();
            if let Ok(changes) = rx.recv_timeout(Duration::from_millis(100)) {
                seen = from_nested(&changes);
            }
            while let Ok(changes) = rx.try_recv() {
                seen |= from_nested(&changes);
            }
            if seen {
                break;
            }
        }
        assert!(seen, "no event from the nested dir");

        // watch_start / watch_stop take the state lock on the main thread;
        // they must not block behind a stuck watcher.
        let state_for_stop = state.clone();
        within(Duration::from_secs(5), move || {
            stop_session(&state_for_stop)
        });
        assert!(lock(&state.watcher).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
