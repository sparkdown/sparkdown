// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod context;
mod file_index;
mod fsio;
mod git;
#[cfg(target_os = "macos")]
mod macos_quit;
mod mcp;
mod mcp_stdio;
mod meat;
mod menu;
mod proc;
mod remote;
mod review;
mod search;
mod terminal;
mod updates;
mod watcher;
#[cfg(all(test, windows))]
mod win_test_agents;

use std::sync::{Arc, Mutex};
use tauri::menu::CheckMenuItem;
use tauri::{Emitter, Manager, State, Wry};

/// Stores file paths received via macOS Apple Events ("Open With")
/// before the frontend is ready to receive them.
#[derive(Default)]
pub struct PendingFiles {
    pub paths: Arc<Mutex<Vec<String>>>,
}

/// Holds the HTML document currently being previewed with scripts enabled.
/// Served by the `htmlpreview://` custom protocol, which gives the document its
/// own origin (isolated from the app) and a network-permissive CSP so inline
/// scripts AND remote framework/CDN assets in the user's HTML can run. The
/// frontend only points the preview iframe at this protocol when the user opts
/// into "Allow JavaScript in HTML Preview"; otherwise it stays in the
/// sandboxed, script-free `srcdoc` path. See the handler below and SECURITY.md.
#[derive(Default)]
pub struct HtmlPreview {
    pub html: Arc<Mutex<String>>,
}

/// Handle to the "Allow JavaScript in HTML Preview" check menu item, so its
/// checkmark can be synced when the toggle is flipped from the floating button.
pub struct HtmlJsMenuItem(pub CheckMenuItem<Wry>);

/// Maximum pending files to queue before dropping new arrivals.
const MAX_PENDING_FILES: usize = 100;

fn push_pending<I: IntoIterator<Item = String>>(state: &State<'_, PendingFiles>, paths: I) {
    if let Ok(mut guard) = state.paths.lock() {
        for path in paths {
            if guard.len() >= MAX_PENDING_FILES {
                eprintln!("Warning: Pending files queue full, dropping: {}", path);
                break;
            }
            guard.push(path);
        }
    }
}

#[cfg(target_os = "macos")]
fn emit_open_file_paths(app: &tauri::AppHandle, paths: &[String]) {
    if let Some(window) = app.get_webview_window("main") {
        for path in paths {
            let _ = window.emit("open-file-path", serde_json::json!({ "path": path }));
        }
    }
}

/// Navigation guard for every webview: only the app's own origin (and the
/// preview iframe's documents) may load. Link clicks in the markdown preview
/// are already intercepted in the frontend; this is defence in depth so no
/// stray navigation can replace the editor UI with a remote page.
///
/// WebKit (macOS/Linux) runs this for subframe navigations too, so the HTML
/// preview iframe's sources (srcdoc, htmlpreview://, asset:) must be allowed.
pub(crate) fn is_allowed_navigation(url: &tauri::Url) -> bool {
    match url.scheme() {
        // App bundle (macOS/Linux) and custom protocols.
        "tauri" | "htmlpreview" | "asset" => url.host_str() == Some("localhost"),
        // about:srcdoc (scripts-off preview iframe) / about:blank.
        "about" => matches!(url.path(), "srcdoc" | "blank"),
        // Windows serves custom protocols as http(s)://<scheme>.localhost.
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost" | "htmlpreview.localhost" | "asset.localhost") => true,
            // Vite dev server (tauri.conf.json devUrl), debug builds only.
            Some("localhost") => cfg!(debug_assertions) && url.port() == Some(1420),
            _ => false,
        },
        _ => false,
    }
}

fn main() {
    // Agent MCP shim: when launched as `sparkdown --mcp-stdio` (by an agent
    // CLI that registered us as a stdio MCP server), act as that bridge and
    // never start the GUI. Must run before the Tauri builder.
    if std::env::args().any(|a| a == mcp::SHIM_FLAG) {
        mcp_stdio::run();
        return;
    }

    tauri::Builder::default()
        .manage(PendingFiles::default())
        .manage(HtmlPreview::default())
        .manage(commands::WriteRateLimiter::default())
        .manage(terminal::TerminalState::default())
        .manage(watcher::WatcherState::default())
        .manage(Arc::new(mcp::McpState::default()))
        .manage(updates::UpdateState::default())
        .register_uri_scheme_protocol("htmlpreview", |ctx, _request| {
            // Serves the HTML the user EXPLICITLY opted to run with scripts
            // (guarded by a confirmation dialog: "only enable for files you
            // trust"). Scripts-on is therefore a "run this document fully"
            // mode — including its remote framework/CDN assets, without which
            // real web documents (reveal.js decks, charting libs, etc.) can't
            // work. The CSP allows https + inline scripts/styles and network
            // egress accordingly; a locked-down connect-src would be security
            // theater once remote <script src> is allowed at all (such a
            // script can exfiltrate however it likes).
            //
            // The guarantees that actually contain a malicious document do NOT
            // depend on this CSP and still hold:
            //   - it CANNOT read other local files (distinct htmlpreview://
            //     origin + asset-protocol CORS scoped to the app origin),
            //   - it CANNOT reach Tauri IPC (injected main-frame-only; this is
            //     a subframe),
            //   - it CANNOT hijack the app window (iframe sandbox withholds
            //     allow-top-navigation and allow-same-origin).
            // frame-ancestors 'self' keeps only our app able to frame it.
            const PREVIEW_CSP: &str =
                "default-src 'self' https: data: blob: asset: https://asset.localhost; \
                script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; \
                style-src 'self' 'unsafe-inline' https:; \
                img-src 'self' https: data: blob: asset: https://asset.localhost; \
                media-src 'self' https: data: blob: asset: https://asset.localhost; \
                font-src 'self' https: data: asset: https://asset.localhost; \
                connect-src https:; \
                frame-ancestors 'self'";
            let html = match ctx.app_handle().state::<HtmlPreview>().html.try_lock() {
                Ok(guard) => guard.clone(),
                Err(_) => {
                    eprintln!("Warning: Failed to acquire HTML preview lock");
                    return tauri::http::Response::builder()
                        .status(503)
                        .header(
                            tauri::http::header::CONTENT_TYPE,
                            "text/plain; charset=utf-8",
                        )
                        .body(b"Preview temporarily unavailable".to_vec())
                        .unwrap();
                }
            };
            tauri::http::Response::builder()
                .header(
                    tauri::http::header::CONTENT_TYPE,
                    "text/html; charset=utf-8",
                )
                .header(tauri::http::header::CACHE_CONTROL, "no-store")
                .header(tauri::http::header::CONTENT_SECURITY_POLICY, PREVIEW_CSP)
                .body(html.into_bytes())
                .unwrap()
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(
            tauri::plugin::Builder::<Wry>::new("navigation-guard")
                .on_navigation(|_webview, url| {
                    let allowed = is_allowed_navigation(url);
                    if !allowed {
                        eprintln!("Blocked navigation to {url}");
                    }
                    allowed
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();

            let app_menu = menu::build_menu(&handle)?;
            app.manage(HtmlJsMenuItem(app_menu.allow_html_js));
            // macOS: native menu bar (and traffic-light overlay title bar).
            // Windows/Linux: no in-window menu bar — the frontend pops this
            // menu from the toolbar app icon. Drop OS decorations so we draw
            // our own caption (icon + min/max/close).
            #[cfg(target_os = "macos")]
            app.set_menu(app_menu.menu)?;
            #[cfg(not(target_os = "macos"))]
            {
                app.manage(menu::AppMenuHandle(app_menu.menu));
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                }
            }

            app.on_menu_event(move |app_handle, event| {
                let id = event.id().0.as_str();
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.emit(&format!("menu:{}", id), ());
                }
            });

            let cli_files: Vec<String> = std::env::args().skip(1).collect();
            if !cli_files.is_empty() {
                push_pending(&app.state::<PendingFiles>(), cli_files);
            }

            // macOS: intercept dock/menu Quit so it runs the save prompt.
            #[cfg(target_os = "macos")]
            macos_quit::install(&handle);

            // In-app MCP server for agents in the terminal. Transport is a
            // per-user Unix domain socket (Windows: a per-launch named pipe),
            // not a network port — filesystem permissions are the access
            // control, so there is no port or token. Failure to bind is not
            // fatal: the file bridge and typed-prompt fallback still work.
            {
                let state = app.state::<Arc<mcp::McpState>>().inner().clone();
                if let Err(e) = mcp::start(handle.clone(), state) {
                    eprintln!("Warning: MCP server failed to start: {e}");
                }
            }

            // Open the Web Inspector automatically in dev builds. Compiled out
            // of release (open_devtools is debug-only).
            #[cfg(debug_assertions)]
            if let Some(window) = handle.get_webview_window("main") {
                window.open_devtools();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::append_crash_log,
            commands::is_directory,
            commands::copy_text,
            commands::copy_file,
            commands::list_directory,
            file_index::list_workspace_files,
            commands::load_config,
            commands::save_config,
            commands::get_pending_files,
            commands::quit,
            commands::set_html_preview,
            commands::set_html_js_checked,
            commands::show_app_menu,
            commands::open_external,
            commands::allow_preview_assets,
            commands::remote_read_image,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            terminal::shell_name,
            terminal::terminal_launch_shell,
            terminal::tmux_sessions,
            terminal::tmux_send_keys,
            terminal::tmux_kill_session,
            watcher::watch_start,
            watcher::watch_stop,
            git::git_status,
            git::git_branch_status,
            git::git_diff_file,
            review::git_change_stats,
            review::review_state_load,
            review::review_state_save,
            search::search_in_files,
            context::agent_context_update,
            context::agent_context_clear,
            mcp::mcp_publish,
            mcp::mcp_reply,
            mcp::mcp_shim_command,
            mcp::mcp_server_running,
            mcp::mcp_install_agent,
            mcp::mcp_uninstall_agent,
            mcp::mcp_agent_installed,
            context::detect_agents,
            remote::ssh_config_hosts,
            remote::remote_connect,
            remote::remote_disconnect,
            remote::remote_session,
            remote::remote_create_dir,
            updates::update_support,
            updates::update_check,
            updates::update_download,
            updates::update_install,
            updates::update_restart,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // User-initiated quit (dock right-click → Quit, app menu Quit, the
            // OS Cmd+Q) arrives as ExitRequested with code: None. Intercept it
            // and route through the frontend's unsaved-changes guard instead of
            // terminating. The frontend, once the user has saved/discarded,
            // calls the `quit` command (app.exit(0)) which re-fires this event
            // with code: Some(0) — allowed through. Programmatic exits always
            // carry a code, so they never get intercepted.
            // Every window-close request (red-X button AND dock/app-menu Quit,
            // which both surface as CloseRequested) is intercepted here in Rust
            // — synchronously, so prevent_close() lands before the OS can
            // terminate. We then hand off to the frontend to decide what to do
            // (hide-to-dock on macOS, or run the unsaved-changes save prompt).
            // A real exit only happens via the `quit` command (app.exit), which
            // does not emit CloseRequested.
            // Red-X / window close: on macOS, prevent the close and hand off to
            // the frontend, which resolves unsaved changes (the Office model)
            // and THEN hides the window to the dock. Resolving before hiding is
            // essential: a hidden window's later dock-Quit fires an
            // unpreventable RunEvent::Exit, so nothing may be left unsaved once
            // the window is in the dock. Other platforms fall through to a
            // normal close → exit.
            // Final teardown, covering both the `quit` command's app.exit and
            // an unpreventable Exit (hidden-window dock Quit): release the SSH
            // control (mux) connection and its reverse MCP forward so they
            // don't outlive the process (ControlPersist would otherwise keep
            // them ~10 minutes, leaving the next launch's MCP forward silently
            // offline).
            if let tauri::RunEvent::Exit = &event {
                remote::shutdown();
                mcp::shutdown();
                return;
            }

            if let tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } = &event
            {
                api.prevent_close();
                if let Some(window) = app.get_webview_window("main") {
                    // macOS: hide to dock (after resolving unsaved changes).
                    // Other platforms: closing the window means quit.
                    #[cfg(target_os = "macos")]
                    let _ = window.emit("close-requested", ());
                    #[cfg(not(target_os = "macos"))]
                    let _ = window.emit("exit-requested", ());
                }
                return;
            }

            // Quit on a VISIBLE window (Cmd+Q via the predefined menu item, or
            // dock-icon Quit) surfaces as a preventable ExitRequested code:None.
            // Intercept, focus the window, and run the frontend's save prompt;
            // it ends by calling `quit` (app.exit(0)) → ExitRequested
            // code:Some(0), allowed through. (A hidden window's dock-Quit can't
            // reach here — it Exits directly — which is why close-to-dock above
            // resolves unsaved work up front.)
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
                if code.is_none() {
                    api.prevent_exit();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = window.emit("exit-requested", ());
                    }
                }
                return;
            }

            // Everything below handles macOS-only events (Reopen, Opened);
            // on other platforms the closure ends here.
            #[cfg(not(target_os = "macos"))]
            let _ = event;

            // macOS: clicking the dock icon while all windows are hidden
            // (closing the window hides it rather than quitting) re-shows it.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if !has_visible_windows {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                return;
            }

            // macOS "Open With" sends file URLs via RunEvent::Opened
            // (variant only exists on macOS/iOS)
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|url| {
                        if url.scheme() == "file" {
                            url.to_file_path()
                                .ok()
                                .map(|p| p.to_string_lossy().into_owned())
                        } else {
                            None
                        }
                    })
                    .collect();

                if paths.is_empty() {
                    return;
                }

                // Re-show the window in case it was hidden (macOS close-to-dock).
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }

                emit_open_file_paths(app, &paths);
                push_pending(&app.state::<PendingFiles>(), paths);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::is_allowed_navigation;

    fn allowed(u: &str) -> bool {
        is_allowed_navigation(&tauri::Url::parse(u).unwrap())
    }

    #[test]
    fn navigation_guard_allows_only_app_origins() {
        for ok in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
            "htmlpreview://localhost/?v=3",
            "http://htmlpreview.localhost/",
            "asset://localhost/%2Ftmp%2Fa.png",
            "about:srcdoc",
            "about:blank",
        ] {
            assert!(allowed(ok), "should allow {ok}");
        }
        for bad in [
            "https://example.com/",
            "http://evil.localhost/",
            "tauri://evil.example/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "http://localhost:8080/",
        ] {
            assert!(!allowed(bad), "should block {bad}");
        }
        assert_eq!(allowed("http://localhost:1420/"), cfg!(debug_assertions));
    }

    /// The NSIS upgrade hook (#17) hard-codes the registry keys Tauri's
    /// template derives from productName / bundle.publisher / identifier;
    /// keep them in sync with tauri.conf.json.
    #[test]
    fn nsis_hooks_match_bundle_config() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let conf: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("tauri.conf.json")).unwrap())
                .unwrap();
        let hooks_rel = conf["bundle"]["windows"]["nsis"]["installerHooks"]
            .as_str()
            .expect("bundle.windows.nsis.installerHooks");
        let hooks = std::fs::read_to_string(dir.join(hooks_rel)).unwrap();
        let product = conf["productName"].as_str().unwrap();
        let publisher = conf["bundle"]["publisher"].as_str().unwrap();
        // Tauri's manufacturer when no publisher is set: the identifier's 2nd part.
        let legacy = conf["identifier"]
            .as_str()
            .unwrap()
            .split('.')
            .nth(1)
            .unwrap();
        for line in [
            format!("!define SD_PRODUCTNAME \"{product}\""),
            format!("!define SD_PUBLISHER \"{publisher}\""),
            format!("!define SD_LEGACY_MANUFACTURER \"{legacy}\""),
        ] {
            assert!(hooks.contains(&line), "{hooks_rel} must contain `{line}`");
        }
    }
}
