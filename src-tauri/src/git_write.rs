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

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::{Duration, Instant};

/// How long a network action (pull / push) may run before it is killed.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
/// A background fetch (#175) is quiet and must never hang around.
const FETCH_TIMEOUT: Duration = Duration::from_secs(45);
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
    /// The pull stopped with conflicts (generic: the kind of stop is
    /// unknown, e.g. classified from output alone).
    Conflict,
    /// Pull merged and stopped on conflicts: the repo is left mid-merge
    /// (`MERGE_HEAD`), never auto-aborted (#174).
    MergeConflict,
    /// Pull rebased (the user's `pull.rebase`) and a commit stopped on
    /// conflicts: the repo is left mid-rebase, never auto-aborted (#174).
    RebaseConflict,
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
    /// Repo-relative files the error is about (the conflicted files of a
    /// merge / rebase conflict). Omitted when empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

impl GitActionError {
    fn new(kind: GitErrorKind, message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            detail: detail.into(),
            files: Vec::new(),
        }
    }
}

/// What a successful action reports back: git's first summary line, its
/// full output (for the Git output tab), and for pull / push how many
/// commits moved and the upstream they moved to or from.
#[derive(Serialize, Clone, Debug)]
pub struct GitActionResult {
    pub summary: String,
    pub output: String,
    pub commits: Option<u32>,
    pub target: Option<String>,
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

/// Run git for machine-readable output (`-z` / porcelain): stdout exactly
/// as git wrote it. Never trimmed (porcelain status codes start with a
/// space, and file names may start or end with one) and never mixed with
/// stderr.
fn run_stdout_raw(
    root: &Path,
    extra: ExtraEnv,
    args: &[&str],
    timeout: Duration,
    action: Action,
) -> Result<String, GitActionError> {
    let o = user_git(root, extra, args, timeout)?;
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).into_owned())
    } else {
        Err(classify(action, &text(&o)))
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
    Discard,
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
        "couldn't connect to server",
        "failed to connect to",
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
        (K::Diverged, "Your branch and its upstream have diverged, and git couldn't reconcile them with your pull settings. Pull in the terminal to choose how to merge or rebase.".to_string())
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
    } else if has(&["index.lock", "unable to create", "another git process"]) {
        (
            K::Other,
            "Another git process is using this repository (its index is locked). Wait for it to finish, or remove a stale .git/index.lock, then try again.".to_string(),
        )
    } else if has(&["hook", "husky"]) {
        let which = match action {
            Action::Commit => "commit",
            Action::Push => "push",
            Action::Pull => "pull",
            Action::Discard => "discard",
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

/// Why Commit / Pull / Push are off in a remote session.
const SYNC_UNSUPPORTED: &str =
    "Commit, Pull and Push aren't available in remote sessions yet. Use the terminal.";

fn check_local(root: &str, unsupported: &str) -> Result<PathBuf, GitActionError> {
    if crate::remote::is_active() {
        return Err(GitActionError::new(
            GitErrorKind::Unsupported,
            unsupported,
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
    let root = check_local(root, SYNC_UNSUPPORTED)?;
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
        output: out,
        commits: None,
        target: None,
    }
}

/// `origin/main` for an upstream (`refs/heads/` stripped from the merge ref).
fn target_name(up: &Upstream) -> String {
    format!(
        "{}/{}",
        up.remote,
        up.merge.strip_prefix("refs/heads/").unwrap_or(&up.merge)
    )
}

fn count(root: &Path, extra: ExtraEnv, range: &str) -> Option<u32> {
    query(root, extra, &["rev-list", "--count", range])?
        .parse()
        .ok()
}

/// How the user's config says Pull reconciles a diverged branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PullConfig {
    /// `branch.<name>.rebase` or `pull.rebase`, whichever applies.
    rebase: Option<String>,
    /// `pull.ff`.
    ff: Option<String>,
}

impl PullConfig {
    fn read(root: &Path, extra: ExtraEnv, branch: &str) -> Self {
        let get =
            |key: &str| query(root, extra, &["config", "--get", key]).filter(|s| !s.is_empty());
        PullConfig {
            rebase: get(&format!("branch.{branch}.rebase")).or_else(|| get("pull.rebase")),
            ff: get("pull.ff"),
        }
    }

    /// No strategy configured in any scope: Pull merges (#174).
    fn is_unset(&self) -> bool {
        self.rebase.is_none() && self.ff.is_none()
    }

    fn ff_only(&self) -> bool {
        self.ff.as_deref().map(str::to_lowercase).as_deref() == Some("only")
    }
}

/// The `git pull` arguments for a config: `-c pull.rebase=false` only when
/// the user set neither `pull.rebase` nor `pull.ff`, so their own
/// `pull.rebase=true|merges|interactive` or `pull.ff=only` always wins.
pub(crate) fn pull_args(cfg: &PullConfig) -> Vec<&'static str> {
    if cfg.is_unset() {
        vec!["-c", "pull.rebase=false", "pull", "--no-edit"]
    } else {
        vec!["pull", "--no-edit"]
    }
}

/// Is a rebase stopped in this repo (`rebase-merge` / `rebase-apply`)?
fn rebase_in_progress(root: &Path, extra: ExtraEnv) -> bool {
    ["rebase-merge", "rebase-apply"].iter().any(|d| {
        query(root, extra, &["rev-parse", "--git-path", d])
            .map(|p| {
                let p = PathBuf::from(p);
                if p.is_absolute() { p } else { root.join(p) }.is_dir()
            })
            .unwrap_or(false)
    })
}

/// Is a merge stopped in this repo (`MERGE_HEAD`)?
fn merge_in_progress(root: &Path, extra: ExtraEnv) -> bool {
    query(root, extra, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_some()
}

/// Unmerged (conflicted) paths, repo-relative to the top level.
fn conflicted_files(root: &Path, extra: ExtraEnv) -> Vec<String> {
    let raw = run_stdout_raw(
        root,
        extra,
        &[
            "-c",
            "core.quotepath=false",
            "diff",
            "--name-only",
            "--diff-filter=U",
            "-z",
        ],
        Duration::from_secs(20),
        Action::Pull,
    )
    .unwrap_or_default();
    let mut files: Vec<String> = raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    files.dedup();
    files
}

fn files_word(n: usize) -> String {
    if n == 1 {
        "1 file".to_string()
    } else {
        format!("{n} files")
    }
}

/// A pull that stopped on conflicts: tell a merge from a rebase by the repo
/// state git left behind, and name the conflicted files. Nothing is aborted.
fn conflict_error(root: &Path, extra: ExtraEnv, output: &str) -> GitActionError {
    let files = conflicted_files(root, extra);
    let n = files.len();
    let rebase = rebase_in_progress(root, extra);
    let (kind, message) = if rebase {
        (
            GitErrorKind::RebaseConflict,
            if n > 0 {
                format!("Pull stopped rebasing on conflicts in {}. Resolve them, stage them, then run git rebase --continue (or git rebase --abort) in the terminal.", files_word(n))
            } else {
                "Pull stopped rebasing on conflicts. Resolve them, then run git rebase --continue (or git rebase --abort) in the terminal.".to_string()
            },
        )
    } else if merge_in_progress(root, extra) || n > 0 {
        (
            GitErrorKind::MergeConflict,
            if n > 0 {
                format!(
                    "Pull stopped on merge conflicts in {}. Resolve them, then commit.",
                    files_word(n)
                )
            } else {
                "Pull stopped on merge conflicts. Resolve them, then commit.".to_string()
            },
        )
    } else {
        return classify(Action::Pull, output);
    };
    let mut detail = output.to_string();
    if n > 0 {
        detail.push_str("\n\nConflicted files:\n");
        for f in &files {
            detail.push_str("  ");
            detail.push_str(f);
            detail.push('\n');
        }
    }
    let mut e = GitActionError::new(kind, message, detail.trim_end().to_string());
    e.files = files;
    e
}

/// Pull the current branch from its upstream. With no pull strategy
/// configured anywhere, a diverged branch is merged (`pull.rebase=false`
/// semantics, #174); otherwise the user's merge / rebase / ff-only setting
/// is used as in their terminal. Conflicts leave the repo mid-merge or
/// mid-rebase for the user to finish.
pub(crate) fn pull_impl(root: &str, extra: ExtraEnv) -> ActionResult {
    let root = check_local(root, SYNC_UNSUPPORTED)?;
    let up = upstream(&root, extra)?;
    let cfg = PullConfig::read(&root, extra, &up.branch);
    let before = query(&root, extra, &["rev-parse", "--verify", "-q", "HEAD"]);
    let o = user_git(&root, extra, &pull_args(&cfg), NETWORK_TIMEOUT)?;
    let t = text(&o);
    if o.status.success() {
        let mut r = summary(t);
        r.commits = before.and_then(|b| count(&root, extra, &format!("{b}..HEAD")));
        r.target = Some(target_name(&up));
        Ok(r)
    } else {
        let e = classify(Action::Pull, &t);
        match e.kind {
            GitErrorKind::Conflict => Err(conflict_error(&root, extra, &t)),
            GitErrorKind::Diverged if cfg.ff_only() => Err(GitActionError::new(
                GitErrorKind::Diverged,
                format!(
                    "Your branch and {} have diverged, and your git config (pull.ff=only) allows only fast-forward pulls, so nothing changed. Merge or rebase in the terminal.",
                    target_name(&up)
                ),
                t,
            )),
            _ => {
                // A rebase / merge that stopped on conflicts is reported the
                // same way even when git's wording wasn't recognised.
                if rebase_in_progress(&root, extra) || merge_in_progress(&root, extra) {
                    Err(conflict_error(&root, extra, &t))
                } else {
                    Err(e)
                }
            }
        }
    }
}

/// Push the current branch to its upstream. Never forced: an explicit
/// `HEAD:<merge ref>` refspec without `+`, so a non-fast-forward is rejected.
pub(crate) fn push_impl(root: &str, extra: ExtraEnv) -> ActionResult {
    let root = check_local(root, SYNC_UNSUPPORTED)?;
    let up = upstream(&root, extra)?;
    let refspec = format!("HEAD:{}", up.merge);
    debug_assert!(!refspec.starts_with('+'));
    let _ = &up.branch;
    // Commits the upstream doesn't have yet (as last fetched).
    let ahead = count(&root, extra, "@{upstream}..HEAD");
    let mut r = run_ok(
        &root,
        extra,
        &["push", "--", &up.remote, &refspec],
        NETWORK_TIMEOUT,
        Action::Push,
    )
    .map(summary)?;
    r.commits = ahead;
    r.target = Some(target_name(&up));
    Ok(r)
}

/// Why the background fetch is off in a remote session.
const FETCH_UNSUPPORTED: &str = "Background fetch is off in remote sessions.";

/// What a background fetch did (#175).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FetchOutcome {
    /// The upstream remote was fetched; the tracking ref is current.
    Fetched,
    /// Another fetch for this window was still running; nothing was done.
    Busy,
}

/// Quietly fetch the current branch's upstream remote so the behind count
/// is current (#175). Local repos with an upstream only; no tags, no prune,
/// no submodules. Never prompts: on top of the runner's
/// `GIT_TERMINAL_PROMPT=0`, both askpass programs are blanked (git then
/// uses none), so a remote that needs credentials just fails and the
/// caller stays silent. Times out after [`FETCH_TIMEOUT`].
pub(crate) fn fetch_impl(root: &str, extra: ExtraEnv) -> Result<FetchOutcome, GitActionError> {
    let root = check_local(root, FETCH_UNSUPPORTED)?;
    let up = upstream(&root, extra)?;
    let mut env: Vec<(&str, &str)> = vec![("GIT_ASKPASS", ""), ("SSH_ASKPASS", "")];
    env.extend_from_slice(extra);
    run_ok(
        &root,
        &env,
        &[
            "-c",
            "credential.interactive=false",
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-prune",
            "--no-recurse-submodules",
            "--",
            &up.remote,
        ],
        FETCH_TIMEOUT,
        Action::Pull,
    )?;
    Ok(FetchOutcome::Fetched)
}

/// Windows with a background fetch running (one at a time per window).
fn fetches_in_flight() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static S: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    S.get_or_init(Default::default)
}

/// Marks a window's fetch in flight; cleared on drop (also on a panic).
struct InFlight(String);
impl InFlight {
    fn claim(label: &str) -> Option<Self> {
        let mut set = fetches_in_flight()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        set.insert(label.to_string())
            .then(|| InFlight(label.to_string()))
    }
}
impl Drop for InFlight {
    fn drop(&mut self) {
        let mut set = fetches_in_flight()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        set.remove(&self.0);
    }
}

#[tauri::command]
pub async fn git_fetch(
    webview_window: tauri::WebviewWindow,
    root: String,
) -> Result<FetchOutcome, GitActionError> {
    let label = webview_window.label().to_string();
    let Some(guard) = InFlight::claim(&label) else {
        return Ok(FetchOutcome::Busy);
    };
    crate::windows::spawn_scoped(label, move || {
        let _guard = guard;
        fetch_impl(&root, &[])
    })
    .await
    .map_err(|e| GitActionError::new(GitErrorKind::Other, "The git task failed.", e.to_string()))?
}

// --- Discard (#172) ---------------------------------------------------------

/// Why Discard is off in a remote session.
const DISCARD_UNSUPPORTED: &str =
    "Discard isn't available in remote sessions yet. Use the terminal on the remote host.";

/// What Discard does to one changed file (#172).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiscardAction {
    /// Back to the last commit (index and work tree).
    Revert,
    /// The file has no committed version: unstaged if needed, then moved to
    /// the OS trash (never deleted permanently).
    Delete,
}

/// One row of the Discard confirmation, computed from a fresh status.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DiscardItem {
    /// Repo-relative path (to the top level), as in Changes.
    pub path: String,
    pub action: DiscardAction,
    /// One sentence for the dialog ("Staged and unstaged changes: both are
    /// reverted").
    pub detail: String,
    /// A staged rename's source, restored together with `path`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Some change is staged.
    pub staged: bool,
    /// Staged and unstaged changes (`MM`): both layers are reverted.
    pub partially_staged: bool,
    /// Untracked (`??`) in the fresh status.
    pub untracked: bool,
    /// Opaque token for exactly what was previewed: status letters, index
    /// entries and the bytes on disk of `path` (and `source`). Sent back
    /// with the confirmation; Discard refuses the row when it differs.
    pub fingerprint: String,
    /// The on-disk part of `fingerprint`, re-checked right before this
    /// row's first change (backend only).
    #[serde(skip)]
    worktree: String,
}

const CHANGED_SINCE_CONFIRMED: &str =
    "Changed since you confirmed; nothing was done. Review it and discard again.";

/// One confirmed row sent back by the dialog: Discard re-plans from a fresh
/// status and refuses a path whose plan no longer matches what the user
/// confirmed (e.g. it became untracked, or a rename source changed).
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct DiscardRequest {
    pub path: String,
    pub action: DiscardAction,
    #[serde(default)]
    pub source: Option<String>,
    /// `DiscardItem::fingerprint` from the preview that was confirmed.
    pub fingerprint: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DiscardFailure {
    pub path: String,
    pub message: String,
}

/// What a discard did: per path, so a partial failure is reported per file.
#[derive(Serialize, Clone, Debug, Default)]
pub struct DiscardResult {
    /// Paths now back to the last commit (or gone, for deletes).
    pub discarded: Vec<String>,
    /// Paths moved to the trash: normally among `discarded`, but also listed
    /// when a later step for that path failed (it is then in `failed` too).
    pub trashed: Vec<String>,
    pub failed: Vec<DiscardFailure>,
    /// git's output, for the Git tab.
    pub output: String,
}

/// Moves one path to the OS trash (never follows a symlink: the link
/// itself moves). The app passes the `trash` crate; tests a fake.
pub(crate) type Trasher<'a> = &'a dyn Fn(&Path) -> Result<(), String>;

/// The OS trash (Trash / Recycle Bin / freedesktop trash).
pub(crate) fn os_trash(p: &Path) -> Result<(), String> {
    trash::delete(p).map_err(|e| e.to_string())
}

/// A repo-relative path Discard may touch: not empty, relative, only plain
/// components (no `..`, `.`, root or drive prefix), no NUL, and no parent
/// directory that is a symlink or resolves outside the top level. The last
/// component may itself be a symlink (a tracked link): it is never followed.
pub(crate) fn check_discard_path(top: &Path, rel: &str) -> Result<(), String> {
    use std::path::Component;
    if rel.is_empty() || rel.contains('\0') || rel.contains('\\') {
        return Err("invalid path".into());
    }
    let p = Path::new(rel);
    if p.is_absolute() || rel.starts_with('/') {
        return Err("path is absolute".into());
    }
    let comps: Vec<_> = p.components().collect();
    if comps.is_empty() || !comps.iter().all(|c| matches!(c, Component::Normal(_))) {
        return Err("path escapes the repository".into());
    }
    let top_canon = top
        .canonicalize()
        .map_err(|e| format!("can't resolve the repository: {e}"))?;
    let mut dir = top.to_path_buf();
    for c in &comps[..comps.len() - 1] {
        dir.push(c.as_os_str());
        match dir.symlink_metadata() {
            Ok(m) if m.file_type().is_symlink() => {
                return Err("path goes through a symbolic link".into())
            }
            Ok(m) if !m.is_dir() => return Err("a parent is not a folder".into()),
            Ok(_) => {
                let c = dir
                    .canonicalize()
                    .map_err(|e| format!("can't resolve a parent: {e}"))?;
                if !c.starts_with(&top_canon) {
                    return Err("path escapes the repository".into());
                }
            }
            // A parent that no longer exists (a deleted folder) can't lead
            // anywhere; git restores below the top level.
            Err(_) => break,
        }
    }
    Ok(())
}

/// One `git status --porcelain -z` record.
#[derive(Clone, Debug)]
struct StatusRec {
    x: char,
    y: char,
    path: String,
    orig: Option<String>,
}

fn status_records(top: &Path, extra: ExtraEnv) -> Result<Vec<StatusRec>, GitActionError> {
    let raw = run_stdout_raw(
        top,
        extra,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=all",
        ],
        Duration::from_secs(60),
        Action::Discard,
    )?;
    let mut out = Vec::new();
    let mut fields = raw.split('\0');
    while let Some(rec) = fields.next() {
        let (Some(code), Some(path)) = (rec.get(..2), rec.get(3..)) else {
            continue;
        };
        let mut cs = code.chars();
        let x = cs.next().unwrap_or(' ');
        let y = cs.next().unwrap_or(' ');
        let orig = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            fields.next().map(str::to_string)
        } else {
            None
        };
        if path.is_empty() || path.ends_with('/') {
            continue; // nested repos (folders) are never discarded
        }
        out.push(StatusRec {
            x,
            y,
            path: path.to_string(),
            orig,
        });
    }
    Ok(out)
}

fn has_head(top: &Path, extra: ExtraEnv) -> bool {
    query(top, extra, &["rev-parse", "--verify", "-q", "HEAD"]).is_some()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// What is on disk at `rel` right now, as a short string: missing, a
/// folder, a symlink (its target, never followed) or a regular file (its
/// length and the SHA-256 of its bytes, streamed). This is change
/// detection, not a lock: a write landing after this read still races.
fn disk_state(top: &Path, rel: &str) -> String {
    use sha2::{Digest, Sha256};
    use std::io::ErrorKind;
    let p = top.join(rel);
    let m = match p.symlink_metadata() {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return "missing".into(),
        Err(e) => return format!("unreadable:{:?}", e.kind()),
    };
    if m.file_type().is_symlink() {
        return match std::fs::read_link(&p) {
            Ok(t) => format!(
                "link:{}",
                hex(&Sha256::digest(t.as_os_str().as_encoded_bytes()))
            ),
            Err(e) => format!("unreadable:{:?}", e.kind()),
        };
    }
    if m.is_dir() {
        return "dir".into();
    }
    let mut f = match std::fs::File::open(&p) {
        Ok(f) => f,
        Err(e) => return format!("unreadable:{:?}", e.kind()),
    };
    // Opening follows a symlink: make sure the open file is the one
    // `symlink_metadata` saw (it was not swapped in between).
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match f.metadata() {
            Ok(fm) if fm.ino() == m.ino() && fm.dev() == m.dev() => {}
            _ => return "unstable".into(),
        }
    }
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut len: u64 = 0;
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                h.update(&buf[..n]);
                len += n as u64;
            }
            Err(e) => return format!("unreadable:{:?}", e.kind()),
        }
    }
    format!("file:{len}:{}", hex(&h.finalize()))
}

/// Index entries (`mode oid stage`, all stages) by repo-relative path.
fn index_entries(
    top: &Path,
    extra: ExtraEnv,
) -> Result<std::collections::HashMap<String, String>, GitActionError> {
    let raw = run_stdout_raw(
        top,
        extra,
        &["ls-files", "--stage", "-z"],
        Duration::from_secs(60),
        Action::Discard,
    )?;
    let mut map: std::collections::HashMap<String, String> = Default::default();
    for rec in raw.split('\0').filter(|r| !r.is_empty()) {
        if let Some((meta, path)) = rec.split_once('\t') {
            let e = map.entry(path.to_string()).or_default();
            e.push_str(meta);
            e.push(';');
        }
    }
    Ok(map)
}

/// The on-disk part of a row's fingerprint (`path`, then `source`).
fn row_disk_state(top: &Path, it: &DiscardItem) -> String {
    let mut s = disk_state(top, &it.path);
    if let Some(src) = &it.source {
        s.push('|');
        s.push_str(&disk_state(top, src));
    }
    s
}

/// Fill in a planned row's fingerprint: everything Discard is about to act
/// on for it, hashed (status letters, index entries, bytes on disk).
fn seal(
    top: &Path,
    it: &mut DiscardItem,
    recs: &[StatusRec],
    index: &std::collections::HashMap<String, String>,
) {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for r in recs.iter().filter(|r| r.path == it.path) {
        h.update([r.x as u8, r.y as u8, 0]);
        h.update(r.orig.as_deref().unwrap_or("").as_bytes());
        h.update([0]);
    }
    for p in std::iter::once(&it.path).chain(it.source.as_ref()) {
        h.update(p.as_bytes());
        h.update([0]);
        h.update(index.get(p).map(String::as_str).unwrap_or("-").as_bytes());
        h.update([0]);
    }
    it.worktree = row_disk_state(top, it);
    h.update(it.worktree.as_bytes());
    it.fingerprint = hex(&h.finalize()[..16]);
}

/// The Discard row for one status record.
fn plan_item(r: &StatusRec, head: bool) -> DiscardItem {
    let staged = r.x != ' ' && r.x != '?';
    let partially_staged = staged && r.y != ' ';
    let item = |action, detail: &str, source: Option<String>| DiscardItem {
        path: r.path.clone(),
        action,
        detail: detail.to_string(),
        source,
        staged,
        partially_staged,
        untracked: r.x == '?',
        fingerprint: String::new(),
        worktree: String::new(),
    };
    if r.x == '?' {
        return item(DiscardAction::Delete, "Untracked: moved to the Trash", None);
    }
    if !head {
        return item(
            DiscardAction::Delete,
            "New file (no commits yet): unstaged and moved to the Trash",
            None,
        );
    }
    if r.x == 'R' || r.y == 'R' {
        let src = r.orig.clone().filter(|o| !o.is_empty());
        let detail = match &src {
            Some(o) => format!("Rename undone: {o} is restored, this file goes to the Trash"),
            None => "Rename undone: this file goes to the Trash".to_string(),
        };
        return item(DiscardAction::Delete, &detail, src);
    }
    if r.x == 'A' || r.x == 'C' || r.y == 'A' {
        return item(
            DiscardAction::Delete,
            "New file: unstaged and moved to the Trash",
            None,
        );
    }
    let detail = if r.x == 'U' || r.y == 'U' {
        "Conflicted: reverted to the last commit"
    } else if partially_staged {
        "Staged and unstaged changes: both are reverted to the last commit"
    } else if r.x == 'D' || r.y == 'D' {
        "Deleted: restored from the last commit"
    } else if staged {
        "Staged changes: unstaged and reverted to the last commit"
    } else {
        "Reverted to the last commit"
    };
    item(DiscardAction::Revert, detail, None)
}

/// Validate, then plan every requested path against a fresh status. Paths
/// that are invalid or no longer changed are returned as failures.
fn plan_discard(
    root: &str,
    paths: &[String],
    extra: ExtraEnv,
) -> Result<(PathBuf, bool, Vec<DiscardItem>, Vec<DiscardFailure>), GitActionError> {
    let root = check_local(root, DISCARD_UNSUPPORTED)?;
    if paths.is_empty() {
        return Err(GitActionError::new(
            GitErrorKind::NothingToCommit,
            "Select at least one file to discard.",
            "",
        ));
    }
    let top = query(&root, extra, &["rev-parse", "--show-toplevel"])
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            GitActionError::new(
                GitErrorKind::NotARepo,
                "This folder is not a git repository.",
                "",
            )
        })?;
    let head = has_head(&top, extra);
    let recs = status_records(&top, extra)?;
    let mut items = Vec::new();
    let mut failed = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for p in paths {
        if !seen.insert(p.as_str()) {
            continue;
        }
        if let Err(why) = check_discard_path(&top, p) {
            failed.push(DiscardFailure {
                path: p.clone(),
                message: format!("Refused: {why}."),
            });
            continue;
        }
        match recs.iter().find(|r| &r.path == p) {
            Some(r) => {
                let mut it = plan_item(r, head);
                // `git rm --cached` leaves two records: a staged deletion and
                // an untracked file with the same name. Reverting brings back
                // HEAD's version over the file on disk, so say so.
                if r.x == 'D' && recs.iter().any(|o| o.x == '?' && &o.path == p) {
                    it.partially_staged = true;
                    it.untracked = false;
                    it.detail = "Staged deletion, file still on disk: both are reverted to the last commit (the file on disk is replaced)".into();
                }
                if let Some(src) = &it.source {
                    if let Err(why) = check_discard_path(&top, src) {
                        failed.push(DiscardFailure {
                            path: p.clone(),
                            message: format!("Refused (rename source {src}): {why}."),
                        });
                        continue;
                    }
                }
                items.push(it);
            }
            None => failed.push(DiscardFailure {
                path: p.clone(),
                message: "Not changed any more (nothing to discard).".into(),
            }),
        }
    }
    if !items.is_empty() {
        let index = index_entries(&top, extra)?;
        for it in &mut items {
            seal(&top, it, &recs, &index);
        }
    }
    Ok((top, head, items, failed))
}

/// The Discard confirmation's rows: what will happen to each path (#172).
pub(crate) fn discard_preview_impl(
    root: &str,
    paths: &[String],
    extra: ExtraEnv,
) -> Result<Vec<DiscardItem>, GitActionError> {
    let (_, _, items, failed) = plan_discard(root, paths, extra)?;
    if items.is_empty() {
        return Err(failure_error(&failed));
    }
    Ok(items)
}

fn failure_error(failed: &[DiscardFailure]) -> GitActionError {
    let detail = failed
        .iter()
        .map(|f| format!("{}: {}", f.path, f.message))
        .collect::<Vec<_>>()
        .join("\n");
    let message = match failed {
        [one] => format!("Couldn't discard {}: {}", one.path, one.message),
        _ => format!("Couldn't discard {} files. See the details.", failed.len()),
    };
    GitActionError::new(GitErrorKind::Other, message, detail)
}

/// Move a work-tree file (or symlink) to the trash; a folder is refused.
/// A path that is already gone is fine.
fn trash_file(top: &Path, rel: &str, trasher: Trasher) -> Result<bool, String> {
    let abs = top.join(rel);
    match abs.symlink_metadata() {
        Err(_) => Ok(false),
        Ok(m) if m.is_dir() => Err("it is a folder; Discard never removes folders".into()),
        Ok(_) => trasher(&abs).map(|_| true),
    }
}

/// Discard the changes of `paths` (repo-relative to the top level, #172):
/// tracked files go back to HEAD in both the index and the work tree
/// (`git restore --source=HEAD --staged --worktree`, literal pathspecs, one
/// file at a time); files with no committed version are unstaged and moved
/// to the OS trash. Never `reset --hard`, never `clean`, never a recursive
/// delete, never through a symlinked folder. Each path is re-checked
/// against a fresh status first.
pub(crate) fn discard_impl(
    root: &str,
    confirmed: &[DiscardRequest],
    extra: ExtraEnv,
    trasher: Trasher,
) -> Result<DiscardResult, GitActionError> {
    let paths: Vec<String> = confirmed.iter().map(|r| r.path.clone()).collect();
    let (top, head, planned, mut failed) = plan_discard(root, &paths, extra)?;
    let mut items = Vec::new();
    for it in planned {
        let same = confirmed
            .iter()
            .find(|r| r.path == it.path)
            .is_some_and(|r| {
                r.action == it.action && r.source == it.source && r.fingerprint == it.fingerprint
            });
        if same {
            items.push(it);
        } else {
            failed.push(DiscardFailure {
                path: it.path.clone(),
                message: CHANGED_SINCE_CONFIRMED.into(),
            });
        }
    }
    let mut res = DiscardResult::default();
    let mut log: Vec<String> = Vec::new();
    for it in &items {
        // Every row was checked against its confirmation above, before any
        // change. Check this row's path and bytes on disk once more right
        // before touching it, so an edit made while earlier rows ran is not
        // lost. (Still not atomic: a write after this check races.)
        let guard = check_discard_path(&top, &it.path).and_then(|()| match &it.source {
            Some(src) => check_discard_path(&top, src),
            None => Ok(()),
        });
        if guard.is_err() || row_disk_state(&top, it) != it.worktree {
            failed.push(DiscardFailure {
                path: it.path.clone(),
                message: CHANGED_SINCE_CONFIRMED.into(),
            });
            continue;
        }
        let (trashed, outcome) = discard_one(&top, head, it, extra, trasher, &mut log);
        if trashed {
            res.trashed.push(it.path.clone());
        }
        match outcome {
            Ok(()) => res.discarded.push(it.path.clone()),
            Err(message) => failed.push(DiscardFailure {
                path: it.path.clone(),
                message,
            }),
        }
    }
    // An error only when nothing at all changed on disk; any side effect
    // (even a trashed file whose next step failed) comes back as a result so
    // the app can reconcile its tabs.
    if res.discarded.is_empty() && res.trashed.is_empty() {
        let mut e = failure_error(&failed);
        if !log.is_empty() {
            e.detail = format!("{}\n\n{}", e.detail, log.join("\n"));
        }
        return Err(e);
    }
    res.failed = failed;
    res.output = log.join("\n");
    Ok(res)
}

/// Discard one planned path. Returns whether the file went to the trash
/// (also when a later step failed, so the caller can report it) and the
/// outcome. The index is always changed before the work tree: a failing git
/// step (an index lock, a hook) leaves the file untouched on disk.
fn discard_one(
    top: &Path,
    head: bool,
    it: &DiscardItem,
    extra: ExtraEnv,
    trasher: Trasher,
    log: &mut Vec<String>,
) -> (bool, Result<(), String>) {
    let git = |args: &[&str], log: &mut Vec<String>| -> Result<(), String> {
        log.push(format!("$ git {}", args.join(" ")));
        let o = user_git(top, extra, args, COMMIT_TIMEOUT).map_err(|e| e.message)?;
        let t = text(&o);
        if !t.is_empty() {
            log.push(t.clone());
        }
        if o.status.success() {
            Ok(())
        } else {
            Err(classify(Action::Discard, &t).message)
        }
    };
    let path = it.path.as_str();
    let trash = |log: &mut Vec<String>| -> Result<bool, String> {
        let trashed = trash_file(top, path, trasher)
            .map_err(|e| format!("Couldn't move it to the Trash: {e}"))?;
        if trashed {
            log.push(format!("moved {path} to the Trash"));
        }
        Ok(trashed)
    };
    match it.action {
        DiscardAction::Revert => (
            false,
            git(
                &[
                    "--literal-pathspecs",
                    "restore",
                    "--source=HEAD",
                    "--staged",
                    "--worktree",
                    "--",
                    path,
                ],
                log,
            ),
        ),
        // Untracked: re-checked as `??` by the fresh status in the plan.
        DiscardAction::Delete if it.untracked => match trash(log) {
            Ok(t) => (t, Ok(())),
            Err(e) => (false, Err(e)),
        },
        DiscardAction::Delete => {
            // 1. Index only: drop the entry that isn't in HEAD (and, for a
            //    rename, put the source's entry back). The file on disk is
            //    not touched, so a failure here changes nothing.
            let unstage = if head {
                let mut args = vec![
                    "--literal-pathspecs",
                    "restore",
                    "--source=HEAD",
                    "--staged",
                    "--",
                    path,
                ];
                if let Some(src) = &it.source {
                    args.push(src);
                }
                git(&args, log)
            } else {
                git(
                    &[
                        "--literal-pathspecs",
                        "rm",
                        "--cached",
                        "--quiet",
                        "--ignore-unmatch",
                        "--",
                        path,
                    ],
                    log,
                )
            };
            if let Err(e) = unstage {
                return (false, Err(e));
            }
            // 2. The file (now untracked) goes to the trash; on failure it
            //    stays where it is.
            let trashed = match trash(log) {
                Ok(t) => t,
                Err(e) => {
                    return (
                        false,
                        Err(format!("{e} (it was unstaged and is still on disk)")),
                    )
                }
            };
            // 3. A rename's source comes back on disk from the restored
            //    index, unless a file already sits there (never overwritten).
            if let Some(src) = &it.source {
                if top.join(src).symlink_metadata().is_ok() {
                    log.push(format!("kept the existing {src} on disk"));
                } else if let Err(e) = git(
                    &["--literal-pathspecs", "restore", "--worktree", "--", src],
                    log,
                ) {
                    return (
                        trashed,
                        Err(format!(
                            "Moved to the Trash, but {src} couldn't be restored: {e}"
                        )),
                    );
                }
            }
            (trashed, Ok(()))
        }
    }
}

#[tauri::command]
pub async fn git_discard_preview(
    webview_window: tauri::WebviewWindow,
    root: String,
    paths: Vec<String>,
) -> Result<Vec<DiscardItem>, GitActionError> {
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        discard_preview_impl(&root, &paths, &[])
    })
    .await
    .map_err(|e| GitActionError::new(GitErrorKind::Other, "The git task failed.", e.to_string()))?
}

#[tauri::command]
pub async fn git_discard(
    webview_window: tauri::WebviewWindow,
    root: String,
    items: Vec<DiscardRequest>,
) -> Result<DiscardResult, GitActionError> {
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        discard_impl(&root, &items, &[], &os_trash)
    })
    .await
    .map_err(|e| GitActionError::new(GitErrorKind::Other, "The git task failed.", e.to_string()))?
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
            "[user]\n\tname = Test\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
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
        let r = push_impl(&root(&sb), &env).unwrap();
        assert_eq!(r.commits, Some(1));
        assert_eq!(r.target.as_deref(), Some("origin/main"));
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
        let r = pull_impl(&root(&sb), &env).unwrap();
        assert_eq!(r.commits, Some(1));
        assert_eq!(r.target.as_deref(), Some("origin/main"));
        assert!(!r.output.is_empty());
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
        assert_eq!(e.kind, GitErrorKind::MergeConflict, "{e:?}");
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

    /// Diverge `sb.work` from its upstream: one commit on the remote
    /// (`up.md`), `n` local ones (`l<i>.md`); the remote side is fetched.
    fn diverge(sb: &Sandbox, n: u32) {
        let other = sb.other();
        sb.commit_in(&other, "up.md", "up\n", "upstream");
        sb.git(&other, &["push", "-q"]);
        for i in 0..n {
            sb.commit_in(&sb.work, &format!("l{i}.md"), "l\n", "local");
        }
        sb.git(&sb.work, &["fetch", "-q"]);
        assert_eq!(ahead_behind(sb), (n, 1));
    }

    #[test]
    fn pull_args_merge_only_without_any_pull_config() {
        let unset = PullConfig {
            rebase: None,
            ff: None,
        };
        assert_eq!(
            pull_args(&unset),
            ["-c", "pull.rebase=false", "pull", "--no-edit"]
        );
        for cfg in [
            PullConfig {
                rebase: Some("true".into()),
                ff: None,
            },
            PullConfig {
                rebase: Some("false".into()),
                ff: None,
            },
            PullConfig {
                rebase: None,
                ff: Some("only".into()),
            },
        ] {
            assert_eq!(pull_args(&cfg), ["pull", "--no-edit"], "{cfg:?}");
        }
    }

    #[test]
    fn pull_diverged_without_config_merges() {
        let sb = sandbox();
        let env = sb.env();
        diverge(&sb, 2);
        let r = pull_impl(&root(&sb), &env).unwrap();
        assert_eq!(r.target.as_deref(), Some("origin/main"));
        // A merge commit: two parents, and (behind, ahead) → (0, n + 1).
        let parents = sb.git(&sb.work, &["rev-list", "--parents", "-n", "1", "HEAD"]);
        assert_eq!(parents.split_whitespace().count(), 3, "{parents}");
        assert_eq!(ahead_behind(&sb), (3, 0));
        assert!(sb.work.join("up.md").exists());
    }

    #[test]
    fn pull_diverged_with_ff_only_is_a_clear_error_and_leaves_head() {
        let sb = sandbox();
        let env = sb.env();
        sb.git(&sb.work, &["config", "pull.ff", "only"]);
        diverge(&sb, 1);
        let head = sb.git(&sb.work, &["rev-parse", "HEAD"]);
        let e = pull_impl(&root(&sb), &env).unwrap_err();
        assert_eq!(e.kind, GitErrorKind::Diverged, "{e:?}");
        assert!(e.message.contains("pull.ff=only"), "{}", e.message);
        assert!(!e.message.contains("set pull.rebase"), "{}", e.message);
        assert!(!e.detail.is_empty());
        assert_eq!(sb.git(&sb.work, &["rev-parse", "HEAD"]), head);
        assert_eq!(ahead_behind(&sb), (1, 1));
    }

    #[test]
    fn pull_diverged_respects_pull_rebase_true() {
        let sb = sandbox();
        let env = sb.env();
        sb.git(&sb.work, &["config", "pull.rebase", "true"]);
        diverge(&sb, 2);
        pull_impl(&root(&sb), &env).unwrap();
        // Rebased: linear history on top of the upstream, no merge commit.
        assert_eq!(ahead_behind(&sb), (2, 0));
        let merges = sb.git(&sb.work, &["rev-list", "--merges", "--count", "HEAD"]);
        assert_eq!(merges, "0");
    }

    #[test]
    fn pull_respects_branch_rebase_config_too() {
        let sb = sandbox();
        let env = sb.env();
        sb.git(&sb.work, &["config", "branch.main.rebase", "true"]);
        diverge(&sb, 1);
        pull_impl(&root(&sb), &env).unwrap();
        assert_eq!(ahead_behind(&sb), (1, 0));
        assert_eq!(
            sb.git(&sb.work, &["rev-list", "--merges", "--count", "HEAD"]),
            "0"
        );
    }

    #[test]
    fn pull_merge_conflict_is_typed_lists_files_and_stays_mid_merge() {
        let sb = sandbox();
        let env = sb.env();
        let other = sb.other();
        sb.commit_in(&other, "README.md", "theirs\n", "theirs");
        sb.git(&other, &["push", "-q"]);
        sb.commit_in(&sb.work, "README.md", "ours\n", "ours");
        let e = pull_impl(&root(&sb), &env).unwrap_err();
        assert_eq!(e.kind, GitErrorKind::MergeConflict, "{e:?}");
        assert_eq!(e.files, vec!["README.md".to_string()]);
        assert!(
            e.message.contains("merge conflicts in 1 file"),
            "{}",
            e.message
        );
        assert!(e.detail.contains("CONFLICT"), "{}", e.detail);
        assert!(
            e.detail.contains("Conflicted files:\n  README.md"),
            "{}",
            e.detail
        );
        // No auto-abort: MERGE_HEAD is still there, the file is unmerged.
        sb.git(&sb.work, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
        let st = sb.git(&sb.work, &["status", "--porcelain"]);
        assert!(st.starts_with("UU README.md"), "{st}");
    }

    #[test]
    fn pull_rebase_conflict_is_typed_and_stays_mid_rebase() {
        let sb = sandbox();
        let env = sb.env();
        sb.git(&sb.work, &["config", "pull.rebase", "true"]);
        let other = sb.other();
        sb.commit_in(&other, "README.md", "theirs\n", "theirs");
        sb.git(&other, &["push", "-q"]);
        sb.commit_in(&sb.work, "README.md", "ours\n", "ours");
        let e = pull_impl(&root(&sb), &env).unwrap_err();
        assert_eq!(e.kind, GitErrorKind::RebaseConflict, "{e:?}");
        assert_eq!(e.files, vec!["README.md".to_string()]);
        assert!(e.message.contains("rebasing"), "{}", e.message);
        assert!(e.message.contains("git rebase --continue"), "{}", e.message);
        assert!(rebase_in_progress(&sb.work, &env));
        assert!(!merge_in_progress(&sb.work, &env));
    }

    #[test]
    fn fetch_updates_the_behind_count_quietly() {
        let sb = sandbox();
        let env = sb.env();
        let other = sb.other();
        sb.commit_in(&other, "up.md", "up\n", "upstream");
        sb.git(&other, &["push", "-q"]);
        assert_eq!(ahead_behind(&sb), (0, 0), "nothing fetched yet");
        assert_eq!(fetch_impl(&root(&sb), &env).unwrap(), FetchOutcome::Fetched);
        assert_eq!(ahead_behind(&sb), (0, 1));
        // Fetch only: the work tree and HEAD did not move.
        assert!(!sb.work.join("up.md").exists());
    }

    #[test]
    fn fetch_after_rejected_push_shows_behind() {
        let _session = crate::remote::TEST_SESSION_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let sb = sandbox();
        let env = sb.env();
        let other = sb.other();
        sb.commit_in(&other, "x.md", "x\n", "theirs");
        sb.git(&other, &["push", "-q"]);
        sb.commit_in(&sb.work, "y.md", "y\n", "ours");
        assert_eq!(
            push_impl(&root(&sb), &env).unwrap_err().kind,
            GitErrorKind::Rejected
        );
        fetch_impl(&root(&sb), &env).unwrap();
        assert_eq!(ahead_behind(&sb), (1, 1));
    }

    #[test]
    fn fetch_never_prompts_and_needs_an_upstream() {
        let sb = sandbox();
        let env = sb.env();
        sb.git(
            &sb.work,
            &["remote", "set-url", "origin", "http://127.0.0.1:9/repo.git"],
        );
        let t = Instant::now();
        let e = fetch_impl(&root(&sb), &env).unwrap_err();
        assert!(
            matches!(e.kind, GitErrorKind::Network | GitErrorKind::Auth),
            "{e:?}"
        );
        assert!(t.elapsed() < FETCH_TIMEOUT);
        sb.git(&sb.work, &["checkout", "-q", "-b", "feature"]);
        assert_eq!(
            fetch_impl(&root(&sb), &env).unwrap_err().kind,
            GitErrorKind::NoUpstream
        );
    }

    #[test]
    fn one_fetch_in_flight_per_window() {
        let a = InFlight::claim("test-window-a").expect("first claim");
        assert!(InFlight::claim("test-window-a").is_none(), "second is busy");
        let b = InFlight::claim("test-window-b");
        assert!(b.is_some(), "other windows are independent");
        drop(a);
        assert!(
            InFlight::claim("test-window-a").is_some(),
            "released on drop"
        );
    }

    // --- Discard (#172) ---

    /// A fake trash: moves the path (never following a link) into the
    /// sandbox's `trash/` folder and records what it got.
    struct FakeTrash {
        dir: PathBuf,
        got: std::sync::Mutex<Vec<String>>,
    }
    impl FakeTrash {
        fn new(sb: &Sandbox) -> Self {
            let dir = sb.bare.parent().unwrap().join("trash");
            fs::create_dir_all(&dir).unwrap();
            FakeTrash {
                dir,
                got: Default::default(),
            }
        }
        fn trash(&self, p: &Path) -> Result<(), String> {
            let mut got = self.got.lock().unwrap();
            let dest = self.dir.join(format!(
                "{}-{}",
                got.len(),
                p.file_name().unwrap().to_string_lossy()
            ));
            fs::rename(p, &dest).map_err(|e| e.to_string())?;
            got.push(p.file_name().unwrap().to_string_lossy().into_owned());
            Ok(())
        }
        fn names(&self) -> Vec<String> {
            self.got.lock().unwrap().clone()
        }
        /// Content of the n-th trashed item.
        fn content(&self, n: usize, name: &str) -> String {
            fs::read_to_string(self.dir.join(format!("{n}-{name}"))).unwrap()
        }
    }

    /// Confirm what a fresh plan says for each path (as the dialog does),
    /// then discard. Paths the plan refuses are sent as a plain revert.
    fn confirmed(sb: &Sandbox, paths: &[&str]) -> Vec<DiscardRequest> {
        let env = sb.env();
        let owned: Vec<String> = paths.iter().map(|s| s.to_string()).collect();
        let planned = plan_discard(&root(sb), &owned, &env)
            .map(|(_, _, items, _)| items)
            .unwrap_or_default();
        owned
            .into_iter()
            .map(|path| match planned.iter().find(|i| i.path == path) {
                Some(i) => DiscardRequest {
                    path,
                    action: i.action,
                    source: i.source.clone(),
                    fingerprint: i.fingerprint.clone(),
                },
                None => DiscardRequest {
                    path,
                    action: DiscardAction::Revert,
                    source: None,
                    fingerprint: String::new(),
                },
            })
            .collect()
    }

    fn discard(
        sb: &Sandbox,
        t: &FakeTrash,
        paths: &[&str],
    ) -> Result<DiscardResult, GitActionError> {
        let env = sb.env();
        discard_impl(&root(sb), &confirmed(sb, paths), &env, &|p: &Path| {
            t.trash(p)
        })
    }

    fn preview(sb: &Sandbox, paths: &[&str]) -> Vec<DiscardItem> {
        let env = sb.env();
        let paths: Vec<String> = paths.iter().map(|s| s.to_string()).collect();
        discard_preview_impl(&root(sb), &paths, &env).unwrap()
    }

    /// Porcelain status with its leading status columns intact (a
    /// trimmed " M x" would read as a staged "M  x").
    fn status(sb: &Sandbox) -> String {
        let env = sb.env();
        run_stdout_raw(
            &sb.work,
            &env,
            &["status", "--porcelain", "--untracked-files=all"],
            Duration::from_secs(20),
            Action::Discard,
        )
        .unwrap()
        .trim_end()
        .to_string()
    }

    /// A sandbox with a few committed files to change.
    fn discard_sandbox() -> Sandbox {
        let sb = sandbox();
        sb.commit_in(&sb.work, "a.md", "a\n", "a");
        sb.commit_in(&sb.work, "b.md", "b\n", "b");
        fs::create_dir_all(sb.work.join("docs")).unwrap();
        sb.commit_in(&sb.work, "docs/c.md", "c\n", "c");
        sb
    }

    #[test]
    fn discard_modified_reverts_and_leaves_the_rest() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        fs::write(sb.work.join("a.md"), "edited\n").unwrap();
        fs::write(sb.work.join("b.md"), "keep me\n").unwrap();
        fs::write(sb.work.join("new.md"), "untracked, keep\n").unwrap();
        let p = preview(&sb, &["a.md"]);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].action, DiscardAction::Revert);
        let r = discard(&sb, &t, &["a.md"]).unwrap();
        assert_eq!(r.discarded, ["a.md"]);
        assert!(r.failed.is_empty());
        assert_eq!(fs::read_to_string(sb.work.join("a.md")).unwrap(), "a\n");
        // Only the selected path was touched.
        assert_eq!(
            fs::read_to_string(sb.work.join("b.md")).unwrap(),
            "keep me\n"
        );
        assert!(sb.work.join("new.md").exists());
        assert_eq!(status(&sb), " M b.md\n?? new.md");
        assert!(t.names().is_empty());
    }

    #[test]
    fn discard_staged_and_partially_staged_revert_both_layers() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        fs::write(sb.work.join("a.md"), "staged\n").unwrap();
        sb.git(&sb.work, &["add", "a.md"]);
        fs::write(sb.work.join("b.md"), "staged\n").unwrap();
        sb.git(&sb.work, &["add", "b.md"]);
        fs::write(sb.work.join("b.md"), "staged and more\n").unwrap();
        let p = preview(&sb, &["a.md", "b.md"]);
        assert!(p[0].staged && !p[0].partially_staged, "{p:?}");
        assert!(p[1].partially_staged, "{p:?}");
        assert!(
            p[1].detail.contains("Staged and unstaged"),
            "{}",
            p[1].detail
        );
        discard(&sb, &t, &["a.md", "b.md"]).unwrap();
        assert_eq!(status(&sb), "");
        assert_eq!(fs::read_to_string(sb.work.join("b.md")).unwrap(), "b\n");
    }

    #[test]
    fn discard_deleted_and_staged_delete_restore_from_head() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        fs::remove_file(sb.work.join("a.md")).unwrap();
        sb.git(&sb.work, &["rm", "-q", "b.md"]);
        fs::remove_dir_all(sb.work.join("docs")).unwrap();
        let p = preview(&sb, &["a.md", "b.md", "docs/c.md"]);
        assert!(p.iter().all(|i| i.action == DiscardAction::Revert));
        assert!(p[0].detail.starts_with("Deleted"), "{}", p[0].detail);
        discard(&sb, &t, &["a.md", "b.md", "docs/c.md"]).unwrap();
        assert_eq!(status(&sb), "");
        assert_eq!(
            fs::read_to_string(sb.work.join("docs/c.md")).unwrap(),
            "c\n"
        );
    }

    #[test]
    fn discard_staged_rename_restores_both_halves() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        sb.git(&sb.work, &["mv", "a.md", "renamed.md"]);
        assert_eq!(status(&sb), "R  a.md -> renamed.md");
        let p = preview(&sb, &["renamed.md"]);
        assert_eq!(p[0].source.as_deref(), Some("a.md"));
        assert_eq!(p[0].action, DiscardAction::Delete);
        let r = discard(&sb, &t, &["renamed.md"]).unwrap();
        assert_eq!(r.trashed, ["renamed.md"]);
        assert_eq!(status(&sb), "", "no new file left behind");
        assert_eq!(fs::read_to_string(sb.work.join("a.md")).unwrap(), "a\n");
        assert!(!sb.work.join("renamed.md").exists());
        // The new file's content is recoverable from the trash.
        assert_eq!(t.content(0, "renamed.md"), "a\n");
    }

    #[test]
    fn discard_untracked_moves_to_trash_after_a_fresh_status_check() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        fs::write(sb.work.join("scratch.md"), "draft\n").unwrap();
        fs::write(sb.work.join("other.md"), "other\n").unwrap();
        let p = preview(&sb, &["scratch.md"]);
        assert_eq!(p[0].action, DiscardAction::Delete);
        assert!(p[0].untracked);
        let r = discard(&sb, &t, &["scratch.md"]).unwrap();
        assert_eq!(r.trashed, ["scratch.md"]);
        assert!(!sb.work.join("scratch.md").exists());
        assert_eq!(t.content(0, "scratch.md"), "draft\n");
        assert_eq!(status(&sb), "?? other.md");
    }

    #[test]
    fn discard_staged_add_unstages_and_trashes() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        fs::write(sb.work.join("added.md"), "new\n").unwrap();
        sb.git(&sb.work, &["add", "added.md"]);
        fs::write(sb.work.join("added.md"), "new, edited\n").unwrap();
        let p = preview(&sb, &["added.md"]);
        assert_eq!(p[0].action, DiscardAction::Delete);
        discard(&sb, &t, &["added.md"]).unwrap();
        assert_eq!(status(&sb), "");
        assert_eq!(t.content(0, "added.md"), "new, edited\n");
    }

    #[test]
    fn discard_glob_like_names_are_literal() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        sb.commit_in(&sb.work, "*.md", "star\n", "star");
        fs::write(sb.work.join("*.md"), "star edited\n").unwrap();
        fs::write(sb.work.join("a.md"), "a edited\n").unwrap();
        discard(&sb, &t, &["*.md"]).unwrap();
        assert_eq!(fs::read_to_string(sb.work.join("*.md")).unwrap(), "star\n");
        assert_eq!(status(&sb), " M a.md", "the glob matched nothing else");
    }

    #[test]
    fn discard_odd_file_names_unstaged_round_trip() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        let names = [
            " lead.md",
            "trail .md",
            "a b[1].md",
            "ção ✓.md",
            ":(top)x.md",
        ];
        for n in names {
            fs::write(sb.work.join(n), "orig\n").unwrap();
            sb.git(&sb.work, &["--literal-pathspecs", "add", "--", n]);
        }
        sb.git(&sb.work, &["commit", "-q", "-m", "odd names"]);
        for n in names {
            fs::write(sb.work.join(n), "edited\n").unwrap();
        }
        let p = preview(&sb, &names);
        assert_eq!(p.len(), names.len(), "{p:?}");
        assert!(p.iter().all(|i| i.action == DiscardAction::Revert), "{p:?}");
        let r = discard(&sb, &t, &names).unwrap();
        assert!(r.failed.is_empty(), "{:?}", r.failed);
        for n in names {
            assert_eq!(
                fs::read_to_string(sb.work.join(n)).unwrap(),
                "orig\n",
                "{n}"
            );
        }
        assert_eq!(status(&sb), "");
    }

    #[test]
    fn discard_a_conflicted_file_goes_back_to_head_and_stays_mid_merge() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        let env = sb.env();
        let other = sb.other();
        sb.commit_in(&other, "README.md", "theirs\n", "theirs");
        sb.git(&other, &["push", "-q"]);
        sb.commit_in(&sb.work, "README.md", "ours\n", "ours");
        assert_eq!(
            pull_impl(&root(&sb), &env).unwrap_err().kind,
            GitErrorKind::MergeConflict
        );
        let p = preview(&sb, &["README.md"]);
        assert!(p[0].detail.starts_with("Conflicted"), "{}", p[0].detail);
        discard(&sb, &t, &["README.md"]).unwrap();
        assert_eq!(
            fs::read_to_string(sb.work.join("README.md")).unwrap(),
            "ours\n"
        );
        assert!(
            merge_in_progress(&sb.work, &env),
            "the merge itself is not aborted"
        );
        assert!(conflicted_files(&sb.work, &env).is_empty());
    }

    #[test]
    fn discard_rejects_escaping_paths() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        let outside = sb.bare.parent().unwrap().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("x.md"), "precious\n").unwrap();
        let abs = outside.join("x.md").to_string_lossy().into_owned();
        for bad in [
            "../outside/x.md",
            abs.as_str(),
            "",
            "./a.md",
            "docs/../a.md",
        ] {
            let e = discard(&sb, &t, &[bad]).unwrap_err();
            assert!(e.detail.contains("Refused"), "{bad}: {e:?}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, sb.work.join("link")).unwrap();
            let e = discard(&sb, &t, &["link/x.md"]).unwrap_err();
            assert!(e.detail.contains("symbolic link"), "{e:?}");
        }
        assert_eq!(
            fs::read_to_string(outside.join("x.md")).unwrap(),
            "precious\n"
        );
        assert!(t.names().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn discard_untracked_symlink_trashes_the_link_not_its_target() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        let target = sb.bare.parent().unwrap().join("target.md");
        fs::write(&target, "target\n").unwrap();
        std::os::unix::fs::symlink(&target, sb.work.join("ln.md")).unwrap();
        discard(&sb, &t, &["ln.md"]).unwrap();
        assert!(sb.work.join("ln.md").symlink_metadata().is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "target\n");
    }

    #[test]
    fn discard_never_removes_a_folder() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        // An untracked nested repo is a folder row: never in the plan.
        sb.git(&sb.work, &["init", "-q", "nested"]);
        fs::write(sb.work.join("nested/f.md"), "f\n").unwrap();
        let e = discard(&sb, &t, &["nested"]).unwrap_err();
        assert!(e.detail.contains("Not changed"), "{e:?}");
        assert!(sb.work.join("nested/f.md").exists());
    }

    #[test]
    fn discard_partial_failure_is_reported_per_path() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        fs::write(sb.work.join("a.md"), "edited\n").unwrap();
        let r = discard(&sb, &t, &["a.md", "not-changed.md", "../x"]).unwrap();
        assert_eq!(r.discarded, ["a.md"]);
        let failed: Vec<&str> = r.failed.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(failed, ["not-changed.md", "../x"]);
    }

    #[test]
    fn discard_refuses_a_path_whose_plan_changed_since_confirmation() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        // scratch.md is confirmed as an untracked file to Trash...
        fs::write(sb.work.join("scratch.md"), "draft\n").unwrap();
        fs::write(sb.work.join("b.md"), "edited\n").unwrap();
        let req = confirmed(&sb, &["scratch.md", "b.md"]);
        assert_eq!(req[0].action, DiscardAction::Delete);
        // ...but it was committed and edited (now a tracked revert) before
        // Discard ran: the confirmation no longer describes it.
        sb.git(&sb.work, &["add", "scratch.md"]);
        sb.git(&sb.work, &["commit", "-q", "-m", "scratch"]);
        fs::write(sb.work.join("scratch.md"), "newer work\n").unwrap();
        let env = sb.env();
        let r = discard_impl(&root(&sb), &req, &env, &|p: &Path| t.trash(p)).unwrap();
        assert_eq!(r.discarded, ["b.md"]);
        assert_eq!(r.failed.len(), 1);
        assert_eq!(r.failed[0].path, "scratch.md");
        assert!(
            r.failed[0].message.contains("Changed since you confirmed"),
            "{:?}",
            r.failed
        );
        assert_eq!(
            fs::read_to_string(sb.work.join("scratch.md")).unwrap(),
            "newer work\n"
        );
        assert!(t.names().is_empty(), "nothing trashed");
    }

    /// Edits made while the confirmation is open must not be discarded
    /// unseen: same status letters, different bytes on disk (#172).
    #[test]
    fn discard_refuses_rows_whose_content_changed_since_confirmation() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        fs::write(sb.work.join("a.md"), "edited\n").unwrap();
        fs::write(sb.work.join("b.md"), "edited\n").unwrap();
        fs::write(sb.work.join("scratch.md"), "draft\n").unwrap();
        let req = confirmed(&sb, &["a.md", "b.md", "scratch.md"]);
        // While the dialog is open: a.md gets newer work (still ` M`) and
        // the untracked scratch.md is rewritten (still `??`).
        fs::write(sb.work.join("a.md"), "newer work, never shown\n").unwrap();
        fs::write(sb.work.join("scratch.md"), "newer draft\n").unwrap();
        let env = sb.env();
        let r = discard_impl(&root(&sb), &req, &env, &|p: &Path| t.trash(p)).unwrap();
        assert_eq!(r.discarded, ["b.md"]);
        let failed: Vec<&str> = r.failed.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(failed, ["a.md", "scratch.md"], "{:?}", r.failed);
        assert!(r
            .failed
            .iter()
            .all(|f| f.message.contains("Changed since you confirmed")));
        assert_eq!(
            fs::read_to_string(sb.work.join("a.md")).unwrap(),
            "newer work, never shown\n"
        );
        assert_eq!(
            fs::read_to_string(sb.work.join("scratch.md")).unwrap(),
            "newer draft\n"
        );
        assert!(t.names().is_empty(), "nothing trashed");
    }

    #[cfg(unix)]
    #[test]
    fn discard_refuses_an_untracked_file_swapped_for_a_symlink_since_confirmation() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        fs::write(sb.work.join("scratch.md"), "draft\n").unwrap();
        let req = confirmed(&sb, &["scratch.md"]);
        let target = sb.bare.parent().unwrap().join("precious.md");
        fs::write(&target, "precious\n").unwrap();
        fs::remove_file(sb.work.join("scratch.md")).unwrap();
        std::os::unix::fs::symlink(&target, sb.work.join("scratch.md")).unwrap();
        let env = sb.env();
        let e = discard_impl(&root(&sb), &req, &env, &|p: &Path| t.trash(p)).unwrap_err();
        assert!(e.detail.contains("Changed since you confirmed"), "{e:?}");
        assert!(sb
            .work
            .join("scratch.md")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "precious\n");
        assert!(t.names().is_empty());
    }

    #[test]
    fn discard_refuses_a_restaged_file_since_confirmation() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        fs::write(sb.work.join("a.md"), "staged v1\n").unwrap();
        sb.git(&sb.work, &["add", "a.md"]);
        let req = confirmed(&sb, &["a.md"]);
        // Same `M ` status, but a different staged blob (and work tree).
        fs::write(sb.work.join("a.md"), "staged v2\n").unwrap();
        sb.git(&sb.work, &["add", "a.md"]);
        let env = sb.env();
        let e = discard_impl(&root(&sb), &req, &env, &|p: &Path| t.trash(p)).unwrap_err();
        assert!(e.detail.contains("Changed since you confirmed"), "{e:?}");
        assert_eq!(status(&sb), "M  a.md");
    }

    #[test]
    fn discard_rechecks_each_row_right_before_touching_it() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        fs::write(sb.work.join("scratch.md"), "draft\n").unwrap();
        fs::write(sb.work.join("a.md"), "edited\n").unwrap();
        let req = confirmed(&sb, &["scratch.md", "a.md"]);
        let env = sb.env();
        let a = sb.work.join("a.md");
        // a.md passes the up-front check, then gets new work while the
        // first row (scratch.md) is being trashed.
        let r = discard_impl(&root(&sb), &req, &env, &|p: &Path| {
            t.trash(p)?;
            fs::write(&a, "typed meanwhile\n").map_err(|e| e.to_string())
        })
        .unwrap();
        assert_eq!(r.discarded, ["scratch.md"]);
        assert_eq!(r.failed.len(), 1);
        assert_eq!(r.failed[0].path, "a.md");
        assert_eq!(fs::read_to_string(&a).unwrap(), "typed meanwhile\n");
    }

    #[test]
    fn discard_fingerprint_is_stable_and_tracks_content_index_and_kind() {
        let sb = discard_sandbox();
        fs::write(sb.work.join("a.md"), "edited\n").unwrap();
        let fp = |sb: &Sandbox| preview(sb, &["a.md"])[0].fingerprint.clone();
        let first = fp(&sb);
        assert_eq!(first.len(), 32);
        assert_eq!(fp(&sb), first, "same state, same token");
        fs::write(sb.work.join("a.md"), "edited again\n").unwrap();
        let second = fp(&sb);
        assert_ne!(second, first, "new bytes");
        fs::write(sb.work.join("a.md"), "edited\n").unwrap();
        assert_eq!(fp(&sb), first, "content-based: back to the same bytes");
        sb.git(&sb.work, &["add", "a.md"]);
        assert_ne!(fp(&sb), first, "staged now (index entry and letters)");
    }

    #[test]
    fn discard_rm_cached_says_the_file_on_disk_is_replaced() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        fs::write(sb.work.join("a.md"), "edited\n").unwrap();
        sb.git(&sb.work, &["rm", "-q", "--cached", "a.md"]);
        let p = preview(&sb, &["a.md"]);
        assert_eq!(p.len(), 1, "{p:?}");
        assert_eq!(p[0].action, DiscardAction::Revert);
        assert!(
            p[0].detail.contains("file on disk is replaced"),
            "{}",
            p[0].detail
        );
        discard(&sb, &t, &["a.md"]).unwrap();
        assert_eq!(status(&sb), "");
        assert_eq!(fs::read_to_string(sb.work.join("a.md")).unwrap(), "a\n");
    }

    #[test]
    fn discard_request_wire_shape_matches_the_frontend() {
        let r: DiscardRequest = serde_json::from_str(
            r#"{"path":"n.md","action":"delete","source":"o.md","fingerprint":"f1"}"#,
        )
        .unwrap();
        assert_eq!(r.action, DiscardAction::Delete);
        assert_eq!(r.source.as_deref(), Some("o.md"));
        assert_eq!(r.fingerprint, "f1");
        let r: DiscardRequest =
            serde_json::from_str(r#"{"path":"a.md","action":"revert","fingerprint":"f2"}"#)
                .unwrap();
        assert_eq!((r.action, r.source), (DiscardAction::Revert, None));
        // An unknown action, a missing fingerprint or a bare path string is
        // refused at the boundary.
        assert!(serde_json::from_str::<DiscardRequest>(
            r#"{"path":"a.md","action":"remove","fingerprint":"f"}"#
        )
        .is_err());
        assert!(
            serde_json::from_str::<DiscardRequest>(r#"{"path":"a.md","action":"revert"}"#).is_err()
        );
        assert!(serde_json::from_str::<Vec<DiscardRequest>>(r#"["a.md"]"#).is_err());
        let item = serde_json::to_value(DiscardItem {
            path: "a.md".into(),
            action: DiscardAction::Revert,
            detail: String::new(),
            source: None,
            staged: false,
            partially_staged: false,
            untracked: false,
            fingerprint: "f".into(),
            worktree: "file:2:secret-ish".into(),
        })
        .unwrap();
        assert_eq!(item["action"], "revert");
        assert_eq!(item["fingerprint"], "f");
        assert!(item.get("source").is_none());
        assert!(item.get("worktree").is_none(), "backend only");
    }

    #[test]
    fn discard_index_lock_is_a_typed_error() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        fs::write(sb.work.join("a.md"), "edited\n").unwrap();
        fs::write(sb.work.join(".git/index.lock"), "").unwrap();
        let e = discard(&sb, &t, &["a.md"]).unwrap_err();
        assert!(e.message.contains("locked"), "{e:?}");
        assert_eq!(
            fs::read_to_string(sb.work.join("a.md")).unwrap(),
            "edited\n"
        );
    }

    #[test]
    fn discard_trash_failure_keeps_the_file() {
        let sb = discard_sandbox();
        fs::write(sb.work.join("scratch.md"), "draft\n").unwrap();
        let env = sb.env();
        let e = discard_impl(
            &root(&sb),
            &confirmed(&sb, &["scratch.md"]),
            &env,
            &|_p: &Path| Err("no trash here".to_string()),
        )
        .unwrap_err();
        assert!(e.message.contains("Trash"), "{e:?}");
        assert!(
            sb.work.join("scratch.md").exists(),
            "never a permanent delete"
        );
    }

    #[test]
    fn discard_staged_add_with_an_index_lock_touches_nothing() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        fs::write(sb.work.join("added.md"), "new\n").unwrap();
        sb.git(&sb.work, &["add", "added.md"]);
        let req = confirmed(&sb, &["added.md"]);
        fs::write(sb.work.join(".git/index.lock"), "").unwrap();
        let env = sb.env();
        let e = discard_impl(&root(&sb), &req, &env, &|p: &Path| t.trash(p)).unwrap_err();
        assert!(e.message.contains("locked"), "{e:?}");
        assert!(t.names().is_empty(), "nothing trashed");
        assert_eq!(
            fs::read_to_string(sb.work.join("added.md")).unwrap(),
            "new\n"
        );
        fs::remove_file(sb.work.join(".git/index.lock")).unwrap();
        assert_eq!(status(&sb), "A  added.md", "still staged");
    }

    #[test]
    fn discard_staged_add_trash_failure_leaves_it_untracked_on_disk() {
        let sb = discard_sandbox();
        fs::write(sb.work.join("added.md"), "new\n").unwrap();
        sb.git(&sb.work, &["add", "added.md"]);
        let env = sb.env();
        let e = discard_impl(
            &root(&sb),
            &confirmed(&sb, &["added.md"]),
            &env,
            &|_p: &Path| Err("no trash here".to_string()),
        )
        .unwrap_err();
        assert!(e.message.contains("still on disk"), "{e:?}");
        assert_eq!(
            fs::read_to_string(sb.work.join("added.md")).unwrap(),
            "new\n"
        );
        assert_eq!(status(&sb), "?? added.md");
    }

    #[test]
    fn discard_reports_a_trashed_file_even_when_its_next_step_fails() {
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        sb.git(&sb.work, &["mv", "a.md", "renamed.md"]);
        let req = confirmed(&sb, &["renamed.md"]);
        let env = sb.env();
        // The trash works, then the fake takes the index lock, so the
        // rename source's restore (the step after it) fails.
        let lock = sb.work.join(".git/index.lock");
        let r = discard_impl(&root(&sb), &req, &env, &|p: &Path| {
            t.trash(p)?;
            fs::write(&lock, "").map_err(|e| e.to_string())
        })
        .unwrap();
        fs::remove_file(&lock).unwrap();
        assert_eq!(r.trashed, ["renamed.md"]);
        assert!(r.discarded.is_empty());
        assert_eq!(r.failed.len(), 1);
        assert!(
            r.failed[0].message.contains("couldn't be restored"),
            "{:?}",
            r.failed
        );
        assert_eq!(
            t.content(0, "renamed.md"),
            "a\n",
            "recoverable from the trash"
        );
        // The index already has a.md back; restoring it is one git restore away.
        assert_eq!(status(&sb), " D a.md");
    }

    #[test]
    fn discard_with_no_head_unstages_and_trashes() {
        let d = tempdir();
        let base = d.path().canonicalize().unwrap();
        let global = base.join("gitconfig");
        fs::write(&global, "[user]\n\tname = T\n\temail = t@example.com\n").unwrap();
        let g = global.to_string_lossy().into_owned();
        let env = [
            ("GIT_CONFIG_GLOBAL", g.as_str()),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ];
        let repo = base.join("fresh");
        fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let o = user_git(&repo, &env, args, Duration::from_secs(30)).unwrap();
            assert!(o.status.success(), "{}", text(&o));
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        };
        git(&["init", "-q"]);
        fs::write(repo.join("first.md"), "first\n").unwrap();
        fs::write(repo.join("keep.md"), "keep\n").unwrap();
        git(&["add", "first.md", "keep.md"]);
        let trash = base.join("trash");
        fs::create_dir_all(&trash).unwrap();
        let tr =
            |p: &Path| fs::rename(p, trash.join(p.file_name().unwrap())).map_err(|e| e.to_string());
        let planned =
            discard_preview_impl(&repo.to_string_lossy(), &["first.md".into()], &env).unwrap();
        let req = [DiscardRequest {
            path: "first.md".into(),
            action: DiscardAction::Delete,
            source: None,
            fingerprint: planned[0].fingerprint.clone(),
        }];
        let r = discard_impl(&repo.to_string_lossy(), &req, &env, &tr).unwrap();
        assert_eq!(r.trashed, ["first.md"]);
        assert_eq!(git(&["status", "--porcelain"]), "A  keep.md");
        assert_eq!(
            fs::read_to_string(trash.join("first.md")).unwrap(),
            "first\n"
        );
    }

    #[test]
    fn discard_and_fetch_are_refused_in_remote_sessions() {
        // Process-global session map: serialize against remote connect tests and
        // always clear, even if an assert panics mid-body.
        let _session = crate::remote::TEST_SESSION_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        struct ClearSession;
        impl Drop for ClearSession {
            fn drop(&mut self) {
                crate::remote::set_session_for_test(None);
            }
        }
        let sb = discard_sandbox();
        let t = FakeTrash::new(&sb);
        fs::write(sb.work.join("a.md"), "edited\n").unwrap();
        let _scope = crate::windows::enter("test-remote-discard");
        crate::remote::set_session_for_test(Some(crate::remote::RemoteSession {
            host: "h".into(),
            path: "/p".into(),
            home: "/home/u".into(),
        }));
        let _clear = ClearSession;
        let e = discard(&sb, &t, &["a.md"]).unwrap_err();
        let env = sb.env();
        let pe = discard_preview_impl(&root(&sb), &["a.md".to_string()], &env).unwrap_err();
        let fe = fetch_impl(&root(&sb), &env).unwrap_err();
        assert_eq!(e.kind, GitErrorKind::Unsupported);
        assert!(e.message.contains("remote sessions"), "{}", e.message);
        assert_eq!(pe.kind, GitErrorKind::Unsupported);
        assert_eq!(fe.kind, GitErrorKind::Unsupported);
        assert_eq!(
            fs::read_to_string(sb.work.join("a.md")).unwrap(),
            "edited\n"
        );
    }

    #[test]
    fn discard_source_never_resets_or_cleans() {
        let src = include_str!("git_write.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        for bad in [
            "\"reset\"",
            "\"clean\"",
            "\"--hard\"",
            "remove_dir_all",
            "remove_file",
            "\"checkout\"",
        ] {
            assert!(!code.contains(bad), "discard must never use {bad}");
        }
    }

    #[test]
    fn rejected_push_is_typed_and_never_forced() {
        // check_local → remote::is_active() keys off DEFAULT_LABEL "main".
        // Remote connect tests install a session there under TEST_SESSION_LOCK;
        // without this lock, a parallel suite run returns Unsupported instead of
        // exercising the real non-fast-forward Rejected path.
        let _session = crate::remote::TEST_SESSION_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
        let _session = crate::remote::TEST_SESSION_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
        assert_eq!(k(Action::Push, "fatal: unable to access 'http://127.0.0.1:9/r.git/': Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server"), GitErrorKind::Network);
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
