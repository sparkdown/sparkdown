//! Multi-window core (#60, #61): one SparkDown process, N windows, each bound
//! to at most one folder.
//!
//! Two pieces live here:
//!
//! - **Window scope.** Tauri commands run on whatever thread the runtime
//!   picks, and much of the core (the remote layer above all) asks "which
//!   session?" deep inside helper calls. Each command enters the calling
//!   window's scope ([`enter`]) on the thread that does the work, and
//!   per-window state is looked up by [`current_label`]. Code that runs with
//!   no scope sees [`DEFAULT_LABEL`].
//! - **Registry.** Which windows exist, the folder each is bound to, which
//!   one was focused last. Folder identity is canonical (see [`FolderId`]),
//!   so a folder is open in at most one window.

// Folder routing (#62) and MCP routing (#64) consume the rest of the
// registry; remove this once they land.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

/// Scope used when no window scope was entered (tests, background threads
/// that were not handed a label). It is also the label of the one window
/// `tauri.conf.json` creates; windows opened on a folder are `w-…` (#62/#65).
pub const DEFAULT_LABEL: &str = "main";

thread_local! {
    static SCOPE: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Restores the previous scope when dropped.
pub struct ScopeGuard {
    prev: Option<String>,
}

impl Drop for ScopeGuard {
    fn drop(&mut self) {
        let prev = self.prev.take();
        SCOPE.with(|s| *s.borrow_mut() = prev);
    }
}

/// Run the rest of this thread's work (until the guard drops) as `label`.
#[must_use = "the scope ends when the guard is dropped"]
pub fn enter(label: &str) -> ScopeGuard {
    let prev = SCOPE.with(|s| s.borrow_mut().replace(label.to_string()));
    ScopeGuard { prev }
}

/// The window this thread is working for.
pub fn current_label() -> String {
    SCOPE
        .with(|s| s.borrow().clone())
        .unwrap_or_else(|| DEFAULT_LABEL.to_string())
}

/// `spawn_blocking` that keeps the caller's window scope on the worker.
pub async fn blocking<T, F>(label: String, f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let _scope = enter(&label);
        f()
    })
    .await
    .map_err(|e| format!("task failed: {e}"))
}

/// `tauri::async_runtime::spawn_blocking` with the caller's window scope
/// entered on the worker thread. Same return type, so `.await` chains stay.
pub fn spawn_scoped<F, R>(label: String, f: F) -> tauri::async_runtime::JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let _scope = enter(&label);
        f()
    })
}

/// Short stable tag for a label, for names with length limits (ssh
/// ControlPath, remote socket names).
pub fn label_tag(label: &str) -> String {
    crate::context::workspace_key(label)[..8].to_string()
}

// --- Folder identity ---------------------------------------------------------

/// What makes two folders "the same" (#62). Local: the canonical path
/// (symlinks resolved; case-folded where the filesystem usually is
/// case-insensitive). Remote: `ssh -G` user/hostname/port plus the remote
/// realpath of the root.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FolderId {
    Local {
        path: String,
    },
    Remote {
        user: String,
        hostname: String,
        port: u16,
        path: String,
    },
}

impl FolderId {
    /// One string per identity, for hashing into labels and tokens.
    pub fn key(&self) -> String {
        match self {
            FolderId::Local { path } => {
                let p = if cfg!(any(windows, target_os = "macos")) {
                    path.to_lowercase()
                } else {
                    path.clone()
                };
                format!("local:{p}")
            }
            FolderId::Remote {
                user,
                hostname,
                port,
                path,
            } => format!("ssh:{}@{}:{port}:{path}", user, hostname.to_lowercase()),
        }
    }

    /// Whether `path` (an absolute local path) is this folder or inside it.
    pub fn contains_local(&self, path: &str) -> bool {
        let FolderId::Local { path: root } = self else {
            return false;
        };
        let norm = |s: &str| {
            // A canonicalized cwd may carry the `\\?\` verbatim prefix.
            let s = s
                .strip_prefix(r"\\?\")
                .filter(|r| !r.starts_with("UNC\\"))
                .unwrap_or(s);
            let s = s.replace('\\', "/");
            let s = s.trim_end_matches('/').to_string();
            if cfg!(any(windows, target_os = "macos")) {
                s.to_lowercase()
            } else {
                s
            }
        };
        let (root, path) = (norm(root), norm(path));
        if root.is_empty() {
            return true; // "/"
        }
        path == root || path.starts_with(&format!("{root}/"))
    }
}

/// Canonical id of a local folder (must exist).
pub fn local_folder_id(path: &str) -> Result<FolderId, String> {
    let canon = std::fs::canonicalize(path).map_err(|e| format!("{path}: {e}"))?;
    if !canon.is_dir() {
        return Err(format!("not a folder: {path}"));
    }
    let mut s = canon.to_string_lossy().to_string();
    // Windows: drop the `\\?\` verbatim prefix canonicalize adds.
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if !rest.starts_with("UNC\\") {
            s = rest.to_string();
        }
    }
    Ok(FolderId::Local { path: s })
}

/// Window label for a window opened on `folder`: stable per folder, so the
/// same folder gets the same label on every launch (#60 decision 4).
pub fn label_for_folder(folder: &FolderId) -> String {
    format!("w-{}", crate::context::workspace_key(&folder.key()))
}

// --- Agent routing tokens (#64) ------------------------------------------------

static TOKEN_SECRET: OnceLock<String> = OnceLock::new();

/// Load (or create, 0600) the per-install secret that keys routing tokens,
/// so a token can't be computed from a folder path alone.
pub fn init_token_secret(config_dir: &std::path::Path) {
    let path = config_dir.join("agent-token.key");
    let secret = std::fs::read_to_string(&path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| s.len() >= 32)
        .unwrap_or_else(|| {
            let s = random_hex();
            let _ = std::fs::create_dir_all(config_dir);
            let _ = write_private(&path, &s);
            s
        });
    let _ = TOKEN_SECRET.set(secret);
}

fn write_private(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(text.as_bytes())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, text)
    }
}

/// 256 bits of OS-seeded randomness as hex.
fn random_hex() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..4u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(i ^ 0x9E37_79B9_7F4A_7C15);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// The routing token agents in a terminal of `folder`'s window carry
/// (`$SPARKDOWN_MCP_TOKEN`). Stable per canonical folder across launches
/// (decision 3), so tmux sessions that outlive a restart still route.
pub fn folder_token(folder: &FolderId) -> String {
    use sha2::{Digest, Sha256};
    let secret = TOKEN_SECRET.get_or_init(random_hex);
    let mut h = Sha256::new();
    h.update(secret.as_bytes());
    h.update([0u8]);
    h.update(folder.key().as_bytes());
    h.finalize()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The routing token for terminals of the current window: its folder's,
/// else (no folder yet) the terminal's local folder `cwd`.
pub fn token_for_current_window(cwd: Option<&str>) -> Option<String> {
    let label = current_label();
    let folder = registry().get(&label).and_then(|w| w.folder.clone());
    folder
        .or_else(|| cwd.and_then(|c| local_folder_id(c).ok()))
        .map(|f| folder_token(&f))
}

// --- Registry ----------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct WindowEntry {
    pub folder: Option<FolderId>,
    /// What the window shows for its folder (local path, or `host:path`).
    pub display: Option<String>,
    /// The frontend reported unsaved tabs (decides "empty", #60 decision 7).
    pub dirty: bool,
    focus_seq: u64,
}

#[derive(Default)]
pub struct Registry {
    windows: HashMap<String, WindowEntry>,
    focus_counter: u64,
    empty_counter: u64,
}

/// One row of `list_windows` / the Window menu.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct WindowSummary {
    pub label: String,
    pub folder: Option<FolderId>,
    pub display: Option<String>,
    pub focused: bool,
}

fn registry_cell() -> &'static Mutex<Registry> {
    static R: OnceLock<Mutex<Registry>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Registry::default()))
}

pub fn registry() -> MutexGuard<'static, Registry> {
    registry_cell().lock().unwrap_or_else(|e| e.into_inner())
}

impl Registry {
    pub fn register(&mut self, label: &str) {
        self.windows.entry(label.to_string()).or_default();
    }

    pub fn unregister(&mut self, label: &str) -> Option<WindowEntry> {
        self.windows.remove(label)
    }

    pub fn contains(&self, label: &str) -> bool {
        self.windows.contains_key(label)
    }

    pub fn len(&self) -> usize {
        self.windows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.windows.is_empty()
    }

    pub fn get(&self, label: &str) -> Option<&WindowEntry> {
        self.windows.get(label)
    }

    pub fn labels(&self) -> Vec<String> {
        let mut v: Vec<_> = self.windows.keys().cloned().collect();
        v.sort();
        v
    }

    /// A fresh label for an empty window.
    pub fn next_empty_label(&mut self) -> String {
        loop {
            self.empty_counter += 1;
            let l = format!("w-new-{}", self.empty_counter);
            if !self.windows.contains_key(&l) {
                return l;
            }
        }
    }

    pub fn mark_focused(&mut self, label: &str) {
        self.focus_counter += 1;
        let n = self.focus_counter;
        if let Some(w) = self.windows.get_mut(label) {
            w.focus_seq = n;
        }
    }

    /// The most recently focused window (or any, if none was focused yet).
    /// `label`'s focus order (0 = never focused).
    pub fn focus_seq(&self, label: &str) -> u64 {
        self.windows.get(label).map(|w| w.focus_seq).unwrap_or(0)
    }

    pub fn focused(&self) -> Option<String> {
        self.windows
            .iter()
            .max_by(|a, b| a.1.focus_seq.cmp(&b.1.focus_seq).then(b.0.cmp(a.0)))
            .map(|(l, _)| l.clone())
    }

    /// The window bound to `folder`, if any.
    pub fn find_folder(&self, folder: &FolderId) -> Option<String> {
        let key = folder.key();
        self.windows
            .iter()
            .find(|(_, w)| w.folder.as_ref().is_some_and(|f| f.key() == key))
            .map(|(l, _)| l.clone())
    }

    /// Bind `label` to `folder` (None unbinds). Fails with the other
    /// window's label when that folder is already open elsewhere.
    pub fn set_folder(
        &mut self,
        label: &str,
        folder: Option<FolderId>,
        display: Option<String>,
    ) -> Result<(), String> {
        if let Some(f) = &folder {
            if let Some(other) = self.find_folder(f) {
                if other != label {
                    return Err(other);
                }
            }
        }
        let w = self.windows.entry(label.to_string()).or_default();
        w.folder = folder;
        w.display = display;
        Ok(())
    }

    pub fn set_dirty(&mut self, label: &str, dirty: bool) {
        if let Some(w) = self.windows.get_mut(label) {
            w.dirty = dirty;
        }
    }

    /// "Empty" = no folder and no unsaved tabs (#60 decision 7).
    pub fn is_empty_window(&self, label: &str) -> bool {
        self.windows
            .get(label)
            .is_some_and(|w| w.folder.is_none() && !w.dirty)
    }

    pub fn summaries(&self) -> Vec<WindowSummary> {
        let focused = self.focused();
        let mut v: Vec<_> = self
            .windows
            .iter()
            .map(|(l, w)| WindowSummary {
                label: l.clone(),
                folder: w.folder.clone(),
                display: w.display.clone(),
                focused: focused.as_deref() == Some(l.as_str()),
            })
            .collect();
        v.sort_by(|a, b| a.label.cmp(&b.label));
        v
    }

    /// The window whose folder's routing token is `token`.
    pub fn window_for_token(&self, token: &str) -> Option<String> {
        self.windows
            .iter()
            .find(|(_, w)| w.folder.as_ref().is_some_and(|f| folder_token(f) == token))
            .map(|(l, _)| l.clone())
    }

    /// The window whose local folder contains `path` (deepest match wins).
    pub fn window_for_local_path(&self, path: &str) -> Option<String> {
        self.windows
            .iter()
            .filter(|(_, w)| w.folder.as_ref().is_some_and(|f| f.contains_local(path)))
            .max_by_key(|(_, w)| match &w.folder {
                Some(FolderId::Local { path }) => path.len(),
                _ => 0,
            })
            .map(|(l, _)| l.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(p: &str) -> FolderId {
        FolderId::Local { path: p.into() }
    }

    #[test]
    fn scope_nests_and_restores() {
        assert_eq!(current_label(), DEFAULT_LABEL);
        {
            let _a = enter("w-a");
            assert_eq!(current_label(), "w-a");
            {
                let _b = enter("w-b");
                assert_eq!(current_label(), "w-b");
            }
            assert_eq!(current_label(), "w-a");
        }
        assert_eq!(current_label(), DEFAULT_LABEL);
        // Another thread starts unscoped.
        let _a = enter("w-a");
        let other = std::thread::spawn(current_label).join().unwrap();
        assert_eq!(other, DEFAULT_LABEL);
    }

    #[test]
    fn a_folder_binds_to_one_window_only() {
        let mut r = Registry::default();
        r.register("w-1");
        r.register("w-2");
        r.set_folder("w-1", Some(local("/p/a")), None).unwrap();
        assert_eq!(
            r.set_folder("w-2", Some(local("/p/a")), None),
            Err("w-1".into())
        );
        // Re-binding the same window to its own folder is fine.
        r.set_folder("w-1", Some(local("/p/a")), None).unwrap();
        r.set_folder("w-2", Some(local("/p/b")), None).unwrap();
        assert_eq!(r.find_folder(&local("/p/b")).as_deref(), Some("w-2"));
        // Unbinding frees the folder.
        r.set_folder("w-1", None, None).unwrap();
        r.set_folder("w-2", Some(local("/p/a")), None).unwrap();
        assert_eq!(r.find_folder(&local("/p/a")).as_deref(), Some("w-2"));
    }

    #[test]
    fn empty_means_no_folder_and_nothing_unsaved() {
        let mut r = Registry::default();
        r.register("w-1");
        assert!(r.is_empty_window("w-1"));
        r.set_dirty("w-1", true);
        assert!(!r.is_empty_window("w-1"));
        r.set_dirty("w-1", false);
        r.set_folder("w-1", Some(local("/p")), None).unwrap();
        assert!(!r.is_empty_window("w-1"));
        assert!(!r.is_empty_window("missing"));
    }

    #[test]
    fn focus_tracks_the_last_focused_window() {
        let mut r = Registry::default();
        r.register("w-1");
        r.register("w-2");
        r.mark_focused("w-2");
        r.mark_focused("w-1");
        assert_eq!(r.focused().as_deref(), Some("w-1"));
        r.unregister("w-1");
        assert_eq!(r.focused().as_deref(), Some("w-2"));
        let s = r.summaries();
        assert_eq!(s.len(), 1);
        assert!(s[0].focused);
    }

    #[test]
    fn local_paths_route_to_the_deepest_containing_window() {
        let mut r = Registry::default();
        r.register("w-outer");
        r.register("w-inner");
        r.set_folder("w-outer", Some(local("/p")), None).unwrap();
        r.set_folder("w-inner", Some(local("/p/sub")), None)
            .unwrap();
        assert_eq!(
            r.window_for_local_path("/p/sub/x.md").as_deref(),
            Some("w-inner")
        );
        assert_eq!(
            r.window_for_local_path("/p/other.md").as_deref(),
            Some("w-outer")
        );
        assert_eq!(r.window_for_local_path("/p").as_deref(), Some("w-outer"));
        // A sibling with the same prefix is not inside.
        assert_eq!(r.window_for_local_path("/pp/x.md"), None);
    }

    #[test]
    fn folder_ids_are_canonical_and_labels_stable() {
        let d = std::env::temp_dir().join(format!("sd-fid-{}", std::process::id()));
        std::fs::create_dir_all(d.join("real")).unwrap();
        let a = local_folder_id(d.join("real").to_str().unwrap()).unwrap();
        let b = local_folder_id(d.join("real").join(".").to_str().unwrap()).unwrap();
        assert_eq!(a, b);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(d.join("real"), d.join("link")).unwrap();
            let c = local_folder_id(d.join("link").to_str().unwrap()).unwrap();
            assert_eq!(a, c, "a symlink is the same folder");
        }
        assert_eq!(label_for_folder(&a), label_for_folder(&b));
        assert!(label_for_folder(&a).starts_with("w-"));
        assert!(local_folder_id(d.join("missing").to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&d);
        // Remote identity ignores hostname case, not path case.
        let r1 = FolderId::Remote {
            user: "u".into(),
            hostname: "Dev.Example".into(),
            port: 22,
            path: "/home/u/p".into(),
        };
        let mut r2 = r1.clone();
        if let FolderId::Remote { hostname, .. } = &mut r2 {
            *hostname = "dev.example".into();
        }
        assert_eq!(r1.key(), r2.key());
        let mut r3 = r1.clone();
        if let FolderId::Remote { port, .. } = &mut r3 {
            *port = 2222;
        }
        assert_ne!(r1.key(), r3.key());
    }
}

// --- Lifecycle ---------------------------------------------------------------

static QUITTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The app is quitting: windows destroyed from now on keep their saved
/// session (they are restored next launch) instead of being forgotten.
pub fn set_quitting() {
    QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
}

pub fn is_quitting() -> bool {
    QUITTING.load(std::sync::atomic::Ordering::SeqCst)
}

/// Create a window from the `tauri.conf.json` template under `label`,
/// sized and placed from `geometry` (clamped to the monitors there are;
/// position skipped on Wayland), and register it.
pub fn create_window(
    app: &tauri::AppHandle,
    label: &str,
    geometry: Option<crate::session::Geometry>,
    focus: bool,
) -> tauri::Result<tauri::WebviewWindow> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window(label) {
        return Ok(w);
    }
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .unwrap_or_default();
    config.label = label.to_string();
    config.create = true;
    config.visible = false;
    let window = tauri::WebviewWindowBuilder::from_config(app, &config)?.build()?;
    #[cfg(not(target_os = "macos"))]
    let _ = window.set_decorations(false);
    if let Some(g) = geometry {
        let monitors: Vec<crate::session::Area> = window
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(|m| {
                let a = m.work_area();
                crate::session::Area {
                    x: a.position.x,
                    y: a.position.y,
                    width: a.size.width,
                    height: a.size.height,
                }
            })
            .collect();
        let g = crate::session::clamp_geometry(g, &monitors);
        let _ = window.set_size(tauri::PhysicalSize::new(g.width, g.height));
        if crate::session::positions_supported() {
            let _ = window.set_position(tauri::PhysicalPosition::new(g.x, g.y));
        }
        if g.maximized {
            let _ = window.maximize();
        }
    }
    registry().register(label);
    let _ = window.show();
    if focus {
        let _ = window.set_focus();
    }
    Ok(window)
}

/// The window app-level events (menu, dock, forwarded paths) go to: the
/// last focused one, else any.
pub fn target_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    use tauri::Manager;
    let focused = registry().focused();
    focused
        .and_then(|l| app.get_webview_window(&l))
        .or_else(|| app.webview_windows().into_values().next())
}

// --- Commands ------------------------------------------------------------------

/// The frontend reports the folder its window now shows (`None` when it
/// closes the folder). Local folders are canonicalized here; a remote
/// folder arrives already canonical from the connect (`ssh -G` + realpath).
/// Errors with the label of another window that already has the folder.
#[tauri::command]
pub fn window_set_folder(
    app: tauri::AppHandle,
    webview_window: tauri::WebviewWindow,
    folder: Option<FolderId>,
    display: Option<String>,
) -> Result<(), String> {
    let folder = match folder {
        Some(FolderId::Local { path }) => {
            Some(local_folder_id(&path).unwrap_or(FolderId::Local { path }))
        }
        other => other,
    };
    let r = registry().set_folder(webview_window.label(), folder, display);
    crate::lifecycle::refresh(&app);
    r
}

/// The frontend reports whether its window has unsaved tabs.
#[tauri::command]
pub fn window_set_dirty(webview_window: tauri::WebviewWindow, dirty: bool) {
    registry().set_dirty(webview_window.label(), dirty);
}

/// Every open window, sorted by label.
#[tauri::command]
pub fn windows_list() -> Vec<WindowSummary> {
    registry().summaries()
}
