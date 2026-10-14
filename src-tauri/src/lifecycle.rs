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
use tauri::menu::{MenuItem, MenuItemBuilder, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// The Window menu and the per-window items it lists. Managed.
pub struct WindowMenu {
    pub submenu: Submenu<Wry>,
    items: Mutex<Vec<MenuItem<Wry>>>,
}

impl WindowMenu {
    pub fn new(submenu: Submenu<Wry>) -> Self {
        Self {
            submenu,
            items: Mutex::new(Vec::new()),
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

/// Re-title every window and rebuild the Window menu's list. Call after
/// a window opens, closes, or changes folder.
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
    let Some(menu) = app.try_state::<WindowMenu>() else {
        return;
    };
    let Ok(mut items) = menu.items.lock() else {
        return;
    };
    for old in items.drain(..) {
        let _ = menu.submenu.remove(&old);
    }
    for (label, title) in titled {
        let text = title.trim_end_matches(" — SparkDown").to_string();
        let text = if text == "SparkDown" {
            "Untitled window".to_string()
        } else {
            text
        };
        if let Ok(item) =
            MenuItemBuilder::with_id(format!("{FOCUS_PREFIX}{label}"), text).build(app)
        {
            if menu.submenu.append(&item).is_ok() {
                items.push(item);
            }
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
    match close_action(visible, cfg!(target_os = "macos")) {
        CloseAction::Close => {
            let _ = window.emit("close-requested", serde_json::json!({ "mode": "close" }));
        }
        CloseAction::Hide => {
            let _ = window.emit("close-requested", serde_json::json!({ "mode": "hide" }));
        }
        CloseAction::Quit => {
            let _ = window.emit("exit-requested", ());
        }
    }
}

// --- Quit ----------------------------------------------------------------------

type Pending = HashMap<u64, Sender<bool>>;

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
            .map(|(label, command)| BusyTerminal {
                window: names.get(&label).cloned().unwrap_or(label),
                command,
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
            quit_pending().insert(id, tx);
            if w.emit("quit-prepare", serde_json::json!({ "id": id }))
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
        true
    })
    .await
    .map_err(|e| e.to_string())
}

/// A window's answer to `quit-prepare`.
#[tauri::command]
pub fn quit_prepare_reply(id: u64, ok: bool) {
    if let Some(tx) = quit_pending().remove(&id) {
        let _ = tx.send(ok);
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
}
