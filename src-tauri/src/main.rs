// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod askpass;
mod commands;
mod config;
mod context;
mod file_index;
mod fsio;
mod git;
mod lifecycle;
#[cfg(target_os = "macos")]
mod macos_quit;
mod mcp;
mod mcp_stdio;
mod meat;
mod menu;
mod proc;
mod remote;
mod review;
mod routing;
mod search;
mod session;
mod terminal;
mod updates;
mod watcher;
#[cfg(all(test, windows))]
mod win_test_agents;
mod windows;

use std::sync::{Arc, Mutex};
use tauri::menu::CheckMenuItem;
use tauri::{Emitter, Manager, Wry};

/// Stores file paths received via macOS Apple Events ("Open With")
/// before the frontend is ready to receive them.
#[derive(Default)]
pub struct PendingFiles {
    pub paths: Arc<Mutex<Vec<String>>>,
    /// The frontend has taken the startup queue (`get_pending_files`), so
    /// later arrivals go to it as an `open-paths` event instead (#51).
    /// Only read or written under the `paths` lock.
    pub frontend_took: Arc<std::sync::atomic::AtomicBool>,
}

impl PendingFiles {
    /// Paths that arrived from outside (a second launch, macOS "Open With",
    /// `open -a`): queued for the starting frontend while it has not taken
    /// the startup queue yet (None), else handed back for routing to one
    /// window (Some). Never both: a path queued after the take would sit in
    /// the app-wide queue and be opened, unrouted, by whichever webview
    /// starts next — a new window or a reloaded one (#106).
    pub fn offer(&self, paths: Vec<String>) -> Option<Vec<String>> {
        let Ok(mut queue) = self.paths.lock() else {
            return Some(paths);
        };
        if self.frontend_took.load(std::sync::atomic::Ordering::SeqCst) {
            return Some(paths);
        }
        for p in paths {
            if queue.len() < MAX_PENDING_FILES {
                queue.push(p);
            } else {
                eprintln!("Warning: Pending files queue full, dropping: {p}");
            }
        }
        None
    }

    /// The startup queue, handed out once: to the first frontend that asks.
    /// A later webview start (another window, or a reload after macOS ended
    /// its web-content process) gets nothing, so it never opens another
    /// window's folder (#106).
    pub fn take_startup(&self) -> Vec<String> {
        let Ok(mut queue) = self.paths.lock() else {
            return Vec::new();
        };
        // Under the lock: a second launch's paths either land in this batch
        // or come later as an `open-paths` event, never neither (#51).
        let first = !self
            .frontend_took
            .swap(true, std::sync::atomic::Ordering::SeqCst);
        let taken = std::mem::take(&mut *queue);
        if first {
            taken
        } else {
            Vec::new()
        }
    }
}

/// Route forwarded paths (#62) and send each window its share as
/// `open-paths`, scoped to that window (`emit_to`).
fn route_and_emit(app: &tauri::AppHandle, paths: &[String], new_window: bool) {
    for (label, paths) in routing::route_forwarded(app, paths, new_window) {
        routing::focus(app, &label);
        let _ = app.emit_to(
            label.as_str(),
            OPEN_PATHS_EVENT,
            serde_json::json!({ "paths": paths }),
        );
    }
}

/// Event for paths a second `sparkdown <path>…` launch forwarded (#51).
const OPEN_PATHS_EVENT: &str = "open-paths";

/// CLI flag forcing folders into a new window (#66).
const NEW_WINDOW_FLAG: &str = "--new-window";

/// Paths a second `sparkdown …` launch passed (#51), resolved against that
/// launch's working directory (not ours). Flags are skipped; `--version`,
/// `--help`, `--mcp-stdio` and the askpass helper never get here (they exit
/// in `main` before the single-instance plugin starts).
fn forwarded_paths(argv: &[String], cwd: &str) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|a| !a.is_empty() && !a.starts_with('-'))
        .map(|a| {
            let p = std::path::Path::new(a);
            let joined = if p.is_absolute() || cwd.is_empty() {
                p.to_path_buf()
            } else {
                std::path::Path::new(cwd).join(p)
            };
            // `sparkdown .` → `<cwd>`, not `<cwd>/.`.
            std::path::absolute(&joined)
                .unwrap_or(joined)
                .to_string_lossy()
                .trim_end_matches(['/', '\\'])
                .to_string()
        })
        .map(|p| {
            if p.is_empty() {
                "/".to_string()
            } else if p.ends_with(':') {
                format!("{p}\\") // `C:` alone would mean "the cwd on C:"
            } else {
                p
            }
        })
        .collect()
}

/// A second launch (#51): bring the window forward and open its paths here.
fn on_second_instance(app: &tauri::AppHandle, argv: Vec<String>, cwd: String) {
    let paths = forwarded_paths(&argv, &cwd);
    // `sparkdown --new-window <folder>` (#66).
    let new_window = argv.iter().skip(1).any(|a| a == NEW_WINDOW_FLAG);
    eprintln!("another launch handed over {} path(s)", paths.len());
    if paths.is_empty() {
        if let Some(window) = windows::target_window(app) {
            routing::focus(app, window.label());
        }
        return;
    }
    // Folders route (#62): focus the window that has it, else the focused
    // window if empty, else a new window. Before the frontend has started,
    // it takes these with the CLI's.
    if let Some(paths) = app.state::<PendingFiles>().offer(paths) {
        let app = app.clone();
        std::thread::spawn(move || route_and_emit(&app, &paths, new_window));
    }
}

/// Hand argv + cwd to a running SparkDown over its core socket. True when
/// one took them.
#[cfg(unix)]
fn forward_to_running_core() -> bool {
    use std::io::{Read, Write};
    let Ok(mut s) = std::os::unix::net::UnixStream::connect(mcp::mcp_socket_path()) else {
        return false;
    };
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let argv: Vec<String> = std::env::args().collect();
    let msg = serde_json::json!({ "sparkdown_forward": { "argv": argv, "cwd": cwd } });
    if writeln!(s, "{msg}").is_err() {
        return false;
    }
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let mut b = [0u8; 64];
    matches!(s.read(&mut b), Ok(n) if n > 0)
}

#[cfg(not(unix))]
fn forward_to_running_core() -> bool {
    false
}

/// Linux: the single-instance plugin talks D-Bus and panics on a malformed
/// `DBUS_SESSION_BUS_ADDRESS` (with `panic = "abort"`, a crash at start).
/// Use it only when that variable is unset (the plugin then tries the
/// standard socket, and simply runs without single-instance if there is no
/// bus) or names a known transport.
fn single_instance_supported() -> bool {
    if !cfg!(target_os = "linux") {
        return true;
    }
    match std::env::var("DBUS_SESSION_BUS_ADDRESS") {
        Err(_) => true,
        Ok(v) => dbus_address_looks_valid(&v),
    }
}

fn dbus_address_looks_valid(v: &str) -> bool {
    let first = v.split(';').next().unwrap_or("").trim();
    [
        "unix:",
        "tcp:",
        "nonce-tcp:",
        "unixexec:",
        "launchd:",
        "autolaunch:",
        "vsock:",
    ]
    .iter()
    .any(|t| first.starts_with(t) && first.len() > t.len())
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

/// What `sparkdown <first arg>` should print and exit with, for the flags that
/// must never open a window (#33): `--version`/`-V` and `--help`/`-h`. Only
/// the first argument counts, so a file that happens to be named `--help`
/// later on the command line still opens.
fn cli_info(first_arg: Option<&str>) -> Option<String> {
    let version = env!("CARGO_PKG_VERSION");
    match first_arg? {
        "--version" | "-V" => Some(format!("SparkDown {version}\n")),
        "--help" | "-h" => Some(format!(
            "SparkDown {version}: a Markdown editor and agent cockpit.\n\n\
             Usage:\n  \
             sparkdown [FILE|FOLDER]...   open files or a folder in the app\n                               (in the open window, if SparkDown is running)\n  \
             sparkdown --new-window FOLDER  open FOLDER in a new window (focuses it if already open)\n  \
             sparkdown --mcp-stdio        run the stdio MCP bridge for agent CLIs\n  \
             sparkdown --version, -V      print the version and exit\n  \
             sparkdown --help, -h         print this help and exit\n"
        )),
        _ => None,
    }
}

/// Release Windows builds use the GUI subsystem, which starts with no
/// console: attach to the parent's (the terminal that ran us) so `--version`
/// output shows there. Redirected output (a pipe or file) works without it.
#[cfg(windows)]
fn attach_parent_console() {
    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    // SAFETY: plain Win32 call with a constant argument; failure (no parent
    // console) just leaves output unattached.
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

fn main() {
    // ssh started us as its SSH_ASKPASS helper (#27): answer one key
    // passphrase prompt from the running app over the private IPC, then exit.
    // Before everything else: no window, no MCP, no single-instance logic.
    if askpass::is_helper_invocation() {
        std::process::exit(askpass::helper_main());
    }

    // `--version` / `--help`: print and exit before any window, single-instance
    // or MCP logic runs (#33).
    let first = std::env::args().nth(1);
    if let Some(text) = cli_info(first.as_deref()) {
        #[cfg(windows)]
        attach_parent_console();
        use std::io::Write;
        let mut out = std::io::stdout();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
        return;
    }

    // Agent MCP shim: when launched as `sparkdown --mcp-stdio` (by an agent
    // CLI that registered us as a stdio MCP server), act as that bridge and
    // never start the GUI. Must run before the Tauri builder.
    if std::env::args().any(|a| a == mcp::SHIM_FLAG) {
        mcp_stdio::run();
        return;
    }

    // Fallback lock (decision 1): without the single-instance plugin (a
    // malformed D-Bus address on Linux), a live core socket means SparkDown
    // already runs: hand it our args and exit, never a second GUI process.
    if !single_instance_supported() && forward_to_running_core() {
        return;
    }

    let mut builder = tauri::Builder::default();
    // #51: one SparkDown per user. A second `sparkdown <folder>` hands its
    // args and cwd to the running window and exits. Registered first, as the
    // plugin asks, so the second process exits before any other setup (MCP
    // socket, terminals, window).
    if single_instance_supported() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            on_second_instance(app, argv, cwd)
        }));
    }
    builder
        .manage(PendingFiles::default())
        .manage(HtmlPreview::default())
        .manage(commands::WriteRateLimiter::default())
        .manage(terminal::TerminalState::default())
        .manage(watcher::WatcherStates::default())
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
            app.manage(lifecycle::WindowMenu::new(app_menu.window_menu));
            // macOS: native menu bar (and traffic-light overlay title bar).
            // Windows/Linux: no in-window menu bar — the frontend pops this
            // menu from the toolbar app icon. Drop OS decorations so we draw
            // our own caption (icon + min/max/close).
            #[cfg(target_os = "macos")]
            {
                // AppKit owns the window list (#90); see lifecycle::refresh.
                let windows_menu = app.state::<lifecycle::WindowMenu>().submenu.clone();
                app.set_menu(app_menu.menu)?;
                windows_menu.set_as_windows_menu_for_nsapp()?;
            }
            #[cfg(not(target_os = "macos"))]
            {
                app.manage(menu::AppMenuHandle(app_menu.menu));
            }

            app.on_menu_event(move |app_handle, event| {
                let id = event.id().0.as_str();
                // Window-level actions are the core's (#65).
                if id.starts_with(lifecycle::NEW_WINDOW_ID) {
                    let app = app_handle.clone();
                    std::thread::spawn(move || {
                        let _ = lifecycle::new_window(&app);
                    });
                    return;
                }
                if let Some(label) = id.strip_prefix(lifecycle::FOCUS_PREFIX) {
                    routing::focus(app_handle, label);
                    return;
                }
                match windows::target_window(app_handle) {
                    Some(window) => {
                        // To this window only: `window.emit` would reach
                        // every window (#88).
                        let _ = app_handle.emit_to(window.label(), &format!("menu:{}", id), ());
                    }
                    // macOS with every window closed: Settings (or any
                    // action) opens in a new empty window (#60 decision 7).
                    None => {
                        let app = app_handle.clone();
                        let id = id.to_string();
                        std::thread::spawn(move || lifecycle::menu_in_new_window(&app, &id));
                    }
                }
            });

            let cli_files: Vec<String> = std::env::args().skip(1).collect();
            if !cli_files.is_empty() {
                let _ = app.state::<PendingFiles>().offer(cli_files);
            }

            // macOS: intercept dock/menu Quit so it runs the save prompt.
            #[cfg(target_os = "macos")]
            macos_quit::install(&handle);

            // One config writer in the core (#63); restore every window of
            // the last session (a 0.3.x config migrates to one window).
            let config_file = config::config_path(&handle).map_err(|e| e.to_string())?;
            if let Some(dir) = config_file.parent() {
                windows::init_token_secret(dir);
            }
            let store = session::ConfigStore::open(config_file);
            let plan = session::plan_restore(&store.stored());
            store.adopt(&plan);
            app.manage(store);
            for p in &plan {
                if let Some(f) = &p.session.folder {
                    let _ = windows::registry().set_folder(
                        &p.label,
                        Some(f.clone()),
                        p.session.display.clone(),
                    );
                }
                if let Err(e) = windows::create_window(&handle, &p.label, p.session.geometry, false)
                {
                    eprintln!("Warning: could not restore window {}: {e}", p.label);
                }
            }
            if let Some(w) = plan
                .iter()
                .find(|p| p.focus)
                .and_then(|p| handle.get_webview_window(&p.label))
            {
                let _ = w.set_focus();
                windows::registry().mark_focused(w.label());
            }
            lifecycle::refresh(&handle);

            mcp::set_forward_handler(Box::new(|app, argv, cwd| {
                on_second_instance(app, argv, cwd)
            }));

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
            if let Some(window) = windows::target_window(&handle) {
                window.open_devtools();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            windows::window_set_folder,
            windows::window_set_dirty,
            windows::windows_list,
            routing::route_folder,
            routing::window_take_open,
            routing::window_numbers_for,
            routing::window_set_remote_folder,
            lifecycle::quit_status,
            lifecycle::quit_prepare_others,
            lifecycle::quit_prepare_reply,
            lifecycle::quit_begin,
            lifecycle::quit_end,
            lifecycle::window_close,
            lifecycle::window_new,
            lifecycle::window_take_menu,
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
            terminal::tmux_window_sessions,
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
            terminal::terminal_busy,
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
            mcp::mcp_agent_status,
            context::detect_agents,
            remote::ssh_config_hosts,
            remote::remote_connect,
            askpass::askpass_answer,
            remote::hostkey::remote_hostkey_scan,
            remote::hostkey::remote_hostkey_trust,
            remote::hostkey::remote_hostkey_forget,
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
                windows::set_quitting();
                let _ = app.state::<session::ConfigStore>().flush();
                remote::shutdown();
                mcp::shutdown();
                return;
            }

            // Per-window bookkeeping (#61): focus order for routing, and
            // teardown of a destroyed window's terminals, remote session,
            // watcher and MCP snapshot.
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Focused(true),
                ..
            } = &event
            {
                let seq = {
                    let mut r = windows::registry();
                    r.mark_focused(label);
                    r.focus_seq(label)
                };
                app.state::<session::ConfigStore>().note_focus(label, seq);
                return;
            }
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_),
                ..
            } = &event
            {
                note_geometry(app, label);
                return;
            }
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                // A window the user closed is not restored; on quit every
                // window keeps its section.
                if !windows::is_quitting() {
                    app.state::<session::ConfigStore>().forget_window(label);
                }
                release_window(app, label);
                lifecycle::refresh(app);
                return;
            }

            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } = &event
            {
                api.prevent_close();
                lifecycle::on_close_requested(app, label);
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
                if code.is_some() {
                    windows::set_quitting();
                }
                if code.is_none() {
                    api.prevent_exit();
                    // ⌘Q can also arrive via applicationShouldTerminate:;
                    // the quit gate keeps it to one flow (#88).
                    lifecycle::request_quit(app);
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
                    // #89: show hidden windows, else restore the last
                    // closed one, else an empty window.
                    let app = app.clone();
                    std::thread::spawn(move || lifecycle::reopen(&app, false));
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
                if let Some(window) = windows::target_window(app) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }

                // Queued for a frontend that hasn't started, else routed
                // and sent to one window. Never both (#106).
                if let Some(paths) = app.state::<PendingFiles>().offer(paths) {
                    let app = app.clone();
                    std::thread::spawn(move || route_and_emit(&app, &paths, false));
                }
            }
        });
}

/// Remember a window's outer geometry for the next launch (in memory; the
/// next save or the quit writes it).
fn note_geometry(app: &tauri::AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else {
        return;
    };
    let maximized = w.is_maximized().unwrap_or(false);
    if maximized || w.is_minimized().unwrap_or(false) {
        // Keep the restored size; just flag maximized.
        if maximized {
            app.state::<session::ConfigStore>().note_maximized(label);
        }
        return;
    }
    // #112: save the inner size, the measure set_size restores (outer
    // position, the measure set_position restores). Saving the outer size
    // grew every window by its frame on each relaunch.
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else {
        return;
    };
    app.state::<session::ConfigStore>().note_geometry(
        label,
        session::Geometry {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            maximized: false,
        },
    );
}

/// Free everything a closed window owned. Runs off the event loop: closing
/// terminals and the SSH session can block.
fn release_window(app: &tauri::AppHandle, label: &str) {
    windows::registry().unregister(label);
    app.state::<Arc<mcp::McpState>>().release_window(label);
    let app = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        app.state::<terminal::TerminalState>()
            .release_window(&label);
        app.state::<watcher::WatcherStates>().release_window(&label);
        remote::release_window(&label);
        askpass::release_window(&label);
    });
}

#[cfg(test)]
mod tests {
    use super::PendingFiles;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn pending_queues_only_until_the_frontend_takes_it() {
        let p = PendingFiles::default();
        assert_eq!(p.offer(v(&["/cli/A"])), None, "before the take: queued");
        assert_eq!(p.take_startup(), v(&["/cli/A"]));
        // #106: an Apple Event (`open -a`, Open With) after the take is
        // routed, never also left in the app-wide queue.
        assert_eq!(p.offer(v(&["/x/A"])), Some(v(&["/x/A"])));
        assert!(
            p.paths.lock().unwrap().is_empty(),
            "nothing lingers in the queue"
        );
    }

    #[test]
    fn a_later_webview_start_gets_no_startup_paths() {
        // #106: B's webview reloaded (web-content process ended) or a new
        // window starting must not open A from the startup queue.
        let p = PendingFiles::default();
        let _ = p.offer(v(&["/cli/A"]));
        assert_eq!(p.take_startup(), v(&["/cli/A"]), "first frontend gets them");
        assert!(
            p.take_startup().is_empty(),
            "a reload or second window gets none"
        );
        // Even if something were queued behind the flag, a later start drops it.
        p.paths.lock().unwrap().push("/stale/A".into());
        assert!(p.take_startup().is_empty());
        assert!(p.paths.lock().unwrap().is_empty());
    }

    #[test]
    fn pending_queue_is_capped() {
        let p = PendingFiles::default();
        let many: Vec<String> = (0..150).map(|i| format!("/f{i}")).collect();
        assert_eq!(p.offer(many), None);
        assert_eq!(p.take_startup().len(), super::MAX_PENDING_FILES);
    }

    #[test]
    fn no_path_is_both_queued_and_emitted() {
        // The macOS Opened handler used to emit AND queue every path.
        let src = include_str!("main.rs");
        let opened = &src[src.find("RunEvent::Opened { urls }").unwrap()..];
        let opened = &opened[..opened.find("\n    });").unwrap_or(opened.len()).min(2500)];
        assert!(
            !opened.contains("push_pending"),
            "Opened must not queue after the take"
        );
        assert!(opened.contains(".offer("));
    }

    #[test]
    fn second_launch_paths_resolve_against_its_own_cwd() {
        // #51: `sparkdown .` / `sparkdown notes` from another directory.
        #[cfg(unix)]
        {
            let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
            assert_eq!(
                super::forwarded_paths(&argv(&["sparkdown", "."]), "/home/u/proj"),
                vec!["/home/u/proj"]
            );
            assert_eq!(
                super::forwarded_paths(&argv(&["sparkdown", "notes", "a.md"]), "/home/u"),
                vec!["/home/u/notes", "/home/u/a.md"]
            );
            assert_eq!(
                super::forwarded_paths(&argv(&["/usr/bin/sparkdown", "/tmp/x/"]), "/home/u"),
                vec!["/tmp/x"]
            );
            // Flags are not paths; a bare launch forwards nothing.
            assert!(super::forwarded_paths(&argv(&["sparkdown", "--foo"]), "/h").is_empty());
            assert!(super::forwarded_paths(&argv(&["sparkdown"]), "/h").is_empty());
            assert_eq!(
                super::forwarded_paths(&argv(&["sparkdown", "/"]), "/h"),
                vec!["/"]
            );
        }
        #[cfg(windows)]
        {
            let argv = vec!["sparkdown.exe".to_string(), "notes".to_string()];
            assert_eq!(
                super::forwarded_paths(&argv, r"C:\Users\u"),
                vec![r"C:\Users\u\notes".to_string()]
            );
        }
    }

    #[test]
    fn dbus_address_guard() {
        assert!(super::dbus_address_looks_valid(
            "unix:path=/run/user/1000/bus"
        ));
        assert!(super::dbus_address_looks_valid(
            "unix:abstract=/tmp/dbus-x,guid=1;tcp:host=x"
        ));
        assert!(!super::dbus_address_looks_valid(""));
        assert!(!super::dbus_address_looks_valid("garbage"));
        assert!(!super::dbus_address_looks_valid("unix:"));
    }

    #[test]
    fn version_and_help_flags_print_instead_of_opening_the_app() {
        let v = super::cli_info(Some("--version")).unwrap();
        assert_eq!(v, format!("SparkDown {}\n", env!("CARGO_PKG_VERSION")));
        assert_eq!(super::cli_info(Some("-V")), Some(v));
        let help = super::cli_info(Some("--help")).unwrap();
        assert!(
            help.contains("--mcp-stdio") && help.contains("--version"),
            "{help}"
        );
        assert_eq!(super::cli_info(Some("-h")), Some(help));
        // Anything else (files, folders, the MCP flag, nothing) is not ours.
        for other in [
            None,
            Some("notes.md"),
            Some("--mcp-stdio"),
            Some("-psn_0_1"),
        ] {
            assert_eq!(super::cli_info(other), None, "{other:?}");
        }
    }

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
