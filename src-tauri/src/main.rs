// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod askpass;
mod cli;
mod cli_install;
mod commands;
mod config;
mod context;
mod file_index;
mod fsio;
mod git;
mod git_write;
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

/// A second launch (#51): bring the window forward and open its paths here.
fn on_second_instance(app: &tauri::AppHandle, argv: Vec<String>, cwd: String) {
    open_forwarded_argv(app, argv, cwd, cli::wants_new_window);
}

/// Shared entry for single-instance forwards and macOS `RunEvent::Opened`
/// paths once converted to argv-equivalent absolute paths (#160 decision 4).
fn open_forwarded_paths(app: &tauri::AppHandle, paths: Vec<String>, new_window: bool) {
    eprintln!("another launch handed over {} path(s)", paths.len());
    if paths.is_empty() {
        if let Some(window) = windows::target_window(app) {
            routing::focus(app, window.label());
        }
        return;
    }
    if let Some(paths) = app.state::<PendingFiles>().offer(paths) {
        let app = app.clone();
        std::thread::spawn(move || route_and_emit(&app, &paths, new_window));
    }
}

fn open_forwarded_argv(
    app: &tauri::AppHandle,
    argv: Vec<String>,
    cwd: String,
    new_window_flag: fn(&[String]) -> bool,
) {
    let new_window = new_window_flag(&argv);
    let paths = cli::forwarded_paths(&argv, &cwd);
    open_forwarded_paths(app, paths, new_window);
}

/// The effective uid of this process.
#[cfg(unix)]
fn our_uid() -> u32 {
    // SAFETY: geteuid() has no arguments and cannot fail.
    unsafe { libc::geteuid() }
}

/// Decide whether a socket peer may receive the forwarded command line: its
/// uid must have been read successfully and equal ours. A lookup error is
/// a refusal.
#[cfg(unix)]
fn peer_uid_allowed(peer: std::io::Result<u32>, ours: u32) -> bool {
    matches!(peer, Ok(uid) if uid == ours)
}

/// The uid of the process at the other end of `stream` (Linux: SO_PEERCRED).
#[cfg(all(unix, target_os = "linux"))]
fn peer_uid(stream: &std::os::unix::net::UnixStream) -> std::io::Result<u32> {
    use std::os::unix::io::AsRawFd;

    #[repr(C)]
    struct Ucred {
        pid: libc::pid_t,
        uid: libc::uid_t,
        gid: libc::gid_t,
    }

    let mut ucred = Ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut size = std::mem::size_of::<Ucred>() as libc::socklen_t;
    // SAFETY: the buffer and its size match what SO_PEERCRED writes.
    let ret = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut ucred as *mut Ucred as *mut libc::c_void,
            &mut size,
        )
    };
    if ret != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(ucred.uid)
}

/// The uid of the process at the other end of `stream` (macOS: getpeereid).
#[cfg(all(unix, target_os = "macos"))]
fn peer_uid(stream: &std::os::unix::net::UnixStream) -> std::io::Result<u32> {
    use std::os::unix::io::AsRawFd;
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: both out-pointers are valid for the call.
    let ret = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    if ret != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(uid)
}

/// Other Unix systems have no peer-credential call wired up here: the
/// socket directory's 0700 mode is the only check, so report our own uid.
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn peer_uid(_stream: &std::os::unix::net::UnixStream) -> std::io::Result<u32> {
    Ok(our_uid())
}

/// Whether the reply to a forwarded command line is a well-formed
/// `{"sparkdown_ack":{"ok":true}}`. Anything else (empty, not JSON, no ack
/// object, `ok` missing or not `true`) counts as "not handed over".
#[cfg(unix)]
fn forward_ack_ok(reply: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(reply) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text.trim()) else {
        return false;
    };
    value
        .get("sparkdown_ack")
        .and_then(|ack| ack.get("ok"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

/// Hand argv + cwd to a running SparkDown over its core socket. True when
/// one took them.
#[cfg(unix)]
fn forward_to_running_core() -> bool {
    let Some(path) = mcp::mcp_socket_path() else {
        return false;
    };
    if let Some(dir) = path.parent() {
        if mcp::ensure_socket_dir(dir).is_err() {
            return false;
        }
    }
    let Ok(s) = std::os::unix::net::UnixStream::connect(&path) else {
        return false;
    };
    // The running instance refuses forwards that lack its per-launch nonce;
    // we read it from the file it placed next to the socket. The read
    // succeeds only for the owning user.
    let Some(nonce) = mcp::read_forward_nonce() else {
        return false;
    };
    forward_over(s, our_uid(), &nonce)
}

/// Send argv + cwd over `s` and wait for the ack, provided the process at
/// the other end runs as `ours`. Returns true only for a well-formed ack.
#[cfg(unix)]
fn forward_over(mut s: std::os::unix::net::UnixStream, ours: u32, nonce: &str) -> bool {
    use std::io::{Read, Write};
    if !peer_uid_allowed(peer_uid(&s), ours) {
        return false;
    }
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let argv: Vec<String> = std::env::args().collect();
    let msg = mcp::forward_message(&argv, &cwd, nonce);
    if writeln!(s, "{msg}").is_err() {
        return false;
    }
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let mut buf = [0u8; 512];
    match s.read(&mut buf) {
        Ok(n) if n > 0 => forward_ack_ok(&buf[..n]),
        _ => false,
    }
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

/// Path of the lock file that serializes the D-Bus-fallback first instance
/// before the MCP socket exists (#160).
#[cfg(unix)]
fn fallback_instance_lock_path() -> Option<std::path::PathBuf> {
    mcp::mcp_socket_path().map(|p| p.with_extension("instance.lock"))
}

/// Result of trying to claim the fallback instance lock.
#[cfg(unix)]
enum LockResult {
    Claimed(std::fs::File),
    Held,
    Failed,
}

/// Exclusive non-blocking flock. Returns the lock holder when successful,
/// `Held` when another process holds it, or `Failed` when the folder check fails.
#[cfg(unix)]
fn try_claim_fallback_lock() -> LockResult {
    use std::os::unix::io::AsRawFd;
    let Some(path) = fallback_instance_lock_path() else {
        return LockResult::Failed;
    };
    // Create the base recursively and harden the leaf with the same ownership
    // check used by `mcp::start`, so a fresh HOME with no ~/.cache works.
    if let Some(dir) = path.parent() {
        if mcp::ensure_socket_dir(dir).is_err() {
            return LockResult::Failed;
        }
    }
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        match std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
        {
            Ok(f) => f,
            Err(_) => return LockResult::Failed,
        }
    };
    let ok = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 };
    if ok {
        LockResult::Claimed(file)
    } else {
        LockResult::Held
    }
}

#[cfg(unix)]
fn hold_fallback_lock(file: std::fs::File) {
    use std::sync::Mutex;
    static HOLD: Mutex<Option<std::fs::File>> = Mutex::new(None);
    *HOLD.lock().unwrap_or_else(|e| e.into_inner()) = Some(file);
}

/// Retry forwarding over the core socket while the first instance is still
/// starting (socket not listening yet).
fn forward_with_retry(budget: std::time::Duration) -> bool {
    let start = std::time::Instant::now();
    let mut delay = std::time::Duration::from_millis(50);
    while start.elapsed() < budget {
        if forward_to_running_core() {
            return true;
        }
        std::thread::sleep(delay);
        delay = (delay * 2).min(std::time::Duration::from_millis(400));
    }
    false
}

/// Without the single-instance plugin: forward to a running/starting app, or
/// claim the fallback lock and become the primary (#160 D-Bus race).
fn fallback_single_instance_or_forward() -> bool {
    if forward_to_running_core() {
        return true;
    }
    #[cfg(unix)]
    {
        match try_claim_fallback_lock() {
            LockResult::Claimed(lock) => {
                hold_fallback_lock(lock);
                return false; // we are primary
            }
            LockResult::Failed => {
                // Folder check failed (no per-user base, or not owned by us):
                // skip the socket entirely, start normally.
                return false;
            }
            LockResult::Held => {
                // Another process holds the lock: fall through to wait.
            }
        }
        // Another process holds the lock (starting or running): wait for its
        // socket and forward, never a second GUI.
        if forward_with_retry(std::time::Duration::from_secs(12)) {
            return true;
        }
        // Lock holder vanished without a socket: try to take over.
        if let LockResult::Claimed(lock) = try_claim_fallback_lock() {
            hold_fallback_lock(lock);
            return false;
        }
        // Still contested: one last forward attempt, else start (rare).
        forward_with_retry(std::time::Duration::from_secs(2))
    }
    #[cfg(not(unix))]
    {
        false
    }
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
    if let Some(text) = cli::cli_info(first.as_deref()) {
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

    // Detach on first launch so the terminal is free (#160 decision 1).
    // `--wait`, the Windows shim, and an already-detached child skip this.
    let argv_all: Vec<String> = std::env::args().collect();
    if cli::should_detach(&argv_all) {
        match proc::spawn_detached_self(&argv_all) {
            Ok(()) => return,
            Err(e) => eprintln!("Warning: could not detach from terminal: {e}"),
        }
    }

    // Fallback lock (#160): without the single-instance plugin (a malformed
    // D-Bus address on Linux), forward to a running/starting instance, or
    // claim the instance lock before the MCP socket exists so a second
    // launch during startup cannot open another GUI.
    if !single_instance_supported() && fallback_single_instance_or_forward() {
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
            app.manage(menu::CloseFolderItem(app_menu.close_folder.clone()));
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
                // PATH install/repair (#160): no window required.
                if matches!(id, "cli-install" | "cli-uninstall" | "cli-repair") {
                    let app = app_handle.clone();
                    let id = id.to_string();
                    std::thread::spawn(move || handle_cli_install_menu(&app, &id));
                    return;
                }
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

            let argv: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let cli_files = cli::forwarded_paths(&argv, &cwd);
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
            lifecycle::window_close_status,
            lifecycle::window_close_folder,
            lifecycle::window_take_menu,
            commands::read_file,
            commands::write_file,
            commands::append_crash_log,
            commands::is_directory,
            commands::copy_text,
            commands::read_clipboard_text,
            commands::copy_file,
            commands::delete_path,
            commands::create_entry,
            commands::reveal_path,
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
            terminal::tmux_wheel,
            watcher::watch_start,
            watcher::watch_stop,
            git::git_status,
            git::git_branch_status,
            git::git_diff_file,
            git_write::git_commit,
            git_write::git_pull,
            git_write::git_push,
            git_write::git_fetch,
            git_write::git_discard_preview,
            git_write::git_discard,
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
                lifecycle::sync_close_folder_item(app);
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

                // Same path as single-instance (#160 decision 4 / #106).
                open_forwarded_paths(app, paths, false);
            }
        });
}

/// SparkDown → Install/Uninstall/Repair 'sparkdown' Command (#160).
fn handle_cli_install_menu(app: &tauri::AppHandle, id: &str) {
    let Some(target) = cli_install::running_cli_target() else {
        eprintln!("cli install: no target binary for this package");
        return;
    };
    let dirs = cli_install::user_bin_dirs();
    let msg = match id {
        "cli-install" => match cli_install::install(&dirs, &target) {
            Ok(link) => format!("Installed sparkdown → {}", link.display()),
            Err(e) => format!("Could not install sparkdown: {e}"),
        },
        "cli-uninstall" => match cli_install::uninstall(&dirs, &target) {
            Ok(()) => "Removed the sparkdown command from PATH.".into(),
            Err(e) => format!("Could not uninstall sparkdown: {e}"),
        },
        "cli-repair" => match cli_install::repair(&dirs, &target) {
            Ok(link) => format!("Repaired sparkdown → {}", link.display()),
            Err(e) => format!("Could not repair sparkdown: {e}"),
        },
        _ => return,
    };
    eprintln!("{msg}");
    // Best-effort UI notice when a window exists.
    if let Some(window) = windows::target_window(app) {
        let _ = app.emit_to(window.label(), "cli-install-status", msg);
    }
}

/// Remember a window's outer geometry for the next launch (in memory; the
/// next save or the quit writes it).
fn note_geometry(app: &tauri::AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else {
        return;
    };
    let maximized = w.is_maximized().unwrap_or(false);
    let minimized = w.is_minimized().unwrap_or(false);
    // #112: save the inner size, the measure set_size restores (outer
    // position, the measure set_position restores). Saving the outer size
    // grew every window by its frame on each relaunch.
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else {
        if maximized {
            app.state::<session::ConfigStore>().note_maximized(label);
        }
        return;
    };
    app.state::<session::ConfigStore>().observe_geometry(
        label,
        maximized,
        minimized,
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

    #[cfg(all(unix, not(target_os = "macos")))]
    struct EnvGuard {
        home: Option<std::ffi::OsString>,
        xdg: Option<std::ffi::OsString>,
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    impl EnvGuard {
        fn new() -> Self {
            Self {
                home: std::env::var_os("HOME"),
                xdg: std::env::var_os("XDG_RUNTIME_DIR"),
            }
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(ref h) = self.home {
                std::env::set_var("HOME", h);
            } else {
                std::env::remove_var("HOME");
            }
            if let Some(ref x) = self.xdg {
                std::env::set_var("XDG_RUNTIME_DIR", x);
            } else {
                std::env::remove_var("XDG_RUNTIME_DIR");
            }
        }
    }

    #[test]
    #[cfg(all(unix, not(target_os = "macos")))]
    #[serial_test::serial]
    fn lock_wait_skipped_on_folder_check_failure() {
        use super::{fallback_instance_lock_path, try_claim_fallback_lock, LockResult};

        let _guard = EnvGuard::new();
        std::env::remove_var("XDG_RUNTIME_DIR");
        std::env::remove_var("HOME");

        let start = std::time::Instant::now();
        let result = try_claim_fallback_lock();
        let elapsed = start.elapsed();

        assert!(
            matches!(result, LockResult::Failed),
            "lock returns Failed when no per-user base is available"
        );
        assert!(
            elapsed.as_secs() < 1,
            "lock check completes quickly without waiting ({}s)",
            elapsed.as_secs()
        );
        assert!(
            fallback_instance_lock_path().is_none(),
            "lock path is None when no per-user base is available"
        );
    }

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
        // Shared with single-instance (#160 decision 4).
        assert!(
            opened.contains("open_forwarded_paths("),
            "Opened must use the shared open path"
        );
    }

    #[test]
    fn opened_and_second_instance_share_one_open_path() {
        // #160 decision 4: both routes call open_forwarded_paths → route_and_emit.
        let src = include_str!("main.rs");
        assert!(src.contains("fn open_forwarded_paths("));
        assert!(
            src.contains("open_forwarded_argv(app, argv, cwd, cli::wants_new_window)"),
            "single-instance must use the shared open path"
        );
        assert!(
            src.contains("open_forwarded_paths(app, paths, false)"),
            "Opened must call open_forwarded_paths"
        );
        assert!(
            src.contains("route_and_emit(&app, &paths, new_window)"),
            "shared open must route_and_emit"
        );
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
        assert!(
            hooks.contains("NSIS_HOOK_POSTINSTALL")
                && hooks.contains("SdAppendUserPath")
                && hooks.contains("un.SdRemoveUserPath")
                && hooks.contains("SdInstallPathShim")
                && !hooks
                    .lines()
                    .any(|l| l.trim_start().starts_with("${un.StrLoc}"))
                && !hooks.contains("!define MUI_FINISHPAGE_SHOWREADME"),
            "PATH hooks (#160): un.SdRemoveUserPath without StrFunc/SHOWREADME defines"
        );
        assert!(
            hooks.contains(r"$INSTDIR\bin")
                && hooks.contains("sparkdown-shim.exe")
                && hooks.contains(r"bin\sparkdown.exe"),
            "PATH must use $INSTDIR\\bin\\sparkdown.exe (Windows case-safe, #160)"
        );
        assert!(
            hooks.contains("/SDNOPATH") && hooks.contains("SdAppendUserPath"),
            "PATH default-on in POSTINSTALL with /SDNOPATH opt-out (#160); Finish SHOWREADME is owned by Tauri desktop shortcut"
        );
        let package_ps1 =
            std::fs::read_to_string(dir.join("../scripts/package-windows.ps1")).unwrap();
        assert!(
            package_ps1.contains("binaries/sparkdown-shim"),
            "package-windows.ps1 must externalBin sparkdown-shim (#160)"
        );
        // Reject the case-colliding name (sparkdown next to SparkDown.exe).
        let colliding = "binaries/sparkdown";
        let safe = "binaries/sparkdown-shim";
        assert!(
            package_ps1.contains(safe)
                && package_ps1
                    .match_indices(colliding)
                    .all(|(i, _)| package_ps1[i..].starts_with(safe)),
            "externalBin must not use binaries/sparkdown without -shim (#160)"
        );
    }

    #[test]
    fn bump_cask_and_launcher_resource_for_cli_path() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let script = std::fs::read_to_string(dir.join("../scripts/bump-cask.sh")).unwrap();
        assert!(
            script.contains("Contents/Resources/bin/sparkdown") && script.contains("binary "),
            "bump-cask.sh must ensure the cask binary stanza (#160)"
        );
        assert!(
            dir.join("resources/bin/sparkdown").is_file(),
            "macOS launcher must ship as Contents/Resources/bin/sparkdown"
        );
        let conf: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("tauri.conf.json")).unwrap())
                .unwrap();
        let resources = conf["bundle"]["resources"].as_array().unwrap();
        assert!(
            resources
                .iter()
                .any(|r| r.as_str() == Some("resources/bin/sparkdown")),
            "tauri.conf.json must bundle the macOS launcher"
        );
    }

    #[test]
    #[cfg(unix)]
    fn peer_uid_decision_accepts_only_our_uid() {
        assert!(super::peer_uid_allowed(Ok(1000), 1000), "same uid");
        assert!(!super::peer_uid_allowed(Ok(1001), 1000), "different uid");
        assert!(!super::peer_uid_allowed(Ok(0), 1000), "root is not us");
        assert!(
            !super::peer_uid_allowed(Ok(1000), 0),
            "we are root, peer is not"
        );
        assert!(super::peer_uid_allowed(Ok(0), 0), "root talking to root");
        let lookup_error = Err(std::io::Error::other("getsockopt failed"));
        assert!(
            !super::peer_uid_allowed(lookup_error, 1000),
            "a failed lookup is a refusal"
        );
    }

    /// Both ends of a real socket pair belong to this user, so the real
    /// lookup reports our own uid.
    #[test]
    #[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
    fn peer_uid_of_a_real_socket_is_our_uid() {
        let (a, b) = std::os::unix::net::UnixStream::pair().unwrap();
        assert_eq!(super::peer_uid(&a).unwrap(), super::our_uid());
        assert_eq!(super::peer_uid(&b).unwrap(), super::our_uid());
    }

    /// Run `forward_over` against a server thread that replies with `reply`.
    /// Returns (result, bytes the server received).
    #[cfg(unix)]
    fn forward_with(reply: &'static str, ours: u32) -> (bool, Vec<u8>) {
        const NONCE: &str = "test-nonce-0123";
        use std::io::{Read, Write};
        let (client, mut server) = std::os::unix::net::UnixStream::pair().unwrap();
        let handle = std::thread::spawn(move || {
            let mut got = Vec::new();
            let mut byte = [0u8; 1];
            // One request line, or EOF when the client sent nothing.
            while let Ok(1) = server.read(&mut byte) {
                got.push(byte[0]);
                if byte[0] == b'\n' {
                    let _ = server.write_all(reply.as_bytes());
                    break;
                }
            }
            got
        });
        let result = super::forward_over(client, ours, NONCE);
        (result, handle.join().unwrap())
    }

    #[test]
    #[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
    fn forward_over_hands_over_to_a_peer_with_our_uid() {
        let (ok, request) = forward_with("{\"sparkdown_ack\":{\"ok\":true}}\n", super::our_uid());
        assert!(ok);
        let text = String::from_utf8(request).unwrap();
        assert!(text.contains("sparkdown_forward"), "{text}");
        assert!(text.contains("test-nonce-0123"), "nonce is sent: {text}");
    }

    /// A peer running as another uid never receives the command line.
    #[test]
    #[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
    fn forward_over_refuses_a_peer_with_another_uid_without_sending() {
        let other = super::our_uid().wrapping_add(1);
        let (ok, request) = forward_with("{\"sparkdown_ack\":{\"ok\":true}}\n", other);
        assert!(!ok);
        assert!(request.is_empty(), "nothing was sent: {request:?}");
    }

    #[test]
    #[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
    fn forward_over_needs_a_well_formed_ack() {
        let ours = super::our_uid();
        for reply in ["{\"sparkdown_ack\":{\"ok\":false}}\n", "ok\n", "{}\n"] {
            let (ok, _) = forward_with(reply, ours);
            assert!(!ok, "{reply:?}");
        }
    }

    #[test]
    #[cfg(unix)]
    fn forward_ack_accepts_only_ok_true() {
        let ok = |s: &str| super::forward_ack_ok(s.as_bytes());
        assert!(ok(r#"{"sparkdown_ack":{"ok":true}}"#));
        assert!(
            ok("{\"sparkdown_ack\":{\"ok\":true}}\n"),
            "trailing newline"
        );
        assert!(
            ok(r#"{"sparkdown_ack":{"ok":true,"secret":"x"}}"#),
            "extra fields"
        );
        assert!(!ok(r#"{"sparkdown_ack":{"ok":false}}"#), "ok false");
        assert!(
            !ok(r#"{"sparkdown_ack":{"ok":false,"error":"no"}}"#),
            "refused"
        );
        assert!(!ok(r#"{"sparkdown_ack":{}}"#), "ok missing");
        assert!(!ok(r#"{"sparkdown_ack":{"ok":"true"}}"#), "ok is a string");
        assert!(!ok(r#"{"sparkdown_ack":{"ok":1}}"#), "ok is a number");
        assert!(!ok(r#"{"sparkdown_ack":null}"#), "ack is null");
        assert!(!ok(r#"{"sparkdown_ack":true}"#), "ack is not an object");
        assert!(!ok(r#"{"ok":true}"#), "ok outside the ack");
        assert!(!ok(r#"{"other":{"ok":true}}"#), "no ack key");
        assert!(!ok("[]"), "wrong shape");
        assert!(!ok("true"), "bare value");
        assert!(!ok("not json"), "malformed");
        assert!(!ok(r#"{"sparkdown_ack":{"ok":true}"#), "truncated");
        assert!(!ok(""), "empty");
        assert!(!super::forward_ack_ok(&[0xff, 0xfe, 0x7b]), "invalid utf-8");
    }
}
