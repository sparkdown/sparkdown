//! Windows console-subsystem shim named `sparkdown` on PATH (#160).
//!
//! The GUI app is `SparkDown.exe` (windows subsystem). This tiny console
//! exe prints `--version` / `--help` to the real console, then launches the
//! GUI and exits (unless `--wait`).

#![cfg_attr(not(windows), allow(dead_code))]

use std::env;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

const WAIT_FLAG: &str = "--wait";
const END_OF_FLAGS: &str = "--";
const FROM_SHIM_ENV: &str = "SPARKDOWN_FROM_SHIM";

fn main() {
    let argv: Vec<String> = env::args().collect();
    if let Some(text) = info(argv.get(1).map(String::as_str)) {
        let mut out = io::stdout();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
        return;
    }

    let gui = match find_gui() {
        Some(p) => p,
        None => {
            eprintln!(
                "sparkdown: could not find SparkDown.exe next to the shim ({})",
                env::current_exe()
                    .ok()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default()
            );
            std::process::exit(1);
        }
    };

    let wait = wants_wait(&argv);
    let forward = forward_args(&argv);

    // POLICY(#160): raw Command::new is required here — this console-subsystem
    // shim launches the GUI and must NOT set CREATE_NO_WINDOW. It cannot call
    // crate::proc::command_gui without a lib target; proc::tests locks this.
    #[allow(clippy::disallowed_methods)]
    let mut cmd = Command::new(&gui);
    cmd.args(&forward)
        .env(FROM_SHIM_ENV, "1")
        .stdin(Stdio::null());
    if !wait {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        }
    }
    match cmd.spawn() {
        Ok(mut child) => {
            if wait {
                let status = child.wait().unwrap_or_default();
                std::process::exit(status.code().unwrap_or(1));
            }
        }
        Err(e) => {
            eprintln!("sparkdown: failed to launch {}: {e}", gui.display());
            std::process::exit(1);
        }
    }
}

/// True when `--wait` appears before any `--` (same rule as `cli::wants_wait`).
fn wants_wait(argv: &[String]) -> bool {
    argv.iter()
        .skip(1)
        .take_while(|a| a.as_str() != END_OF_FLAGS)
        .any(|a| a == WAIT_FLAG)
}

/// Argv[1..] for the GUI: strip `--wait` only before `--`, so a path literally
/// named `--wait` after `--` is preserved.
fn forward_args(argv: &[String]) -> Vec<String> {
    let mut after_end = false;
    argv.iter()
        .skip(1)
        .filter_map(|a| {
            if after_end {
                return Some(a.clone());
            }
            if a.as_str() == END_OF_FLAGS {
                after_end = true;
                return Some(a.clone());
            }
            if a == WAIT_FLAG {
                None
            } else {
                Some(a.clone())
            }
        })
        .collect()
}

fn info(first: Option<&str>) -> Option<String> {
    let version = env!("CARGO_PKG_VERSION");
    match first? {
        "--version" | "-V" => Some(format!("SparkDown {version}\n")),
        "--help" | "-h" => Some(format!(
            "SparkDown {version}: a Markdown editor and agent cockpit.\n\n\
             Usage:\n  \
             sparkdown [FILE|FOLDER]...   open files or a folder in the app\n  \
             sparkdown --new-window FOLDER  open FOLDER in a new window\n  \
             sparkdown --wait             keep this process until the app quits\n  \
             sparkdown --version, -V      print the version and exit\n  \
             sparkdown --help, -h         print this help and exit\n"
        )),
        _ => None,
    }
}

fn find_gui() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    let dir = exe.parent()?;
    // Installed layout: $INSTDIR\bin\sparkdown.exe → GUI in parent ($INSTDIR).
    // Dev layout: target/release/sparkdown-shim next to target/release/sparkdown.
    let mut bases = vec![dir.to_path_buf()];
    if let Some(parent) = dir.parent() {
        bases.push(parent.to_path_buf());
    }
    for base in bases {
        for name in ["SparkDown.exe", "sparkdown.exe", "SparkDown", "sparkdown"] {
            let p = base.join(name);
            if !p.is_file() {
                continue;
            }
            if same_file(&p, &exe) {
                continue;
            }
            // Never treat the externalBin helper as the GUI.
            if file_stem_eq_ignore_ascii_case(&p, "sparkdown-shim") {
                continue;
            }
            return Some(p);
        }
    }
    None
}

fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn file_stem_eq_ignore_ascii_case(p: &std::path::Path, want: &str) -> bool {
    p.file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case(want))
}

#[cfg(test)]
mod tests {
    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn version_text_includes_crate_version() {
        let v = super::info(Some("--version")).unwrap();
        assert_eq!(v, format!("SparkDown {}\n", env!("CARGO_PKG_VERSION")));
        assert!(super::info(Some("--help")).unwrap().contains("--wait"));
        assert_eq!(super::info(Some("file.md")), None);
    }

    #[test]
    fn wait_flag_only_counts_before_end_of_flags() {
        assert!(super::wants_wait(&argv(&["sparkdown", "--wait"])));
        assert!(super::wants_wait(&argv(&["sparkdown", "a", "--wait"])));
        assert!(!super::wants_wait(&argv(&["sparkdown", "--", "--wait"])));
        assert!(!super::wants_wait(&argv(&["sparkdown", "a"])));
    }

    #[test]
    fn forward_args_strips_wait_only_before_end_of_flags() {
        assert_eq!(
            super::forward_args(&argv(&["sparkdown", "--wait", "a.md"])),
            vec!["a.md"]
        );
        assert_eq!(
            super::forward_args(&argv(&["sparkdown", "a.md", "--wait"])),
            vec!["a.md"]
        );
        assert_eq!(
            super::forward_args(&argv(&["sparkdown", "--", "--wait"])),
            vec!["--", "--wait"]
        );
        assert_eq!(
            super::forward_args(&argv(&["sparkdown", "--new-window", "f"])),
            vec!["--new-window", "f"]
        );
    }
}
