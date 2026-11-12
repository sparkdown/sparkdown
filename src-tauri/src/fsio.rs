//! Crash-safe local file writes.
//!
//! `fs::write` truncates the target and then writes it: a crash, full disk
//! or kill in between leaves a truncated file. [`write_atomic`] writes a temp
//! file in the same directory, fsyncs it, and renames it over the target, so
//! the target always holds either the old or the new contents.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Same limit as the kernel's ELOOP check (Linux MAXSYMLINKS).
const MAX_SYMLINK_HOPS: usize = 40;

/// Follow `path` while it is a symlink, so the rename replaces the link's
/// target and not the link itself. Works for dangling links too (where
/// `canonicalize` fails): the result is the path the link points at.
fn resolve_symlinks(path: &Path) -> io::Result<PathBuf> {
    let mut current = path.to_path_buf();
    for _ in 0..MAX_SYMLINK_HOPS {
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let link = fs::read_link(&current)?;
                current = if link.is_absolute() {
                    link
                } else {
                    current.parent().map(|p| p.join(&link)).unwrap_or(link)
                };
            }
            _ => return Ok(current),
        }
    }
    Err(io::Error::other(format!(
        "too many levels of symbolic links: {}",
        path.display()
    )))
}

/// Create a fresh temp file next to `name` in `dir`
/// (`.<name>.sparkdown-tmp-<pid>-<n>`), never reusing an existing path.
///
/// On Unix the file is created with mode 0o600 so the staged contents are
/// never readable by other local accounts, even for the window between the
/// first write and the final `set_permissions`. Callers widen the mode
/// afterwards (to match the existing target, or to 0o666 & ~umask for new
/// files) only once the data has been written.
fn create_temp(dir: &Path, name: &std::ffi::OsStr, mode: u32) -> io::Result<(PathBuf, File)> {
    // The creation mode only applies on Unix.
    #[cfg(not(unix))]
    let _ = mode;
    let pid = std::process::id();
    loop {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut tmp_name = std::ffi::OsString::from(".");
        tmp_name.push(name);
        tmp_name.push(format!(".sparkdown-tmp-{pid}-{n}"));
        let tmp = dir.join(tmp_name);
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        opts.mode(mode);
        match opts.open(&tmp) {
            Ok(f) => return Ok((tmp, f)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
}

/// Atomically replace `path` with `data`.
///
/// - Symlinks are resolved first; the link itself is kept.
/// - An existing file's permissions are copied to the new file. New files
///   get the default mode (0666 minus umask), same as `fs::write`.
/// - The temp file is removed on any error.
/// - When no temp file can be created in the directory (permission denied,
///   e.g. a writable file in a read-only directory), fall back to an
///   in-place write so saves that worked before still work.
///
/// Known limits: ownership is not copied (the new file is owned by the
/// current user) and hard links to the old file are split off.
pub fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let target = resolve_symlinks(path)?;
    let dir = match target.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let existing_perms = fs::metadata(&target).ok().map(|m| m.permissions());

    // For new files, use 0o666 and let the kernel apply umask.
    // For existing files, use 0o600 (owner-only while the data is written) then widen to existing perms.
    #[cfg(unix)]
    let initial_mode = if existing_perms.is_some() {
        0o600
    } else {
        0o666
    };
    #[cfg(not(unix))]
    let initial_mode = 0o600;

    let (tmp, mut file) = match create_temp(&dir, name, initial_mode) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
            return fs::write(&target, data);
        }
        Err(e) => return Err(e),
    };

    let result = (|| {
        file.write_all(data)?;
        // Only widen the mode after the data is on disk. On Unix the file
        // was created 0o600, so the staged contents are never readable by
        // other local accounts; here we match the target's existing mode.
        if let Some(perms) = existing_perms {
            file.set_permissions(perms)?;
        }
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, &target)?;
        sync_dir(&dir);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Best effort: persist the rename itself (the directory entry).
#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sparkdown_fsio_{tag}_{}_{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn temp_leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("sparkdown-tmp"))
            .collect()
    }

    #[test]
    fn replaces_contents_and_leaves_no_temp() {
        let dir = temp_dir("replace");
        let file = dir.join("a.md");
        fs::write(&file, "old contents that are longer than the new ones").unwrap();
        write_atomic(&file, b"new").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"new");
        // New file too.
        let fresh = dir.join("fresh.md");
        write_atomic(&fresh, b"hello").unwrap();
        assert_eq!(fs::read(&fresh).unwrap(), b"hello");
        assert!(temp_leftovers(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("perms");
        let file = dir.join("script.sh");
        fs::write(&file, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o750)).unwrap();
        write_atomic(&file, b"#!/bin/sh\necho hi\n").unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o750);
        assert_eq!(fs::read(&file).unwrap(), b"#!/bin/sh\necho hi\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_target_is_updated_not_replaced() {
        let dir = temp_dir("symlink");
        let real = dir.join("real.md");
        fs::write(&real, "old").unwrap();
        let link = dir.join("link.md");
        std::os::unix::fs::symlink("real.md", &link).unwrap();
        write_atomic(&link, b"via link").unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&real).unwrap(), b"via link");
        // A dangling link creates its target instead of replacing the link.
        let dangling = dir.join("dangling.md");
        std::os::unix::fs::symlink(dir.join("missing.md"), &dangling).unwrap();
        write_atomic(&dangling, b"created").unwrap();
        assert!(fs::symlink_metadata(&dangling)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(dir.join("missing.md")).unwrap(), b"created");
        assert!(temp_leftovers(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_rename_cleans_up_temp() {
        // Renaming a file over a non-empty directory fails on every platform.
        let dir = temp_dir("fail");
        let target = dir.join("occupied");
        fs::create_dir_all(target.join("child")).unwrap();
        assert!(write_atomic(&target, b"x").is_err());
        assert!(temp_leftovers(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn new_file_matches_umask_default() {
        // A brand-new target gets the same final mode `fs::write` would
        // produce (0o666 with kernel-applied umask), so callers that rely
        // on the usual default are unaffected by the owner-only staging.
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("newperms");
        let file = dir.join("fresh.md");
        let reference = dir.join("reference.md");
        write_atomic(&file, b"hello").unwrap();
        fs::write(&reference, b"hello").unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o7777;
        let expected = fs::metadata(&reference).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, expected, "write_atomic should match fs::write mode");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn staging_file_is_owner_only_during_write() {
        // Regression test: previously the staging file was created with
        // the process umask (typically 0o644), exposing the plaintext of
        // 0o600 targets to other local users during the write window.
        // Here we drive write_atomic with a large payload so we can
        // observe the temp file mid-write from another thread.
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicBool, Ordering as AO};
        use std::sync::Arc;
        use std::thread;
        use std::time::{Duration, Instant};

        let dir = temp_dir("stagingmode");
        let file = dir.join("secret.md");
        fs::write(&file, "old").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();

        // Prefix of the temp names create_temp produces.
        let prefix = format!(".secret.md.sparkdown-tmp-{}-", std::process::id());
        let dir_watch = dir.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_w = stop.clone();
        let seen_modes = Arc::new(std::sync::Mutex::new(Vec::<u32>::new()));
        let seen_w = seen_modes.clone();
        let watcher = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !stop_w.load(AO::Relaxed) && Instant::now() < deadline {
                if let Ok(rd) = fs::read_dir(&dir_watch) {
                    for entry in rd.flatten() {
                        let name = entry.file_name();
                        let name = name.to_string_lossy();
                        if name.starts_with(&prefix) {
                            if let Ok(meta) = entry.metadata() {
                                let m = meta.permissions().mode() & 0o7777;
                                seen_w.lock().unwrap().push(m);
                            }
                        }
                    }
                }
            }
        });

        // A payload large enough to make the write window observable.
        let payload = vec![b'x'; 4 * 1024 * 1024];
        for _ in 0..5 {
            write_atomic(&file, &payload).unwrap();
        }
        stop.store(true, AO::Relaxed);
        watcher.join().unwrap();

        let seen = seen_modes.lock().unwrap().clone();
        for mode in &seen {
            assert_eq!(
                *mode & 0o077,
                0,
                "staging file was observable to group/other: mode={mode:o}"
            );
        }
        // Final target still restrictive.
        let final_mode = fs::metadata(&file).unwrap().permissions().mode() & 0o7777;
        assert_eq!(final_mode, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }
}
