//! Agent context bridge.
//!
//! Publishes what the user is looking at in SparkDown to a small directory any
//! agent can read — the same agent-agnostic move as the file watcher, in the
//! other direction. We don't integrate with vendor APIs; we write files, and
//! every agent already knows how to read files.
//!
//! Layout (under the per-user runtime dir, keyed by workspace root):
//!   <base>/sparkdown/<key>/context.json    — active file, tabs, dirty flags
//!   <base>/sparkdown/<key>/buffers/<name>  — shadow copies of unsaved buffers
//!
//! `<base>` is `$XDG_RUNTIME_DIR` on Linux (per-user, mode 0700) or the
//! per-user temp dir elsewhere (`$TMPDIR` on macOS) — the same base mcp.rs
//! uses for its socket. Each level we create is 0700 and verified to be a real
//! directory we own, so on a shared machine no other user can pre-create the
//! tree (e.g. symlinking `buffers/` at the victim's files) and turn our
//! cleanup and writes against them.
//!
//! The embedded terminal exports SPARKDOWN_CONTEXT=<that dir> so an agent can
//! be told, once, "read $SPARKDOWN_CONTEXT/context.json". Unsaved (even
//! never-saved) buffers become readable through their shadow files.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Max bytes we'll mirror for one unsaved buffer (agents don't need more, and
/// this is rewritten on every debounced update). Shared with mcp.rs, which
/// caps the same buffer text in its in-memory snapshot.
pub(crate) const MAX_BUFFER_BYTES: usize = 2 * 1024 * 1024;

/// Deadline for the login-shell probes below. A blocking shell profile
/// (a `~/.zprofile` that waits on the network, etc.) must not hang a caller —
/// especially `login_shell_path`, which memoizes inside `OnceLock::get_or_init`
/// and would otherwise stall every later caller forever.
const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// One unsaved buffer to mirror into the context dir.
#[derive(Deserialize)]
pub struct ShadowBuffer {
    pub name: String,
    pub content: String,
}

/// Stable short key for a workspace root (hash of the path). Used for the
/// context dir and tmux session prefixes.
///
/// An inline FNV-1a rather than `DefaultHasher`: `DefaultHasher`'s output is
/// explicitly NOT guaranteed stable across Rust releases, and this key names
/// both the on-disk context dir and (via terminal.rs) the tmux session
/// prefix — a value that changed on a toolchain upgrade would silently orphan
/// running sessions so they stopped reattaching. FNV-1a is fixed forever.
pub fn workspace_key(root: &str) -> String {
    // FNV-1a, 64-bit (fixed constants, no crate).
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut h = OFFSET_BASIS;
    for byte in root.as_bytes() {
        h ^= *byte as u64;
        h = h.wrapping_mul(PRIME);
    }
    format!("{h:016x}")
}

/// Base holding every per-workspace context dir: `<runtime>/sparkdown`. Mirrors
/// `mcp::mcp_socket_path`: `$XDG_RUNTIME_DIR` (per-user, 0700) on Linux, else
/// the per-user temp dir (`$TMPDIR` on macOS).
fn context_root() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("sparkdown")
}

/// Context dir for a workspace root: stable across runs, safe for concurrent
/// workspaces.
pub fn context_dir_for(root: &str) -> PathBuf {
    context_root().join(workspace_key(root))
}

/// File-name-safe version of a tab title ("Untitled" → "Untitled.md").
fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "buffer.md".to_string()
    } else {
        cleaned
    }
}

/// Write the context snapshot. `context_json` is composed by the frontend
/// (which owns tab/editor state); we add the self-describing README and the
/// shadow buffers, and return the directory path.
/// README so an agent that only ls's the dir still understands it.
const CONTEXT_README: &str = "SparkDown agent context.\n\
    context.json describes what the user is viewing in the SparkDown editor:\n\
    the active file (its `path`, or a `shadow` path under buffers/ when the\n\
    buffer is unsaved), dirty state, and all open tabs. Shadow files under\n\
    buffers/ are live mirrors of unsaved editor buffers - read them like\n\
    regular files, but do not edit them; edit the real `path` when one exists.\n";

/// `async` + `spawn_blocking`: on a remote session this batches into an ssh
/// round trip; even locally it does file I/O (mkdir/write). A sync Tauri 2
/// command would run this on the main thread and could freeze the UI.
#[tauri::command]
pub async fn agent_context_update(
    root: String,
    context_json: String,
    buffers: Vec<ShadowBuffer>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        agent_context_update_impl(root, context_json, buffers)
    })
    .await
    .map_err(|e| format!("agent_context_update task failed: {e}"))?
}

fn agent_context_update_impl(
    root: String,
    context_json: String,
    buffers: Vec<ShadowBuffer>,
) -> Result<String, String> {
    // Remote workspace: the agent runs on the remote host, so the context
    // must live there too (one batched ssh round trip).
    if crate::remote::is_active() {
        let bufs: Vec<(String, String)> = buffers
            .iter()
            .map(|b| {
                (
                    sanitize_name(&b.name),
                    truncate_at_char_boundary(&b.content, MAX_BUFFER_BYTES).to_string(),
                )
            })
            .collect();
        return crate::remote::agent_context_update(&root, &context_json, CONTEXT_README, &bufs);
    }

    let dir = context_dir_for(&root);
    let buf_dir = dir.join("buffers");
    // Create the tree owner-only AND verify each level is a real directory we
    // own — never follow a symlink or reuse another user's dir. On a shared
    // Linux box `$XDG_RUNTIME_DIR` is per-user, but if it is unset the base
    // falls back to a world-writable /tmp; without this check another local
    // user could pre-create `<key>/` or `buffers/` as a symlink to files in
    // the victim's home, and the cleanup loop below (plus every write) would
    // hit those targets instead.
    secure_context_tree(&buf_dir).map_err(|e| format!("context dir: {e}"))?;

    std::fs::write(dir.join("context.json"), context_json)
        .map_err(|e| format!("context write: {e}"))?;
    let _ = std::fs::write(dir.join("README.md"), CONTEXT_README);

    // Replace the shadow set wholesale so stale buffers don't linger.
    if let Ok(entries) = std::fs::read_dir(&buf_dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    for buf in &buffers {
        let content = truncate_at_char_boundary(&buf.content, MAX_BUFFER_BYTES);
        let _ = std::fs::write(buf_dir.join(sanitize_name(&buf.name)), content);
    }

    Ok(dir.to_string_lossy().into_owned())
}

/// Remove a workspace's context dir (quit, bridge disabled, folder closed).
/// The shadows are unsaved user text; they must not outlive the session.
///
/// `async` + `spawn_blocking`: a remote session's cleanup is an ssh call;
/// even locally `remove_dir_all` can block on many files. Keep it off Tauri
/// 2's main thread.
#[tauri::command]
pub async fn agent_context_clear(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || agent_context_clear_impl(root))
        .await
        .map_err(|e| format!("agent_context_clear task failed: {e}"))?
}

fn agent_context_clear_impl(root: String) -> Result<(), String> {
    if crate::remote::is_active() {
        return crate::remote::agent_context_clear(&root);
    }
    let dir = context_dir_for(&root);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("context clear: {e}")),
    }
}

/// Cut `s` to at most `max` bytes without splitting a UTF-8 sequence.
/// `String::truncate` panics on a non-boundary — and the release profile
/// aborts on panic, so a 2 MiB buffer with a multibyte char at the limit
/// would have taken the whole app down. Shared with mcp.rs.
pub(crate) fn truncate_at_char_boundary(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Create `<runtime>/sparkdown/<key>/buffers` and its parents down from the
/// `sparkdown` root, each 0700 and verified to be a real directory we own. The
/// runtime base itself (`$XDG_RUNTIME_DIR` / `$TMPDIR`) is already per-user, so
/// we start hardening at the first level we create.
#[cfg(unix)]
fn secure_context_tree(buf_dir: &Path) -> std::io::Result<()> {
    let key_dir = buf_dir
        .parent()
        .ok_or_else(|| std::io::Error::other("buffers dir has no parent"))?;
    let sd_root = key_dir
        .parent()
        .ok_or_else(|| std::io::Error::other("context dir has no parent"))?;
    for level in [sd_root, key_dir, buf_dir] {
        ensure_owned_dir(level)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn secure_context_tree(buf_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(buf_dir)
}

/// Create `dir` mode 0700 if it is absent, then require it to be a real
/// directory (not a symlink), owned by the current effective uid, with no
/// group/other permission bits. Anything else means another user may control
/// it, so we refuse rather than write through it.
#[cfg(unix)]
fn ensure_owned_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    // symlink_metadata, NOT metadata: a symlink planted here must be rejected,
    // not silently followed.
    let meta = std::fs::symlink_metadata(dir)?;
    if !meta.file_type().is_dir() {
        return Err(std::io::Error::other(format!(
            "{} is not a directory (possible symlink attack)",
            dir.display()
        )));
    }
    if meta.uid() != current_euid() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{} is not owned by the current user", dir.display()),
        ));
    }
    // A pre-existing dir we own but with loose bits: tighten it (fails loudly
    // if we somehow cannot).
    if meta.mode() & 0o077 != 0 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// The current effective uid, for the ownership check above. No `libc`
/// dependency: `geteuid(2)` takes no arguments and cannot fail.
#[cfg(unix)]
fn current_euid() -> u32 {
    extern "C" {
        fn geteuid() -> u32;
    }
    // SAFETY: geteuid() has no arguments, no error path, and no side effects.
    unsafe { geteuid() }
}

/// A known agent CLI and whether it's installed (found on PATH).
#[derive(serde::Serialize, Clone)]
pub struct AgentCli {
    pub id: String,
    pub label: String,
    pub bin: String,
    pub found: bool,
}

/// PATH as the user's login shell sees it. macOS GUI apps inherit launchd's
/// minimal PATH (/usr/bin:/bin:…), NOT the shell profile's — so agent CLIs
/// installed via Homebrew/npm/~/.local/bin are invisible to the app process.
/// Ask the login shell (the same one the embedded terminal runs) once and
/// cache it. Falls back to the process PATH.
///
/// Windows: the process PATH as is. There is no `$SHELL` to ask, and a GUI
/// app started from Explorer already gets the user + system PATH from the
/// registry (the same PATH the embedded PowerShell inherits).
pub fn login_shell_path() -> String {
    #[cfg(windows)]
    {
        std::env::var("PATH").unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        use std::sync::OnceLock;
        static PATH: OnceLock<String> = OnceLock::new();
        PATH.get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            // Timeout-guarded: a profile that never returns must not wedge
            // this OnceLock forever (it would block every future PATH lookup).
            crate::mcp::run_with_timeout(
                &shell,
                &["-lc", "printf %s \"$PATH\""],
                &std::env::temp_dir(),
                SHELL_PROBE_TIMEOUT,
            )
            .ok()
            .filter(|(ok, _, _)| *ok)
            .map(|(_, stdout, _)| stdout.trim().to_string())
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
        })
        .clone()
    }
}

fn on_path(bin: &str) -> bool {
    find_on_path(bin).is_some()
}

/// Absolute path of `bin` on the login shell's PATH, if present. On Windows
/// a bare name is tried with each `%PATHEXT%` extension (see
/// [`path_candidates`]), so `claude` finds `claude.exe` or npm's `claude.cmd`.
pub fn find_on_path(bin: &str) -> Option<PathBuf> {
    let pathext = std::env::var("PATHEXT").unwrap_or_default();
    find_in_path(bin, &login_shell_path(), &pathext, cfg!(windows))
}

/// [`find_on_path`] with every input explicit, so the Windows rules can be
/// tested on any OS.
pub(crate) fn find_in_path(bin: &str, path: &str, pathext: &str, windows: bool) -> Option<PathBuf> {
    let names = path_candidates(bin, pathext, windows);
    std::env::split_paths(path).find_map(|dir| {
        names.iter().find_map(|name| {
            let candidate = dir.join(name);
            is_runnable_file(&candidate, windows).then_some(candidate)
        })
    })
}

/// `%PATHEXT%` when the variable is unset.
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// File names to look for in one PATH directory.
///
/// Unix: the bare name. Windows: a name that already has an extension
/// (`pwsh.exe`) as is; else the name plus each `%PATHEXT%` extension in
/// order, then `.ps1`. The bare name is NOT tried on Windows: npm writes an
/// extensionless POSIX `sh` script next to `claude.cmd` / `claude.ps1`, and
/// Windows cannot run it. `.ps1` comes last: PowerShell (the terminal shell)
/// runs a script-only install too.
pub(crate) fn path_candidates(bin: &str, pathext: &str, windows: bool) -> Vec<String> {
    if !windows || Path::new(bin).extension().is_some() {
        return vec![bin.to_string()];
    }
    let pathext = if pathext.trim().is_empty() {
        DEFAULT_PATHEXT
    } else {
        pathext
    };
    let mut exts: Vec<String> = Vec::new();
    for e in pathext.split(';').map(str::trim) {
        let e = e.to_ascii_lowercase();
        if e.len() > 1 && e.starts_with('.') && !exts.contains(&e) {
            exts.push(e);
        }
    }
    if !exts.iter().any(|e| e == ".ps1") {
        exts.push(".ps1".into());
    }
    exts.into_iter().map(|e| format!("{bin}{e}")).collect()
}

/// A file we could run. Windows: any non-directory entry, including the
/// 0-byte App Execution Alias reparse points in `WindowsApps` (a Store
/// install of `pwsh.exe` is one), which `is_file()` cannot follow.
fn is_runnable_file(p: &Path, windows: bool) -> bool {
    if windows {
        return std::fs::symlink_metadata(p)
            .map(|m| !m.is_dir())
            .unwrap_or(false);
    }
    p.is_file() && is_executable(p)
}

/// Whether the login shell can run `bin` — catches aliases and shell
/// functions (e.g. a `codex` alias) that a PATH file-scan can't see. One
/// interactive-shell invocation per binary, done once at detect time.
///
/// Windows: always false. The PATH + PATHEXT scan finds `.exe` files, npm's
/// `.cmd` / `.ps1` shims and Store aliases; a function defined only in a
/// PowerShell profile is not detected (the user can still type it).
fn shell_can_run(bin: &str) -> bool {
    // Only allow simple command names; anything else can't be a chip.
    if !bin
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return false;
    }
    if cfg!(windows) {
        return false;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // Timeout-guarded like login_shell_path: an interactive profile that
    // blocks (network prompt, `read`, …) must not hang agent detection.
    crate::mcp::run_with_timeout(
        &shell,
        &["-lic", &format!("command -v {bin} >/dev/null 2>&1")],
        &std::env::temp_dir(),
        SHELL_PROBE_TIMEOUT,
    )
    .map(|(ok, _, _)| ok)
    .unwrap_or(false)
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_p: &Path) -> bool {
    true
}

/// Detect which agent CLIs are installed: fast PATH scan first (using the
/// login shell's PATH), then an alias/function-aware shell check for the
/// rest. The list is deliberately small and well-known; anything else the
/// user just types themselves.
// Async so the shell probes run on Tauri's worker pool, never blocking the
// UI thread (each interactive-shell check can take ~100ms+).
#[tauri::command]
pub async fn detect_agents() -> Vec<AgentCli> {
    let known: [(&str, &str, &str); 8] = [
        ("claude", "Claude Code", "claude"),
        ("codex", "Codex", "codex"),
        ("kiro", "Kiro", "kiro-cli"),
        ("grok", "Grok", "grok"),
        ("cursor", "Cursor CLI", "cursor-agent"),
        ("opencode", "opencode", "opencode"),
        ("antigravity", "Antigravity", "agy"),
        ("gemini", "Gemini", "gemini"),
    ];
    // Remote workspace: the chips launch agents in the REMOTE shell, so ask
    // the remote login shell what it can run (one round trip). A failed
    // probe reports nothing found rather than the local machine's agents.
    if crate::remote::is_active() {
        let bins: Vec<&str> = known.iter().map(|(_, _, b)| *b).collect();
        let found = crate::remote::detect_agent_bins(&bins).unwrap_or_default();
        return known
            .iter()
            .map(|(id, label, bin)| AgentCli {
                id: id.to_string(),
                label: label.to_string(),
                bin: bin.to_string(),
                found: found.iter().any(|f| f == bin),
            })
            .collect();
    }
    known
        .iter()
        .map(|(id, label, bin)| AgentCli {
            id: id.to_string(),
            label: label.to_string(),
            bin: bin.to_string(),
            found: on_path(bin) || shell_can_run(bin),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_buffer_names() {
        assert_eq!(sanitize_name("Untitled"), "Untitled");
        assert_eq!(sanitize_name("my spec/../etc"), "my_spec_.._etc");
        assert_eq!(sanitize_name(""), "buffer.md");
    }

    #[test]
    fn truncation_never_splits_a_multibyte_char() {
        // 'é' is 2 bytes; a cut at byte 3 lands inside the second 'é'.
        let s = "aéé";
        assert_eq!(truncate_at_char_boundary(s, 3), "aé");
        assert_eq!(truncate_at_char_boundary(s, 5), "aéé");
        assert_eq!(truncate_at_char_boundary(s, 0), "");
        // 4-byte emoji straddling the real limit.
        let big = format!("{}😀", "x".repeat(MAX_BUFFER_BYTES - 2));
        let cut = truncate_at_char_boundary(&big, MAX_BUFFER_BYTES);
        assert_eq!(cut.len(), MAX_BUFFER_BYTES - 2);
        assert!(cut.chars().all(|c| c == 'x'));
    }

    #[test]
    fn clear_removes_the_context_dir_and_tolerates_absence() {
        let root = format!("/tmp/sd-test-{}", std::process::id());
        let dir = context_dir_for(&root);
        std::fs::create_dir_all(dir.join("buffers")).unwrap();
        std::fs::write(dir.join("buffers").join("x.md"), "secret").unwrap();
        agent_context_clear_impl(root.clone()).unwrap();
        assert!(!dir.exists());
        agent_context_clear_impl(root).unwrap(); // already gone: not an error
    }

    #[test]
    fn context_dir_is_stable_and_distinct() {
        let a1 = context_dir_for("/Users/x/proj-a");
        let a2 = context_dir_for("/Users/x/proj-a");
        let b = context_dir_for("/Users/x/proj-b");
        assert_eq!(a1, a2);
        assert_ne!(a1, b);
    }

    #[test]
    fn workspace_key_is_fnv1a_and_toolchain_stable() {
        // Canonical FNV-1a/64 test vector; a DefaultHasher would differ and
        // could change between Rust releases, orphaning tmux sessions.
        assert_eq!(workspace_key("hello"), "a430d84680aabd0b");
        assert_eq!(workspace_key("/Users/x/proj-a"), "f551ff7622e69587");
    }

    /// A `buffers/` symlink planted by another user must be refused, not
    /// followed — otherwise our cleanup loop would delete the link's target.
    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_buffers_dir() {
        let base = std::env::temp_dir().join(format!(
            "sd-sym-{}-{}",
            std::process::id(),
            workspace_key("sym-test")
        ));
        let key_dir = base.join("sparkdown").join("k");
        std::fs::create_dir_all(&key_dir).unwrap();
        let victim = base.join("victim");
        std::fs::create_dir_all(&victim).unwrap();
        std::os::unix::fs::symlink(&victim, key_dir.join("buffers")).unwrap();
        // ensure_owned_dir must reject the symlink at the buffers level.
        let err = secure_context_tree(&key_dir.join("buffers")).unwrap_err();
        assert!(
            err.to_string().contains("not a directory"),
            "unexpected error: {err}"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn path_candidates_use_pathext_on_windows_only() {
        assert_eq!(path_candidates("claude", ".EXE;.CMD", false), ["claude"]);
        assert_eq!(
            path_candidates("claude", ".COM;.EXE;.BAT;.CMD", true),
            [
                "claude.com",
                "claude.exe",
                "claude.bat",
                "claude.cmd",
                "claude.ps1"
            ]
        );
        // Unset PATHEXT: the Windows default list.
        assert_eq!(
            path_candidates("codex", " ", true),
            [
                "codex.com",
                "codex.exe",
                "codex.bat",
                "codex.cmd",
                "codex.ps1"
            ]
        );
        // .ps1 already listed: kept in place, not added twice.
        assert_eq!(
            path_candidates("x", ".PS1;.EXE;.exe", true),
            ["x.ps1", "x.exe"]
        );
        // A name with an extension is looked up as is.
        assert_eq!(path_candidates("pwsh.exe", ".EXE", true), ["pwsh.exe"]);
    }

    /// The Windows lookup rules against a real directory (runs on any OS):
    /// npm's three shims resolve to the `.cmd` (never the extensionless sh
    /// script); an `.exe` earlier on PATH wins; a `.ps1`-only install is
    /// found; dirs with spaces and an apostrophe are fine.
    #[test]
    fn windows_lookup_finds_npm_shims_and_exes() {
        let base = std::env::temp_dir().join(format!("sd find O'Brien {}", std::process::id()));
        let npm = base.join("npm dir");
        let native = base.join("native");
        std::fs::create_dir_all(&npm).unwrap();
        std::fs::create_dir_all(&native).unwrap();
        for f in [
            "claude",
            "claude.cmd",
            "claude.ps1",
            "only.ps1",
            "codex.cmd",
        ] {
            std::fs::write(npm.join(f), "x").unwrap();
        }
        std::fs::write(native.join("codex.exe"), "x").unwrap();
        std::fs::create_dir_all(npm.join("adir.exe")).unwrap();
        let path = std::env::join_paths([&native, &npm]).unwrap();
        let path = path.to_string_lossy();
        let found = |bin: &str| find_in_path(bin, &path, ".COM;.EXE;.BAT;.CMD", true);
        assert_eq!(found("claude"), Some(npm.join("claude.cmd")));
        assert_eq!(found("codex"), Some(native.join("codex.exe")));
        assert_eq!(found("only"), Some(npm.join("only.ps1")));
        assert_eq!(found("adir"), None, "a directory is not a program");
        assert_eq!(found("missing"), None);
        let _ = std::fs::remove_dir_all(&base);
    }
}
