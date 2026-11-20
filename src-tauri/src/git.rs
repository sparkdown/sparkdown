//! Git working-tree inspection for the Changes view.
//!
//! The cockpit's signature question is "what did my agent just change?" In an
//! agent-built project that's a git repo, the answer is the working-tree diff
//! since the last commit. We shell out to the user's `git` (already on PATH for
//! anyone using coding agents) rather than linking a git library — it keeps the
//! binary tiny and always matches the repo's real git behavior. Read-only:
//! `status` and `diff` only. The only writes (commit / pull / push, on a
//! click) live in `git_write.rs`, with their own runner.

use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::OnceLock;

/// One changed path in the working tree, with a coarse status.
#[derive(Serialize, Clone)]
pub struct GitChange {
    pub path: String,
    /// "modified" | "added" | "deleted" | "renamed" | "untracked"
    pub status: String,
    /// Whether the path is staged (informational; the diff shows working tree).
    pub staged: bool,
    /// A directory, not a file: git lists an untracked nested repository
    /// (a folder with its own `.git`) as `?? proj/` without descending into
    /// it (#47). `path` is given without the trailing slash. Never opened
    /// as a file tab.
    #[serde(default)]
    pub is_dir: bool,
}

#[derive(Serialize, Clone)]
pub struct GitStatus {
    /// True if `root` is inside a git work tree.
    pub is_repo: bool,
    /// Current branch name, if resolvable.
    pub branch: Option<String>,
    /// Absolute path of the repo's top-level directory. Porcelain paths are
    /// relative to THIS, not to the queried `root` (which may be a subdir),
    /// so the frontend must resolve and diff against it.
    pub top_level: Option<String>,
    pub changes: Vec<GitChange>,
}

/// Absolute path to the git binary, resolved once against the login shell's
/// PATH (macOS GUI apps inherit launchd's minimal PATH, so a bare `git` would
/// miss Homebrew/Nix installs and pop the Xcode CLT installer). Falls back to
/// the bare name so a PATH-based lookup still happens if resolution fails.
pub(crate) fn git_bin() -> PathBuf {
    static GIT: OnceLock<PathBuf> = OnceLock::new();
    GIT.get_or_init(|| crate::context::find_on_path("git").unwrap_or_else(|| PathBuf::from("git")))
        .clone()
}

/// A git `Command` pinned to `root` with the read-only hardening every call
/// shares. We deliberately keep PATH/HOME (and the rest of the environment)
/// intact — clearing them broke git discovery and `safe.directory` handling —
/// and instead drop only the `GIT_*` variables, then force config isolation
/// via `GIT_CONFIG_{NOSYSTEM,GLOBAL,SYSTEM}`. Code-executing config keys
/// (`diff.external`, `diff.tool`, `core.fsmonitor`) are neutralised here; the
/// repo-local `filter.*` / `diff.*.{command,textconv}` drivers, which are the
/// real no-click RCE surface via `.gitattributes`, are neutralised per-call by
/// `local_exec_neutralisers` (they must be enumerated from the repo first).
///
/// `safe.directory`: with GIT_CONFIG_GLOBAL at /dev/null git would ignore the
/// user's own `safe.directory` entries, and a repo owned by another user
/// would show as "not a repo". So the user's real system + global values are
/// read once (`user_safe_directories`) and passed as `-c safe.directory=…`
/// (git honours this key from the command line). Only that key is carried
/// over; nothing else from the global/system config.
fn git_command(root: &Path) -> Result<Command, String> {
    git_command_with(root, user_safe_directories())
}

/// [`git_command`] with an explicit `safe.directory` list (tests inject one).
fn git_command_with(root: &Path, safe_dirs: &[String]) -> Result<Command, String> {
    let root_path = root
        .canonicalize()
        .map_err(|e| format!("invalid root: {e}"))?;
    let mut cmd = crate::proc::command(git_bin());
    cmd.current_dir(&root_path);
    // Drop only GIT_* vars (they can point config/hooks/pagers at attacker
    // input); keep PATH, HOME, etc. so git and its helpers resolve normally.
    for (key, _) in std::env::vars_os() {
        if key.to_str().map(|k| k.starts_with("GIT_")).unwrap_or(false) {
            cmd.env_remove(key);
        }
    }
    cmd.env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_ALLOW_PROTOCOL", "")
        .arg("--no-pager")
        .arg("--no-optional-locks")
        .arg("-c")
        .arg("core.quotepath=false")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .arg("-c")
        .arg("diff.external=")
        .arg("-c")
        .arg("diff.tool=")
        .arg("-c")
        .arg("diff.submodule=short")
        .arg("-c")
        .arg("protocol.allow=never")
        .arg("-c")
        .arg("fetch.negotiationAlgorithm=noop");
    for dir in safe_dirs {
        cmd.arg("-c").arg(format!("safe.directory={dir}"));
    }
    Ok(cmd)
}

/// How long the one-time `git config --get-all safe.directory` probe may run.
const SAFE_DIR_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// The user's real `safe.directory` values (system, then global: git's own
/// read order, so an empty "reset" entry keeps its meaning), read once and
/// cached. Empty if git is missing, the probe fails or times out.
fn user_safe_directories() -> &'static [String] {
    static DIRS: OnceLock<Vec<String>> = OnceLock::new();
    DIRS.get_or_init(|| read_safe_directories(probe_git_config))
}

/// Run `git <args>` for the safe.directory probe: the user's normal
/// environment (no GIT_* stripping, so their real global/system config is
/// read), a neutral cwd (not a repo), a deadline. Returns stdout on success.
fn probe_git_config(args: &[&str]) -> Option<String> {
    let git = git_bin();
    let program = git.to_str()?;
    let (ok, stdout, _) =
        crate::mcp::run_with_timeout(program, args, &std::env::temp_dir(), SAFE_DIR_PROBE_TIMEOUT)
            .ok()?;
    ok.then_some(stdout)
}

/// Collect `safe.directory` from the system and global scopes through
/// `probe` (injected for tests). `--get-all -z`: NUL-terminated values, so a
/// path with a newline stays whole. A scope with no entries exits 1 → none.
fn read_safe_directories(probe: impl Fn(&[&str]) -> Option<String>) -> Vec<String> {
    let mut dirs = Vec::new();
    for scope in ["--system", "--global"] {
        if let Some(out) = probe(&["config", scope, "-z", "--get-all", "safe.directory"]) {
            // An empty value (a list reset) is kept: "\0" → [""].
            dirs.extend(out.split_terminator('\0').map(str::to_string));
        }
    }
    dirs
}

/// Config (key, value) overrides that disable every repo-local `filter.<x>`
/// and `diff.<x>` driver (covering local, worktree, and included config), so
/// viewing changes never runs a repo-supplied clean/smudge/process filter or
/// diff textconv/command hook (these fire implicitly on `git status`/`git diff`
/// through `.gitattributes`). We enumerate keys with --includes (to follow
/// include.path/includeIf) from both --local and --worktree scopes, then blank
/// the code-executing sub-keys and force `filter.<x>.required=false` so a
/// still-referenced-but-disabled filter can't make the command fail.
/// Enumeration failure is an error (fail-closed). Public for reuse by fetch.
/// Returned as (key, value) pairs to be applied via GIT_CONFIG_COUNT env vars,
/// which prevents subsection names containing '=' from being misparsed.
pub(crate) fn local_exec_neutralisers(root: &Path) -> Result<Vec<(String, String)>, String> {
    fn collect_names(
        root: &Path,
        scope: &str,
    ) -> Result<(BTreeSet<String>, BTreeSet<String>), String> {
        let mut cmd = git_command(root)?;
        cmd.env("LC_ALL", "C").env("LANG", "C").args([
            "config",
            scope,
            "--includes",
            "--name-only",
            "--get-regexp",
            r"^(filter|diff)\.",
        ]);
        let output = cmd
            .output()
            .map_err(|e| format!("failed to enumerate {scope} config: {e}"))?;
        if !output.status.success() {
            let code = output.status.code();
            let stderr = String::from_utf8_lossy(&output.stderr);
            if code == Some(1) && output.stdout.is_empty() {
                return Ok((BTreeSet::new(), BTreeSet::new()));
            }
            if stderr.contains("not a git repository")
                || stderr.contains("can only be used inside a git repository")
                || (code == Some(128)
                    && stderr.contains("cannot be used with multiple working trees")
                    && stderr.contains("worktreeConfig"))
            {
                return Ok((BTreeSet::new(), BTreeSet::new()));
            }
            return Err(format!("{scope} config enumeration failed: exit {code:?}"));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let mut filters = BTreeSet::new();
        let mut diffs = BTreeSet::new();
        for line in text.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("filter.") {
                if let Some((name, sub)) = rest.rsplit_once('.') {
                    if !name.is_empty()
                        && matches!(sub, "clean" | "smudge" | "process" | "required")
                    {
                        filters.insert(name.to_string());
                    }
                }
            } else if let Some(rest) = line.strip_prefix("diff.") {
                if let Some((name, sub)) = rest.rsplit_once('.') {
                    if !name.is_empty() && matches!(sub, "command" | "textconv") {
                        diffs.insert(name.to_string());
                    }
                }
            }
        }
        Ok((filters, diffs))
    }

    let (mut filters, mut diffs) = collect_names(root, "--local")?;
    let (wf, wd) = collect_names(root, "--worktree")?;
    filters.extend(wf);
    diffs.extend(wd);

    let mut pairs = Vec::new();
    for f in filters {
        pairs.push((format!("filter.{f}.clean"), String::new()));
        pairs.push((format!("filter.{f}.smudge"), String::new()));
        pairs.push((format!("filter.{f}.process"), String::new()));
        pairs.push((format!("filter.{f}.required"), "false".to_string()));
    }
    for d in diffs {
        pairs.push((format!("diff.{d}.command"), String::new()));
        pairs.push((format!("diff.{d}.textconv"), String::new()));
    }
    Ok(pairs)
}

/// Apply config overrides via GIT_CONFIG_COUNT/KEY/VALUE env vars. Key and
/// value are transported separately, so a subsection name containing '=' is
/// carried verbatim and cannot be misparsed as a key/value split.
fn apply_config_env(cmd: &mut Command, overrides: &[(String, String)]) {
    if overrides.is_empty() {
        return;
    }
    cmd.env("GIT_CONFIG_COUNT", overrides.len().to_string());
    for (i, (key, value)) in overrides.iter().enumerate() {
        cmd.env(format!("GIT_CONFIG_KEY_{i}"), key);
        cmd.env(format!("GIT_CONFIG_VALUE_{i}"), value);
    }
}

/// Deadline for every read-only git invocation.
const READ_GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Run a read-only git command and return its full `Output` (never fails on a
/// non-zero exit — the caller decides). This is the single builder used by
/// every git invocation, so all of them get the same environment, config, and
/// driver overrides, plus a timeout to prevent repository content from blocking
/// forever.
fn run_git_raw(root: &Path, args: &[&str]) -> Result<Output, String> {
    let mut cmd = git_command(root)?;
    let neutralisers = local_exec_neutralisers(root)?;
    apply_config_env(&mut cmd, &neutralisers);
    cmd.args(args);
    let cwd = cmd
        .get_current_dir()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| root.to_path_buf());
    let outcome = crate::mcp::run_command_with_timeout(cmd, &cwd, READ_GIT_TIMEOUT)?;
    match outcome {
        crate::mcp::CliOutcome::Exited {
            code,
            stdout,
            stderr,
        } => {
            #[cfg(unix)]
            let status = {
                use std::os::unix::process::ExitStatusExt;
                match code {
                    Some(c) => std::process::ExitStatus::from_raw((c & 0xff) << 8),
                    None => std::process::ExitStatus::from_raw(0x09),
                }
            };
            #[cfg(not(unix))]
            let status = {
                use std::os::windows::process::ExitStatusExt;
                std::process::ExitStatus::from_raw(code.map(|c| c as u32).unwrap_or(1))
            };
            Ok(Output {
                status,
                stdout: stdout.into_bytes(),
                stderr: stderr.into_bytes(),
            })
        }
        _ => Err("git command failed".to_string()),
    }
}

pub(crate) fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = run_git_raw(root, args)?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if err.is_empty() {
            return Err("git command failed (no stderr)".to_string());
        }
        return Err(err);
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn map_status_code(code: &str) -> &'static str {
    // Two-char XY code from `git status --porcelain`; classify by the more
    // meaningful of the pair.
    if code.contains('?') {
        return "untracked";
    }
    if code.contains('D') {
        return "deleted";
    }
    if code.contains('A') {
        return "added";
    }
    if code.contains('R') {
        return "renamed";
    }
    "modified"
}

/// Working-tree status for `root`. Returns `is_repo: false` (not an error) when
/// the folder isn't a git repo, so the UI can show a friendly empty state.
///
/// `async` + `spawn_blocking`: a synchronous `#[tauri::command]` runs on the
/// main thread in Tauri 2, so a remote session's blocking ssh call — or a slow
/// local `git status` on a huge tree — would freeze the UI. The frontend
/// already `invoke`s this asynchronously.
#[tauri::command]
pub async fn git_status(
    webview_window: tauri::WebviewWindow,
    root: String,
) -> Result<GitStatus, String> {
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        git_status_impl(root)
    })
    .await
    .map_err(|e| format!("git_status task failed: {e}"))?
}

/// Synchronous body of [`git_status`]. Split out so in-process callers (the
/// MCP tools) and tests can invoke the blocking git logic directly instead of
/// going through a Tauri async runtime.
pub(crate) fn git_status_impl(root: String) -> Result<GitStatus, String> {
    if crate::remote::is_active() {
        return crate::remote::git_status(&root);
    }
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    // Cheap repo check; if it fails, report not-a-repo rather than erroring.
    if run_git(root_path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(GitStatus {
            is_repo: false,
            branch: None,
            top_level: None,
            changes: vec![],
        });
    }

    let top_level = run_git(root_path, &["rev-parse", "--show-toplevel"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|canonical| top_level_in_root_spelling(root_path, canonical));

    let branch = run_git(root_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Porcelain v1, NUL-terminated so paths with spaces/newlines are safe.
    let raw = run_git(
        root_path,
        &[
            "status",
            "--ignore-submodules=all",
            "--porcelain",
            "-z",
            "--untracked-files=all",
        ],
    )?;

    Ok(GitStatus {
        is_repo: true,
        branch,
        top_level,
        changes: parse_porcelain(&raw),
    })
}

/// The repo top level spelled the way the caller spelled `root`.
///
/// `git rev-parse --show-toplevel` answers in canonical form: a workspace
/// opened through a symlink (macOS `/tmp` -> `/private/tmp`, a symlinked home
/// or `~/Projects`) gets `/private/tmp/x` back while every tab and tree path
/// uses `/tmp/x`, so no change path matched an open file (Diff mode off,
/// badges and the review queue out of step). `--show-cdup` is the relative
/// way up from `root` to the top level; joined lexically onto `root` it keeps
/// the caller's spelling. The result must resolve to the same directory as
/// git's answer (a symlink BELOW the top level would make the lexical walk
/// land elsewhere); otherwise, or if git fails, the canonical path is kept.
fn top_level_in_root_spelling(root: &Path, canonical: String) -> String {
    let Ok(cdup) = run_git(root, &["rev-parse", "--show-cdup"]) else {
        return canonical;
    };
    let joined = lexical_join(root, cdup.trim());
    match (joined.canonicalize(), Path::new(&canonical).canonicalize()) {
        (Ok(a), Ok(b)) if a == b => joined.to_string_lossy().into_owned(),
        _ => canonical,
    }
}

/// `base` joined with `rel`, with `.` and `..` resolved lexically (no
/// filesystem access, so symlinks in `base` keep their spelling).
fn lexical_join(base: &Path, rel: &str) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in base.join(rel).components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c.as_os_str()),
        }
    }
    out
}

/// POSIX-string form of [`lexical_join`] for paths on a remote (SSH) host,
/// where local `Path` rules (e.g. Windows separators) must not apply. `base`
/// is absolute; the result is absolute with no trailing slash.
pub(crate) fn lexical_join_posix(base: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in base.split('/').chain(rel.split('/')) {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    format!("/{}", parts.join("/"))
}

/// Parse NUL-separated `git status --porcelain -z` output into changes.
/// Pure (no git), so it's unit-testable. A rename OR copy record ("R  new" /
/// "C  new") is followed by a second NUL field (the old/source path); either
/// status column can carry the R/C, and the paired field must be consumed in
/// every such case or the stream desyncs and the next path is misread. Slicing
/// uses `get(..)` so a multibyte path can never panic (which, with
/// `panic="abort"`, would kill the app) — malformed entries are skipped.
pub(crate) fn parse_porcelain(raw: &str) -> Vec<GitChange> {
    let mut changes = Vec::new();
    let mut parts = raw.split('\0');
    while let Some(entry) = parts.next() {
        // "XY path": two status columns, a separator, then the path.
        let Some(code) = entry.get(..2) else {
            continue;
        };
        let Some(path) = entry.get(3..) else {
            continue;
        };
        // Staged = the index (first) column is not space and not '?'.
        let staged = code.starts_with(|c: char| c != ' ' && c != '?');
        // Rename/copy in EITHER column carries a paired path field to consume.
        let mut cols = code.chars();
        let x = cols.next().unwrap_or(' ');
        let y = cols.next().unwrap_or(' ');
        if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            let _ = parts.next(); // consume the paired old/source-path field
        }
        // A trailing separator marks a directory entry (nested repo, #47).
        let is_dir = path.ends_with('/');
        let path = path.trim_end_matches('/');
        if path.is_empty() {
            continue;
        }
        changes.push(GitChange {
            path: path.to_string(),
            status: map_status_code(code).to_string(),
            staged,
            is_dir,
        });
    }
    changes
}

/// Branch and upstream sync state for the status bar ("main ↑1 ↓2").
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct GitBranchStatus {
    /// Branch name; the short commit id when HEAD is detached; `None` when
    /// the folder is not a repo or HEAD has no commit yet.
    pub branch: Option<String>,
    /// HEAD is detached (`branch` then holds a short commit id).
    pub detached: bool,
    /// The branch tracks an upstream (`ahead` / `behind` are only
    /// meaningful when this is true).
    pub has_upstream: bool,
    /// Commits on HEAD that the upstream does not have.
    pub ahead: u32,
    /// Commits on the upstream that HEAD does not have.
    pub behind: u32,
}

/// Parse `git rev-list --left-right --count @{u}...HEAD`: "<left>\t<right>",
/// where left = commits only on the upstream (behind) and right = commits
/// only on HEAD (ahead). Returns `(behind, ahead)`; `None` for anything else.
pub(crate) fn parse_left_right_count(raw: &str) -> Option<(u32, u32)> {
    let mut fields = raw.split_whitespace();
    let behind = fields.next()?.parse().ok()?;
    let ahead = fields.next()?.parse().ok()?;
    if fields.next().is_some() {
        return None;
    }
    Some((behind, ahead))
}

/// Build the branch status from the raw answers of the three git questions
/// (each `None` when that git call failed). Pure, so local and remote share
/// it and it is unit-testable:
/// - `abbrev`: `rev-parse --abbrev-ref HEAD` ("HEAD" when detached)
/// - `short_head`: `rev-parse --short HEAD` (asked only when detached)
/// - `counts`: `rev-list --left-right --count @{u}...HEAD` (fails without an
///   upstream)
pub(crate) fn branch_status_from(
    abbrev: Option<&str>,
    short_head: Option<&str>,
    counts: Option<&str>,
) -> GitBranchStatus {
    let clean = |s: Option<&str>| {
        s.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let Some(name) = clean(abbrev) else {
        return GitBranchStatus::default();
    };
    if name == "HEAD" {
        // Detached: no branch, so no upstream either.
        return GitBranchStatus {
            branch: clean(short_head),
            detached: true,
            ..GitBranchStatus::default()
        };
    }
    let sync = counts.and_then(parse_left_right_count);
    GitBranchStatus {
        branch: Some(name),
        detached: false,
        has_upstream: sync.is_some(),
        ahead: sync.map_or(0, |(_, ahead)| ahead),
        behind: sync.map_or(0, |(behind, _)| behind),
    }
}

/// Current branch and how far it is ahead of / behind its upstream. Read-only
/// (`rev-parse` / `rev-list`), through the same hardened runner as status.
/// A folder that is not a repo answers with `branch: None`, not an error.
///
/// `async` + `spawn_blocking` for the same reason as [`git_status`].
#[tauri::command]
pub async fn git_branch_status(
    webview_window: tauri::WebviewWindow,
    root: String,
) -> Result<GitBranchStatus, String> {
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        git_branch_status_impl(root)
    })
    .await
    .map_err(|e| format!("git_branch_status task failed: {e}"))?
}

pub(crate) fn git_branch_status_impl(root: String) -> Result<GitBranchStatus, String> {
    if crate::remote::is_active() {
        return crate::remote::git_branch_status(&root);
    }
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let abbrev = run_git(root_path, &["rev-parse", "--abbrev-ref", "HEAD"]).ok();
    let detached = abbrev.as_deref().map(str::trim) == Some("HEAD");
    let short_head = if detached {
        run_git(root_path, &["rev-parse", "--short", "HEAD"]).ok()
    } else {
        None
    };
    let counts = if abbrev.is_some() && !detached {
        run_git(
            root_path,
            &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
        )
        .ok()
    } else {
        None
    };
    Ok(branch_status_from(
        abbrev.as_deref(),
        short_head.as_deref(),
        counts.as_deref(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_join_posix_resolves_dots_without_fs() {
        assert_eq!(lexical_join_posix("/tmp/x", ""), "/tmp/x");
        assert_eq!(lexical_join_posix("/tmp/x/", ""), "/tmp/x");
        assert_eq!(lexical_join_posix("/tmp/x/sub/dir", "../../"), "/tmp/x");
        assert_eq!(lexical_join_posix("/tmp/./x/sub", ".."), "/tmp/x");
        assert_eq!(lexical_join_posix("/a", "../../.."), "/");
    }

    #[cfg(unix)]
    #[test]
    fn lexical_join_keeps_symlink_spelling() {
        let p = lexical_join(Path::new("/tmp/x/sub/dir/"), "../../");
        assert_eq!(p, PathBuf::from("/tmp/x"));
        assert_eq!(
            lexical_join(Path::new("/tmp/x"), ""),
            PathBuf::from("/tmp/x")
        );
    }

    /// A workspace opened through a symlink (macOS `/tmp` -> `/private/tmp`)
    /// must get the top level back in the spelling it was opened with, or no
    /// change path matches an open tab (Diff mode stays disabled).
    #[cfg(unix)]
    #[test]
    fn git_status_top_level_uses_symlink_spelling() {
        use std::fs;

        let git = git_bin();
        if crate::proc::command(&git)
            .arg("--version")
            .status()
            .map(|s| !s.success())
            .unwrap_or(true)
        {
            return;
        }
        let _guard = crate::remote::TEST_SESSION_LOCK.lock().unwrap();
        let base =
            std::env::temp_dir().join(format!("sparkdown_git_symlink_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        // Canonical base, so the only symlink in play is the one made below.
        let base = base.canonicalize().unwrap();
        let real = base.join("real");
        fs::create_dir_all(real.join("sub/deep")).unwrap();
        let run = |args: &[&str]| {
            let ok = crate::proc::command(&git)
                .current_dir(&real)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .args(args)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            assert!(ok, "setup: git {args:?} failed");
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@example.com"]);
        run(&["config", "user.name", "Test"]);
        fs::write(real.join("a.md"), "one\n").unwrap();
        fs::write(real.join("sub/deep/b.md"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);
        fs::write(real.join("a.md"), "two\n").unwrap();

        // `link` -> `real`: the workspace is opened as `<base>/link`.
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        // A symlink INTO the repo (below its top level): the lexical walk up
        // would leave the repo, so the canonical top level must be kept.
        let inner = base.join("inner");
        std::os::unix::fs::symlink(real.join("sub/deep"), &inner).unwrap();

        let at_root = git_status_impl(link.to_string_lossy().into_owned());
        let at_sub = git_status_impl(link.join("sub/deep").to_string_lossy().into_owned());
        let slash = git_status_impl(format!("{}/", link.to_string_lossy()));
        let below = git_status_impl(inner.to_string_lossy().into_owned());
        let _ = fs::remove_dir_all(&base);

        let link_s = link.to_string_lossy().into_owned();
        let at_root = at_root.unwrap();
        assert!(at_root.is_repo);
        assert_eq!(at_root.top_level.as_deref(), Some(link_s.as_str()));
        assert!(at_root.changes.iter().any(|c| c.path == "a.md"));
        assert_eq!(at_sub.unwrap().top_level.as_deref(), Some(link_s.as_str()));
        assert_eq!(slash.unwrap().top_level.as_deref(), Some(link_s.as_str()));
        let real_s = real.to_string_lossy().into_owned();
        assert_eq!(below.unwrap().top_level.as_deref(), Some(real_s.as_str()));
    }

    #[test]
    fn parses_left_right_counts() {
        assert_eq!(parse_left_right_count("2\t5\n"), Some((2, 5)));
        assert_eq!(parse_left_right_count("0\t0"), Some((0, 0)));
        assert_eq!(parse_left_right_count(""), None);
        assert_eq!(parse_left_right_count("3"), None);
        assert_eq!(parse_left_right_count("a\tb"), None);
        assert_eq!(parse_left_right_count("1\t2\t3"), None);
        assert_eq!(parse_left_right_count("-1\t2"), None);
    }

    #[test]
    fn branch_status_with_upstream() {
        let s = branch_status_from(Some("main\n"), None, Some("1\t3\n"));
        assert_eq!(
            s,
            GitBranchStatus {
                branch: Some("main".into()),
                detached: false,
                has_upstream: true,
                ahead: 3,
                behind: 1,
            }
        );
    }

    #[test]
    fn branch_status_without_upstream_or_repo() {
        let s = branch_status_from(Some("feature/x"), None, None);
        assert_eq!(s.branch.as_deref(), Some("feature/x"));
        assert!(!s.has_upstream);
        assert_eq!((s.ahead, s.behind), (0, 0));
        // Garbage count output is "no upstream", never a panic.
        assert!(!branch_status_from(Some("main"), None, Some("fatal")).has_upstream);
        // Not a repo / no commits yet: nothing to show.
        assert_eq!(
            branch_status_from(None, None, None),
            GitBranchStatus::default()
        );
        assert_eq!(
            branch_status_from(Some("  \n"), None, None),
            GitBranchStatus::default()
        );
    }

    #[test]
    fn branch_status_detached_head() {
        let s = branch_status_from(Some("HEAD\n"), Some("431cb0f\n"), Some("0\t1"));
        assert!(s.detached);
        assert_eq!(s.branch.as_deref(), Some("431cb0f"));
        assert!(!s.has_upstream, "a detached HEAD has no upstream");
    }

    #[test]
    fn branch_status_reads_a_real_repo() {
        let dir = std::env::temp_dir().join(format!("sd-branch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        let git = |args: &[&str]| run_git(&dir, args);
        if git(&["init", "-q", "-b", "trunk"]).is_err() {
            return; // no usable git on this machine
        }
        // Empty repo: HEAD has no commit, so no branch is shown.
        assert_eq!(git_branch_status_impl(root.clone()).unwrap().branch, None);
        std::fs::write(dir.join("a.md"), "a").unwrap();
        git(&["add", "a.md"]).unwrap();
        git(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-q",
            "-m",
            "a",
        ])
        .unwrap();
        let s = git_branch_status_impl(root.clone()).unwrap();
        assert_eq!(s.branch.as_deref(), Some("trunk"));
        assert!(!s.has_upstream);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn classifies_status_codes() {
        assert_eq!(map_status_code("??"), "untracked");
        assert_eq!(map_status_code(" M"), "modified");
        assert_eq!(map_status_code("M "), "modified");
        assert_eq!(map_status_code("A "), "added");
        assert_eq!(map_status_code(" D"), "deleted");
        assert_eq!(map_status_code("R "), "renamed");
    }

    #[test]
    fn parses_porcelain_records() {
        // " M file", "?? new", "A  staged" joined NUL, trailing NUL.
        let raw = " M src/app.ts\0?? notes.md\0A  src/git.rs\0";
        let changes = parse_porcelain(raw);
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].path, "src/app.ts");
        assert_eq!(changes[0].status, "modified");
        assert!(!changes[0].staged);
        assert_eq!(changes[1].status, "untracked");
        assert_eq!(changes[2].status, "added");
        assert!(changes[2].staged);
    }

    #[test]
    fn nested_repo_is_a_directory_entry() {
        // #47: git lists an untracked nested repo as "?? proj/" (it does not
        // descend into it). It must come back as a directory, path without
        // the slash, so the UI never opens it as a file tab.
        let raw = "?? proj/\0?? notes.md\0?? a/b/inner/\0";
        let changes = parse_porcelain(raw);
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].path, "proj");
        assert!(changes[0].is_dir);
        assert_eq!(changes[0].status, "untracked");
        assert_eq!(changes[1].path, "notes.md");
        assert!(!changes[1].is_dir);
        assert_eq!(changes[2].path, "a/b/inner");
        assert!(changes[2].is_dir);
    }

    #[cfg(unix)]
    #[test]
    fn real_git_reports_untracked_nested_repo_as_dir() {
        use std::fs;
        let git = git_bin();
        let base =
            std::env::temp_dir().join(format!("sparkdown_git_nested_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("proj")).unwrap();
        let base = base.canonicalize().unwrap();
        let run = |dir: &std::path::Path, args: &[&str]| {
            let ok = crate::proc::command(&git)
                .current_dir(dir)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .args(args)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            assert!(ok, "setup: git {args:?} failed");
        };
        run(&base, &["init", "-q"]);
        run(&base.join("proj"), &["init", "-q"]);
        fs::write(base.join("proj/inside.md"), "x\n").unwrap();
        fs::write(base.join("top.md"), "x\n").unwrap();
        let status = git_status_impl(base.to_string_lossy().into_owned());
        let _ = fs::remove_dir_all(&base);
        let status = status.unwrap();
        let proj = status.changes.iter().find(|c| c.path == "proj");
        assert!(
            proj.is_some_and(|c| c.is_dir),
            "{:?}",
            status
                .changes
                .iter()
                .map(|c| (&c.path, c.is_dir))
                .collect::<Vec<_>>()
        );
        assert!(status
            .changes
            .iter()
            .any(|c| c.path == "top.md" && !c.is_dir));
        assert!(!status.changes.iter().any(|c| c.path.contains("inside.md")));
    }

    #[test]
    fn rename_consumes_old_path_field() {
        // "R  new\0old\0?? other" — the old-path field must be skipped so
        // "other" isn't misread as a change record.
        let raw = "R  src/new.ts\0src/old.ts\0?? other.md\0";
        let changes = parse_porcelain(raw);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].status, "renamed");
        assert_eq!(changes[0].path, "src/new.ts");
        assert_eq!(changes[1].path, "other.md");
        assert_eq!(changes[1].status, "untracked");
    }

    #[test]
    fn copy_and_second_column_rename_consume_paired_field() {
        // A copy ("C  dst\0src") and a second-column rename (" R new\0old")
        // both carry a paired path field; if it isn't consumed, the following
        // record is misread. Assert the trailing "?? other" survives intact.
        let raw = "C  dst.ts\0src.ts\0 R new.ts\0old.ts\0?? other.md\0";
        let changes = parse_porcelain(raw);
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].path, "dst.ts");
        assert_eq!(changes[1].status, "renamed");
        assert_eq!(changes[1].path, "new.ts");
        assert_eq!(changes[2].path, "other.md");
        assert_eq!(changes[2].status, "untracked");
    }

    #[test]
    fn non_ascii_paths_parse_without_panicking() {
        // Multibyte bytes just after the 2-char code must not cause a panic
        // (panic="abort" would kill the app) or corrupt the path.
        let raw = " M café/résumé.txt\0?? naïve.md\0R  münchen.rs\0köln.rs\0";
        let changes = parse_porcelain(raw);
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].path, "café/résumé.txt");
        assert_eq!(changes[0].status, "modified");
        assert_eq!(changes[1].path, "naïve.md");
        assert_eq!(changes[2].path, "münchen.rs");
        assert_eq!(changes[2].status, "renamed");
    }

    #[test]
    fn hardened_git_neutralises_malicious_local_filter() {
        use std::fs;
        use std::sync::atomic::{AtomicU32, Ordering};

        let git = git_bin();
        // Skip gracefully if git isn't runnable in this environment.
        if crate::proc::command(&git)
            .arg("--version")
            .status()
            .map(|s| !s.success())
            .unwrap_or(true)
        {
            return;
        }

        static N: AtomicU32 = AtomicU32::new(0);
        let id = N.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("sparkdown_git_it_{}_{}", std::process::id(), id));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let run = |args: &[&str]| {
            let ok = crate::proc::command(&git)
                .current_dir(&dir)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .env("GIT_TERMINAL_PROMPT", "0")
                .args(args)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            assert!(ok, "setup: git {args:?} failed");
        };

        run(&["init", "-q"]);
        run(&["config", "user.email", "t@example.com"]);
        run(&["config", "user.name", "Test"]);

        // Commit a tracked file with no filter attribute yet.
        fs::write(dir.join("data.txt"), "one\n").unwrap();
        run(&["add", "data.txt"]);
        run(&["commit", "-q", "-m", "init"]);

        // Wire a malicious repo-local clean filter that touches a marker file,
        // bind it via .gitattributes, and dirty the file (different size, so
        // git must re-hash it and run the clean filter).
        let marker = dir.join("PWNED");
        let clean = format!("touch {} && cat", marker.display());
        run(&["config", "--local", "filter.evil.clean", &clean]);
        run(&["config", "--local", "filter.evil.smudge", "cat"]);
        fs::write(dir.join(".gitattributes"), "data.txt filter=evil\n").unwrap();
        fs::write(dir.join("data.txt"), "changed contents\n").unwrap();

        // Control: plain `git diff` honours the local filter and
        // creates the marker (it must clean the working file to diff it) —
        // proving the attack is real and the test below isn't vacuous.
        let _ = fs::remove_file(&marker);
        let _ = crate::proc::command(&git)
            .current_dir(&dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .args(["diff", "--no-color", "HEAD", "--", "data.txt"])
            .output();
        let control_fired = marker.exists();
        let _ = fs::remove_file(&marker);

        // Hardened path (the code under test): must NOT run the clean filter.
        let out = run_git(
            &dir,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--ignore-submodules=all",
                "HEAD",
                "--",
                "data.txt",
            ],
        );
        let marker_after = marker.exists();
        let _ = fs::remove_dir_all(&dir);

        assert!(out.is_ok(), "hardened status errored: {:?}", out.err());
        assert!(
            !marker_after,
            "malicious clean filter executed under hardened git"
        );
        assert!(
            control_fired,
            "control run did not trigger the filter; test is inconclusive"
        );
    }

    #[test]
    fn safe_directories_are_read_system_then_global() {
        let seen = std::cell::RefCell::new(Vec::new());
        let dirs = read_safe_directories(|args| {
            seen.borrow_mut().push(args.join(" "));
            match args[1] {
                "--system" => Some("/srv/shared\0".to_string()),
                // A reset (empty value), a path with a newline, then `*`.
                "--global" => Some("\0/home/u/odd\nname\0*\0".to_string()),
                _ => None,
            }
        });
        assert_eq!(dirs, vec!["/srv/shared", "", "/home/u/odd\nname", "*"]);
        assert_eq!(
            *seen.borrow(),
            vec![
                "config --system -z --get-all safe.directory",
                "config --global -z --get-all safe.directory"
            ]
        );
        // No entries / probe failure / timeout: nothing added.
        assert!(read_safe_directories(|_| None).is_empty());
        assert!(read_safe_directories(|_| Some(String::new())).is_empty());
    }

    #[test]
    fn hardened_git_honours_user_safe_directory_only() {
        use std::fs;

        let git = git_bin();
        if crate::proc::command(&git)
            .arg("--version")
            .status()
            .map(|s| !s.success())
            .unwrap_or(true)
        {
            return;
        }
        let base = std::env::temp_dir().join(format!("sparkdown_git_safe_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let repo = base.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let repo = repo.canonicalize().unwrap();
        let ok = crate::proc::command(&git)
            .current_dir(&repo)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args(["init", "-q"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "git init failed");

        // Fake global config: the repo is a safe.directory, plus a key that
        // must NOT leak into the hardened invocations.
        let global = base.join("gitconfig");
        let repo_str = repo.to_str().unwrap().replace('\\', "/");
        fs::write(
            &global,
            format!("[safe]\n\tdirectory = {repo_str}\n[user]\n\tname = Leaked Name\n"),
        )
        .unwrap();
        let probe = |args: &[&str]| -> Option<String> {
            let out = crate::proc::command(&git)
                .current_dir(&base)
                .env("GIT_CONFIG_GLOBAL", &global)
                // `--system` reads the system file even with NOSYSTEM set
                // (CI runners ship `safe.directory = *` there): point it away.
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .args(args)
                .output()
                .ok()?;
            out.status
                .success()
                .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
        };
        let dirs = read_safe_directories(probe);
        assert_eq!(dirs, vec![repo_str.clone()]);

        // git's test hook makes it treat the repo as owned by someone else,
        // so the ownership check runs without a second user account.
        let rev_parse = |safe: &[String]| {
            let mut cmd = git_command_with(&repo, safe).unwrap();
            cmd.env("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1")
                .args(["rev-parse", "--is-inside-work-tree"]);
            cmd.output().unwrap()
        };
        let control = rev_parse(&[]);
        if control.status.success() {
            // This git has no ownership test hook: inconclusive, skip.
            eprintln!("skip: git ignores GIT_TEST_ASSUME_DIFFERENT_OWNER");
            let _ = fs::remove_dir_all(&base);
            return;
        }
        let err = String::from_utf8_lossy(&control.stderr);
        assert!(err.contains("dubious ownership"), "{err}");

        let out = rev_parse(&dirs);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "true");

        // Only safe.directory is carried over: the fake global's user.name
        // is not visible to the hardened git.
        let mut cmd = git_command_with(&repo, &dirs).unwrap();
        let name = cmd.args(["config", "user.name"]).output().unwrap();
        assert!(!String::from_utf8_lossy(&name.stdout).contains("Leaked"));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn git_diff_file_sanitizes_and_constrains_paths() {
        // This tests the constrained canonical path logic (unit-testable via
        // the sync `_impl`; full integration needs a temp git repo).
        // Malicious paths are rejected; relative paths are normalized to repo root.
        let bad = git_diff_file_impl("/tmp".to_string(), "/etc/passwd".to_string(), false);
        assert!(bad.is_err());

        let bad2 = git_diff_file_impl("/tmp".to_string(), "../etc/passwd".to_string(), false);
        assert!(bad2.is_err());
    }

    #[test]
    fn git_neutralises_filter_name_with_equals() {
        use std::fs;

        let git = git_bin();
        let base =
            std::env::temp_dir().join(format!("sparkdown_filter_equals_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let repo = base.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let repo = repo.canonicalize().unwrap();

        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["init", "-q"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["config", "user.name", "test"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["config", "user.email", "test@example.com"])
            .status()
            .unwrap();

        let marker = base.join("marker");
        let marker_script = base.join("script.sh");
        fs::write(
            &marker_script,
            format!("#!/bin/sh\ntouch {}\ncat\n", marker.display()),
        )
        .unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&marker_script, fs::Permissions::from_mode(0o755)).unwrap();
        }

        crate::proc::command(&git)
            .current_dir(&repo)
            .args([
                "config",
                "filter.x=y.clean",
                marker_script.to_str().unwrap(),
            ])
            .status()
            .unwrap();

        fs::write(repo.join(".gitattributes"), "*.txt filter=x=y\n").unwrap();
        fs::write(repo.join("a.txt"), "content\n").unwrap();

        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["add", ".gitattributes", "a.txt"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["commit", "-m", "initial"])
            .status()
            .unwrap();

        let _ = fs::remove_file(&marker);

        fs::write(repo.join("a.txt"), "modified\n").unwrap();

        #[cfg(unix)]
        {
            let control = crate::proc::command(&git)
                .current_dir(&repo)
                .args(["diff", "HEAD", "--", "a.txt"])
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(control.status.success());
            assert!(
                marker.exists(),
                "control: plain git diff must run filter with '=' in name"
            );
            let _ = fs::remove_file(&marker);
        }

        let _ = run_git(&repo, &["diff", "HEAD", "--", "a.txt"]);
        assert!(
            !marker.exists(),
            "filter with '=' in name ran despite neutraliser"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(unix)]
    fn git_diff_against_fifo_returns_within_timeout() {
        use std::fs;

        let git = git_bin();
        let base = std::env::temp_dir().join(format!("sparkdown_fifo_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let repo = base.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let repo = repo.canonicalize().unwrap();

        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["init", "-q"])
            .status()
            .unwrap();

        fs::write(repo.join("regular.txt"), "content\n").unwrap();

        let fifo = repo.join("pipe");
        crate::proc::command("mkfifo").arg(&fifo).status().unwrap();

        let start = std::time::Instant::now();
        let result = git_diff_file_impl(
            repo.to_string_lossy().into_owned(),
            "pipe".to_string(),
            true,
        );
        let elapsed = start.elapsed();

        assert!(result.is_err(), "diff against FIFO should fail");
        assert!(
            elapsed < READ_GIT_TIMEOUT,
            "diff should return before timeout"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(unix)]
    fn git_neutralises_filter_from_include_path() {
        use std::fs;

        let git = git_bin();
        let base =
            std::env::temp_dir().join(format!("sparkdown_include_filter_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let repo = base.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let repo = repo.canonicalize().unwrap();

        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["init", "-q"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["config", "user.name", "test"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["config", "user.email", "test@example.com"])
            .status()
            .unwrap();

        let included = base.join("included.gitconfig");
        let marker = base.join("marker");
        let marker_script = base.join("script.sh");
        fs::write(
            &marker_script,
            format!("#!/bin/sh\ntouch {}\ncat\n", marker.display()),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&marker_script, fs::Permissions::from_mode(0o755)).unwrap();
        }

        fs::write(
            &included,
            format!(
                "[filter \"external\"]\n\tclean = {}\n",
                marker_script.display()
            ),
        )
        .unwrap();

        crate::proc::command(&git)
            .current_dir(&repo)
            .args([
                "config",
                "--local",
                "include.path",
                included.to_str().unwrap(),
            ])
            .status()
            .unwrap();

        fs::write(repo.join(".gitattributes"), "*.txt filter=external\n").unwrap();
        fs::write(repo.join("a.txt"), "content\n").unwrap();
        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["add", ".gitattributes", "a.txt"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["commit", "-m", "initial"])
            .status()
            .unwrap();

        let _ = fs::remove_file(&marker);
        fs::write(repo.join("a.txt"), "modified\n").unwrap();

        {
            let control = crate::proc::command(&git)
                .current_dir(&repo)
                .args(["diff", "HEAD", "--", "a.txt"])
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(control.status.success());
            assert!(
                marker.exists(),
                "control: plain git diff must run filter from include.path"
            );
            let _ = fs::remove_file(&marker);
        }

        let _ = run_git(&repo, &["diff", "HEAD", "--", "a.txt"]);
        assert!(
            !marker.exists(),
            "filter from include.path ran despite neutraliser"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(unix)]
    fn git_neutralises_filter_from_worktree_config() {
        use std::fs;

        let git = git_bin();
        let base =
            std::env::temp_dir().join(format!("sparkdown_worktree_filter_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let repo = base.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let repo = repo.canonicalize().unwrap();

        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["init", "-q"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["config", "user.name", "test"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["config", "user.email", "test@example.com"])
            .status()
            .unwrap();

        let marker = base.join("marker");
        let marker_script = base.join("script.sh");
        fs::write(
            &marker_script,
            format!("#!/bin/sh\ntouch {}\ncat\n", marker.display()),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&marker_script, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let set_ext_status = crate::proc::command(&git)
            .current_dir(&repo)
            .args(["config", "extensions.worktreeConfig", "true"])
            .status()
            .unwrap();
        assert!(
            set_ext_status.success(),
            "failed to set extensions.worktreeConfig"
        );

        let set_filter_status = crate::proc::command(&git)
            .current_dir(&repo)
            .args([
                "config",
                "--worktree",
                "filter.wt.clean",
                marker_script.to_str().unwrap(),
            ])
            .status()
            .unwrap();
        assert!(set_filter_status.success(), "failed to set worktree filter");

        let worktree_config = repo.join(".git/config.worktree");
        assert!(
            worktree_config.exists(),
            "worktree config must exist in .git/config.worktree"
        );
        let wt_content = fs::read_to_string(&worktree_config).unwrap();
        assert!(
            wt_content.contains("[filter \"wt\"]") && wt_content.contains("clean ="),
            "worktree filter must be in .git/config.worktree, got: {}",
            wt_content
        );

        fs::write(repo.join(".gitattributes"), "*.txt filter=wt\n").unwrap();
        fs::write(repo.join("a.txt"), "content\n").unwrap();
        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["add", ".gitattributes", "a.txt"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&repo)
            .args(["commit", "-m", "initial"])
            .status()
            .unwrap();

        let _ = fs::remove_file(&marker);
        fs::write(repo.join("a.txt"), "modified\n").unwrap();

        {
            let control = crate::proc::command(&git)
                .current_dir(&repo)
                .args(["diff", "HEAD", "--", "a.txt"])
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(control.status.success());
            assert!(
                marker.exists(),
                "control: plain git diff must run filter from worktree config"
            );
            let _ = fs::remove_file(&marker);
        }

        let _ = run_git(&repo, &["diff", "HEAD", "--", "a.txt"]);
        assert!(
            !marker.exists(),
            "filter from worktree config ran despite neutraliser"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(unix)]
    fn git_diff_does_not_trigger_lazy_fetch_uploadpack() {
        use std::fs;

        let git = git_bin();
        let base =
            std::env::temp_dir().join(format!("sparkdown_lazy_fetch_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        let source = base.join("source");
        fs::create_dir_all(&source).unwrap();
        crate::proc::command(&git)
            .current_dir(&source)
            .args(["init", "-q"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&source)
            .args(["config", "user.name", "test"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&source)
            .args(["config", "user.email", "test@example.com"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&source)
            .args(["config", "uploadpack.allowFilter", "true"])
            .status()
            .unwrap();

        fs::write(source.join("a.txt"), "initial\n").unwrap();
        crate::proc::command(&git)
            .current_dir(&source)
            .args(["add", "a.txt"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&source)
            .args(["commit", "-m", "initial"])
            .status()
            .unwrap();

        fs::write(source.join("a.txt"), "modified\n").unwrap();
        crate::proc::command(&git)
            .current_dir(&source)
            .args(["add", "a.txt"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&source)
            .args(["commit", "-m", "modify"])
            .status()
            .unwrap();

        let clone = base.join("clone");
        let source_url = format!("file://{}", source.display());
        crate::proc::command(&git)
            .current_dir(&base)
            .args([
                "clone",
                "--filter=blob:none",
                &source_url,
                clone.to_str().unwrap(),
            ])
            .status()
            .unwrap();

        let marker = base.join("uploadpack-ran");
        let marker_script = base.join("uploadpack.sh");
        fs::write(
            &marker_script,
            format!(
                "#!/bin/sh\ntouch {}\nexec git-upload-pack \"$@\"\n",
                marker.display()
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&marker_script, fs::Permissions::from_mode(0o755)).unwrap();
        }

        crate::proc::command(&git)
            .current_dir(&clone)
            .args([
                "config",
                "--local",
                "remote.origin.uploadpack",
                marker_script.to_str().unwrap(),
            ])
            .status()
            .unwrap();

        let blob_path = clone.join(".git/objects/pack");
        if blob_path.exists() {
            for entry in fs::read_dir(&blob_path).unwrap() {
                let entry = entry.unwrap();
                if entry.path().extension().and_then(|s| s.to_str()) == Some("pack") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }

        let _ = run_git(&clone, &["diff", "HEAD~1", "--", "a.txt"]);
        assert!(
            !marker.exists(),
            "uploadpack ran during read-only diff despite lazy fetch block"
        );

        {
            let control = crate::proc::command(&git)
                .current_dir(&clone)
                .args(["diff", "HEAD~1", "--", "a.txt"])
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(control.status.success());
            assert!(
                marker.exists(),
                "control: plain git diff on partial clone must trigger lazy fetch"
            );
        }

        let _ = fs::remove_dir_all(&base);
    }

    /// Repo with one committed file and an executable `post-index-change`
    /// hook that creates `<base>/marker`. Returns `(base, repo, marker)`.
    #[cfg(unix)]
    fn repo_with_index_hook(
        name: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let git = git_bin();
        let base = std::env::temp_dir().join(format!("sparkdown_{name}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let repo = base.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let repo = repo.canonicalize().unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.name", "test"],
            vec!["config", "user.email", "test@example.com"],
        ] {
            let st = crate::proc::command(&git)
                .current_dir(&repo)
                .args(&args)
                .status()
                .unwrap();
            assert!(st.success(), "git {args:?}");
        }
        let marker = base.join("marker");
        let hook = repo.join(".git/hooks/post-index-change");
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        fs::write(&hook, format!("#!/bin/sh\ntouch {}\n", marker.display())).unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();

        fs::write(repo.join("a.txt"), "initial\n").unwrap();
        for args in [vec!["add", "a.txt"], vec!["commit", "-q", "-m", "initial"]] {
            let st = crate::proc::command(&git)
                .current_dir(&repo)
                .args(&args)
                .status()
                .unwrap();
            assert!(st.success(), "git {args:?}");
        }
        let _ = fs::remove_file(&marker);
        (base, repo, marker)
    }

    /// Give `a.txt` a modification time git has not recorded, without
    /// changing its content (use a different `secs` each time): git must refresh the index entry, which is an
    /// optional write for `status` and a required one for `update-index`.
    #[cfg(unix)]
    fn make_stat_dirty(repo: &std::path::Path, secs: u64) {
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(repo.join("a.txt"))
            .unwrap();
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs))
            .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn git_status_does_not_rewrite_the_index() {
        let git = git_bin();
        let (base, repo, _marker) = repo_with_index_hook("index_untouched");
        let index = repo.join(".git/index");

        make_stat_dirty(&repo, 1_000_000);
        let before = std::fs::read(&index).unwrap();
        let status = git_status_impl(repo.to_string_lossy().into_owned()).unwrap();
        assert!(status.changes.is_empty(), "content is unchanged");
        assert_eq!(
            std::fs::read(&index).unwrap(),
            before,
            "read-only status must not take optional locks / rewrite the index"
        );

        // Control: a plain `git status` does refresh and rewrite the index
        // for the same stat-dirty file, so the check above can fail.
        let control = crate::proc::command(&git)
            .current_dir(&repo)
            .args(["status", "--porcelain"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(control.status.success());
        assert_ne!(
            std::fs::read(&index).unwrap(),
            before,
            "control: plain git status rewrites the index"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn git_commands_do_not_run_repo_hooks() {
        let git = git_bin();
        let (base, repo, marker) = repo_with_index_hook("hooks_off");

        // `update-index --refresh` always writes the index, so the
        // post-index-change hook would fire unless hooks are switched off in
        // the command built by git_command.
        make_stat_dirty(&repo, 1_000_000);
        let out = git_command(&repo)
            .unwrap()
            .args(["update-index", "--refresh"])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(
            !marker.exists(),
            "git_command must not run the repository's hooks"
        );

        // Control: the same refresh without that setting does run the hook.
        make_stat_dirty(&repo, 2_000_000);
        let control = crate::proc::command(&git)
            .current_dir(&repo)
            .args(["update-index", "--refresh"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(control.status.success());
        assert!(marker.exists(), "control: plain update-index runs the hook");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn git_status_and_fetch_work_in_linked_worktree() {
        use std::fs;

        let git = git_bin();
        let base = std::env::temp_dir().join(format!(
            "sparkdown_linked_worktree_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let main_repo = base.join("main");
        fs::create_dir_all(&main_repo).unwrap();

        crate::proc::command(&git)
            .current_dir(&main_repo)
            .args(["init", "-q"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&main_repo)
            .args(["config", "user.name", "test"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&main_repo)
            .args(["config", "user.email", "test@example.com"])
            .status()
            .unwrap();

        fs::write(main_repo.join("a.txt"), "initial\n").unwrap();
        crate::proc::command(&git)
            .current_dir(&main_repo)
            .args(["add", "a.txt"])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&main_repo)
            .args(["commit", "-m", "initial"])
            .status()
            .unwrap();

        let linked_wt = base.join("linked");
        crate::proc::command(&git)
            .current_dir(&main_repo)
            .args([
                "worktree",
                "add",
                linked_wt.to_str().unwrap(),
                "-b",
                "feature",
            ])
            .status()
            .unwrap();

        let status = git_status_impl(linked_wt.to_string_lossy().into_owned()).unwrap();
        assert!(
            status.is_repo,
            "linked worktree must be recognized as a repo"
        );
        assert_eq!(status.branch.as_deref(), Some("feature"));

        fs::write(linked_wt.join("b.txt"), "new\n").unwrap();
        let status2 = git_status_impl(linked_wt.to_string_lossy().into_owned()).unwrap();
        assert_eq!(status2.changes.len(), 1);

        let bare = base.join("bare.git");
        crate::proc::command(&git)
            .args([
                "clone",
                "--bare",
                main_repo.to_str().unwrap(),
                bare.to_str().unwrap(),
            ])
            .status()
            .unwrap();
        crate::proc::command(&git)
            .current_dir(&linked_wt)
            .args(["remote", "set-url", "origin", bare.to_str().unwrap()])
            .status()
            .unwrap();

        let fetch_result = crate::git_write::fetch_impl(
            &linked_wt.to_string_lossy(),
            &[("GIT_TERMINAL_PROMPT", "0")],
        );
        assert!(
            !matches!(fetch_result, Ok(crate::git_write::FetchOutcome::Skipped)),
            "fetch must not be skipped in linked worktree: {fetch_result:?}"
        );

        let _ = fs::remove_dir_all(&base);
    }
}

/// Unified diff for one path in `root`'s working tree vs HEAD. For untracked
/// files (no HEAD blob) we diff against /dev/null so the whole file shows as
/// added. Returns the raw unified-diff text for the frontend to render.
///
/// `async` + `spawn_blocking`: keeps the blocking git (or remote ssh) call off
/// the Tauri 2 main thread so the UI cannot freeze while a diff is computed.
#[tauri::command]
pub async fn git_diff_file(
    webview_window: tauri::WebviewWindow,
    root: String,
    path: String,
    untracked: bool,
) -> Result<String, String> {
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        git_diff_file_impl(root, path, untracked)
    })
    .await
    .map_err(|e| format!("git_diff_file task failed: {e}"))?
}

/// Synchronous body of [`git_diff_file`], reused by in-process callers (MCP
/// tools) and tests.
pub(crate) fn git_diff_file_impl(
    root: String,
    path: String,
    untracked: bool,
) -> Result<String, String> {
    if crate::remote::is_active() {
        return crate::remote::git_diff_file(&root, &path, untracked);
    }
    let root_path = Path::new(&root);

    // Don't canonicalize the change path: it breaks legitimate cases (a file
    // deleted along with its directory no longer resolves; a changed tracked
    // symlink would resolve to its target instead of diffing the link itself)
    // and the old strip_prefix against a non-canonical root failed whenever the
    // root itself was a symlink (e.g. /tmp -> /private/tmp on macOS). Instead
    // keep the repo-relative path as given and reject anything that could
    // escape the repo, then let git resolve it after `--`.
    let rel = Path::new(&path);
    if path.is_empty() || rel.is_absolute() {
        return Err("path escapes root".to_string());
    }
    for comp in rel.components() {
        use std::path::Component;
        match comp {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("path escapes root".to_string());
            }
            Component::CurDir | Component::Normal(_) => {}
        }
    }
    let rel_path = path.as_str();

    if untracked {
        // For untracked files, check the file type before diffing. A FIFO would
        // block git diff --no-index forever waiting for a writer. Symlinks to
        // FIFOs are also rejected.
        let full_path = root_path.join(rel_path);
        match std::fs::symlink_metadata(&full_path) {
            Ok(meta) => {
                let ft = meta.file_type();
                if !ft.is_file() && !ft.is_symlink() {
                    return Err(format!("cannot diff special file: {}", path));
                }
                if ft.is_symlink() {
                    if let Ok(target_meta) = std::fs::metadata(&full_path) {
                        if !target_meta.is_file() {
                            return Err(format!("cannot diff symlink to non-file: {}", path));
                        }
                    }
                }
            }
            Err(e) => return Err(format!("failed to stat file: {e}")),
        }

        // Show the whole new file as additions. `--no-index` exits 0 (no diff)
        // or 1 (diff found); anything else is a real error. One hardened call.
        let output = run_git_raw(
            root_path,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=all",
                "--no-index",
                "--",
                "/dev/null",
                rel_path,
            ],
        )?;
        match output.status.code() {
            Some(0) | Some(1) => Ok(String::from_utf8_lossy(&output.stdout).into_owned()),
            _ => {
                let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
                Err(if err.is_empty() {
                    "git command failed (no stderr)".to_string()
                } else {
                    err
                })
            }
        }
    } else {
        run_git(
            root_path,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=all",
                "HEAD",
                "--",
                rel_path,
            ],
        )
    }
}
