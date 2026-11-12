//! Install / uninstall / repair the `sparkdown` command on PATH (#160).
//!
//! Pure filesystem logic lives here so unit tests can drive it with a temp
//! directory. Platform callers supply the real target binary (macOS launcher
//! script, AppImage path) and the candidate bin dirs.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Name of the command users type.
pub const COMMAND_NAME: &str = "sparkdown";

/// Where the link should point, and what the install menus should do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkStatus {
    /// No `sparkdown` in any candidate dir.
    Missing,
    /// A working symlink (or regular file) at `link` pointing at `target`
    /// (after canonicalize, when possible).
    Ok { link: PathBuf },
    /// A symlink whose target is missing or wrong.
    Broken { link: PathBuf },
    /// A non-symlink file that is not our target (leave it alone).
    Foreign { link: PathBuf },
}

/// Preferred bin directories, first writable-or-creatable wins for install.
/// `home` is injected so tests do not touch the real `$HOME`.
pub fn candidate_bin_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::with_capacity(3);
    // System-ish location first on Unix (VS Code uses /usr/local/bin).
    #[cfg(unix)]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs.push(home.join(".local").join("bin"));
    dirs
}

/// Status of `sparkdown` across `dirs`, comparing against `expected_target`.
pub fn status(dirs: &[PathBuf], expected_target: &Path) -> LinkStatus {
    let expected = normalize(expected_target);
    for dir in dirs {
        let link = dir.join(COMMAND_NAME);
        match classify_one(&link, &expected) {
            LinkStatus::Missing => continue,
            other => return other,
        }
    }
    LinkStatus::Missing
}

fn classify_one(link: &Path, expected: &Path) -> LinkStatus {
    let meta = match fs::symlink_metadata(link) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return LinkStatus::Missing,
        Err(_) => {
            return LinkStatus::Broken {
                link: link.to_path_buf(),
            }
        }
    };
    if meta.file_type().is_symlink() {
        let dest = fs::read_link(link).unwrap_or_default();
        let resolved = if dest.is_absolute() {
            dest
        } else {
            link.parent().unwrap_or_else(|| Path::new(".")).join(dest)
        };
        if path_exists(&resolved) && same_path(&resolved, expected) {
            LinkStatus::Ok {
                link: link.to_path_buf(),
            }
        } else {
            LinkStatus::Broken {
                link: link.to_path_buf(),
            }
        }
    } else if meta.is_file() {
        if same_path(link, expected) {
            LinkStatus::Ok {
                link: link.to_path_buf(),
            }
        } else {
            LinkStatus::Foreign {
                link: link.to_path_buf(),
            }
        }
    } else {
        LinkStatus::Broken {
            link: link.to_path_buf(),
        }
    }
}

fn path_exists(p: &Path) -> bool {
    fs::metadata(p).is_ok()
}

fn normalize(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn same_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Create or replace the `sparkdown` symlink so it points at `target`.
/// Prefers the first directory in `dirs` that is writable (or can be
/// created). Returns the link path.
pub fn install(dirs: &[PathBuf], target: &Path) -> Result<PathBuf, String> {
    if !path_exists(target) {
        return Err(format!("target does not exist: {}", target.display()));
    }
    let target = normalize(target);
    // Prefer repairing an existing broken link in place. Never overwrite a
    // foreign file (another tool's `sparkdown`).
    match status(dirs, &target) {
        LinkStatus::Ok { link } => return Ok(link),
        LinkStatus::Broken { link } => {
            return replace_link(&link, &target).map(|_| link);
        }
        LinkStatus::Foreign { link } => {
            return Err(format!(
                "{} exists and is not a SparkDown link; remove it or pick another name",
                link.display()
            ));
        }
        LinkStatus::Missing => {}
    }
    let mut last_err = String::from("no writable bin directory");
    for dir in dirs {
        match ensure_dir(dir).and_then(|_| create_link(&dir.join(COMMAND_NAME), &target)) {
            Ok(()) => return Ok(dir.join(COMMAND_NAME)),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

/// Remove our `sparkdown` link when it points at `expected_target` (or is
/// broken). Refuses to delete a foreign file.
pub fn uninstall(dirs: &[PathBuf], expected_target: &Path) -> Result<(), String> {
    let expected = normalize(expected_target);
    match status(dirs, &expected) {
        LinkStatus::Missing => Ok(()),
        LinkStatus::Ok { link } | LinkStatus::Broken { link } => {
            fs::remove_file(&link).map_err(|e| format!("could not remove {}: {e}", link.display()))
        }
        LinkStatus::Foreign { link } => Err(format!(
            "{} exists and is not a SparkDown link; leave it alone",
            link.display()
        )),
    }
}

/// Make the link point at `target`, creating it when missing.
pub fn repair(dirs: &[PathBuf], target: &Path) -> Result<PathBuf, String> {
    install(dirs, target)
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))
}

fn create_link(link: &Path, target: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).map_err(|e| {
            format!(
                "could not link {} -> {}: {e}",
                link.display(),
                target.display()
            )
        })
    }
    #[cfg(windows)]
    {
        // Windows: a symlink needs privilege; for the shim we rely on NSIS
        // PATH. This path is for tests / AppImage-style repair only.
        std::os::windows::fs::symlink_file(target, link).map_err(|e| {
            format!(
                "could not link {} -> {}: {e}",
                link.display(),
                target.display()
            )
        })
    }
}

fn replace_link(link: &Path, target: &Path) -> Result<(), String> {
    let _ = fs::remove_file(link);
    create_link(link, target)
}

/// The binary / script the PATH link should point at for this running app.
/// `None` when the platform package already ships `/usr/bin/sparkdown`
/// (deb/AUR) or when we cannot find a stable path.
pub fn running_cli_target() -> Option<PathBuf> {
    // AppImage: the image itself is the stable entry (path changes if moved;
    // repair rewrites the link).
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        let p = PathBuf::from(appimage);
        if path_exists(&p) {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().ok().map(strip_deleted)?;
    #[cfg(target_os = "macos")]
    {
        // Prefer Contents/Resources/bin/sparkdown (the launcher script).
        // exe is Contents/MacOS/sparkdown.
        if let Some(macos_dir) = exe.parent() {
            if let Some(contents) = macos_dir.parent() {
                let launcher = contents.join("Resources").join("bin").join(COMMAND_NAME);
                if path_exists(&launcher) {
                    return Some(launcher);
                }
            }
        }
    }
    // Fallback: the running executable (dev builds, Linux unpackaged).
    Some(exe)
}

/// Linux `/proc/self/exe` can show as `"… (deleted)"` after an overwrite.
fn strip_deleted(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_suffix(" (deleted)") {
        PathBuf::from(rest)
    } else {
        p
    }
}

/// True when the Install/Uninstall/Repair menu items should appear.
pub fn menu_applicable() -> bool {
    if cfg!(target_os = "macos") {
        return true;
    }
    std::env::var_os("APPIMAGE").is_some()
}

/// Candidate dirs for the current user (real `$HOME`).
pub fn user_bin_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    candidate_bin_dirs(&home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("sd-cli-install-{n}"));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn touch(p: &Path) {
        if let Some(dir) = p.parent() {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(p, b"x").unwrap();
    }

    #[test]
    fn install_creates_link_in_local_bin() {
        let root = tmp();
        let home = root.join("home");
        let target = root.join("SparkDown.app/Contents/Resources/bin/sparkdown");
        touch(&target);
        let dirs = candidate_bin_dirs(&home);
        // Drop /usr/local/bin for the test (not writable / not ours).
        let dirs: Vec<_> = dirs.into_iter().filter(|d| d.starts_with(&home)).collect();
        let link = install(&dirs, &target).unwrap();
        assert_eq!(link, home.join(".local/bin/sparkdown"));
        assert!(matches!(status(&dirs, &target), LinkStatus::Ok { .. }));
        uninstall(&dirs, &target).unwrap();
        assert!(matches!(status(&dirs, &target), LinkStatus::Missing));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn broken_link_is_detected_and_repaired() {
        let root = tmp();
        let home = root.join("home");
        let dirs = vec![home.join(".local/bin")];
        fs::create_dir_all(&dirs[0]).unwrap();
        let link = dirs[0].join(COMMAND_NAME);
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("gone"), &link).unwrap();
        #[cfg(windows)]
        {
            touch(&root.join("gone"));
            std::os::windows::fs::symlink_file(root.join("gone"), &link).unwrap();
            fs::remove_file(root.join("gone")).unwrap();
        }
        let target = root.join("real-sparkdown");
        touch(&target);
        assert!(matches!(status(&dirs, &target), LinkStatus::Broken { .. }));
        repair(&dirs, &target).unwrap();
        assert!(matches!(status(&dirs, &target), LinkStatus::Ok { .. }));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn foreign_file_is_not_removed() {
        let root = tmp();
        #[cfg(target_os = "macos")]
        let root = fs::canonicalize(&root).unwrap_or(root);
        let home = root.join("home");
        let dirs = vec![home.join(".local/bin")];
        let link = dirs[0].join(COMMAND_NAME);
        touch(&link);
        let target = root.join("ours");
        touch(&target);
        assert!(matches!(status(&dirs, &target), LinkStatus::Foreign { .. }));
        assert!(uninstall(&dirs, &target).is_err());
        assert!(link.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn candidate_dirs_include_local_bin() {
        let home = Path::new("/home/u");
        let dirs = candidate_bin_dirs(home);
        assert!(dirs.iter().any(|d| d.ends_with(".local/bin")));
    }
}
