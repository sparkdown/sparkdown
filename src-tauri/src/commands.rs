use crate::config::{self, AppConfig};
use crate::menu::AppMenuHandle;
use crate::PendingFiles;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use thiserror::Error;

/// Guards Linux/Windows brand-menu popups against re-entry.
///
/// muda 0.20 (pulled in by tauri 2.12 / #171) holds `Menu.platform`'s
/// `RefCell` borrow across GTK's nested `main_iteration` loop in
/// `show_context_menu_for_gtk_window` (`muda` `items/menu.rs:601`). A second
/// `popup_menu_at` while the first is still open panics with
/// `RefCell already borrowed` (E2E P0, 2026-10-02 tip AppImage).
static APP_MENU_POPUP_OPEN: AtomicBool = AtomicBool::new(false);

/// Application error type for all Tauri commands. Serialized as a plain string
/// to the frontend so error messages are human-readable in dialogs.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Invalid path: {0}")]
    InvalidPath(String),
    #[error("File too large ({size_mb} MB). Maximum supported size is {max_mb} MB.")]
    FileTooLarge { size_mb: u64, max_mb: u64 },
    #[error("Rate limit exceeded, please try again shortly")]
    RateLimited,
    #[error("Config error: {0}")]
    Config(String),
    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// A single entry in a directory listing, returned by [`list_directory`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    /// The file or directory name (not full path).
    pub name: String,
    /// The absolute path to this entry.
    pub path: String,
    /// Whether this entry is a directory (including symlinks to directories).
    pub is_dir: bool,
}

/// Maximum file size: 50 MB
const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;

/// Minimum interval between write operations to the SAME path (milliseconds).
const MIN_WRITE_INTERVAL_MS: u64 = 50;

/// How long a path's last-write time is remembered. Bounds the map: a path not
/// written within this window is forgotten (and would pass the next check).
const RATE_LIMIT_RETAIN_MS: u64 = 1_000;

/// Per-path rate limiter for write operations. Enforces a minimum interval
/// between consecutive writes to the SAME file, so runaway saves of one
/// document can't flood disk I/O — while a legitimate save of a different file
/// (e.g. a user save right after an export or perf-trace write) is never
/// wrongly rejected. Managed as Tauri state; injected into [`write_file`].
pub struct WriteRateLimiter {
    last_write_ms: Mutex<HashMap<PathBuf, u64>>,
}

impl Default for WriteRateLimiter {
    fn default() -> Self {
        Self {
            last_write_ms: Mutex::new(HashMap::new()),
        }
    }
}

impl WriteRateLimiter {
    fn check(&self, path: &Path) -> Result<(), AppError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        // A poisoned lock still leaves usable data; recover rather than fail
        // a save.
        let mut map = self
            .last_write_ms
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Keep the map bounded: drop paths untouched within the window.
        map.retain(|_, &mut last| now.saturating_sub(last) < RATE_LIMIT_RETAIN_MS);
        if let Some(&last) = map.get(path) {
            if now.saturating_sub(last) < MIN_WRITE_INTERVAL_MS {
                return Err(AppError::RateLimited);
            }
        }
        map.insert(path.to_path_buf(), now);
        Ok(())
    }
}

/// Validates and canonicalizes a file path to prevent directory traversal attacks.
/// Returns the canonical absolute path if valid.
pub(crate) fn validate_path(path: &str) -> Result<PathBuf, AppError> {
    let path = Path::new(path);

    // Canonicalize to resolve .. and symlinks, which also validates existence
    let canonical = path.canonicalize().map_err(|_| {
        AppError::InvalidPath(format!("Invalid or inaccessible path: {}", path.display()))
    })?;

    Ok(canonical)
}

/// Validates a path for write operations. Unlike validate_path, this allows
/// non-existent files (for "Save As") but still validates the parent directory.
fn validate_write_path(path: &str) -> Result<PathBuf, AppError> {
    let path = Path::new(path);

    // If file exists, canonicalize it
    if path.exists() {
        return validate_path(
            path.to_str()
                .ok_or_else(|| AppError::InvalidPath("Invalid UTF-8 in path".into()))?,
        );
    }

    // For new files, validate the parent directory exists and is accessible
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidPath("No parent directory".into()))?;

    if !parent.exists() {
        return Err(AppError::InvalidPath(format!(
            "Parent directory does not exist: {}",
            parent.display()
        )));
    }

    let canonical_parent = parent.canonicalize().map_err(|_| {
        AppError::InvalidPath(format!(
            "Cannot access parent directory: {}",
            parent.display()
        ))
    })?;

    // Reconstruct the full path with canonical parent + filename
    let filename = path
        .file_name()
        .ok_or_else(|| AppError::InvalidPath("No filename".into()))?;

    Ok(canonical_parent.join(filename))
}

/// Read a file's contents as UTF-8. Validates the path to prevent directory
/// traversal and rejects files larger than 50 MB to prevent memory exhaustion.
///
/// Opening a file also grants the asset protocol read access to that file's
/// directory (recursively), so the markdown preview can load images referenced
/// relative to it. The asset scope ships empty (see tauri.conf.json) and is
/// widened only here and in [`list_directory`]: an injected webview script
/// therefore cannot reach arbitrary files on disk via `asset:` URLs.
///
/// `async` + `spawn_blocking`: a synchronous `#[tauri::command]` runs on the
/// main thread in Tauri 2, so when a remote session is active the (blocking)
/// ssh round trip would freeze the UI — potentially for minutes on a
/// half-open connection. The frontend already `invoke`s this asynchronously.
#[tauri::command]
pub async fn read_file(app: AppHandle, path: String) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        if crate::remote::is_active() {
            return crate::remote::read_file(&path);
        }
        let (contents, safe_path) = read_local_file(&path)?;
        if let Some(parent) = safe_path.parent() {
            let _ = app.asset_protocol_scope().allow_directory(parent, true);
        }
        Ok(contents)
    })
    .await
    .map_err(|e| AppError::Other(format!("read task failed: {e}")))?
}

/// Validate, size-check and read a local file, returning its text and the
/// canonical path. Split out from [`read_file`] so the read logic is testable
/// without a Tauri `AppHandle`.
fn read_local_file(path: &str) -> Result<(String, PathBuf), AppError> {
    let safe_path = validate_path(path)?;

    let metadata = fs::metadata(&safe_path)?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(AppError::FileTooLarge {
            size_mb: metadata.len() / 1024 / 1024,
            max_mb: MAX_FILE_SIZE / 1024 / 1024,
        });
    }

    let contents = fs::read_to_string(&safe_path)?;
    Ok((contents, safe_path))
}

/// Append one frontend crash-log entry to `<app log dir>/crash-YYYY-MM-DD.log`.
/// Owned by the backend so the path is always the platform log directory —
/// the old frontend version wrote a *relative* path through `write_file`,
/// which resolved to the process cwd (`/` when launched from Finder) and,
/// during a remote session, to the remote host. Capped at 256 KB per file
/// so a crash loop cannot fill the disk.
#[tauri::command]
pub fn append_crash_log(app_handle: AppHandle, entry: String) -> Result<(), AppError> {
    const MAX_LOG_BYTES: u64 = 256 * 1024;
    let dir = app_handle
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Config(e.to_string()))?;
    fs::create_dir_all(&dir)?;
    let date = chrono_date_utc();
    let path = dir.join(format!("crash-{date}.log"));
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() >= MAX_LOG_BYTES {
            return Ok(());
        }
    }
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    f.write_all(entry.as_bytes())?;
    Ok(())
}

/// `YYYY-MM-DD` in UTC without pulling in a date crate: civil-from-days
/// (Howard Hinnant's algorithm) over the Unix epoch.
fn chrono_date_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Whether `path` points at a directory. Used to route OS drag-and-drop:
/// dropped directories become the sidebar root, files open as tabs.
#[tauri::command]
pub async fn is_directory(path: String) -> bool {
    // Off the main thread: on a remote session this is a blocking ssh call.
    tauri::async_runtime::spawn_blocking(move || is_directory_impl(&path))
        .await
        .unwrap_or(false)
}

fn is_directory_impl(path: &str) -> bool {
    if crate::remote::is_active() {
        return crate::remote::is_directory(path);
    }
    // Validation here would reject non-existent paths, but this function
    // intentionally returns false for those (not an error), so use direct check
    Path::new(path).is_dir()
}

/// Copy plain text to the system clipboard (file name / path menu actions).
#[tauri::command]
pub fn copy_text(text: String) -> Result<(), AppError> {
    set_clipboard_text(&text)
}

/// Copy a file reference to the clipboard so it can be pasted into Finder /
/// other apps as the actual file. macOS only (uses native NSPasteboard API);
/// elsewhere falls back to copying the path as text.
#[tauri::command]
pub fn copy_file(path: String) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        copy_file_macos(&path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        set_clipboard_text(&path)
    }
}

#[cfg(target_os = "macos")]
fn copy_file_macos(path: &str) -> Result<(), AppError> {
    let path_obj = Path::new(path);
    if !path_obj.exists() {
        return Err(AppError::InvalidPath(format!(
            "File does not exist: {}",
            path
        )));
    }

    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg("on run argv")
        .arg("-e")
        .arg("  set the clipboard to (POSIX file (item 1 of argv))")
        .arg("-e")
        .arg("end run")
        .arg(path)
        .status()?;

    if !status.success() {
        return Err(AppError::Other("Failed to copy file to clipboard".into()));
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn set_clipboard_text(text: &str) -> Result<(), AppError> {
    use std::io::Write;
    let mut child = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .ok_or_else(|| AppError::Other("no pbcopy stdin".into()))?
        .write_all(text.as_bytes())?;
    child.wait()?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn set_clipboard_text(_text: &str) -> Result<(), AppError> {
    Err(AppError::Other(
        "clipboard not supported on this platform".into(),
    ))
}

/// Write content to a file. Validates the path and enforces a per-path rate
/// limit (50 ms minimum between writes to the same file) to prevent runaway
/// saves. The replace is atomic (see fsio.rs).
#[tauri::command]
pub async fn write_file(
    limiter: State<'_, WriteRateLimiter>,
    path: String,
    content: String,
) -> Result<(), AppError> {
    // Rate-limit check is cheap and stays on the calling thread; the blocking
    // write (local atomic replace, or a remote ssh round trip) goes to the
    // blocking pool so a remote save can't freeze the main thread.
    limiter.check(Path::new(&path))?;
    tauri::async_runtime::spawn_blocking(move || write_file_impl(&path, &content))
        .await
        .map_err(|e| AppError::Other(format!("write task failed: {e}")))?
}

fn write_file_impl(path: &str, content: &str) -> Result<(), AppError> {
    if crate::remote::is_active() {
        return crate::remote::write_file(path, content);
    }
    // validate_write_path already requires the parent directory to exist (it
    // errors otherwise), so no create_dir_all is needed here.
    let safe_path = validate_write_path(path)?;

    // Temp file + fsync + rename: a crash mid-save never truncates the file.
    Ok(crate::fsio::write_atomic(&safe_path, content.as_bytes())?)
}

/// List the contents of a directory. Returns entries sorted with directories
/// first, then files, alphabetical within each group. Skips hidden files
/// (dot-prefixed) unless `include_hidden` is true. Detects circular symlinks.
#[tauri::command]
pub async fn list_directory(
    app: AppHandle,
    path: String,
    include_hidden: Option<bool>,
) -> Result<Vec<FileEntry>, AppError> {
    let include_hidden = include_hidden.unwrap_or(false);
    // Off the main thread: on a remote session this is a blocking ssh call.
    tauri::async_runtime::spawn_blocking(move || {
        if crate::remote::is_active() {
            return crate::remote::list_directory(&path, include_hidden);
        }
        let entries = list_directory_impl(&path, include_hidden)?;
        // Grant the asset protocol read access to the browsed directory
        // (recursively) so preview images anywhere under it load. See
        // read_file for why the scope starts empty.
        if let Ok(safe_path) = validate_path(&path) {
            let _ = app.asset_protocol_scope().allow_directory(&safe_path, true);
        }
        Ok(entries)
    })
    .await
    .map_err(|e| AppError::Other(format!("list task failed: {e}")))?
}

/// List a local directory's entries. Split out from [`list_directory`] so the
/// listing logic is testable without a Tauri `AppHandle`.
fn list_directory_impl(path: &str, include_hidden: bool) -> Result<Vec<FileEntry>, AppError> {
    let safe_path = validate_path(path)?;

    if !safe_path.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "Path is not a directory: {}",
            safe_path.display()
        )));
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&safe_path)?;
    // Entry paths keep the caller's spelling of the directory (e.g. /tmp/x on
    // macOS, where /tmp → /private/tmp), not the canonical one: tabs, git
    // badges and reveal-on-switch compare against the path the user opened.
    let base = Path::new(path.trim_end_matches(['/', '\\']));
    let base = if base.as_os_str().is_empty() {
        Path::new(path)
    } else {
        base
    };

    for entry in read_dir {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();

        if !include_hidden && name.starts_with('.') {
            continue;
        }

        // file_type() uses readdir's d_type when available (no extra stat on
        // macOS), unlike metadata() which always stats. We only need is_dir.
        // Fall back to metadata() if the type is unknown (e.g. some FUSE FSes).
        let is_dir = match entry.file_type() {
            Ok(ft) if !ft.is_symlink() => ft.is_dir(),
            // Symlink: follow via canonicalize to detect circular links.
            _ => match entry.path().canonicalize() {
                Ok(real) => {
                    // Skip entries that point back to a parent of the listing
                    // directory (circular symlink protection)
                    if safe_path.starts_with(&real) {
                        continue;
                    }
                    real.is_dir()
                }
                // Broken symlink — treat as file
                Err(_) => false,
            },
        };

        entries.push(FileEntry {
            path: base.join(&name).to_string_lossy().into_owned(),
            name,
            is_dir,
        });
    }

    // Sort: directories first, then files, alphabetical within each group
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

/// Load the persisted application configuration from the platform-specific
/// app config directory. Returns defaults if the file doesn't exist yet.
#[tauri::command]
pub fn load_config(app_handle: AppHandle) -> Result<AppConfig, AppError> {
    config::load(&app_handle)
}

/// Persist the application configuration to disk. Called by the frontend
/// whenever a preference changes (debounced).
#[tauri::command]
pub fn save_config(app_handle: AppHandle, config: AppConfig) -> Result<(), AppError> {
    config::save(&app_handle, &config)
}

/// Returns and clears any file paths received via macOS "Open With" or CLI args
/// before the frontend was ready.
#[tauri::command]
pub fn get_pending_files(state: State<'_, PendingFiles>) -> Vec<String> {
    state
        .paths
        .lock()
        .map(|mut paths| std::mem::take(&mut *paths))
        .unwrap_or_default()
}

/// Terminates the application. The frontend calls this only after the
/// unsaved-changes guard has run, so it is safe to exit immediately.
#[tauri::command]
pub fn quit(app_handle: AppHandle) {
    crate::mcp::shutdown(); // remove the MCP socket file
    app_handle.exit(0);
}

/// Stores the HTML served by the `htmlpreview://` protocol. The frontend pushes
/// the current document here before pointing the (script-enabled) preview
/// iframe at the protocol, so live edits are reflected on each render.
#[tauri::command]
pub fn set_html_preview(state: State<'_, crate::HtmlPreview>, html: String) {
    if let Ok(mut guard) = state.html.lock() {
        *guard = html;
    }
}

/// Syncs the "Allow JavaScript in HTML Preview" menu checkmark. Called when the
/// toggle is flipped from the preview's floating button so the menu reflects it.
#[tauri::command]
pub fn set_html_js_checked(state: State<'_, crate::HtmlJsMenuItem>, checked: bool) {
    let _ = state.0.set_checked(checked);
}

/// Pops up the native app menu at a window-relative point (Windows/Linux
/// toolbar icon). Coordinates are logical pixels from the window's top-left
/// (typically the brand button's bottom-left from getBoundingClientRect).
/// Cursor-based `popup_menu` is unreliable on Wayland (Omarchy/Hyprland):
/// GDK often cannot read the pointer, so the menu lands at (0,0) or centered.
/// On macOS the same menu is the system menu bar, so this command is unused.
///
/// Re-entrant calls are ignored: muda holds a `RefCell` borrow for the whole
/// popup lifetime (see [`APP_MENU_POPUP_OPEN`]), so a second invoke while the
/// menu is open would panic the process.
#[tauri::command]
pub fn show_app_menu(
    window: WebviewWindow,
    menu: State<'_, AppMenuHandle>,
    x: f64,
    y: f64,
) -> Result<(), AppError> {
    if APP_MENU_POPUP_OPEN.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let result = window
        .popup_menu_at(&menu.0, tauri::LogicalPosition::new(x, y))
        .map_err(|e| AppError::Other(e.to_string()));
    APP_MENU_POPUP_OPEN.store(false, Ordering::Release);
    result
}

/// Validate a URL for [`open_external`]: only http(s) with a host, or mailto.
/// Returns the normalized URL string handed to the platform opener.
pub(crate) fn validate_external_url(raw: &str) -> Result<String, AppError> {
    let url = tauri::Url::parse(raw.trim())
        .map_err(|_| AppError::Other(format!("Invalid URL: {raw}")))?;
    let ok = match url.scheme() {
        "http" | "https" => url.host_str().is_some_and(|h| !h.is_empty()),
        "mailto" => true,
        _ => false,
    };
    if !ok {
        return Err(AppError::Other(format!("Refusing to open URL: {raw}")));
    }
    // Url serializes percent-encoded, so no whitespace/control chars remain;
    // it always starts with the scheme, so it can't be read as a CLI flag.
    Ok(url.into())
}

/// Open an http(s)/mailto link from the preview in the user's default
/// browser / mail client. The URL is passed as a single argv entry to the
/// platform opener, never through a shell string.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), AppError> {
    let url = validate_external_url(&url)?;
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        // url.dll's FileProtocolHandler = ShellExecute on the URL, with no
        // cmd.exe parsing (cmd /c start would interpret & and ^).
        let mut c = std::process::Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = std::process::Command::new("xdg-open");
    let mut child = cmd
        .arg(&url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    // Reap the opener off the main thread (xdg-open can linger).
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// File extensions the preview may load as images (lowercase, no dot).
pub(crate) const PREVIEW_IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico",
];

/// Most paths one [`allow_preview_assets`] call may grant. A document with
/// more distinct images than this is resolved over several renders.
const MAX_PREVIEW_ASSETS_PER_CALL: usize = 512;

/// True when `path` ends in one of [`PREVIEW_IMAGE_EXTS`] (case-insensitive).
pub(crate) fn has_image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            PREVIEW_IMAGE_EXTS.contains(&e.as_str())
        })
        .unwrap_or(false)
}

/// Validate one preview image path: absolute, resolves (symlinks included)
/// to a regular file, and the RESOLVED path has an image extension. Checking
/// the canonical path means `logo.png -> ~/.ssh/id_rsa` is refused.
fn check_preview_image(path: &str) -> Result<PathBuf, AppError> {
    let p = Path::new(path);
    if path.is_empty() || !p.is_absolute() {
        return Err(AppError::InvalidPath(format!(
            "Not an absolute path: {path}"
        )));
    }
    let canonical = fs::canonicalize(p)
        .map_err(|_| AppError::InvalidPath(format!("Invalid or inaccessible path: {path}")))?;
    let meta = fs::metadata(&canonical)?;
    if !meta.is_file() {
        return Err(AppError::InvalidPath(format!("Not a regular file: {path}")));
    }
    if !has_image_extension(&canonical) {
        return Err(AppError::InvalidPath(format!("Not an image file: {path}")));
    }
    Ok(canonical)
}

/// Grant the asset protocol read access to individual preview images.
///
/// The asset scope ships empty and read_file / list_directory only grant the
/// opened file's directory or the browsed folder. A file opened on its own
/// that references `../img/x.png` would otherwise show a broken image. Each
/// path must pass [`check_preview_image`]; only that exact file is allowed —
/// never its directory. Returns one flag per input path (true = allowed).
#[tauri::command]
pub async fn allow_preview_assets(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<bool>, AppError> {
    if paths.len() > MAX_PREVIEW_ASSETS_PER_CALL {
        return Err(AppError::Other(format!(
            "Too many preview assets in one call (max {MAX_PREVIEW_ASSETS_PER_CALL})"
        )));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let scope = app.asset_protocol_scope();
        Ok(paths
            .iter()
            .map(|p| match check_preview_image(p) {
                Ok(canonical) => scope.allow_file(&canonical).is_ok(),
                Err(_) => false,
            })
            .collect())
    })
    .await
    .map_err(|e| AppError::Other(format!("allow task failed: {e}")))?
}

/// Read one image of a remote document over SSH, as raw bytes (the frontend
/// receives an `ArrayBuffer`). `host` must be the active session's host, so
/// a tab opened on another machine never reads a same-named path here.
/// Image extensions only, capped at [`crate::remote::MAX_REMOTE_IMAGE_BYTES`].
#[tauri::command]
pub async fn remote_read_image(
    host: String,
    path: String,
) -> Result<tauri::ipc::Response, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = crate::remote::current_session()
            .ok_or_else(|| AppError::Other("no remote session".into()))?;
        if session.host != host {
            return Err(AppError::Other(format!(
                "Image belongs to {host}, but the active session is {}",
                session.host
            )));
        }
        crate::remote::read_image(&path).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| AppError::Other(format!("read task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn has_image_extension_accepts_only_image_types() {
        for ok in [
            "/a/x.png",
            "/a/x.JPG",
            "/a/x.jpeg",
            "/a/x.gif",
            "/a/x.webp",
            "/a/x.svg",
            "/a/x.avif",
            "/a/x.bmp",
            "/a/x.ico",
        ] {
            assert!(has_image_extension(Path::new(ok)), "{ok}");
        }
        for bad in [
            "/a/x.md",
            "/a/x",
            "/a/.png",
            "/a/id_rsa",
            "/a/x.png.txt",
            "/a/x.html",
        ] {
            assert!(!has_image_extension(Path::new(bad)), "{bad}");
        }
    }

    #[test]
    fn check_preview_image_requires_absolute_existing_image_file() {
        let dir = std::env::temp_dir().join("sparkdown_test_preview_image");
        let img_dir = dir.join("img");
        let doc_dir = dir.join("docs");
        fs::create_dir_all(&img_dir).unwrap();
        fs::create_dir_all(&doc_dir).unwrap();
        let img = img_dir.join("x.png");
        fs::write(&img, b"\x89PNG").unwrap();
        let txt = img_dir.join("notes.txt");
        fs::write(&txt, "secret").unwrap();

        // `docs/../img/x.png` canonicalizes to the image itself.
        let via_parent = format!("{}/../img/x.png", doc_dir.display());
        let got = check_preview_image(&via_parent).unwrap();
        assert_eq!(got, fs::canonicalize(&img).unwrap());

        assert!(check_preview_image("img/x.png").is_err(), "relative path");
        assert!(check_preview_image("").is_err());
        assert!(
            check_preview_image(txt.to_str().unwrap()).is_err(),
            "non-image"
        );
        assert!(
            check_preview_image(img_dir.join("missing.png").to_str().unwrap()).is_err(),
            "missing"
        );
        // A directory named like an image is not a regular file.
        let dir_png = img_dir.join("folder.png");
        fs::create_dir_all(&dir_png).unwrap();
        assert!(
            check_preview_image(dir_png.to_str().unwrap()).is_err(),
            "directory"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn check_preview_image_refuses_image_named_symlink_to_non_image() {
        let dir = std::env::temp_dir().join("sparkdown_test_preview_symlink");
        fs::create_dir_all(&dir).unwrap();
        let secret = dir.join("id_rsa");
        fs::write(&secret, "key").unwrap();
        let link = dir.join("logo.png");
        let _ = fs::remove_file(&link);
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        assert!(check_preview_image(link.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_external_url_allows_only_http_https_mailto() {
        assert_eq!(
            validate_external_url("https://example.com/a?b=1").unwrap(),
            "https://example.com/a?b=1"
        );
        assert!(validate_external_url("http://example.com").is_ok());
        assert!(validate_external_url("mailto:a@b.c").is_ok());
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "asset://localhost/x",
            "tauri://localhost",
            "-a Calculator",
            "data:text/html,x",
            "https://",
            "not a url",
            "",
        ] {
            assert!(validate_external_url(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn validate_path_rejects_nonexistent() {
        let result = validate_path("/nonexistent/path/abc123.txt");
        assert!(result.is_err());
    }

    #[test]
    fn validate_path_accepts_existing_file() {
        let dir = std::env::temp_dir().join("sparkdown_test_validate");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("test.txt");
        fs::write(&file, "hello").unwrap();

        let result = validate_path(file.to_str().unwrap());
        assert!(result.is_ok());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_path_resolves_dotdot() {
        let dir = std::env::temp_dir().join("sparkdown_test_dotdot");
        let sub = dir.join("sub");
        let _ = fs::create_dir_all(&sub);
        let file = dir.join("target.txt");
        fs::write(&file, "content").unwrap();

        // sub/../target.txt should resolve to dir/target.txt
        let dotdot_path = sub.join("../target.txt");
        let result = validate_path(dotdot_path.to_str().unwrap());
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), file.canonicalize().unwrap());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_write_path_allows_new_file() {
        let dir = std::env::temp_dir().join("sparkdown_test_write");
        let _ = fs::create_dir_all(&dir);

        let new_file = dir.join("new_file.md");
        let result = validate_write_path(new_file.to_str().unwrap());
        assert!(result.is_ok());
        // Should have canonical parent + filename
        let canonical = result.unwrap();
        assert_eq!(canonical.file_name().unwrap(), "new_file.md");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_write_path_rejects_nonexistent_parent() {
        let result = validate_write_path("/nonexistent/parent/file.md");
        assert!(result.is_err());
    }

    #[test]
    fn read_file_respects_size_limit() {
        let dir = std::env::temp_dir().join("sparkdown_test_size");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("small.txt");
        fs::write(&file, "small content").unwrap();

        let result = read_local_file(file.to_str().unwrap());
        assert!(result.is_ok());
        assert_eq!(result.unwrap().0, "small content");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_rejects_nonexistent() {
        let result = read_local_file("/nonexistent/file.txt");
        assert!(result.is_err());
    }

    #[test]
    fn is_directory_returns_correct_value() {
        let _session_guard = crate::remote::TEST_SESSION_LOCK.lock().unwrap();
        let dir = std::env::temp_dir();
        assert!(is_directory_impl(dir.to_str().unwrap()));
        assert!(!is_directory_impl("/nonexistent/path"));
    }

    #[test]
    fn list_directory_rejects_file_path() {
        let dir = std::env::temp_dir().join("sparkdown_test_listdir");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("not_a_dir.txt");
        fs::write(&file, "content").unwrap();

        let result = list_directory_impl(file.to_str().unwrap(), false);
        assert!(result.is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_directory_excludes_hidden_by_default() {
        let dir = std::env::temp_dir().join("sparkdown_test_hidden");
        let _ = fs::create_dir_all(&dir);
        fs::write(dir.join(".hidden"), "").unwrap();
        fs::write(dir.join("visible.txt"), "").unwrap();

        let result = list_directory_impl(dir.to_str().unwrap(), false).unwrap();
        assert!(result.iter().any(|e| e.name == "visible.txt"));
        assert!(!result.iter().any(|e| e.name == ".hidden"));

        let result_with_hidden = list_directory_impl(dir.to_str().unwrap(), true).unwrap();
        assert!(result_with_hidden.iter().any(|e| e.name == ".hidden"));

        let _ = fs::remove_dir_all(&dir);
    }

    /// A directory reached through a symlink lists entries in the caller's
    /// spelling (tabs and git badges compare against the opened path).
    #[cfg(unix)]
    #[test]
    fn list_directory_keeps_the_callers_path_spelling() {
        let real = std::env::temp_dir().join(format!("sd_ld_real_{}", std::process::id()));
        let link = std::env::temp_dir().join(format!("sd_ld_link_{}", std::process::id()));
        let _ = fs::remove_dir_all(&real);
        let _ = fs::remove_file(&link);
        fs::create_dir_all(real.join("docs")).unwrap();
        fs::write(real.join("a.md"), "").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let via_link = link.to_str().unwrap();
        let entries = list_directory_impl(via_link, false).unwrap();
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            [format!("{via_link}/docs"), format!("{via_link}/a.md")]
        );
        // A trailing slash does not double up.
        let entries = list_directory_impl(&format!("{via_link}/"), false).unwrap();
        assert_eq!(entries[1].path, format!("{via_link}/a.md"));

        let _ = fs::remove_file(&link);
        let _ = fs::remove_dir_all(&real);
    }

    #[test]
    fn list_directory_sorts_dirs_first() {
        let dir = std::env::temp_dir().join("sparkdown_test_sort");
        let _ = fs::create_dir_all(dir.join("aaa_dir"));
        fs::write(dir.join("bbb_file.txt"), "").unwrap();

        let result = list_directory_impl(dir.to_str().unwrap(), false).unwrap();
        // Find positions of our entries
        let dir_pos = result.iter().position(|e| e.name == "aaa_dir");
        let file_pos = result.iter().position(|e| e.name == "bbb_file.txt");

        if let (Some(dp), Some(fp)) = (dir_pos, file_pos) {
            assert!(dp < fp, "Directories should sort before files");
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn utc_date_is_iso_and_plausible() {
        let d = chrono_date_utc();
        assert_eq!(d.len(), 10);
        assert_eq!(&d[4..5], "-");
        assert_eq!(&d[7..8], "-");
        let year: i32 = d[..4].parse().unwrap();
        assert!(year >= 2026);
        let month: u32 = d[5..7].parse().unwrap();
        let day: u32 = d[8..10].parse().unwrap();
        assert!((1..=12).contains(&month));
        assert!((1..=31).contains(&day));
    }

    #[test]
    fn rate_limiter_allows_first_call() {
        let limiter = WriteRateLimiter::default();
        assert!(limiter.check(Path::new("/tmp/a.md")).is_ok());
    }

    #[test]
    fn rate_limiter_blocks_rapid_calls_to_same_path() {
        let limiter = WriteRateLimiter::default();
        assert!(limiter.check(Path::new("/tmp/a.md")).is_ok());
        // Immediate second call to the SAME path should be blocked.
        assert!(limiter.check(Path::new("/tmp/a.md")).is_err());
    }

    #[test]
    fn rate_limiter_allows_a_different_path_immediately() {
        let limiter = WriteRateLimiter::default();
        assert!(limiter.check(Path::new("/tmp/a.md")).is_ok());
        // A rapid save of a DIFFERENT file is not runaway; it must pass (this
        // is the perf-trace/export-then-save case the old global limiter broke).
        assert!(limiter.check(Path::new("/tmp/b.md")).is_ok());
    }

    #[test]
    fn rate_limiter_allows_after_interval() {
        let limiter = WriteRateLimiter::default();
        assert!(limiter.check(Path::new("/tmp/a.md")).is_ok());
        std::thread::sleep(std::time::Duration::from_millis(MIN_WRITE_INTERVAL_MS + 10));
        assert!(limiter.check(Path::new("/tmp/a.md")).is_ok());
    }
}
