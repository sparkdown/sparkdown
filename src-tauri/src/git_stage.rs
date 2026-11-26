//! Stage or unstage one hunk (or a whole file) from the Changes diff.
//!
//! The patch is taken from the exact layer diff the UI shows (index vs HEAD,
//! or worktree vs index). If that diff has changed since it was shown, the
//! call is refused so we never write something the user didn't see.

use crate::git;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const DIFF_FLAGS: &[&str] = &[
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=all",
    "-M",
];

/// Both sides of a file's diff, plus a fingerprint of each side.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct FileLayers {
    pub path: String,
    pub staged: String,
    pub unstaged: String,
    pub staged_fp: String,
    pub unstaged_fp: String,
    pub binary_staged: bool,
    pub binary_unstaged: bool,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StageSide {
    Staged,
    Unstaged,
}

impl StageSide {
    fn unstage(self) -> bool {
        matches!(self, StageSide::Staged)
    }
}

/// Reject a path that could escape the repository (same rules as the file diff).
pub(crate) fn reject_rel_path(path: &str) -> Result<(), String> {
    let rel = Path::new(path);
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
    Ok(())
}

pub(crate) fn diff_fingerprint(diff: &str) -> String {
    format!("{:016x}", fnv1a64(diff.as_bytes()))
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

pub(crate) fn is_binary_diff(diff: &str) -> bool {
    diff.lines()
        .any(|l| l.starts_with("Binary files ") || l.starts_with("GIT binary patch"))
}

/// Lines of a unified diff before the first hunk, plus each hunk starting at `@@`.
pub(crate) fn split_diff(diff: &str) -> (String, Vec<(String, String)>) {
    let mut preamble = String::new();
    let mut hunks: Vec<(String, String)> = Vec::new();
    for line in diff.split_inclusive('\n') {
        if line.starts_with("@@") {
            hunks.push((line.to_string(), String::new()));
        } else if let Some((_, body)) = hunks.last_mut() {
            body.push_str(line);
        } else {
            preamble.push_str(line);
        }
    }
    let hunks = hunks
        .into_iter()
        .map(|(h, b)| (h.trim_end_matches(['\r', '\n']).to_string(), b))
        .collect();
    (preamble, hunks)
}

/// Build a one-hunk patch from a full layer diff. `header` is the `@@` line
/// without a trailing newline.
pub(crate) fn extract_hunk_patch(diff: &str, header: &str) -> Result<String, String> {
    let (preamble, hunks) = split_diff(diff);
    if preamble.trim().is_empty() && hunks.is_empty() {
        return Err("There is no textual diff to apply.".to_string());
    }
    let want = header.trim_end_matches(['\r', '\n']);
    let Some((h, body)) = hunks.iter().find(|(h, _)| h == want) else {
        return Err("That hunk is no longer in the diff. Refresh and try again.".to_string());
    };
    Ok(format!("{preamble}{h}\n{body}"))
}

fn diff_stdout(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = git::run_git_raw(root, args)?;
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
}

fn layer_diff(
    root: &Path,
    path: &str,
    old_path: Option<&str>,
    untracked: bool,
    cached: bool,
) -> Result<String, String> {
    if untracked && !cached {
        return diff_stdout(
            root,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=all",
                "--no-index",
                "--",
                "/dev/null",
                path,
            ],
        );
    }
    let mut args: Vec<&str> = DIFF_FLAGS.to_vec();
    if cached {
        args.push("--cached");
    }
    args.push("--");
    if let Some(old) = old_path {
        if !old.is_empty() && old != path {
            args.push(old);
        }
    }
    args.push(path);
    diff_stdout(root, &args)
}

pub(crate) fn file_layers_impl(
    root: &str,
    path: String,
    untracked: bool,
    old_path: Option<String>,
) -> Result<FileLayers, String> {
    if crate::remote::is_active() {
        return Err("Layered diffs are only available in a local folder.".to_string());
    }
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    reject_rel_path(&path)?;
    if let Some(old) = old_path.as_deref() {
        reject_rel_path(old)?;
    }
    if let Ok(top) = git::run_git(root_path, &["rev-parse", "--show-toplevel"]) {
        let top = top.trim();
        if !top.is_empty() && !git::work_tree_holds_checkout(root_path, Path::new(top)) {
            return Err("the repository's work tree is not the opened folder".to_string());
        }
    }
    let old = old_path.as_deref();
    let staged = if untracked {
        String::new()
    } else {
        layer_diff(root_path, &path, old, false, true)?
    };
    let unstaged = layer_diff(root_path, &path, old, untracked, false)?;
    Ok(FileLayers {
        path,
        staged_fp: diff_fingerprint(&staged),
        unstaged_fp: diff_fingerprint(&unstaged),
        binary_staged: is_binary_diff(&staged),
        binary_unstaged: is_binary_diff(&unstaged),
        staged,
        unstaged,
    })
}

#[tauri::command]
pub async fn git_file_layers(
    webview_window: tauri::WebviewWindow,
    root: String,
    path: String,
    untracked: bool,
    old_path: Option<String>,
) -> Result<FileLayers, String> {
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        file_layers_impl(&root, path, untracked, old_path)
    })
    .await
    .map_err(|e| format!("git_file_layers task failed: {e}"))?
}

static PATCH_SEQ: AtomicU64 = AtomicU64::new(1);

fn apply_cached_patch(root: &Path, patch: &str, reverse: bool) -> Result<(), String> {
    let n = PATCH_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp: PathBuf = std::env::temp_dir().join(format!(
        "sd-hunk-{}-{}-{n}.patch",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::write(&tmp, patch).map_err(|e| format!("Couldn't write the patch: {e}"))?;
    let tmp_s = tmp.to_string_lossy().into_owned();
    let mut args = vec![
        "apply",
        "--cached",
        "--unidiff-zero",
        "--whitespace=nowarn",
        "--",
        tmp_s.as_str(),
    ];
    if reverse {
        args.insert(2, "--reverse");
    }
    let output = git::run_git_raw(root, &args);
    let _ = std::fs::remove_file(&tmp);
    let output = output?;
    if output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if err.is_empty() {
            "git apply failed (no stderr)".to_string()
        } else {
            err
        })
    }
}

fn add_paths(root: &Path, paths: &[&str]) -> Result<(), String> {
    let mut args = vec!["--literal-pathspecs", "add", "-A", "--"];
    args.extend(paths.iter().copied());
    let output = git::run_git_raw(root, &args)?;
    if output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if err.is_empty() {
            "git add failed (no stderr)".to_string()
        } else {
            err
        })
    }
}

fn unstage_paths(root: &Path, paths: &[&str]) -> Result<(), String> {
    let mut args = vec!["--literal-pathspecs", "restore", "--staged", "--"];
    args.extend(paths.iter().copied());
    let output = git::run_git_raw(root, &args)?;
    if output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if err.is_empty() {
            "git restore --staged failed (no stderr)".to_string()
        } else {
            err
        })
    }
}

/// Stage or unstage one hunk (`hunk_header` is the `@@` line) or, when
/// `hunk_header` is empty, the whole layer (`git add` / `git restore --staged`).
pub(crate) fn stage_hunk_impl(
    root: &str,
    path: String,
    untracked: bool,
    old_path: Option<String>,
    side: StageSide,
    hunk_header: Option<String>,
    fingerprint: String,
) -> Result<(), String> {
    if crate::remote::is_active() {
        return Err("Staging a hunk is only available in a local folder.".to_string());
    }
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    reject_rel_path(&path)?;
    if let Some(old) = old_path.as_deref() {
        reject_rel_path(old)?;
    }
    let layers = file_layers_impl(root, path.clone(), untracked, old_path.clone())?;
    let (diff, fp, binary) = match side {
        StageSide::Staged => (layers.staged, layers.staged_fp, layers.binary_staged),
        StageSide::Unstaged => (layers.unstaged, layers.unstaged_fp, layers.binary_unstaged),
    };
    if fp != fingerprint {
        return Err("The file has changed. Refresh and try again.".to_string());
    }
    let header = hunk_header
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(header) = header {
        if binary {
            return Err(
                "Binary files cannot be staged by hunk. Stage the whole file instead.".to_string(),
            );
        }
        let patch = extract_hunk_patch(&diff, header)?;
        apply_cached_patch(root_path, &patch, side.unstage())
    } else if side.unstage() {
        let mut paths = vec![path.as_str()];
        if let Some(old) = old_path.as_deref() {
            if !old.is_empty() && old != path {
                paths.push(old);
            }
        }
        unstage_paths(root_path, &paths)
    } else {
        let mut paths = vec![path.as_str()];
        if let Some(old) = old_path.as_deref() {
            if !old.is_empty() && old != path {
                paths.push(old);
            }
        }
        add_paths(root_path, &paths)
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn git_stage_hunk(
    webview_window: tauri::WebviewWindow,
    root: String,
    path: String,
    untracked: bool,
    old_path: Option<String>,
    side: StageSide,
    hunk_header: Option<String>,
    fingerprint: String,
) -> Result<(), String> {
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        stage_hunk_impl(
            &root,
            path,
            untracked,
            old_path,
            side,
            hunk_header,
            fingerprint,
        )
    })
    .await
    .map_err(|e| format!("git_stage_hunk task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn tempdir() -> TempDir {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "sd-stage-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        TempDir(d)
    }

    fn git_available() -> bool {
        crate::proc::command(crate::git::git_bin())
            .arg("--version")
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn git(dir: &Path, args: &[&str]) {
        let o = crate::proc::command(crate::git::git_bin())
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .args(args)
            .output()
            .expect("git ran");
        assert!(
            o.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&o.stderr)
        );
    }

    fn git_out(dir: &Path, args: &[&str]) -> String {
        let o = crate::proc::command(crate::git::git_bin())
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .args(args)
            .output()
            .expect("git ran");
        assert!(
            o.status.success() || o.status.code() == Some(1),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    fn repo() -> TempDir {
        let d = tempdir();
        git(d.0.as_path(), &["init", "-q"]);
        git(d.0.as_path(), &["config", "user.name", "Test"]);
        git(d.0.as_path(), &["config", "user.email", "t@example.com"]);
        git(d.0.as_path(), &["config", "commit.gpgsign", "false"]);
        git(d.0.as_path(), &["config", "core.autocrlf", "false"]);
        d
    }

    fn first_header(diff: &str) -> String {
        split_diff(diff)
            .1
            .into_iter()
            .map(|(h, _)| h)
            .next()
            .expect("expected a hunk")
    }

    fn nth_header(diff: &str, n: usize) -> String {
        split_diff(diff)
            .1
            .into_iter()
            .map(|(h, _)| h)
            .nth(n)
            .expect("expected a hunk")
    }

    #[test]
    fn extract_hunk_keeps_preamble_and_no_newline_marker() {
        let diff = "\
diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,2 +1,2 @@
 keep
-old
+new
\\ No newline at end of file
@@ -10,1 +10,1 @@
-x
+y
";
        let patch = extract_hunk_patch(diff, "@@ -1,2 +1,2 @@").unwrap();
        assert!(patch.starts_with("diff --git a/f b/f\n"));
        assert!(patch.contains("\\ No newline at end of file\n"));
        assert!(!patch.contains("@@ -10,1 +10,1 @@"));
        assert!(extract_hunk_patch(diff, "@@ -9,1 +9,1 @@").is_err());
    }

    #[test]
    fn binary_diff_is_detected() {
        assert!(is_binary_diff("Binary files a/x and b/x differ\n"));
        assert!(!is_binary_diff("@@ -1 +1 @@\n-a\n+b\n"));
    }

    #[test]
    fn staging_one_hunk_leaves_the_other_unstaged() {
        if !git_available() {
            return;
        }
        let d = repo();
        let root = d.0.as_path();
        let mid = "keep\n".repeat(8);
        fs::write(root.join("notes.md"), format!("alpha\n{mid}gamma\n")).unwrap();
        git(root, &["add", "notes.md"]);
        git(root, &["commit", "-q", "-m", "base"]);
        fs::write(root.join("notes.md"), format!("ALPHA\n{mid}GAMMA\n")).unwrap();
        let layers =
            file_layers_impl(&root.to_string_lossy(), "notes.md".into(), false, None).unwrap();
        assert!(!layers.unstaged.is_empty());
        assert!(layers.staged.is_empty());
        assert!(
            split_diff(&layers.unstaged).1.len() >= 2,
            "need two hunks, got {}",
            layers.unstaged
        );
        let h0 = nth_header(&layers.unstaged, 0);
        stage_hunk_impl(
            &root.to_string_lossy(),
            "notes.md".into(),
            false,
            None,
            StageSide::Unstaged,
            Some(h0),
            layers.unstaged_fp.clone(),
        )
        .unwrap();
        let cached = git_out(root, &["diff", "--cached", "--", "notes.md"]);
        let work = git_out(root, &["diff", "--", "notes.md"]);
        assert!(cached.contains("ALPHA") || cached.contains("+ALPHA"));
        assert!(!cached.contains("GAMMA"));
        assert!(work.contains("GAMMA") || work.contains("+GAMMA"));
        assert!(!work.contains("ALPHA"));
        // The cached diff is exactly the staged layer after a refresh.
        let after =
            file_layers_impl(&root.to_string_lossy(), "notes.md".into(), false, None).unwrap();
        assert_eq!(after.staged, cached);
    }

    #[test]
    fn refuses_when_the_file_changed_on_disk() {
        if !git_available() {
            return;
        }
        let d = repo();
        let root = d.0.as_path();
        fs::write(root.join("a.txt"), "one\n\ntwo\n").unwrap();
        git(root, &["add", "a.txt"]);
        git(root, &["commit", "-q", "-m", "base"]);
        fs::write(root.join("a.txt"), "ONE\n\ntwo\n").unwrap();
        let layers =
            file_layers_impl(&root.to_string_lossy(), "a.txt".into(), false, None).unwrap();
        let h = first_header(&layers.unstaged);
        fs::write(root.join("a.txt"), "ONE\n\nTWO\n").unwrap();
        let err = stage_hunk_impl(
            &root.to_string_lossy(),
            "a.txt".into(),
            false,
            None,
            StageSide::Unstaged,
            Some(h),
            layers.unstaged_fp,
        )
        .unwrap_err();
        assert!(err.contains("has changed"), "unexpected error: {err}");
    }

    #[test]
    fn no_trailing_newline_is_kept() {
        if !git_available() {
            return;
        }
        let d = repo();
        let root = d.0.as_path();
        fs::write(root.join("f.txt"), "hello\nworld").unwrap();
        git(root, &["add", "f.txt"]);
        git(root, &["commit", "-q", "-m", "base"]);
        fs::write(root.join("f.txt"), "hello\nWORLD").unwrap();
        let layers =
            file_layers_impl(&root.to_string_lossy(), "f.txt".into(), false, None).unwrap();
        assert!(
            layers.unstaged.contains("No newline at end of file"),
            "{}",
            layers.unstaged
        );
        let h = first_header(&layers.unstaged);
        stage_hunk_impl(
            &root.to_string_lossy(),
            "f.txt".into(),
            false,
            None,
            StageSide::Unstaged,
            Some(h),
            layers.unstaged_fp,
        )
        .unwrap();
        let blob = git_out(root, &["show", ":f.txt"]);
        assert_eq!(blob, "hello\nWORLD");
        assert!(!blob.ends_with('\n'));
    }

    #[test]
    fn crlf_hunk_matches_cached_diff() {
        if !git_available() {
            return;
        }
        let d = repo();
        let root = d.0.as_path();
        fs::write(root.join("win.txt"), b"one\r\n\r\ntwo\r\n").unwrap();
        git(root, &["add", "win.txt"]);
        git(root, &["commit", "-q", "-m", "base"]);
        fs::write(root.join("win.txt"), b"ONE\r\n\r\ntwo\r\n").unwrap();
        let layers =
            file_layers_impl(&root.to_string_lossy(), "win.txt".into(), false, None).unwrap();
        let h = first_header(&layers.unstaged);
        stage_hunk_impl(
            &root.to_string_lossy(),
            "win.txt".into(),
            false,
            None,
            StageSide::Unstaged,
            Some(h),
            layers.unstaged_fp,
        )
        .unwrap();
        let cached = git_out(root, &["diff", "--cached", "--", "win.txt"]);
        let layers2 =
            file_layers_impl(&root.to_string_lossy(), "win.txt".into(), false, None).unwrap();
        assert_eq!(layers2.staged, cached);
        let blob = git_out(root, &["show", ":win.txt"]);
        assert_eq!(blob, "ONE\r\n\r\ntwo\r\n");
    }

    #[test]
    fn binary_hunk_is_refused_and_stage_all_adds_the_file() {
        if !git_available() {
            return;
        }
        let d = repo();
        let root = d.0.as_path();
        fs::write(root.join("a.bin"), b"aaa").unwrap();
        git(root, &["add", "a.bin"]);
        git(root, &["commit", "-q", "-m", "base"]);
        fs::write(root.join("a.bin"), b"aaa\0bbb").unwrap();
        let layers =
            file_layers_impl(&root.to_string_lossy(), "a.bin".into(), false, None).unwrap();
        assert!(layers.binary_unstaged, "{}", layers.unstaged);
        let err = stage_hunk_impl(
            &root.to_string_lossy(),
            "a.bin".into(),
            false,
            None,
            StageSide::Unstaged,
            Some("@@ -1,1 +1,1 @@".into()),
            layers.unstaged_fp.clone(),
        )
        .unwrap_err();
        assert!(err.contains("Binary"), "{err}");
        stage_hunk_impl(
            &root.to_string_lossy(),
            "a.bin".into(),
            false,
            None,
            StageSide::Unstaged,
            None,
            layers.unstaged_fp,
        )
        .unwrap();
        let cached = git_out(root, &["diff", "--cached", "--numstat", "--", "a.bin"]);
        assert!(cached.contains("a.bin"), "{cached}");
        let work = git_out(root, &["diff", "--", "a.bin"]);
        assert!(work.trim().is_empty(), "{work}");
    }

    #[test]
    fn rename_with_an_edit_can_be_staged_by_hunk() {
        if !git_available() {
            return;
        }
        let d = repo();
        let root = d.0.as_path();
        fs::write(root.join("old.rs"), "fn a() {}\n\nfn b() {}\n").unwrap();
        git(root, &["add", "old.rs"]);
        git(root, &["commit", "-q", "-m", "base"]);
        git(root, &["mv", "old.rs", "new.rs"]);
        fs::write(root.join("new.rs"), "fn a() { 1 }\n\nfn b() {}\n").unwrap();
        let layers = file_layers_impl(
            &root.to_string_lossy(),
            "new.rs".into(),
            false,
            Some("old.rs".into()),
        )
        .unwrap();
        assert!(
            !layers.unstaged.trim().is_empty() || !layers.staged.trim().is_empty(),
            "staged={} unstaged={}",
            layers.staged,
            layers.unstaged
        );
        if !layers.unstaged.trim().is_empty() && !layers.binary_unstaged {
            let h = first_header(&layers.unstaged);
            stage_hunk_impl(
                &root.to_string_lossy(),
                "new.rs".into(),
                false,
                Some("old.rs".into()),
                StageSide::Unstaged,
                Some(h),
                layers.unstaged_fp.clone(),
            )
            .unwrap();
        }
        let cached = git_out(root, &["diff", "--cached", "-M", "--"]);
        assert!(
            cached.contains("new.rs") || cached.contains("old.rs"),
            "{cached}"
        );
        let blob = git_out(root, &["show", ":new.rs"]);
        assert!(blob.contains("fn a() { 1 }"), "{blob}");
    }

    #[test]
    fn unstage_reverses_a_staged_hunk() {
        if !git_available() {
            return;
        }
        let d = repo();
        let root = d.0.as_path();
        fs::write(root.join("x.txt"), "a\n\nb\n").unwrap();
        git(root, &["add", "x.txt"]);
        git(root, &["commit", "-q", "-m", "base"]);
        fs::write(root.join("x.txt"), "A\n\nB\n").unwrap();
        let layers =
            file_layers_impl(&root.to_string_lossy(), "x.txt".into(), false, None).unwrap();
        let h = first_header(&layers.unstaged);
        stage_hunk_impl(
            &root.to_string_lossy(),
            "x.txt".into(),
            false,
            None,
            StageSide::Unstaged,
            Some(h),
            layers.unstaged_fp,
        )
        .unwrap();
        let after = file_layers_impl(&root.to_string_lossy(), "x.txt".into(), false, None).unwrap();
        assert!(!after.staged.is_empty());
        let hs = first_header(&after.staged);
        stage_hunk_impl(
            &root.to_string_lossy(),
            "x.txt".into(),
            false,
            None,
            StageSide::Staged,
            Some(hs),
            after.staged_fp,
        )
        .unwrap();
        let cached = git_out(root, &["diff", "--cached", "--", "x.txt"]);
        assert!(cached.trim().is_empty(), "{cached}");
    }
}
