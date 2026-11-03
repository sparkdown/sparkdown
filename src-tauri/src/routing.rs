//! Open Folder routing (#62): a folder is open in at most one window.
//!
//! Every way to open a folder — File → Open Folder, its shortcut, the
//! recent list, the remote dialog, `sparkdown <dir>` (forwarded by the
//! single-instance plugin) and macOS "Open With" — asks here first:
//!
//! 1. the folder is already open in a window → focus that window;
//! 2. the asking window is empty (no folder, nothing unsaved) → open here;
//! 3. otherwise → a new window opens it.
//!
//! Identity is canonical: a local folder by its real path, a remote one by
//! `ssh -G`'s user/hostname/port plus the path (the session's `pwd -P` once
//! connected; a duplicate found only then is caught when the window reports
//! its folder).

use crate::windows::{self, FolderId, Registry};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

/// What the asking window should do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "action", content = "label", rename_all = "lowercase")]
pub enum Route {
    /// Open it in the asking window.
    Here,
    /// Already open in this window, which was focused.
    Focused(String),
    /// A new window with this label opens it.
    New(String),
}

/// The routing rule, on the registry alone.
#[cfg(test)]
pub fn decide(reg: &Registry, caller: Option<&str>, folder: &FolderId) -> Route {
    decide_with(reg, caller, folder, false)
}

/// `decide`, optionally forcing a new window (#66 "Open in New Window"):
/// an empty caller is skipped, but a folder that is already open still
/// just focuses its window (one folder, one window).
pub fn decide_with(
    reg: &Registry,
    caller: Option<&str>,
    folder: &FolderId,
    new_window: bool,
) -> Route {
    if let Some(open_in) = reg.find_folder(folder) {
        return if caller == Some(open_in.as_str()) {
            Route::Here
        } else {
            Route::Focused(open_in)
        };
    }
    if let Some(c) = caller.filter(|_| !new_window) {
        if reg.is_empty_window(c) {
            return Route::Here;
        }
    }
    let base = windows::label_for_folder(folder);
    let mut label = base.clone();
    let mut n = 1;
    while reg.contains(&label) {
        n += 1;
        label = format!("{base}-{n}");
    }
    Route::New(label)
}

/// `ssh://host/abs/path` (the recent-list form) → (host, path).
pub fn parse_ssh_url(s: &str) -> Option<(String, String)> {
    let rest = s.strip_prefix("ssh://")?;
    let slash = rest.find('/')?;
    let (host, path) = rest.split_at(slash);
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), path.to_string()))
}

fn normalize_remote_path(p: &str) -> String {
    let t = p.trim();
    if t.len() > 1 {
        t.trim_end_matches('/').to_string()
    } else {
        t.to_string()
    }
}

/// Canonical id of a remote folder: `ssh -G` identity plus the path.
pub fn remote_folder_id(host: &str, path: &str) -> Result<FolderId, String> {
    let r = crate::remote::hostkey::resolve(host)?;
    Ok(FolderId::Remote {
        user: r.user,
        hostname: r.hostname,
        port: r.port,
        path: normalize_remote_path(path),
    })
}

/// What a window should open when it starts (set by a `New` route).
fn pending_opens() -> std::sync::MutexGuard<'static, HashMap<String, String>> {
    static P: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    P.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Close Folder (#127): take what is queued for `label` to open at start.
pub fn take_pending_open(label: &str) -> Option<String> {
    pending_opens().remove(label)
}

/// Queue `spec` for `label`'s (re)starting webview.
pub fn queue_open(label: &str, spec: String) {
    pending_opens().insert(label.to_string(), spec);
}

/// Whether a path queued for a window whose folder was just closed should
/// be routed again: never the closed folder itself (it would reopen in
/// the now-empty window), anything else yes.
pub fn reroute_after_close(queued: Option<&FolderId>, closed: Option<&FolderId>) -> bool {
    match (queued, closed) {
        (Some(q), Some(c)) => q.key() != c.key(),
        (Some(_), None) => true,
        // Unresolvable now: let the route report it.
        (None, _) => true,
    }
}

/// The folder spec a request names, as seen from `caller`: `ssh://` is
/// remote; a bare path is remote on the caller's live session, else local.
fn folder_for(caller: Option<&str>, dir: &str) -> Result<(FolderId, String, String), String> {
    if let Some((host, path)) = parse_ssh_url(dir) {
        let f = remote_folder_id(&host, &path)?;
        return Ok((f, dir.to_string(), format!("{host}:{path}")));
    }
    if let Some(label) = caller {
        let _scope = windows::enter(label);
        if let Some(s) = crate::remote::current_session() {
            let f = remote_folder_id(&s.host, dir)?;
            return Ok((
                f,
                format!("ssh://{}{}", s.host, dir),
                format!("{}:{dir}", s.host),
            ));
        }
    }
    let f = windows::local_folder_id(dir)?;
    Ok((f, dir.to_string(), dir.to_string()))
}

/// Route `dir` for `caller` and carry the route out (focus or create).
pub fn route(
    app: &AppHandle,
    caller: Option<&str>,
    dir: &str,
    new_window: bool,
) -> Result<Route, String> {
    let (folder, spec, display) = folder_for(caller, dir)?;
    let route = {
        let mut reg = windows::registry();
        let r = decide_with(&reg, caller, &folder, new_window);
        if let Route::New(label) = &r {
            // Claim the folder now so a second request focuses this window.
            reg.register(label);
            let _ = reg.set_folder(label, Some(folder.clone()), Some(display));
        }
        r
    };
    match &route {
        Route::Here => {}
        Route::Focused(label) => focus(app, label),
        Route::New(label) => {
            pending_opens().insert(label.clone(), spec);
            if let Err(e) = windows::create_window(app, label, None, true) {
                pending_opens().remove(label);
                windows::registry().unregister(label);
                return Err(format!("could not open a new window: {e}"));
            }
            crate::lifecycle::refresh(app);
        }
    }
    Ok(route)
}

pub fn focus(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// --- Commands --------------------------------------------------------------------

/// Ask where `dir` (a local path, a path on this window's remote session,
/// or `ssh://host/path`) opens. `here` = the caller opens it itself.
/// Unresolvable input (a missing folder, a bad host) answers `here` so the
/// caller's own open reports the error as before.
#[tauri::command]
pub async fn route_folder(
    app: AppHandle,
    webview_window: tauri::WebviewWindow,
    dir: String,
    new_window: Option<bool>,
) -> Result<Route, String> {
    let label = webview_window.label().to_string();
    let new_window = new_window.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        Ok(route(&app, Some(&label), &dir, new_window).unwrap_or(Route::Here))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// For each recent-folder spec (a local path or `ssh://host/path`), the
/// 1-based number of the window that has it open (Window menu order), or
/// null (#66: recents mark open folders).
#[tauri::command]
pub async fn window_numbers_for(specs: Vec<String>) -> Result<Vec<Option<usize>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ids: Vec<Option<FolderId>> = specs
            .iter()
            .map(|s| folder_for(None, s).ok().map(|(f, _, _)| f))
            .collect();
        let reg = windows::registry();
        Ok(numbers_for(&reg, &ids))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn numbers_for(reg: &Registry, ids: &[Option<FolderId>]) -> Vec<Option<usize>> {
    let order: Vec<String> = reg.summaries().into_iter().map(|w| w.label).collect();
    ids.iter()
        .map(|id| {
            let label = reg.find_folder(id.as_ref()?)?;
            order.iter().position(|l| *l == label).map(|i| i + 1)
        })
        .collect()
}

/// The folder a window created by a `new` route should open (once).
#[tauri::command]
pub fn window_take_open(webview_window: tauri::WebviewWindow) -> Option<String> {
    pending_opens().remove(webview_window.label())
}

/// After a remote connect: record this window's remote folder (the
/// session's resolved path). If another window already has it, that window
/// is focused and its label returned so this one can step back.
#[tauri::command]
pub async fn window_set_remote_folder(
    app: AppHandle,
    webview_window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let label = webview_window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let session = {
            let _scope = windows::enter(&label);
            crate::remote::current_session()
        };
        let Some(s) = session else {
            return Ok(None);
        };
        let f = remote_folder_id(&s.host, &s.path)?;
        let display = format!("{}:{}", s.host, s.path);
        let r = windows::registry().set_folder(&label, Some(f), Some(display));
        crate::lifecycle::refresh(&app);
        match r {
            Ok(()) => Ok(None),
            Err(other) => {
                focus(&app, &other);
                Ok(Some(other))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Paths handed over by a second launch or "Open With": folders are routed
/// (focus / the focused window if empty / new window); files go to the
/// window whose folder contains them, else the focused one. Returns the
/// paths each window should open itself.
pub fn route_forwarded(
    app: &AppHandle,
    paths: &[String],
    new_window: bool,
) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    let focused = windows::registry().focused();
    for p in paths {
        let is_dir = std::path::Path::new(p).is_dir();
        if is_dir {
            match route(app, focused.as_deref(), p, new_window) {
                Ok(Route::Here) => {
                    if let Some(f) = &focused {
                        // Claim it now so a second folder in the same
                        // batch doesn't also land here.
                        if let Ok(id) = windows::local_folder_id(p) {
                            let _ = windows::registry().set_folder(f, Some(id), Some(p.clone()));
                        }
                        out.entry(f.clone()).or_default().push(p.clone());
                    }
                }
                Ok(Route::Focused(_)) | Ok(Route::New(_)) => {}
                Err(_) => {
                    if let Some(f) = &focused {
                        out.entry(f.clone()).or_default().push(p.clone());
                    }
                }
            }
        } else {
            let target = decide_file(&windows::registry(), focused.as_deref(), p);
            if let Some(t) = target {
                focus(app, &t);
                out.entry(t).or_default().push(p.clone());
            }
        }
    }
    out
}

/// Where a forwarded file opens (#160, decision 3): the window whose open
/// folder contains it, else the focused window as a plain tab. `None` means
/// no window is open (a new empty window gets it; follow-up in #160).
/// Parent folders are never opened for a file.
pub fn decide_file(reg: &Registry, focused: Option<&str>, file: &str) -> Option<String> {
    reg.window_for_local_path(file)
        .or_else(|| focused.map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg_with(folders: &[(&str, Option<&str>)]) -> Registry {
        let mut r = Registry::default();
        for (label, folder) in folders {
            r.register(label);
            if let Some(f) = folder {
                r.set_folder(
                    label,
                    Some(FolderId::Local {
                        path: f.to_string(),
                    }),
                    Some(f.to_string()),
                )
                .unwrap();
            }
        }
        r
    }

    #[test]
    fn an_open_folder_focuses_its_window_even_from_another() {
        let r = reg_with(&[("w-1", Some("/p/a")), ("w-2", Some("/p/b"))]);
        let a = FolderId::Local {
            path: "/p/a".into(),
        };
        assert_eq!(decide(&r, Some("w-2"), &a), Route::Focused("w-1".into()));
        assert_eq!(
            decide_with(&r, Some("w-2"), &a, true),
            Route::Focused("w-1".into())
        );
        assert_eq!(
            decide_with(&r, None, &a, false),
            Route::Focused("w-1".into())
        );
        assert_eq!(decide(&r, Some("w-1"), &a), Route::Here);
    }

    #[test]
    fn a_file_in_an_open_folder_goes_to_that_folders_window() {
        let r = reg_with(&[
            ("w-1", Some("/p/a")),
            ("w-2", Some("/p/b")),
            ("w-3", Some("/p/a/sub")),
        ]);
        assert_eq!(
            decide_file(&r, Some("w-2"), "/p/a/x.md").as_deref(),
            Some("w-1")
        );
        // Deepest open folder wins.
        assert_eq!(
            decide_file(&r, Some("w-2"), "/p/a/sub/y.md").as_deref(),
            Some("w-3")
        );
    }

    #[test]
    fn a_file_outside_every_folder_is_a_tab_in_the_focused_window() {
        let r = reg_with(&[("w-1", Some("/p/a")), ("w-2", None)]);
        assert_eq!(
            decide_file(&r, Some("w-1"), "/elsewhere/z.md").as_deref(),
            Some("w-1")
        );
        // `/p/ab` is not inside `/p/a`.
        assert_eq!(
            decide_file(&r, Some("w-2"), "/p/ab/z.md").as_deref(),
            Some("w-2")
        );
    }

    #[test]
    fn a_file_with_no_window_open_has_no_target() {
        let r = Registry::default();
        assert_eq!(decide_file(&r, None, "/p/a/x.md"), None);
    }

    #[test]
    fn close_folder_drops_a_queued_open_of_that_folder_only() {
        let a = FolderId::Local {
            path: "/p/a".into(),
        };
        let b = FolderId::Local {
            path: "/p/b".into(),
        };
        assert!(!reroute_after_close(Some(&a), Some(&a)));
        assert!(reroute_after_close(Some(&b), Some(&a)));
        assert!(reroute_after_close(Some(&b), None));
        assert!(reroute_after_close(None, Some(&a)));
        queue_open("w-x", "/p/b".into());
        assert_eq!(take_pending_open("w-x").as_deref(), Some("/p/b"));
        assert_eq!(take_pending_open("w-x"), None);
    }

    #[test]
    fn a_closed_folder_window_is_reused_for_the_next_open() {
        // #127: after Close Folder the window keeps its w-<hash> label but
        // is empty, so reopening the same folder from it lands "Here"
        // (fresh), and from elsewhere it focuses nothing old.
        let a = FolderId::Local {
            path: "/p/a".into(),
        };
        let la = windows::label_for_folder(&a);
        let mut reg = Registry::default();
        reg.register(&la);
        reg.register("w-other");
        reg.set_folder(&la, Some(a.clone()), None).unwrap();
        reg.set_folder(
            "w-other",
            Some(FolderId::Local {
                path: "/p/o".into(),
            }),
            None,
        )
        .unwrap();
        reg.close_folder(&la);
        assert_eq!(decide(&reg, Some(&la), &a), Route::Here);
        // From a busy window: a new window, never the stale label.
        assert_eq!(
            decide(&reg, Some("w-other"), &a),
            Route::New(format!("{la}-2"))
        );
    }

    fn local(p: &str) -> FolderId {
        FolderId::Local { path: p.into() }
    }

    #[test]
    fn recents_get_the_number_of_the_window_that_has_them() {
        let mut reg = Registry::default();
        for l in ["w-1", "w-2"] {
            reg.register(l);
        }
        reg.set_folder("w-2", Some(local("/two")), None).unwrap();
        let order: Vec<String> = reg.summaries().into_iter().map(|w| w.label).collect();
        let n = order.iter().position(|l| l == "w-2").unwrap() + 1;
        assert_eq!(
            numbers_for(&reg, &[Some(local("/two")), Some(local("/nope")), None]),
            vec![Some(n), None, None]
        );
    }

    #[test]
    fn open_folder_routing_rule() {
        let mut reg = Registry::default();
        reg.register("w-a");
        reg.register("w-empty");
        reg.set_folder("w-a", Some(local("/a")), None).unwrap();
        // Already open elsewhere: focus it.
        assert_eq!(
            decide(&reg, Some("w-empty"), &local("/a")),
            Route::Focused("w-a".into())
        );
        // Already open here: here.
        assert_eq!(decide(&reg, Some("w-a"), &local("/a")), Route::Here);
        // Empty caller: here.
        assert_eq!(decide(&reg, Some("w-empty"), &local("/b")), Route::Here);
        // Caller has a folder: new window with the folder's stable label.
        assert_eq!(
            decide(&reg, Some("w-a"), &local("/b")),
            Route::New(windows::label_for_folder(&local("/b")))
        );
        // Unsaved tabs make a window non-empty.
        reg.set_dirty("w-empty", true);
        assert!(matches!(
            decide(&reg, Some("w-empty"), &local("/b")),
            Route::New(_)
        ));
        // No caller (a forwarded path with no window focused): new window.
        assert!(matches!(decide(&reg, None, &local("/c")), Route::New(_)));
        // #66: a forced new window skips the empty caller, but an open
        // folder still only focuses its window.
        assert!(matches!(
            decide_with(&reg, Some("w-empty"), &local("/c"), true),
            Route::New(_)
        ));
        assert_eq!(
            decide_with(&reg, Some("w-empty"), &local("/a"), true),
            Route::Focused("w-a".into())
        );
        assert_eq!(
            decide_with(&reg, Some("w-a"), &local("/a"), true),
            Route::Here
        );
    }

    #[test]
    fn remote_identity_ignores_alias_spelling_and_trailing_slash() {
        let mut reg = Registry::default();
        reg.register("w-r");
        let a = FolderId::Remote {
            user: "u".into(),
            hostname: "Box.Example".into(),
            port: 22,
            path: normalize_remote_path("/srv/app/"),
        };
        reg.set_folder("w-r", Some(a), None).unwrap();
        let b = FolderId::Remote {
            user: "u".into(),
            hostname: "box.example".into(),
            port: 22,
            path: normalize_remote_path("/srv/app"),
        };
        reg.register("w-x");
        reg.set_folder("w-x", Some(local("/x")), None).unwrap();
        assert_eq!(decide(&reg, Some("w-x"), &b), Route::Focused("w-r".into()));
        let other_port = FolderId::Remote {
            user: "u".into(),
            hostname: "box.example".into(),
            port: 2222,
            path: "/srv/app".into(),
        };
        assert!(matches!(
            decide(&reg, Some("w-x"), &other_port),
            Route::New(_)
        ));
    }

    #[test]
    fn a_taken_label_gets_a_suffix() {
        let mut reg = Registry::default();
        let l = windows::label_for_folder(&local("/b"));
        reg.register(&l); // e.g. a window still closing
        reg.register("w-a");
        reg.set_folder("w-a", Some(local("/a")), None).unwrap();
        assert_eq!(
            decide(&reg, Some("w-a"), &local("/b")),
            Route::New(format!("{l}-2"))
        );
    }

    #[test]
    fn ssh_urls_parse() {
        assert_eq!(
            parse_ssh_url("ssh://box/srv/a"),
            Some(("box".into(), "/srv/a".into()))
        );
        assert_eq!(
            parse_ssh_url("ssh://u@h:2222/x"),
            Some(("u@h:2222".into(), "/x".into()))
        );
        assert_eq!(parse_ssh_url("ssh:///x"), None);
        assert_eq!(parse_ssh_url("/local"), None);
    }

    #[test]
    fn ssh_g_user_is_parsed() {
        let r = crate::remote::hostkey::parse_ssh_g("user deploy\nhostname 10.0.0.5\nport 2200\n");
        assert_eq!(
            (r.user.as_str(), r.hostname.as_str(), r.port),
            ("deploy", "10.0.0.5", 2200)
        );
    }
}
