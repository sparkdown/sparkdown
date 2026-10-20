//! Commit / Pull / Push from the Changes view (#122).
//!
//! Everything in `git.rs` is read-only and deliberately ignores the user's
//! global and system git config (a hostile repo must not run code just by
//! being opened). Writes are different: they only ever run on an explicit
//! click, and they must behave exactly like `git` in the user's terminal —
//! their identity, commit signing, hooks, credential helpers and SSH agent.
//! So this module has its own runner, [`user_git`], which spawns the system
//! `git` with the user's normal environment and config (the login-shell PATH,
//! so Homebrew `gpg` / `gh` / credential helpers resolve) and only adds:
//!
//! - `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`: never prompt for a
//!   username/password; fail and report [`GitErrorKind::Auth`] instead.
//! - `SSH_ASKPASS_REQUIRE=never` and a null stdin: ssh can't ask either.
//! - A timeout, so a hung network call can't leave the button spinning.
//!
//! Push never force-pushes: it pushes `HEAD:<upstream branch>` with no `+`
//! and no `--force*` flag, so a non-fast-forward is always rejected by git.
//!
//! Failures are typed ([`GitErrorKind`]) so the UI can say "no upstream",
//! "sign in failed", "conflicts" or "push rejected" instead of echoing stderr.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::{Duration, Instant};

/// How long a network action (pull / push) may run before it is killed.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
/// Commit runs hooks and signing (a pinentry may wait for the user).
const COMMIT_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitErrorKind {
    /// The commit message is empty or only whitespace.
    EmptyMessage,
    /// Nothing selected / nothing to commit.
    NothingToCommit,
    /// The folder is not inside a git work tree.
    NotARepo,
    /// HEAD is detached: there is no branch to pull into or push.
    Detached,
    /// The branch has no upstream to pull from / push to.
    NoUpstream,
    /// Credentials or SSH key refused, or a prompt would have been needed.
    Auth,
    /// The remote couldn't be reached (DNS, connection refused, timeout).
    Network,
    /// The pull stopped with merge (or rebase) conflicts.
    Conflict,
    /// Local changes would be overwritten by the pull.
    LocalChanges,
    /// The branch and its upstream have diverged and git needs a strategy.
    Diverged,
    /// The remote rejected the push (non-fast-forward or a remote hook).
    Rejected,
    /// git has no user.name / user.email.
    Identity,
    /// Commit signing failed.
    Signing,
    /// A hook (pre-commit, commit-msg, pre-push) refused.
    Hook,
    /// Not available in a remote (ssh) session.
    Unsupported,
    /// The action took longer than its timeout and was stopped.
    Timeout,
    /// Anything else; `detail` has git's output.
    Other,
}

/// A failed git action: a kind for the UI, a sentence to show, and git's own
/// output for the "details" disclosure.
#[derive(Serialize, Clone, Debug)]
pub struct GitActionError {
    pub kind: GitErrorKind,
    pub message: String,
    pub detail: String,
}

impl GitActionError {
    fn new(kind: GitErrorKind, message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            detail: detail.into(),
        }
    }
}

/// What a successful action reports back (git's summary line(s)).
#[derive(Serialize, Clone, Debug)]
pub struct GitActionResult {
    pub summary: String,
}

type ActionResult = Result<GitActionResult, GitActionError>;

/// Extra environment for the runner. Empty in the app; tests use it to point
/// `GIT_CONFIG_GLOBAL` at a temp file (they must not touch the developer's
/// real config, and must not set process-wide env from parallel tests).
pub(crate) type ExtraEnv<'a> = &'a [(&'a str, &'a str)];

/// The user's own `git`, as in their terminal: their config, credentials,
/// SSH agent, signing and hooks, never an interactive prompt.
fn user_git(
    root: &Path,
    extra: ExtraEnv,
    args: &[&str],
    timeout: Duration,
) -> Result<Output, GitActionError> {
    let mut cmd = crate::proc::command(crate::git::git_bin());
    cmd.current_dir(root)
        .env("PATH", crate::context::login_shell_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .arg("--no-pager")
        .args(args);
    for (k, v) in extra {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| {
        GitActionError::new(GitErrorKind::Other, "Couldn't run git.", e.to_string())
    })?;
    // Drain both pipes on threads so a chatty git can't block on a full pipe.
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let t_out = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_end(&mut b);
        }
        b
    });
    let t_err = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_end(&mut b);
        }
        b
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitActionError::new(
                    GitErrorKind::Timeout,
                    format!(
                        "git {} took longer than {} s and was stopped.",
                        args.first().unwrap_or(&""),
                        timeout.as_secs()
                    ),
                    "",
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => {
                return Err(GitActionError::new(
                    GitErrorKind::Other,
                    "Couldn't run git.",
                    e.to_string(),
                ))
            }
        }
    };
    Ok(Output {
        status,
        stdout: t_out.join().unwrap_or_default(),
        stderr: t_err.join().unwrap_or_default(),
    })
}

fn text(o: &Output) -> String {
    let mut s = String::from_utf8_lossy(&o.stdout).trim().to_string();
    let e = String::from_utf8_lossy(&o.stderr).trim().to_string();
    if !e.is_empty() {
        if !s.is_empty() {
            s.push('\n');
        }
        s.push_str(&e);
    }
    s
}

/// Run and require success; a failure is classified from git's output.
fn run_ok(
    root: &Path,
    extra: ExtraEnv,
    args: &[&str],
    timeout: Duration,
    action: Action,
) -> Result<String, GitActionError> {
    let o = user_git(root, extra, args, timeout)?;
    let t = text(&o);
    if o.status.success() {
        Ok(t)
    } else {
        Err(classify(action, &t))
    }
}

/// Run a quiet query; `None` on failure.
fn query(root: &Path, extra: ExtraEnv, args: &[&str]) -> Option<String> {
    let o = user_git(root, extra, args, Duration::from_secs(20)).ok()?;
    o.status
        .success()
        .then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Action {
    Commit,
    Pull,
    Push,
}

/// Map git's (C-locale) output to a typed error. Pure, unit-tested.
pub(crate) fn classify(action: Action, out: &str) -> GitActionError {
    use GitErrorKind as K;
    let l = out.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| l.contains(n));
    let (kind, message) = if has(&["not a git repository"]) {
        (
            K::NotARepo,
            "This folder is not a git repository.".to_string(),
        )
    } else if has(&[
        "authentication failed",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "permission denied (publickey",
        "permission denied, please try again",
        "host key verification failed",
        "invalid username or password",
        "the requested url returned error: 401",
        "the requested url returned error: 403",
        "access denied",
    ]) {
        (
            K::Auth,
            "Git couldn't sign in to the remote. SparkDown uses the same credentials and SSH agent as your terminal and never prompts: run the same command once in the terminal (or load your key into the agent), then try again.".to_string(),
        )
    } else if has(&[
        "could not resolve host",
        "connection refused",
        "connection timed out",
        "network is unreachable",
        "operation timed out",
        "could not connect to server",
    ]) {
        (
            K::Network,
            "The remote couldn't be reached. Check your connection and try again.".to_string(),
        )
    } else if action == Action::Commit
        && has(&[
            "gpg failed",
            "failed to sign",
            "error: gpg",
            "signing failed",
            "ssh-keygen",
            "error: cannot run gpg",
            "no secret key",
        ])
    {
        (K::Signing, "Commit signing failed, so nothing was committed. Check your signing setup (gpg / ssh signing key) in the terminal.".to_string())
    } else if action == Action::Commit
        && has(&[
            "please tell me who you are",
            "empty ident name",
            "unable to auto-detect email",
        ])
    {
        (K::Identity, "Git doesn't know who you are. Set user.name and user.email (git config --global), then commit again.".to_string())
    } else if action == Action::Commit
        && has(&[
            "nothing to commit",
            "no changes added to commit",
            "nothing added to commit",
        ])
    {
        (K::NothingToCommit, "Nothing to commit.".to_string())
    } else if action == Action::Pull
        && has(&[
            "conflict",
            "automatic merge failed",
            "could not apply",
            "resolve all conflicts",
        ])
    {
        (K::Conflict, "Pull stopped with conflicts. Resolve the conflicted files (they're in Changes), then commit.".to_string())
    } else if action == Action::Pull
        && has(&[
            "would be overwritten by merge",
            "would be overwritten by checkout",
            "cannot pull with rebase: you have unstaged changes",
            "please commit your changes or stash them",
        ])
    {
        (
            K::LocalChanges,
            "Pull would overwrite your uncommitted changes. Commit or stash them first."
                .to_string(),
        )
    } else if action == Action::Pull
        && has(&[
            "divergent branches",
            "not possible to fast-forward",
            "need to specify how to reconcile",
        ])
    {
        (K::Diverged, "Your branch and its upstream have diverged, and git needs to know whether to merge or rebase (set pull.rebase). Pull in the terminal to choose.".to_string())
    } else if action == Action::Push
        && has(&[
            "[rejected]",
            "non-fast-forward",
            "fetch first",
            "updates were rejected",
            "[remote rejected]",
            "pre-receive hook declined",
        ])
    {
        (K::Rejected, "The remote rejected the push: it has commits you don't have. Pull first, then push again. (SparkDown never force-pushes.)".to_string())
    } else if action == Action::Push && has(&["no upstream", "has no upstream branch"]) {
        (
            K::NoUpstream,
            "This branch has no upstream yet.".to_string(),
        )
    } else if has(&["hook", "husky"]) {
        let which = match action {
            Action::Commit => "commit",
            Action::Push => "push",
            Action::Pull => "pull",
        };
        (
            K::Hook,
            format!("A git hook stopped the {which}. See the details for its output."),
        )
    } else {
        (
            K::Other,
            "Git reported an error. See the details.".to_string(),
        )
    };
    GitActionError::new(kind, message, out.to_string())
}

fn check_local(root: &str) -> Result<PathBuf, GitActionError> {
    if crate::remote::is_active() {
        return Err(GitActionError::new(
            GitErrorKind::Unsupported,
            "Commit, Pull and Push aren't available in remote sessions yet. Use the terminal.",
            "",
        ));
    }
    let p = PathBuf::from(root);
    if !p.is_dir() {
        return Err(GitActionError::new(
            GitErrorKind::NotARepo,
            format!("Not a folder: {root}"),
            "",
        ));
    }
    Ok(p)
}

/// Current branch and its upstream remote + merge ref, or a typed error.
struct Upstream {
    branch: String,
    remote: String,
    merge: String,
}

fn upstream(root: &Path, extra: ExtraEnv) -> Result<Upstream, GitActionError> {
    if query(root, extra, &["rev-parse", "--is-inside-work-tree"]).is_none() {
        return Err(GitActionError::new(
            GitErrorKind::NotARepo,
            "This folder is not a git repository.",
            "",
        ));
    }
    let branch = query(root, extra, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .filter(|b| !b.is_empty())
        .ok_or_else(|| {
            GitActionError::new(
                GitErrorKind::Detached,
                "HEAD is detached (not on a branch), so there's nothing to pull into or push. Check out a branch first.",
                "",
            )
        })?;
    let remote = query(
        root,
        extra,
        &["config", "--get", &format!("branch.{branch}.remote")],
    )
    .filter(|s| !s.is_empty());
    let merge = query(
        root,
        extra,
        &["config", "--get", &format!("branch.{branch}.merge")],
    )
    .filter(|s| !s.is_empty());
    match (remote, merge) {
        (Some(remote), Some(merge)) if remote != "." => Ok(Upstream { branch, remote, merge }),
        _ => Err(GitActionError::new(
            GitErrorKind::NoUpstream,
            format!("Branch {branch} has no upstream. Publish it once from the terminal with: git push -u origin {branch}"),
            "",
        )),
    }
}

/// Repo-relative paths to commit, plus the old path of each staged rename
/// among them (so the rename's deletion side is committed too).
fn with_rename_sources(root: &Path, extra: ExtraEnv, paths: &[String]) -> Vec<String> {
    let mut out: Vec<String> = paths.to_vec();
    if let Some(raw) = query(
        root,
        extra,
        &["-c", "core.quotepath=false", "status", "--porcelain", "-z"],
    ) {
        let mut fields = raw.split('\0');
        while let Some(rec) = fields.next() {
            if rec.len() < 4 {
                continue;
            }
            let code = &rec[..2];
            let path = &rec[3..];
            if code.contains('R') || code.contains('C') {
                let orig = fields.next().unwrap_or("");
                if code.contains('R')
                    && !orig.is_empty()
                    && paths.iter().any(|p| p == path)
                    && !out.iter().any(|p| p == orig)
                {
                    out.push(orig.to_string());
                }
            }
        }
    }
    out
}

/// Commit. `paths` = the files to include (repo-relative to the top level),
/// or `None` for every change. Untracked files among them are added; only
/// they go into the commit (the rest of the index is left as it was).
pub(crate) fn commit_impl(
    root: &str,
    message: &str,
    paths: Option<Vec<String>>,
    extra: ExtraEnv,
) -> ActionResult {
    if message.trim().is_empty() {
        return Err(GitActionError::new(
            GitErrorKind::EmptyMessage,
            "Write a commit message first.",
            "",
        ));
    }
    let root = check_local(root)?;
    let top = query(&root, extra, &["rev-parse", "--show-toplevel"])
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            GitActionError::new(
                GitErrorKind::NotARepo,
                "This folder is not a git repository.",
                "",
            )
        })?;
    let top = PathBuf::from(top);
    match paths {
        Some(p) if p.is_empty() => Err(GitActionError::new(
            GitErrorKind::NothingToCommit,
            "Select at least one file to commit.",
            "",
        )),
        Some(p) => {
            if p.iter().any(|s| {
                s.starts_with('-')
                    || s.contains('\0')
                    || Path::new(s).is_absolute()
                    || s.split('/').any(|c| c == "..")
            }) {
                return Err(GitActionError::new(
                    GitErrorKind::Other,
                    "Invalid file path.",
                    p.join("\n"),
                ));
            }
            let all = with_rename_sources(&top, extra, &p);
            // Stage what's on disk or still in the index (new, edited and
            // unstaged-deleted files). An already-staged deletion (or a
            // rename's source) is in neither, and `git add` would refuse it;
            // `git commit -- <path>` picks it up from HEAD.
            let mut ls = vec!["--literal-pathspecs", "ls-files", "-z", "--"];
            ls.extend(all.iter().map(|s| s.as_str()));
            let indexed = query(&top, extra, &ls).unwrap_or_default();
            let indexed: Vec<&str> = indexed.split('\0').collect();
            let to_add: Vec<&str> = all
                .iter()
                .map(|s| s.as_str())
                .filter(|s| top.join(s).symlink_metadata().is_ok() || indexed.contains(s))
                .collect();
            if !to_add.is_empty() {
                let mut add = vec!["--literal-pathspecs", "add", "-A", "--"];
                add.extend(to_add);
                run_ok(&top, extra, &add, COMMIT_TIMEOUT, Action::Commit)?;
            }
            let mut c = vec!["--literal-pathspecs", "commit", "-m", message, "--"];
            c.extend(all.iter().map(|s| s.as_str()));
            run_ok(&top, extra, &c, COMMIT_TIMEOUT, Action::Commit).map(summary)
        }
        None => {
            run_ok(&top, extra, &["add", "-A"], COMMIT_TIMEOUT, Action::Commit)?;
            run_ok(
                &top,
                extra,
                &["commit", "-m", message],
                COMMIT_TIMEOUT,
                Action::Commit,
            )
            .map(summary)
        }
    }
}

fn summary(out: String) -> GitActionResult {
    GitActionResult {
        summary: out.lines().next().unwrap_or("").trim().to_string(),
    }
}

/// Pull the current branch from its upstream with the user's own pull
/// settings (merge / rebase / ff-only).
pub(crate) fn pull_impl(root: &str, extra: ExtraEnv) -> ActionResult {
    let root = check_local(root)?;
    upstream(&root, extra)?;
    let o = user_git(&root, extra, &["pull", "--no-edit"], NETWORK_TIMEOUT)?;
    let t = text(&o);
    if o.status.success() {
        Ok(summary(t))
    } else {
        Err(classify(Action::Pull, &t))
    }
}

/// Push the current branch to its upstream. Never forced: an explicit
/// `HEAD:<merge ref>` refspec without `+`, so a non-fast-forward is rejected.
pub(crate) fn push_impl(root: &str, extra: ExtraEnv) -> ActionResult {
    let root = check_local(root)?;
    let up = upstream(&root, extra)?;
    let refspec = format!("HEAD:{}", up.merge);
    debug_assert!(!refspec.starts_with('+'));
    let _ = &up.branch;
    run_ok(
        &root,
        extra,
        &["push", "--", &up.remote, &refspec],
        NETWORK_TIMEOUT,
        Action::Push,
    )
    .map(summary)
}

#[tauri::command]
pub async fn git_commit(
    webview_window: tauri::WebviewWindow,
    root: String,
    message: String,
    paths: Option<Vec<String>>,
) -> ActionResult {
    spawn(webview_window, move || {
        commit_impl(&root, &message, paths, &[])
    })
    .await
}

#[tauri::command]
pub async fn git_pull(webview_window: tauri::WebviewWindow, root: String) -> ActionResult {
    spawn(webview_window, move || pull_impl(&root, &[])).await
}

#[tauri::command]
pub async fn git_push(webview_window: tauri::WebviewWindow, root: String) -> ActionResult {
    spawn(webview_window, move || push_impl(&root, &[])).await
}

async fn spawn(
    w: tauri::WebviewWindow,
    f: impl FnOnce() -> ActionResult + Send + 'static,
) -> ActionResult {
    crate::windows::spawn_scoped(w.label().to_string(), f)
        .await
        .map_err(|e| {
            GitActionError::new(GitErrorKind::Other, "The git task failed.", e.to_string())
        })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A unique temp dir, removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> TempDir {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "sd-gitw-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        TempDir(d)
    }

    /// A sandbox: a bare remote, a clone with an upstream, and an isolated
    /// global config (identity, no signing) passed only to child gits.
    struct Sandbox {
        _dir: TempDir,
        bare: PathBuf,
        work: PathBuf,
        global: String,
    }

    impl Sandbox {
        fn env(&self) -> Vec<(&str, &str)> {
            vec![
                ("GIT_CONFIG_GLOBAL", self.global.as_str()),
                ("GIT_CONFIG_NOSYSTEM", "1"),
                (
                    "HOME",
                    self.global.rsplit_once('/').map(|x| x.0).unwrap_or("/"),
                ),
            ]
        }
        fn git(&self, dir: &Path, args: &[&str]) -> String {
            let env = self.env();
            let o = user_git(dir, &env, args, Duration::from_secs(30)).expect("git ran");
            assert!(o.status.success(), "git {args:?} failed: {}", text(&o));
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        }
        /// A second clone (another machine) for making upstream commits.
        fn other(&self) -> PathBuf {
            let other = self.bare.parent().unwrap().join("other");
            if !other.exists() {
                self.git(
                    self.bare.parent().unwrap(),
                    &["clone", "-q", self.bare.to_str().unwrap(), "other"],
                );
            }
            other
        }
        fn commit_in(&self, dir: &Path, file: &str, body: &str, msg: &str) {
            fs::write(dir.join(file), body).unwrap();
            self.git(dir, &["add", file]);
            self.git(dir, &["commit", "-q", "-m", msg]);
        }
    }

    fn sandbox() -> Sandbox {
        let dir = tempdir();
        let base = dir.path().canonicalize().unwrap();
        let global = base.join("gitconfig");
        fs::write(
            &global,
            "[user]\n\tname = Test\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[pull]\n\trebase = false\n",
        )
        .unwrap();
        let sb = Sandbox {
            bare: base.join("remote.git"),
            work: base.join("work"),
            global: global.to_string_lossy().into_owned(),
            _dir: dir,
        };
        sb.git(&base, &["init", "-q", "--bare", "remote.git"]);
        sb.git(&base, &["clone", "-q", sb.bare.to_str().unwrap(), "work"]);
        sb.commit_in(&sb.work, "README.md", "hello\n", "init");
        sb.git(&sb.work, &["push", "-q", "-u", "origin", "main"]);
        sb
    }

    fn root(sb: &Sandbox) -> String {
        sb.work.to_string_lossy().into_owned()
    }

    fn ahead_behind(sb: &Sandbox) -> (u32, u32) {
        let raw = sb.git(
            &sb.work,
            &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
        );
        let (behind, ahead) = crate::git::parse_left_right_count(&raw).unwrap();
        (ahead, behind)
    }

    #[test]
    fn empty_message_is_blocked_before_git_runs() {
        let e = commit_impl("/definitely/not/here", "  \n\t", None, &[]).unwrap_err();
        assert_eq!(e.kind, GitErrorKind::EmptyMessage);
    }

    #[test]
    fn commit_all_then_ahead_by_one() {
        let sb = sandbox();
        let env = sb.env();
        fs::write(sb.work.join("a.md"), "a\n").unwrap();
        fs::write(sb.work.join("README.md"), "changed\n").unwrap();
        let r = commit_impl(&root(&sb), "Add a", None, &env).unwrap();
        assert!(r.summary.contains("Add a"), "{}", r.summary);
        assert_eq!(sb.git(&sb.work, &["status", "--porcelain"]), "");
        assert_eq!(ahead_behind(&sb), (1, 0));
        assert_eq!(
            sb.git(&sb.work, &["log", "-1", "--format=%an <%ae>"]),
            "Test <t@example.com>"
        );
    }

    #[test]
    fn commit_selected_files_only() {
        let sb = sandbox();
        let env = sb.env();
        fs::write(sb.work.join("keep.md"), "k\n").unwrap();
        fs::write(sb.work.join("take.md"), "t\n").unwrap();
        fs::write(sb.work.join("README.md"), "changed\n").unwrap();
        commit_impl(
            &root(&sb),
            "Take one",
            Some(vec!["take.md".into(), "README.md".into()]),
            &env,
        )
        .unwrap();
        let files = sb.git(&sb.work, &["show", "--name-only", "--format=", "HEAD"]);
        assert_eq!(
            files.lines().collect::<Vec<_>>(),
            vec!["README.md", "take.md"]
        );
        assert_eq!(sb.git(&sb.work, &["status", "--porcelain"]), "?? keep.md");
    }

    #[test]
    fn commit_selected_staged_rename_includes_its_source() {
        let sb = sandbox();
        let env = sb.env();
        sb.git(&sb.work, &["mv", "README.md", "READ.md"]);
        commit_impl(&root(&sb), "Rename", Some(vec!["READ.md".into()]), &env).unwrap();
        assert_eq!(sb.git(&sb.work, &["status", "--porcelain"]), "");
        let files = sb.git(&sb.work, &["show", "--name-status", "--format=", "HEAD"]);
        assert!(files.starts_with('R'), "{files}");
    }

    #[test]
    fn commit_selected_deletions_staged_or_not() {
        let sb = sandbox();
        let env = sb.env();
        sb.commit_in(&sb.work, "b.md", "b\n", "b");
        fs::remove_file(sb.work.join("README.md")).unwrap();
        sb.git(&sb.work, &["rm", "-q", "b.md"]);
        commit_impl(
            &root(&sb),
            "Delete",
            Some(vec!["README.md".into(), "b.md".into()]),
            &env,
        )
        .unwrap();
        assert_eq!(sb.git(&sb.work, &["status", "--porcelain"]), "");
        assert_eq!(sb.git(&sb.work, &["ls-files"]), "");
    }

    #[test]
    fn commit_selected_glob_like_name_is_literal() {
        let sb = sandbox();
        let env = sb.env();
        fs::write(sb.work.join("*.md"), "star\n").unwrap();
        fs::write(sb.work.join("other.md"), "o\n").unwrap();
        commit_impl(&root(&sb), "Star", Some(vec!["*.md".into()]), &env).unwrap();
        assert_eq!(sb.git(&sb.work, &["status", "--porcelain"]), "?? other.md");
    }

    #[test]
    fn commit_with_nothing_selected_or_nothing_changed() {
        let sb = sandbox();
        let env = sb.env();
        assert_eq!(
            commit_impl(&root(&sb), "x", Some(vec![]), &env)
                .unwrap_err()
                .kind,
            GitErrorKind::NothingToCommit
        );
        assert_eq!(
            commit_impl(&root(&sb), "x", None, &env).unwrap_err().kind,
            GitErrorKind::NothingToCommit
        );
    }

    #[test]
    fn commit_runs_the_users_hooks() {
        let sb = sandbox();
        let env = sb.env();
        let hook = sb.work.join(".git/hooks/pre-commit");
        fs::write(
            &hook,
            "#!/bin/sh\necho 'pre-commit hook says no' >&2\nexit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(sb.work.join("a.md"), "a\n").unwrap();
        let e = commit_impl(&root(&sb), "x", None, &env).unwrap_err();
        assert_eq!(e.kind, GitErrorKind::Hook, "{e:?}");
        assert!(e.detail.contains("pre-commit hook says no"));
    }

    #[test]
    fn commit_uses_the_users_global_config() {
        // The read-only runner ignores global config; this one must not.
        let sb = sandbox();
        let env = sb.env();
        fs::write(sb.work.join("a.md"), "a\n").unwrap();
        commit_impl(&root(&sb), "x", None, &env).unwrap();
        assert_eq!(
            sb.git(&sb.work, &["log", "-1", "--format=%ae"]),
            "t@example.com"
        );
    }

    #[test]
    fn commit_signing_failure_is_typed() {
        let sb = sandbox();
        let mut env = sb.env();
        env.push(("GIT_CONFIG_COUNT", "2"));
        env.push(("GIT_CONFIG_KEY_0", "commit.gpgsign"));
        env.push(("GIT_CONFIG_VALUE_0", "true"));
        env.push(("GIT_CONFIG_KEY_1", "gpg.program"));
        env.push(("GIT_CONFIG_VALUE_1", "/bin/false"));
        fs::write(sb.work.join("a.md"), "a\n").unwrap();
        let e = commit_impl(&root(&sb), "x", None, &env).unwrap_err();
        assert_eq!(e.kind, GitErrorKind::Signing, "{e:?}");
        assert_eq!(sb.git(&sb.work, &["rev-list", "--count", "HEAD"]), "1");
    }

    #[test]
    fn push_then_up_to_date() {
        let sb = sandbox();
        let env = sb.env();
        sb.commit_in(&sb.work, "b.md", "b\n", "b");
        assert_eq!(ahead_behind(&sb), (1, 0));
        push_impl(&root(&sb), &env).unwrap();
        assert_eq!(ahead_behind(&sb), (0, 0));
        let remote_head = sb.git(&sb.bare, &["rev-parse", "main"]);
        assert_eq!(remote_head, sb.git(&sb.work, &["rev-parse", "HEAD"]));
    }

    #[test]
    fn pull_fast_forward_and_behind_count() {
        let sb = sandbox();
        let env = sb.env();
        let other = sb.other();
        sb.commit_in(&other, "up.md", "up\n", "upstream");
        sb.git(&other, &["push", "-q"]);
        sb.git(&sb.work, &["fetch", "-q"]);
        assert_eq!(ahead_behind(&sb), (0, 1));
        pull_impl(&root(&sb), &env).unwrap();
        assert_eq!(ahead_behind(&sb), (0, 0));
        assert!(sb.work.join("up.md").exists());
    }

    #[test]
    fn pull_conflict_is_typed() {
        let sb = sandbox();
        let env = sb.env();
        let other = sb.other();
        sb.commit_in(&other, "README.md", "theirs\n", "theirs");
        sb.git(&other, &["push", "-q"]);
        sb.commit_in(&sb.work, "README.md", "ours\n", "ours");
        let e = pull_impl(&root(&sb), &env).unwrap_err();
        assert_eq!(e.kind, GitErrorKind::Conflict, "{e:?}");
    }

    #[test]
    fn pull_over_local_edits_is_typed() {
        let sb = sandbox();
        let env = sb.env();
        let other = sb.other();
        sb.commit_in(&other, "README.md", "theirs\n", "theirs");
        sb.git(&other, &["push", "-q"]);
        fs::write(sb.work.join("README.md"), "dirty\n").unwrap();
        let e = pull_impl(&root(&sb), &env).unwrap_err();
        assert_eq!(e.kind, GitErrorKind::LocalChanges, "{e:?}");
    }

    #[test]
    fn rejected_push_is_typed_and_never_forced() {
        let sb = sandbox();
        let env = sb.env();
        let other = sb.other();
        sb.commit_in(&other, "x.md", "x\n", "theirs");
        sb.git(&other, &["push", "-q"]);
        let theirs = sb.git(&sb.bare, &["rev-parse", "main"]);
        sb.commit_in(&sb.work, "y.md", "y\n", "ours");
        let e = push_impl(&root(&sb), &env).unwrap_err();
        assert_eq!(e.kind, GitErrorKind::Rejected, "{e:?}");
        assert_eq!(
            sb.git(&sb.bare, &["rev-parse", "main"]),
            theirs,
            "remote must be untouched"
        );
    }

    #[test]
    fn force_in_user_push_refspec_config_is_not_used() {
        // A `+` refspec in remote.origin.push would force; our explicit
        // refspec overrides it.
        let sb = sandbox();
        let env = sb.env();
        sb.git(
            &sb.work,
            &["config", "remote.origin.push", "+refs/heads/*:refs/heads/*"],
        );
        let other = sb.other();
        sb.commit_in(&other, "x.md", "x\n", "theirs");
        sb.git(&other, &["push", "-q"]);
        let theirs = sb.git(&sb.bare, &["rev-parse", "main"]);
        sb.commit_in(&sb.work, "y.md", "y\n", "ours");
        assert_eq!(
            push_impl(&root(&sb), &env).unwrap_err().kind,
            GitErrorKind::Rejected
        );
        assert_eq!(sb.git(&sb.bare, &["rev-parse", "main"]), theirs);
    }

    #[test]
    fn no_upstream_and_detached_are_typed() {
        let sb = sandbox();
        let env = sb.env();
        sb.git(&sb.work, &["checkout", "-q", "-b", "feature"]);
        let e = push_impl(&root(&sb), &env).unwrap_err();
        assert_eq!(e.kind, GitErrorKind::NoUpstream);
        assert!(
            e.message.contains("git push -u origin feature"),
            "{}",
            e.message
        );
        assert_eq!(
            pull_impl(&root(&sb), &env).unwrap_err().kind,
            GitErrorKind::NoUpstream
        );
        sb.git(&sb.work, &["checkout", "-q", "--detach"]);
        assert_eq!(
            push_impl(&root(&sb), &env).unwrap_err().kind,
            GitErrorKind::Detached
        );
    }

    #[test]
    fn auth_failure_never_prompts() {
        let sb = sandbox();
        let env = sb.env();
        // An http remote that wants credentials: with prompts disabled git
        // must fail fast instead of waiting for a username.
        sb.git(
            &sb.work,
            &["remote", "set-url", "origin", "http://127.0.0.1:9/repo.git"],
        );
        let e = push_impl(&root(&sb), &env).unwrap_err();
        assert!(
            matches!(e.kind, GitErrorKind::Network | GitErrorKind::Auth),
            "{e:?}"
        );
    }

    #[test]
    fn not_a_repo_is_typed() {
        let d = tempdir();
        let p = d.path().to_string_lossy().into_owned();
        let dummy = d.path().join("cfg");
        fs::write(&dummy, "").unwrap();
        let g = dummy.to_string_lossy().into_owned();
        let env = [
            ("GIT_CONFIG_GLOBAL", g.as_str()),
            ("GIT_CEILING_DIRECTORIES", p.as_str()),
        ];
        assert_eq!(
            push_impl(&p, &env).unwrap_err().kind,
            GitErrorKind::NotARepo
        );
        assert_eq!(
            commit_impl(&p, "m", None, &env).unwrap_err().kind,
            GitErrorKind::NotARepo
        );
    }

    #[test]
    fn classifies_auth_and_rejections() {
        let k = |a, s: &str| classify(a, s).kind;
        assert_eq!(k(Action::Push, "fatal: could not read Username for 'https://github.com': terminal prompts disabled"), GitErrorKind::Auth);
        assert_eq!(k(Action::Pull, "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."), GitErrorKind::Auth);
        assert_eq!(
            k(
                Action::Push,
                " ! [rejected]        main -> main (fetch first)"
            ),
            GitErrorKind::Rejected
        );
        assert_eq!(
            k(
                Action::Push,
                " ! [remote rejected] main -> main (protected branch hook declined)"
            ),
            GitErrorKind::Rejected
        );
        assert_eq!(
            k(Action::Pull, "CONFLICT (content): Merge conflict in a.md"),
            GitErrorKind::Conflict
        );
        assert_eq!(
            k(
                Action::Pull,
                "fatal: Need to specify how to reconcile divergent branches."
            ),
            GitErrorKind::Diverged
        );
        assert_eq!(
            k(Action::Commit, "error: gpg failed to sign the data"),
            GitErrorKind::Signing
        );
        assert_eq!(
            k(
                Action::Push,
                "fatal: unable to access: Could not resolve host: example.invalid"
            ),
            GitErrorKind::Network
        );
        assert_eq!(k(Action::Commit, "weird"), GitErrorKind::Other);
    }

    #[test]
    fn push_source_never_forces() {
        let src = include_str!("git_write.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        for bad in ["\"--force", "\"-f\"", "\"--force-with-lease", "format!(\"+"] {
            assert!(!code.contains(bad), "push code must never force ({bad})");
        }
    }
}
