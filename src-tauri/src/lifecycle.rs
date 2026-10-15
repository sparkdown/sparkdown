//! Window lifecycle (#65): New Window, the Window menu, window titles,
//! closing one window, and quitting with every window's work resolved.
//!
//! - Close (red X / Close Window): with other windows open, only that window
//!   closes, after its unsaved tabs are resolved. The last window: on
//!   Windows/Linux that is a quit; on macOS the window hides to the dock and
//!   the app stays alive (#60).
//! - Quit: one confirm listing running (non-tmux) terminals across all
//!   windows, then each window resolves its own unsaved tabs in turn.

use crate::windows::{self, FolderId};
use std::collections::HashMap;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::menu::{MenuItemBuilder, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// The Window menu and the per-window items it lists. Managed.
pub struct WindowMenu {
    pub submenu: Submenu<Wry>,
    items: Mutex<()>,
}

impl WindowMenu {
    pub fn new(submenu: Submenu<Wry>) -> Self {
        Self {
            submenu,
            items: Mutex::new(()),
        }
    }
}

pub const FOCUS_PREFIX: &str = "window-focus:";
pub const NEW_WINDOW_ID: &str = "new-window";

/// The window title for a folder: `name — SparkDown`, remote
/// `name (host) — SparkDown`, no folder `SparkDown`.
pub fn title_for(folder: Option<&FolderId>, display: Option<&str>) -> String {
    let name = |p: &str| {
        let t = p.trim_end_matches(['/', '\\']);
        t.rsplit(['/', '\\'])
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or(if t.is_empty() { "/" } else { t })
            .to_string()
    };
    match folder {
        Some(FolderId::Local { path }) => format!("{} — SparkDown", name(path)),
        Some(FolderId::Remote { path, .. }) => {
            let host = display
                .and_then(|d| d.split_once(':').map(|(h, _)| h.to_string()))
                .unwrap_or_default();
            if host.is_empty() {
                format!("{} — SparkDown", name(path))
            } else {
                format!("{} ({host}) — SparkDown", name(path))
            }
        }
        None => "SparkDown".to_string(),
    }
}

/// One Window-menu entry per live window: `(menu id, text)`, sorted by
/// label, deduplicated by label, dead windows dropped (#90).
pub fn menu_entries(
    rows: &[(String, String)],
    live: impl Fn(&str) -> bool,
) -> Vec<(String, String)> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<(String, String)> = rows
        .iter()
        .filter(|(label, _)| live(label) && seen.insert(label.clone()))
        .map(|(label, title)| {
            let text = title.trim_end_matches(" — SparkDown");
            let text = if text == "SparkDown" || text.is_empty() {
                "Untitled window"
            } else {
                text
            };
            (format!("{FOCUS_PREFIX}{label}"), text.to_string())
        })
        .collect();
    out.sort();
    out
}

/// Re-title every window and rebuild the Window menu's list. Call after
/// a window opens, closes, or changes folder. Menu edits run on the main
/// thread (AppKit requires it; callers are often worker threads).
///
/// macOS: the Window menu is NSApp's `windowsMenu`, so AppKit lists the
/// windows itself and keeps the list in sync on open/close/retitle; adding
/// our own entries there duplicated them (#90), so we add none.
pub fn refresh(app: &AppHandle) {
    let rows = windows::registry().summaries();
    let mut titled = Vec::new();
    for r in &rows {
        let title = title_for(r.folder.as_ref(), r.display.as_deref());
        if let Some(w) = app.get_webview_window(&r.label) {
            let _ = w.set_title(&title);
        }
        titled.push((r.label.clone(), title));
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || rebuild_window_menu(&handle, &titled));
}

fn rebuild_window_menu(app: &AppHandle, titled: &[(String, String)]) {
    let Some(menu) = app.try_state::<WindowMenu>() else {
        return;
    };
    let Ok(_guard) = menu.items.lock() else {
        return;
    };
    // Remove every window entry by id, not a tracked list, so nothing
    // stale can survive a missed update.
    if let Ok(items) = menu.submenu.items() {
        for it in items {
            if it.id().as_ref().starts_with(FOCUS_PREFIX) {
                let _ = menu.submenu.remove(&it);
            }
        }
    }
    if cfg!(target_os = "macos") {
        return;
    }
    let live = |l: &str| app.get_webview_window(l).is_some();
    for (id, text) in menu_entries(titled, live) {
        if let Ok(item) = MenuItemBuilder::with_id(id, text).build(app) {
            let _ = menu.submenu.append(&item);
        }
    }
}

/// Open a new empty window (File/Window → New Window, Ctrl/⌘+Shift+N).
pub fn new_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let label = windows::registry().next_empty_label();
    let w = windows::create_window(app, &label, None, true)?;
    refresh(app);
    Ok(w)
}

/// One-shot menu actions for a window that is still starting (macOS:
/// Settings with no window open opens it in a new empty window).
fn pending_menu() -> std::sync::MutexGuard<'static, HashMap<String, String>> {
    static P: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    P.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// A menu action with no window to receive it: open an empty window that
/// runs it once ready.
pub fn menu_in_new_window(app: &AppHandle, id: &str) {
    if let Ok(w) = new_window(app) {
        pending_menu().insert(w.label().to_string(), id.to_string());
    }
}

/// What a red X / Close Window does for `label`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Close just this window (after its unsaved tabs).
    Close,
    /// macOS, last window: hide to the dock.
    Hide,
    /// Windows/Linux, last window: quit the app.
    Quit,
}

pub fn close_action(open_windows: usize, macos: bool) -> CloseAction {
    if open_windows > 1 {
        CloseAction::Close
    } else if macos {
        CloseAction::Hide
    } else {
        CloseAction::Quit
    }
}

/// Route a close request of `label` to its window's frontend.
pub fn on_close_requested(app: &AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let visible = app
        .webview_windows()
        .values()
        .filter(|w| w.is_visible().unwrap_or(true))
        .count();
    // `emit_to`, never `window.emit`: in Tauri 2 the latter reaches every
    // window, so one red X closed them all (#89).
    match close_action(visible, cfg!(target_os = "macos")) {
        CloseAction::Close => {
            let _ = app.emit_to(
                label,
                "close-requested",
                serde_json::json!({ "mode": "close" }),
            );
        }
        CloseAction::Hide => {
            let _ = app.emit_to(
                label,
                "close-requested",
                serde_json::json!({ "mode": "hide" }),
            );
        }
        CloseAction::Quit => request_quit(app),
    }
    drop(window);
}

/// What a dock click / Reopen does (#89, macOS).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReopenAction {
    /// A window is visible: AppKit brings it forward.
    Nothing,
    /// Show the hidden window(s): the last window's red X hides it.
    ShowHidden,
    /// No window at all: bring back the last closed window's session.
    RestoreClosed,
    /// Nothing to restore: a new empty window.
    NewEmpty,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn reopen_action(has_visible: bool, hidden: usize, has_closed: bool) -> ReopenAction {
    if has_visible {
        ReopenAction::Nothing
    } else if hidden > 0 {
        ReopenAction::ShowHidden
    } else if has_closed {
        ReopenAction::RestoreClosed
    } else {
        ReopenAction::NewEmpty
    }
}

/// macOS dock click / `RunEvent::Reopen` (#89): show hidden windows, else
/// restore the last closed window, else open an empty one. Blocking.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn reopen(app: &AppHandle, has_visible: bool) {
    let all = app.webview_windows();
    let hidden: Vec<_> = all
        .values()
        .filter(|w| !w.is_visible().unwrap_or(true))
        .cloned()
        .collect();
    let live: Vec<String> = all.keys().cloned().collect();
    let store = app.try_state::<crate::session::ConfigStore>();
    let has_closed = store.as_ref().is_some_and(|s| s.has_closed());
    match reopen_action(has_visible, hidden.len(), has_closed) {
        ReopenAction::Nothing => {}
        ReopenAction::ShowHidden => {
            for w in &hidden {
                let _ = w.show();
            }
            if let Some(w) = hidden.first() {
                let _ = w.set_focus();
            }
            refresh(app);
        }
        ReopenAction::RestoreClosed | ReopenAction::NewEmpty => {
            let restored = store.and_then(|s| s.reopen_last_closed(&live));
            match restored {
                Some((label, session)) => {
                    if let Some(f) = session.folder.clone() {
                        let mut reg = windows::registry();
                        reg.register(&label);
                        if let Err(other) = reg.set_folder(&label, Some(f), session.display.clone())
                        {
                            // Its folder is open again elsewhere: one
                            // folder, one window.
                            reg.unregister(&label);
                            drop(reg);
                            crate::routing::focus(app, &other);
                            return;
                        }
                    }
                    if windows::create_window(app, &label, session.geometry, true).is_ok() {
                        refresh(app);
                    } else {
                        windows::registry().unregister(&label);
                        let _ = new_window(app);
                    }
                }
                None => {
                    let _ = new_window(app);
                }
            }
        }
    }
}

// --- Quit ----------------------------------------------------------------------

/// Where the app is in a quit (#88). One quit flow at a time, owned by one
/// window; only that window may end the process, and only after every
/// other window resolved its unsaved work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuitState {
    Idle,
    /// `owner` is asking: the combined confirm, its own save prompts, then
    /// the other windows in turn.
    Asking(String),
    /// Every window agreed; `owner` may exit.
    Approved(String),
    Exiting,
}

#[derive(Debug)]
pub struct QuitGate(QuitState);

impl Default for QuitGate {
    fn default() -> Self {
        Self(QuitState::Idle)
    }
}

impl QuitGate {
    #[cfg(test)]
    pub fn state(&self) -> &QuitState {
        &self.0
    }
    /// Start a quit owned by `owner`. False if one is already running
    /// (a second ⌘Q, or the same ⌘Q via another native path).
    pub fn begin(&mut self, owner: &str) -> bool {
        if self.0 == QuitState::Idle {
            self.0 = QuitState::Asking(owner.to_string());
            true
        } else {
            false
        }
    }
    /// Cancelled (or failed): back to idle. Only the owner can end it.
    pub fn end(&mut self, owner: &str) {
        if matches!(&self.0, QuitState::Asking(o) | QuitState::Approved(o) if o == owner) {
            self.0 = QuitState::Idle;
        }
    }
    /// Every other window resolved its unsaved work.
    pub fn approve(&mut self, owner: &str) -> bool {
        if matches!(&self.0, QuitState::Asking(o) if o == owner) {
            self.0 = QuitState::Approved(owner.to_string());
            true
        } else {
            false
        }
    }
    /// May `caller` end the process now?
    pub fn exit(&mut self, caller: &str) -> bool {
        match &self.0 {
            QuitState::Approved(o) if o == caller => {
                self.0 = QuitState::Exiting;
                true
            }
            QuitState::Exiting => true,
            _ => false,
        }
    }
    pub fn owner(&self) -> Option<&str> {
        match &self.0 {
            QuitState::Asking(o) | QuitState::Approved(o) => Some(o),
            _ => None,
        }
    }
}

pub fn quit_gate() -> std::sync::MutexGuard<'static, QuitGate> {
    static G: OnceLock<Mutex<QuitGate>> = OnceLock::new();
    G.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// A native quit (⌘Q, app-menu or dock Quit, last window closed on
/// Windows/Linux): run the quit flow in ONE window. With a flow already
/// running, bring its window forward instead of starting another (#88).
pub fn request_quit(app: &AppHandle) {
    let owner = quit_gate().owner().map(str::to_string);
    let target = match owner {
        Some(o) => {
            crate::routing::focus(app, &o);
            return;
        }
        None => windows::target_window(app),
    };
    if let Some(w) = target {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to(w.label(), "exit-requested", ());
    }
}

/// The frontend starts a quit flow (any entry: native or keyboard).
#[tauri::command]
pub fn quit_begin(webview_window: tauri::WebviewWindow) -> bool {
    quit_gate().begin(webview_window.label())
}

/// The frontend's quit flow was cancelled or failed.
#[tauri::command]
pub fn quit_end(webview_window: tauri::WebviewWindow) {
    quit_gate().end(webview_window.label());
}

type Pending = HashMap<u64, (String, Sender<bool>)>;

fn quit_pending() -> std::sync::MutexGuard<'static, Pending> {
    static P: OnceLock<Mutex<Pending>> = OnceLock::new();
    P.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// One running terminal a quit would stop.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BusyTerminal {
    pub window: String,
    pub command: String,
    /// A tmux session: keeps running after the quit (#88).
    pub keeps_running: bool,
}

/// What a quit would cost, across every window (#65/#68): running
/// terminals it would stop and windows with unsaved changes. One confirm
/// lists both.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct QuitStatus {
    pub busy: Vec<BusyTerminal>,
    /// Display names of windows with unsaved changes.
    pub unsaved: Vec<String>,
}

fn window_name(s: &windows::WindowSummary) -> String {
    let t = title_for(s.folder.as_ref(), s.display.as_deref());
    let t = t.trim_end_matches(" — SparkDown");
    if t == "SparkDown" {
        "Untitled window".to_string()
    } else {
        t.to_string()
    }
}

#[tauri::command]
pub async fn quit_status(app: AppHandle) -> Result<QuitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (names, unsaved) = {
            let reg = windows::registry();
            let rows = reg.summaries();
            let names: HashMap<String, String> = rows
                .iter()
                .map(|s| (s.label.clone(), window_name(s)))
                .collect();
            let unsaved: Vec<String> = rows
                .iter()
                .filter(|s| reg.get(&s.label).is_some_and(|w| w.dirty))
                .map(window_name)
                .collect();
            (names, unsaved)
        };
        let busy = crate::terminal::busy_on_quit(&app.state::<crate::terminal::TerminalState>())
            .into_iter()
            .map(|(label, command, keeps_running)| BusyTerminal {
                window: names.get(&label).cloned().unwrap_or(label),
                command,
                keeps_running,
            })
            .collect();
        QuitStatus { busy, unsaved }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Ask every window but the caller to get ready to quit: each resolves its
/// unsaved tabs (focused in turn, so the prompt is in front) and saves its
/// session. False as soon as one is cancelled.
#[tauri::command]
pub async fn quit_prepare_others(
    app: AppHandle,
    webview_window: tauri::WebviewWindow,
) -> Result<bool, String> {
    let caller = webview_window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let labels: Vec<(String, bool)> = {
            let reg = windows::registry();
            reg.labels()
                .into_iter()
                .filter(|l| *l != caller)
                .map(|l| {
                    let dirty = reg.get(&l).is_some_and(|w| w.dirty);
                    (l, dirty)
                })
                .collect()
        };
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        for (label, dirty) in labels {
            let Some(w) = app.get_webview_window(&label) else {
                continue;
            };
            if dirty {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let (tx, rx) = channel();
            quit_pending().insert(id, (label.clone(), tx));
            // To this window only (#88): a broadcast let another window
            // answer for it.
            if app
                .emit_to(
                    label.as_str(),
                    "quit-prepare",
                    serde_json::json!({ "id": id }),
                )
                .is_err()
            {
                quit_pending().remove(&id);
                continue;
            }
            // A window with unsaved tabs waits on the user; a clean one only
            // flushes its session.
            let wait = if dirty {
                Duration::from_secs(60 * 60)
            } else {
                Duration::from_secs(5)
            };
            let ok = rx.recv_timeout(wait).unwrap_or(!dirty);
            quit_pending().remove(&id);
            if !ok {
                return false;
            }
        }
        quit_gate().approve(&caller)
    })
    .await
    .map_err(|e| e.to_string())
}

/// A window's answer to `quit-prepare`.
#[tauri::command]
pub fn quit_prepare_reply(webview_window: tauri::WebviewWindow, id: u64, ok: bool) {
    let mut pending = quit_pending();
    // Only the asked window may answer (#88).
    if pending
        .get(&id)
        .is_some_and(|(label, _)| label == webview_window.label())
    {
        if let Some((_, tx)) = pending.remove(&id) {
            let _ = tx.send(ok);
        }
    }
}

/// Close the calling window (its frontend has resolved its unsaved tabs).
#[tauri::command]
pub fn window_close(webview_window: tauri::WebviewWindow) -> Result<(), String> {
    webview_window.destroy().map_err(|e| e.to_string())
}

/// New Window from the frontend (shortcut / command palette).
#[tauri::command]
pub async fn window_new(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        new_window(&app).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A menu action queued for this (new) window, once.
#[tauri::command]
pub fn window_take_menu(webview_window: tauri::WebviewWindow) -> Option<String> {
    pending_menu().remove(webview_window.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn red_close_closes_only_that_window_until_the_last() {
        // #89: with other windows open, the red X closes just this one.
        assert_eq!(close_action(3, true), CloseAction::Close);
        assert_eq!(close_action(2, false), CloseAction::Close);
        assert_eq!(close_action(1, false), CloseAction::Quit);
    }

    #[test]
    fn reopen_shows_hidden_then_restores_closed_then_opens_empty() {
        use ReopenAction::*;
        assert_eq!(reopen_action(true, 1, true), Nothing);
        assert_eq!(reopen_action(false, 1, true), ShowHidden);
        assert_eq!(reopen_action(false, 0, true), RestoreClosed);
        assert_eq!(reopen_action(false, 0, false), NewEmpty);
    }

    /// The macOS model end to end, on the pure pieces (#89): three windows;
    /// red X on one closes only it; red X on the last of the others hides
    /// it; a dock click shows it; with every window gone a dock click
    /// restores the last closed one.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_close_and_reopen_state_machine() {
        let mac = cfg!(target_os = "macos");
        let mut visible = 3usize;
        assert_eq!(close_action(visible, mac), CloseAction::Close);
        visible -= 1;
        assert_eq!(close_action(visible, mac), CloseAction::Close);
        visible -= 1;
        // Last visible window: hide to the dock, never quit.
        assert_eq!(close_action(visible, mac), CloseAction::Hide);
        assert_eq!(reopen_action(false, 1, true), ReopenAction::ShowHidden);
        assert_eq!(reopen_action(false, 0, true), ReopenAction::RestoreClosed);
    }

    #[test]
    fn quit_gate_runs_one_flow_and_only_the_owner_exits() {
        let mut g = QuitGate::default();
        assert!(g.begin("w-a"));
        // The same ⌘Q via the other native path, or another window: refused.
        assert!(!g.begin("w-a"));
        assert!(!g.begin("w-b"));
        assert_eq!(g.owner(), Some("w-a"));
        // Not approved yet: nobody may exit (the data-loss path of #88).
        assert!(!g.exit("w-a"));
        assert!(!g.exit("w-b"));
        // Another window can't approve or cancel it.
        assert!(!g.approve("w-b"));
        g.end("w-b");
        assert_eq!(g.state(), &QuitState::Asking("w-a".into()));
        assert!(g.approve("w-a"));
        assert!(!g.exit("w-b"));
        assert!(g.exit("w-a"));
        assert_eq!(g.state(), &QuitState::Exiting);
    }

    #[test]
    fn quit_gate_cancel_returns_to_idle() {
        let mut g = QuitGate::default();
        assert!(g.begin("w-a"));
        g.end("w-a");
        assert_eq!(g.state(), &QuitState::Idle);
        assert!(!g.exit("w-a"));
        // A new quit can start after a cancel.
        assert!(g.begin("w-b"));
        g.end("w-b");
        assert!(g.begin("w-a"));
        assert!(g.approve("w-a"));
        g.end("w-a");
        assert_eq!(g.state(), &QuitState::Idle);
    }

    /// In Tauri 2, `WebviewWindow::emit` / `AppHandle::emit` reach EVERY
    /// window. Per-window events (quit, close, menu, prepare) broadcast
    /// that way made each window run its own quit and close (#88, #89).
    /// Only app-wide broadcasts on this list may use plain `emit`.
    #[test]
    fn per_window_events_are_never_broadcast() {
        const ALLOWED: &[&str] = &["app.emit(PROGRESS_EVENT"];
        let needle = [".emit", "("].concat();
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut bad = Vec::new();
        let mut files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .collect();
        if let Ok(rd) = std::fs::read_dir(dir.join("remote")) {
            files.extend(rd.flatten().map(|e| e.path()));
        }
        for f in files
            .iter()
            .filter(|p| p.extension().is_some_and(|e| e == "rs"))
        {
            let text = std::fs::read_to_string(f).unwrap();
            for (i, line) in text.lines().enumerate() {
                let t = line.trim_start();
                if t.starts_with("//") || !line.contains(&needle) {
                    continue;
                }
                if ALLOWED.iter().any(|a| line.contains(a)) {
                    continue;
                }
                bad.push(format!("{}:{}: {}", f.display(), i + 1, t));
            }
        }
        assert!(
            bad.is_empty(),
            "use emit_to(label, ..):\n{}",
            bad.join("\n")
        );
    }

    #[test]
    fn last_window_close_quits_except_on_mac() {
        assert_eq!(close_action(2, false), CloseAction::Close);
        assert_eq!(close_action(2, true), CloseAction::Close);
        assert_eq!(close_action(1, false), CloseAction::Quit);
        assert_eq!(close_action(1, true), CloseAction::Hide);
        assert_eq!(close_action(0, false), CloseAction::Quit);
    }

    #[test]
    fn titles_show_folder_and_host() {
        let l = FolderId::Local {
            path: "/home/u/proj".into(),
        };
        assert_eq!(title_for(Some(&l), None), "proj — SparkDown");
        let r = FolderId::Remote {
            user: "u".into(),
            hostname: "10.0.0.2".into(),
            port: 22,
            path: "/srv/app/".into(),
        };
        assert_eq!(
            title_for(Some(&r), Some("box:/srv/app/")),
            "app (box) — SparkDown"
        );
        assert_eq!(title_for(None, None), "SparkDown");
        let root = FolderId::Local { path: "/".into() };
        assert_eq!(title_for(Some(&root), None), "/ — SparkDown");
        let win = FolderId::Local {
            path: r"C:\Users\u\docs".into(),
        };
        assert_eq!(title_for(Some(&win), None), "docs — SparkDown");
    }

    #[test]
    fn window_menu_has_one_entry_per_live_window() {
        let rows = vec![
            ("w2".to_string(), "B — SparkDown".to_string()),
            ("w1".to_string(), "A — SparkDown".to_string()),
            ("w1".to_string(), "A — SparkDown".to_string()),
            ("w3".to_string(), "SparkDown".to_string()),
            ("gone".to_string(), "A — SparkDown".to_string()),
        ];
        let e = menu_entries(&rows, |l| l != "gone");
        let texts: Vec<_> = e.iter().map(|(_, t)| t.as_str()).collect();
        assert_eq!(texts, ["A", "B", "Untitled window"]);
        assert_eq!(e[0].0, format!("{FOCUS_PREFIX}w1"));
    }

    #[test]
    fn window_menu_follows_retitle_and_close() {
        let mut rows = vec![("w1".to_string(), "A — SparkDown".to_string())];
        assert_eq!(menu_entries(&rows, |_| true)[0].1, "A");
        rows[0].1 = "notes (host) — SparkDown".into();
        assert_eq!(menu_entries(&rows, |_| true)[0].1, "notes (host)");
        assert!(menu_entries(&rows, |_| false).is_empty());
    }

    #[test]
    fn macos_window_menu_is_the_native_windows_menu() {
        let main = include_str!("main.rs");
        assert!(main.contains("set_as_windows_menu_for_nsapp"));
    }
}
