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
//! Two intentional exceptions exist, both named:
//! - [`command_gui`]: re-launch this GUI app (must NOT hide a console).
//! - `src/bin/sparkdown_shim.rs`: a separate console-subsystem binary that
//!   launches the GUI; it cannot import this module without a `lib` target,
//!   so it keeps one documented raw `Command::new`.
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
#[allow(clippy::disallowed_methods)] // Sanctioned helper spawn (CREATE_NO_WINDOW).
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

/// A [`Command`] that must keep normal console/window behavior — e.g.
/// re-launching this GUI app from a terminal (#160). On Windows it
/// deliberately does **not** set `CREATE_NO_WINDOW` (contrast [`command`],
/// which hides the console for background helpers — #15).
///
/// Prefer this over a raw `Command::new` inside the app crate. The Windows
/// console shim (`src/bin/sparkdown_shim.rs`) is the only other place that
/// may call `Command::new` directly: it is a separate binary entry point and
/// cannot call into this module without adding a `lib` target.
#[allow(clippy::disallowed_methods)] // Sanctioned GUI-visible Command::new.
pub fn command_gui<S: AsRef<OsStr>>(program: S) -> Command {
    Command::new(program)
}

/// Re-launch this executable detached from the terminal (#160): the parent
/// returns to the shell immediately. Stdio is discarded; on Unix the child
/// gets its own process group so a later SIGHUP to the terminal does not
/// take it down. On Windows the child is a new process group (the GUI
/// subsystem binary shows no console of its own).
///
/// `argv` is the full argument list including argv[0]; only argv[1..] is
/// forwarded. Sets `SPARKDOWN_DETACHED=1` so the child does not detach again.
pub fn spawn_detached_self(argv: &[String]) -> std::io::Result<()> {
    use std::process::Stdio;
    let exe = std::env::current_exe()?;
    // command_gui: CREATE_NO_WINDOW would hide the GUI we are spawning.
    let mut cmd = command_gui(&exe);
    cmd.args(argv.iter().skip(1))
        .env(crate::cli::DETACHED_ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP — not CREATE_NO_WINDOW:
        // this is the GUI app itself.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let _child = cmd.spawn()?;
    Ok(())
}

/// Start this app again on `paths` once this process has exited (Linux).
///
/// A second launch that arrives while this instance is quitting is handed
/// to it by the single-instance check and would be lost with it. The new
/// process waits for this one to end ([`wait_for_previous_instance`]), so it
/// reads the session file this quit wrote and owns the instance lock.
#[cfg(target_os = "linux")]
pub fn spawn_self_after_exit(paths: &[String], new_window: bool) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    let exe = std::env::current_exe()?;
    let mut cmd = command_gui(&exe);
    cmd.args(crate::cli::relaunch_args(paths, new_window))
        .env(crate::cli::DETACHED_ENV, "1")
        .env(crate::cli::AFTER_PID_ENV, std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    let _child = cmd.spawn()?;
    Ok(())
}

/// Started by [`spawn_self_after_exit`]: wait (at most 30 s) until the
/// instance that started this one has exited. No-op otherwise.
#[cfg(target_os = "linux")]
pub fn wait_for_previous_instance() {
    let Some(pid) = std::env::var(crate::cli::AFTER_PID_ENV)
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
    else {
        return;
    };
    // Not passed on to terminals and other children of this instance.
    std::env::remove_var(crate::cli::AFTER_PID_ENV);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while process_running(pid) && std::time::Instant::now() < until {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// Whether process `pid` is still running (a zombie has ended).
#[cfg(target_os = "linux")]
fn process_running(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    // `pid (comm) S ...`: the state follows the last ')'.
    let state = stat
        .rsplit_once(')')
        .and_then(|(_, rest)| rest.trim_start().chars().next());
    !matches!(state, Some('Z') | Some('X') | None)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    #[cfg(target_os = "linux")]
    #[test]
    fn a_relaunch_waits_until_the_previous_process_has_ended() {
        assert!(super::process_running(std::process::id()));
        let mut child = super::command("sleep").arg("0.3").spawn().unwrap();
        let pid = child.id();
        assert!(super::process_running(pid));
        let t0 = std::time::Instant::now();
        let waiter = std::thread::spawn(move || {
            while super::process_running(pid) {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });
        // Reaped here: until then the child is a zombie, which has ended too.
        let _ = child.wait();
        waiter.join().unwrap();
        assert!(t0.elapsed() >= std::time::Duration::from_millis(250));
        assert!(!super::process_running(pid));
    }

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

    /// True when this path is the Windows console shim binary source.
    fn is_gui_launch_shim(path: &Path) -> bool {
        path.file_name().is_some_and(|n| n == "sparkdown_shim.rs")
            && path.components().any(|c| c.as_os_str() == "bin")
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
        assert!(raw_command_new("let c = crate::proc::command_gui(p);").is_empty());
    }

    /// Guards sparkdown/sparkdown#15: a spawn that bypasses `proc::command`
    /// would flash a console window on Windows.
    ///
    /// Intent, not a blanket allow-list: only `proc.rs` (via [`super::command`]
    /// / [`super::command_gui`]) and the documented Windows console shim may
    /// call `Command::new`. The shim must launch the GUI *without*
    /// CREATE_NO_WINDOW and cannot import this module without a `lib` target.
    #[test]
    fn no_raw_command_new_outside_proc() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&src, &mut files);
        assert!(files.len() > 5, "no sources found under {}", src.display());
        let mut offenders = Vec::new();
        let mut shim_seen = false;
        for f in files {
            if f.file_name().is_some_and(|n| n == "proc.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&f).unwrap();
            let hits = raw_command_new(&text);
            if is_gui_launch_shim(&f) {
                shim_seen = true;
                // Match executable code, not this policy's own explanatory comments.
                let code = text
                    .lines()
                    .filter(|line| !line.trim_start().starts_with("//"))
                    .filter(|line| !line.starts_with("//!"))
                    .collect::<String>();
                assert!(
                    !hits.is_empty(),
                    "sparkdown_shim.rs must spawn the GUI with Command::new"
                );
                assert!(
                    !code.contains("CREATE_NO_WINDOW"),
                    "sparkdown_shim.rs must not set CREATE_NO_WINDOW (#160)"
                );
                assert!(
                    text.contains("DETACHED_PROCESS") || text.contains("creation_flags"),
                    "sparkdown_shim.rs should document Windows detach flags when not --wait"
                );
                continue;
            }
            for line in hits {
                offenders.push(format!("{}:{line}", f.display()));
            }
        }
        assert!(
            shim_seen,
            "expected src/bin/sparkdown_shim.rs in the tree (#160)"
        );
        assert!(
            offenders.is_empty(),
            "use crate::proc::command() for helpers or command_gui() for \
             GUI launches instead of Command::new (CREATE_NO_WINDOW on \
             Windows, see #15 / #160):\n{}",
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

    #[test]
    fn command_gui_runs_the_program() {
        let program = if cfg!(windows) { "cmd" } else { "sh" };
        let flag = if cfg!(windows) { "/C" } else { "-c" };
        let out = super::command_gui(program)
            .args([flag, "echo sd-gui-ok"])
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("sd-gui-ok"));
    }

    #[test]
    fn spawn_detached_self_uses_command_gui() {
        let src = include_str!("proc.rs");
        let start = src
            .find("pub fn spawn_detached_self")
            .expect("spawn_detached_self");
        let end = src[start..]
            .find("\n#[cfg(test)]")
            .map(|i| start + i)
            .unwrap_or(src.len());
        let body = &src[start..end];
        assert!(
            body.contains("let mut cmd = command_gui(&exe);"),
            "spawn_detached_self must use command_gui, not raw Command::new"
        );
        assert!(
            !body.contains("Command::new("),
            "spawn_detached_self must not call Command::new directly"
        );
    }
}
