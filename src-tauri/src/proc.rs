//! The one way SparkDown spawns a helper process (git, ssh, tmux, the URL
//! opener, curl, an agent CLI probe, ...).
//!
//! SparkDown is a GUI-subsystem app. On Windows, every console program it
//! starts without `CREATE_NO_WINDOW` gets its own console window, which
//! flashes open and closed (sparkdown/sparkdown#15). [`command`] sets that
//! flag, so call it instead of `std::process::Command::new`. Clippy
//! (`clippy.toml` `disallowed-methods`) and the
//! `no_raw_command_new_outside_proc` test below both reject a raw
//! `Command::new`, so a new spawn can't miss the flag.
//!
//! The user-facing terminal is NOT spawned here: it runs through
//! `portable_pty::CommandBuilder` (ConPTY on Windows), which needs a console
//! of its own and must keep working.

use std::ffi::OsStr;
use std::process::Command;

/// `CREATE_NO_WINDOW` from the Win32 process creation flags.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A [`Command`] for a background helper process. On Windows it is created
/// with `CREATE_NO_WINDOW`, so no console window appears; elsewhere it is a
/// plain `Command::new(program)`.
#[allow(clippy::disallowed_methods)] // The one sanctioned Command::new.
pub fn command<S: AsRef<OsStr>>(program: S) -> Command {
    let cmd = Command::new(program);
    #[cfg(windows)]
    let cmd = {
        use std::os::windows::process::CommandExt;
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    cmd
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    /// Every `Command::new` (std or tokio, any path prefix) outside this
    /// file, ignoring `//` comment lines. `CommandBuilder::new` (the PTY) is
    /// a different name and is not matched.
    fn raw_command_new(src: &str) -> Vec<usize> {
        const NEEDLE: &str = "Command::new";
        let mut hits = Vec::new();
        for (i, line) in src.lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            let mut from = 0;
            while let Some(pos) = line[from..].find(NEEDLE) {
                let at = from + pos;
                let before = line[..at].chars().next_back();
                if !before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                    hits.push(i + 1);
                    break;
                }
                from = at + NEEDLE.len();
            }
        }
        hits
    }

    #[test]
    fn raw_command_new_detector() {
        assert_eq!(raw_command_new("let c = Command::new(\"git\");"), [1]);
        assert_eq!(raw_command_new("x\nstd::process::Command::new(p)"), [2]);
        assert_eq!(raw_command_new("tokio::process::Command::new(p)"), [1]);
        assert_eq!(raw_command_new(".map(Command::new)"), [1]);
        assert!(raw_command_new("let c = CommandBuilder::new(shell);").is_empty());
        assert!(raw_command_new("let c = MyCommand::new();").is_empty());
        assert!(raw_command_new("    // Command::new(\"git\") in a comment").is_empty());
        assert!(raw_command_new("let c = crate::proc::command(\"git\");").is_empty());
    }

    /// Guards sparkdown/sparkdown#15: a spawn that bypasses `proc::command`
    /// would flash a console window on Windows.
    #[test]
    fn no_raw_command_new_outside_proc() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&src, &mut files);
        assert!(files.len() > 5, "no sources found under {}", src.display());
        let mut offenders = Vec::new();
        for f in files {
            if f.file_name().is_some_and(|n| n == "proc.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&f).unwrap();
            for line in raw_command_new(&text) {
                offenders.push(format!("{}:{line}", f.display()));
            }
        }
        assert!(
            offenders.is_empty(),
            "use crate::proc::command() instead of Command::new (it sets \
             CREATE_NO_WINDOW on Windows, see #15):\n{}",
            offenders.join("\n")
        );
    }

    #[test]
    fn command_runs_the_program() {
        let program = if cfg!(windows) { "cmd" } else { "sh" };
        let flag = if cfg!(windows) { "/C" } else { "-c" };
        let out = super::command(program)
            .args([flag, "echo sd-proc-ok"])
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("sd-proc-ok"));
    }
}
