//! Config and window sessions (#63): one writer in the core.
//!
//! Every window shares one `config.json`. The core owns it: windows load
//! their view of it and send their saves here, and only this module writes
//! the file (atomically, under one lock). The file has two parts:
//!
//! - **Preferences** — the [`AppConfig`] fields, shared by all windows. A
//!   window's save only applies the preferences *it* changed since it last
//!   loaded or saved, so two windows saving at once never undo each other.
//! - **Window sections** — `windows.<label>`: the folder, open files and
//!   geometry of each window, restored on the next launch.
//!
//! A 0.3.x file (no `version`) is migrated on first load: one window on the
//! most recent folder with the saved open files that live under it; with no
//! recent folder, an empty window with the files (#60 decision 5).

use crate::config::AppConfig;
use crate::windows::{self, FolderId};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The on-disk format version this build writes.
pub const VERSION: u32 = 2;

/// Saved outer geometry of a window, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Geometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

/// One window's saved state.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WindowSession {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<FolderId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    #[serde(default)]
    pub open_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry: Option<Geometry>,
    /// Focus order (higher = focused more recently); the highest is focused
    /// again after a restore.
    #[serde(default)]
    pub focus: u64,
}

/// The whole file.
#[derive(Debug, Clone, PartialEq)]
pub struct Stored {
    /// Preferences as JSON (an [`AppConfig`] without `last_open_files`).
    /// Kept as a map so keys from a newer build survive a save.
    pub prefs: Map<String, Value>,
    pub windows: BTreeMap<String, WindowSession>,
}

impl Default for Stored {
    fn default() -> Self {
        Self {
            prefs: prefs_of(&AppConfig::default()),
            windows: BTreeMap::new(),
        }
    }
}

/// Window-local fields that are not shared preferences.
const WINDOW_KEYS: &[&str] = &["last_open_files", "window_folder"];

fn prefs_of(cfg: &AppConfig) -> Map<String, Value> {
    let Value::Object(mut m) = serde_json::to_value(cfg).unwrap_or(Value::Null) else {
        return Map::new();
    };
    for k in WINDOW_KEYS {
        m.remove(*k);
    }
    m
}

impl Stored {
    /// Parse a config file, migrating a 0.3.x one. `window_state` is the
    /// old window-state plugin file (geometry of `main`), if any.
    pub fn parse(text: &str, window_state: Option<&str>) -> Self {
        let Ok(Value::Object(mut root)) = serde_json::from_str::<Value>(text) else {
            return Self::default();
        };
        let version = root.get("version").and_then(Value::as_u64).unwrap_or(0);
        if version >= 2 {
            let windows = root
                .remove("windows")
                .and_then(|w| match w {
                    Value::Object(m) => Some(
                        m.into_iter()
                            .filter_map(|(k, v)| serde_json::from_value(v).ok().map(|s| (k, s)))
                            .collect(),
                    ),
                    _ => None,
                })
                .unwrap_or_default();
            root.remove("version");
            for k in WINDOW_KEYS {
                root.remove(*k);
            }
            return Self {
                prefs: normalize_prefs(root),
                windows,
            };
        }
        migrate_v1(root, window_state)
    }

    pub fn to_json(&self) -> String {
        let mut root = self.prefs.clone();
        root.insert("version".into(), VERSION.into());
        root.insert(
            "windows".into(),
            serde_json::to_value(&self.windows).unwrap_or(Value::Null),
        );
        serde_json::to_string_pretty(&Value::Object(root)).unwrap_or_default()
    }

    /// The config a window loads: shared preferences plus its own files and
    /// the folder it should reopen.
    pub fn config_for(&self, label: &str) -> AppConfig {
        let mut v = self.prefs.clone();
        let w = self.windows.get(label);
        v.insert(
            "last_open_files".into(),
            serde_json::to_value(w.map(|w| w.open_files.clone()).unwrap_or_default())
                .unwrap_or_default(),
        );
        let folder = w.and_then(|w| match &w.folder {
            Some(FolderId::Local { path }) => Some(path.clone()),
            _ => None,
        });
        v.insert(
            "window_folder".into(),
            serde_json::to_value(folder).unwrap_or_default(),
        );
        serde_json::from_value(Value::Object(v)).unwrap_or_default()
    }

    /// Apply a window's save. `base` is the preferences that window last
    /// loaded or saved; only keys it changed since then are written, so a
    /// concurrent change from another window survives.
    pub fn apply_save(
        &mut self,
        label: &str,
        base: Option<&Map<String, Value>>,
        cfg: &AppConfig,
        folder: Option<(FolderId, Option<String>)>,
    ) {
        let incoming = prefs_of(cfg);
        for (k, v) in &incoming {
            let changed = match base {
                Some(b) => b.get(k) != Some(v),
                None => true,
            };
            if changed {
                self.prefs.insert(k.clone(), v.clone());
            }
        }
        let w = self.windows.entry(label.to_string()).or_default();
        w.open_files = cfg.last_open_files.clone();
        match folder {
            Some((f, display)) => {
                w.folder = Some(f);
                w.display = display;
            }
            None => {
                w.folder = None;
                w.display = None;
            }
        }
    }
}

/// Run stored preferences through [`AppConfig`] so missing keys get their
/// defaults, keeping unknown keys (a newer build's) as they were.
fn normalize_prefs(mut raw: Map<String, Value>) -> Map<String, Value> {
    let parsed: AppConfig = serde_json::from_value(Value::Object(raw.clone())).unwrap_or_default();
    for (k, v) in prefs_of(&parsed) {
        raw.insert(k, v);
    }
    raw
}

fn migrate_v1(root: Map<String, Value>, window_state: Option<&str>) -> Stored {
    let old: AppConfig = serde_json::from_value(Value::Object(root.clone())).unwrap_or_default();
    let mut prefs = root;
    for k in WINDOW_KEYS {
        prefs.remove(*k);
    }
    let prefs = normalize_prefs(prefs);
    let folder = old
        .recent_folders
        .iter()
        .find_map(|f| windows::local_folder_id(f).ok());
    let geometry = window_state.and_then(old_main_geometry);
    let (label, session) = match folder {
        Some(f) => {
            let files = old
                .last_open_files
                .iter()
                .filter(|p| f.contains_local(p))
                .cloned()
                .collect();
            let display = match &f {
                FolderId::Local { path } => Some(path.clone()),
                FolderId::Remote { .. } => None,
            };
            (
                windows::label_for_folder(&f),
                WindowSession {
                    folder: Some(f),
                    display,
                    open_files: files,
                    geometry,
                    focus: 1,
                },
            )
        }
        None => (
            windows::DEFAULT_LABEL.to_string(),
            WindowSession {
                open_files: old.last_open_files.clone(),
                geometry,
                focus: 1,
                ..Default::default()
            },
        ),
    };
    Stored {
        prefs,
        windows: BTreeMap::from([(label, session)]),
    }
}

/// `main`'s geometry from tauri-plugin-window-state's `.window-state.json`.
fn old_main_geometry(text: &str) -> Option<Geometry> {
    let v: Value = serde_json::from_str(text).ok()?;
    let m = v.get("main")?;
    let num = |k: &str| m.get(k).and_then(Value::as_f64);
    let (w, h) = (num("width")?, num("height")?);
    if w < 1.0 || h < 1.0 {
        return None;
    }
    Some(Geometry {
        x: num("x").unwrap_or(0.0) as i32,
        y: num("y").unwrap_or(0.0) as i32,
        width: w as u32,
        height: h as u32,
        maximized: m.get("maximized").and_then(Value::as_bool).unwrap_or(false),
    })
}

// --- Restore -------------------------------------------------------------------

/// A window to create at launch.
#[derive(Debug, Clone, PartialEq)]
pub struct RestorePlan {
    pub label: String,
    pub session: WindowSession,
    pub focus: bool,
}

/// Which windows to open at launch: every saved section (folder windows
/// under their stable label), the most recently focused one focused. With
/// no sections, one empty `main` window.
pub fn plan_restore(stored: &Stored) -> Vec<RestorePlan> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<RestorePlan> = Vec::new();
    let mut sections: Vec<(&String, &WindowSession)> = stored.windows.iter().collect();
    // Most recently focused first, so it wins a duplicate folder.
    sections.sort_by(|a, b| b.1.focus.cmp(&a.1.focus).then(a.0.cmp(b.0)));
    for (label, s) in sections {
        let label = match &s.folder {
            Some(f) => {
                if !seen.insert(f.key()) {
                    continue; // the same folder twice: keep one window
                }
                windows::label_for_folder(f)
            }
            None => label.clone(),
        };
        if out.iter().any(|p| p.label == label) {
            continue;
        }
        out.push(RestorePlan {
            label,
            session: s.clone(),
            focus: false,
        });
    }
    if out.is_empty() {
        out.push(RestorePlan {
            label: windows::DEFAULT_LABEL.to_string(),
            session: WindowSession::default(),
            focus: true,
        });
    } else {
        out[0].focus = true;
    }
    out
}

/// A monitor's work area, physical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Fit saved geometry onto the monitors there are now: shrink it to the
/// monitor it overlaps most (or the first), and pull it fully on screen.
/// `None` position when nothing usable (no monitors reported).
pub fn clamp_geometry(g: Geometry, monitors: &[Area]) -> Geometry {
    let overlap = |m: &Area| {
        let x0 = g.x.max(m.x) as i64;
        let y0 = g.y.max(m.y) as i64;
        let x1 = (g.x as i64 + g.width as i64).min(m.x as i64 + m.width as i64);
        let y1 = (g.y as i64 + g.height as i64).min(m.y as i64 + m.height as i64);
        (x1 - x0).max(0) * (y1 - y0).max(0)
    };
    let Some(m) = monitors
        .iter()
        .max_by_key(|m| overlap(m))
        .filter(|m| overlap(m) > 0)
        .or(monitors.first())
    else {
        return g;
    };
    let width = g.width.min(m.width).max(1);
    let height = g.height.min(m.height).max(1);
    let max_x = m.x + (m.width - width) as i32;
    let max_y = m.y + (m.height - height) as i32;
    Geometry {
        x: g.x.clamp(m.x, max_x),
        y: g.y.clamp(m.y, max_y),
        width,
        height,
        maximized: g.maximized,
    }
}

/// Whether window positions can be set on this platform: not on Wayland,
/// where the compositor places windows (#60 decision 4).
pub fn positions_supported() -> bool {
    if !cfg!(target_os = "linux") {
        return true;
    }
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty());
    let forced_x11 = std::env::var("GDK_BACKEND").is_ok_and(|b| b.starts_with("x11"));
    !wayland || forced_x11
}

// --- The store -------------------------------------------------------------------

/// Closed windows kept for Reopen (#89).
const MAX_CLOSED: usize = 10;

struct Inner {
    stored: Stored,
    /// Sessions of windows the user closed this run, newest last (#89):
    /// a dock click with no window open brings the last one back.
    closed: Vec<(String, WindowSession)>,
    /// Preferences each window last loaded or saved (the merge base).
    given: HashMap<String, Map<String, Value>>,
}

/// The one config writer. Managed by Tauri.
pub struct ConfigStore {
    path: PathBuf,
    inner: Mutex<Inner>,
}

impl ConfigStore {
    /// Load (and migrate) `path`. A migrated file is written back at once
    /// in the new format, so a crash before the first save can't migrate
    /// twice. The old window-state file is read for `main`'s geometry.
    pub fn open(path: PathBuf) -> Self {
        let text = std::fs::read_to_string(&path).ok();
        let ws = path
            .parent()
            .map(|d| d.join(".window-state.json"))
            .and_then(|p| std::fs::read_to_string(p).ok());
        let stored = match &text {
            Some(t) => Stored::parse(t, ws.as_deref()),
            None => Stored::default(),
        };
        let store = Self {
            path,
            inner: Mutex::new(Inner {
                stored,
                given: HashMap::new(),
                closed: Vec::new(),
            }),
        };
        if text.is_some_and(|t| !t.contains("\"version\"")) {
            let _ = store.write();
        }
        store
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn stored(&self) -> Stored {
        self.lock().stored.clone()
    }

    /// Re-key the window sections to the labels the restore uses (folder
    /// windows get their stable label; duplicates are dropped).
    pub fn adopt(&self, plan: &[RestorePlan]) {
        self.lock().stored.windows = plan
            .iter()
            .map(|p| (p.label.clone(), p.session.clone()))
            .collect();
    }

    /// The config window `label` loads (and records it as its merge base).
    pub fn load_for(&self, label: &str) -> AppConfig {
        let mut g = self.lock();
        let cfg = g.stored.config_for(label);
        g.given.insert(label.to_string(), prefs_of(&cfg));
        cfg
    }

    /// A window saved: merge and write.
    pub fn save_from(
        &self,
        label: &str,
        cfg: &AppConfig,
        folder: Option<(FolderId, Option<String>)>,
    ) -> Result<(), String> {
        {
            let mut g = self.lock();
            let base = g.given.get(label).cloned();
            g.stored.apply_save(label, base.as_ref(), cfg, folder);
            g.given.insert(label.to_string(), prefs_of(cfg));
        }
        self.write()
    }

    /// Record a window's geometry and focus order (written with the next
    /// save or [`flush`](Self::flush)).
    pub fn note_geometry(&self, label: &str, geometry: Geometry) {
        let mut g = self.lock();
        if let Some(w) = g.stored.windows.get_mut(label) {
            w.geometry = Some(geometry);
        } else {
            g.stored.windows.insert(
                label.to_string(),
                WindowSession {
                    geometry: Some(geometry),
                    ..Default::default()
                },
            );
        }
    }

    pub fn note_maximized(&self, label: &str) {
        if let Some(g) = self
            .lock()
            .stored
            .windows
            .get_mut(label)
            .and_then(|w| w.geometry.as_mut())
        {
            g.maximized = true;
        }
    }

    pub fn note_focus(&self, label: &str, seq: u64) {
        if let Some(w) = self.lock().stored.windows.get_mut(label) {
            w.focus = seq;
        }
    }

    /// The user closed a window (not a quit): it is not restored at the
    /// next launch, but kept in memory for Reopen (#89).
    pub fn forget_window(&self, label: &str) {
        {
            let mut g = self.lock();
            if let Some(w) = g.stored.windows.remove(label) {
                g.closed.retain(|(l, _)| l != label);
                g.closed.push((label.to_string(), w));
                let n = g.closed.len();
                if n > MAX_CLOSED {
                    g.closed.drain(..n - MAX_CLOSED);
                }
            }
            g.given.remove(label);
        }
        let _ = self.write();
    }

    /// Close Folder (#127): the window stays open but its folder is gone.
    /// Drop its section entirely (a relaunch must not reopen the folder or
    /// its files) and keep nothing for Reopen either. The window's next
    /// save writes a fresh, empty section.
    pub fn close_folder(&self, label: &str) {
        {
            let mut g = self.lock();
            g.stored.windows.remove(label);
            g.closed.retain(|(l, _)| l != label);
        }
        let _ = self.write();
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn has_closed(&self) -> bool {
        !self.lock().closed.is_empty()
    }

    /// Put the most recently closed window's session back, so a window
    /// created with that label restores its folder and files (#89).
    /// Skips sessions whose label is in `live` (already open again).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn reopen_last_closed(&self, live: &[String]) -> Option<(String, WindowSession)> {
        let mut g = self.lock();
        while let Some((label, w)) = g.closed.pop() {
            if live.contains(&label) {
                continue;
            }
            g.stored.windows.insert(label.clone(), w.clone());
            return Some((label, w));
        }
        None
    }

    pub fn flush(&self) -> Result<(), String> {
        self.write()
    }

    /// Serialize under the lock and replace the file atomically.
    fn write(&self) -> Result<(), String> {
        let g = self.lock();
        let json = g.stored.to_json();
        write_atomic(&self.path, json.as_bytes()).map_err(|e| e.to_string())
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("json.tmp{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sd-session-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    #[test]
    fn close_folder_drops_the_section_so_a_relaunch_does_not_restore_it() {
        let d = tmpdir("close-folder");
        let path = d.join("config.json");
        let store = ConfigStore::open(path.clone());
        let f = |p: &str| FolderId::Local { path: p.into() };
        let a = windows::label_for_folder(&f("/a"));
        let b = windows::label_for_folder(&f("/b"));
        {
            let mut g = store.lock();
            for (l, p) in [(&a, "/a"), (&b, "/b")] {
                g.stored.windows.insert(
                    l.clone(),
                    WindowSession {
                        folder: Some(f(p)),
                        open_files: vec![format!("{p}/notes.md")],
                        ..Default::default()
                    },
                );
            }
        }
        store.close_folder(&a);
        // On disk: only B is restored at the next launch.
        let on_disk = Stored::parse(&std::fs::read_to_string(&path).unwrap(), None);
        let plan = plan_restore(&on_disk);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].label, b);
        // The window that stays open loads nothing of the old folder.
        let cfg = store.load_for(&a);
        assert!(cfg.last_open_files.is_empty());
        assert_eq!(cfg.window_folder, None);
        // Reopen (dock) can't bring the closed folder back either.
        assert!(!store.has_closed());
        // Its next save (empty window) restores as an empty window, not A.
        store.save_from(&a, &cfg, None).unwrap();
        let on_disk = Stored::parse(&std::fs::read_to_string(&path).unwrap(), None);
        assert!(plan_restore(&on_disk)
            .iter()
            .all(|p| p.session.folder != Some(f("/a"))
                && p.session.open_files.iter().all(|o| !o.starts_with("/a/"))));
    }

    #[test]
    fn closed_windows_can_be_reopened_newest_first() {
        let dir = std::env::temp_dir().join(format!("sd-closed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = ConfigStore::open(dir.join("config.json"));
        let w = |p: &str| WindowSession {
            folder: Some(crate::windows::FolderId::Local { path: p.into() }),
            ..Default::default()
        };
        {
            let mut g = store.lock();
            g.stored.windows.insert("w-a".into(), w("/a"));
            g.stored.windows.insert("w-b".into(), w("/b"));
        }
        assert!(!store.has_closed());
        store.forget_window("w-a");
        store.forget_window("w-b");
        assert!(store.has_closed());
        // Not restored at the next launch...
        assert!(store.stored().windows.is_empty());
        // ...but Reopen brings back the newest, then the next.
        let (l, s) = store.reopen_last_closed(&[]).unwrap();
        assert_eq!(l, "w-b");
        assert_eq!(s.folder, w("/b").folder);
        assert!(store.stored().windows.contains_key("w-b"));
        // A label that is live again is skipped.
        assert!(store.reopen_last_closed(&["w-a".to_string()]).is_none());
        assert!(!store.has_closed());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_03x_to_one_window_on_the_recent_folder() {
        let d = tmpdir("mig");
        let proj = d.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let inside = proj.join("a.md").to_string_lossy().to_string();
        let outside = d.join("b.md").to_string_lossy().to_string();
        let old = serde_json::json!({
            "theme": "dark",
            "word_wrap": false,
            "last_open_files": [inside, outside],
            "recent_folders": [proj.to_string_lossy(), "/nope"],
        });
        let ws = r#"{"main":{"width":900,"height":700,"x":10,"y":20,"maximized":false}}"#;
        let s = Stored::parse(&old.to_string(), Some(ws));
        assert_eq!(s.windows.len(), 1);
        let (label, w) = s.windows.iter().next().unwrap();
        let f = windows::local_folder_id(proj.to_str().unwrap()).unwrap();
        assert_eq!(label, &windows::label_for_folder(&f));
        assert_eq!(w.folder.as_ref(), Some(&f));
        assert_eq!(w.open_files, vec![inside.clone()]);
        assert_eq!(w.geometry.unwrap().width, 900);
        assert_eq!(s.prefs.get("theme"), Some(&Value::from("dark")));
        assert!(!s.prefs.contains_key("last_open_files"));
        // The window loads its files and folder back.
        let cfg = s.config_for(label);
        assert_eq!(cfg.last_open_files, vec![inside]);
        assert_eq!(cfg.window_folder.as_deref(), proj.to_str());
        assert!(!cfg.word_wrap);
    }

    #[test]
    fn migrates_without_recent_folder_to_an_empty_window_with_the_files() {
        let old = r#"{"theme":"light","last_open_files":["/x/a.md"],"recent_folders":[]}"#;
        let s = Stored::parse(old, None);
        let w = s.windows.get(windows::DEFAULT_LABEL).expect("main");
        assert!(w.folder.is_none());
        assert_eq!(w.open_files, vec!["/x/a.md".to_string()]);
        // Round trip in the new format is stable.
        let again = Stored::parse(&s.to_json(), None);
        assert_eq!(again, s);
    }

    #[test]
    fn garbage_and_missing_files_give_defaults() {
        assert_eq!(Stored::parse("not json", None), Stored::default());
        let s = Stored::parse(r#"{"version":2,"windows":{"w-1":42}}"#, None);
        assert!(s.windows.is_empty());
    }

    #[test]
    fn unknown_pref_keys_survive() {
        let s = Stored::parse(r#"{"version":2,"future_pref":7,"windows":{}}"#, None);
        assert_eq!(
            Stored::parse(&s.to_json(), None).prefs.get("future_pref"),
            Some(&Value::from(7))
        );
    }

    #[test]
    fn a_save_only_writes_the_prefs_that_window_changed() {
        let mut s = Stored::default();
        let a_base = s.config_for("w-a");
        let b_base = s.config_for("w-b");
        // A turns wrap off; B (still holding the old wrap) changes theme.
        let a = AppConfig {
            word_wrap: false,
            last_open_files: vec!["/a/1.md".into()],
            ..a_base.clone()
        };
        s.apply_save("w-a", Some(&prefs_of(&a_base)), &a, None);
        let b = AppConfig {
            theme: crate::config::ThemeMode::Dark,
            last_open_files: vec!["/b/1.md".into()],
            ..b_base.clone()
        };
        s.apply_save("w-b", Some(&prefs_of(&b_base)), &b, None);
        let merged = s.config_for("w-a");
        assert!(!merged.word_wrap, "B's save must not undo A's change");
        assert_eq!(merged.theme, crate::config::ThemeMode::Dark);
        // Window sections stay separate.
        assert_eq!(
            s.config_for("w-a").last_open_files,
            vec!["/a/1.md".to_string()]
        );
        assert_eq!(
            s.config_for("w-b").last_open_files,
            vec!["/b/1.md".to_string()]
        );
    }

    #[test]
    fn concurrent_saves_from_many_windows_keep_every_section_and_a_valid_file() {
        let d = tmpdir("conc");
        let path = d.join("config.json");
        let store = Arc::new(ConfigStore::open(path.clone()));
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let store = store.clone();
                std::thread::spawn(move || {
                    let label = format!("w-{i}");
                    let base = store.load_for(&label);
                    for n in 0..25 {
                        let cfg = AppConfig {
                            last_open_files: vec![format!("/f/{i}/{n}.md")],
                            ..base.clone()
                        };
                        store.save_from(&label, &cfg, None).unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let s = Stored::parse(&text, None);
        assert_eq!(s.windows.len(), 8);
        for i in 0..8 {
            assert_eq!(
                s.windows[&format!("w-{i}")].open_files,
                vec![format!("/f/{i}/24.md")]
            );
        }
        // No temp files left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn store_migrates_once_and_writes_the_new_format() {
        let d = tmpdir("store");
        let path = d.join("config.json");
        std::fs::write(&path, r#"{"theme":"dark","last_open_files":["/q.md"]}"#).unwrap();
        let store = ConfigStore::open(path.clone());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"version\": 2"));
        assert_eq!(
            store.load_for("main").last_open_files,
            vec!["/q.md".to_string()]
        );
        store.forget_window("main");
        assert!(
            Stored::parse(&std::fs::read_to_string(&path).unwrap(), None)
                .windows
                .is_empty()
        );
    }

    #[test]
    fn restore_opens_every_saved_window_once_focusing_the_latest() {
        let f = |p: &str| FolderId::Local { path: p.into() };
        let mut s = Stored::default();
        s.windows.insert(
            "w-x".into(),
            WindowSession {
                folder: Some(f("/a")),
                focus: 1,
                ..Default::default()
            },
        );
        s.windows.insert(
            "w-y".into(),
            WindowSession {
                folder: Some(f("/b")),
                focus: 5,
                ..Default::default()
            },
        );
        s.windows.insert(
            "w-dup".into(),
            WindowSession {
                folder: Some(f("/a")),
                focus: 0,
                ..Default::default()
            },
        );
        s.windows.insert(
            "w-new-1".into(),
            WindowSession {
                open_files: vec!["/u.md".into()],
                focus: 2,
                ..Default::default()
            },
        );
        let plan = plan_restore(&s);
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[0].label, windows::label_for_folder(&f("/b")));
        assert!(plan[0].focus);
        assert!(plan[1..].iter().all(|p| !p.focus));
        assert!(plan
            .iter()
            .any(|p| p.label == windows::label_for_folder(&f("/a"))));
        assert!(plan.iter().any(|p| p.label == "w-new-1"));
        // The store re-keys its sections to the plan's labels.
        let d = tmpdir("adopt");
        let store = ConfigStore::open(d.join("config.json"));
        store.lock().stored = s.clone();
        store.adopt(&plan);
        let label_a = windows::label_for_folder(&f("/a"));
        assert_eq!(store.stored().windows.len(), 3);
        assert_eq!(store.stored().windows[&label_a].focus, 1);
        // Nothing saved: one empty main window.
        let empty = plan_restore(&Stored::default());
        assert_eq!(empty.len(), 1);
        assert_eq!(empty[0].label, windows::DEFAULT_LABEL);
    }

    #[test]
    fn geometry_is_clamped_to_visible_monitors() {
        let mons = [
            Area {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            Area {
                x: 1920,
                y: 0,
                width: 1280,
                height: 1024,
            },
        ];
        let g = |x, y, w, h| Geometry {
            x,
            y,
            width: w,
            height: h,
            maximized: false,
        };
        // On screen: unchanged.
        assert_eq!(
            clamp_geometry(g(100, 100, 800, 600), &mons),
            g(100, 100, 800, 600)
        );
        // Mostly on the second monitor, hanging off its right edge.
        assert_eq!(
            clamp_geometry(g(2900, 50, 800, 600), &mons),
            g(2400, 50, 800, 600)
        );
        // A monitor that is gone: moved onto the first, shrunk to fit.
        assert_eq!(
            clamp_geometry(g(5000, 3000, 2500, 1200), &mons),
            g(0, 0, 1920, 1080)
        );
        // No monitors reported: left as saved.
        assert_eq!(clamp_geometry(g(5, 5, 10, 10), &[]), g(5, 5, 10, 10));
    }
}
