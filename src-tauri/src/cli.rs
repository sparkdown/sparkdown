//! Command-line parsing for `sparkdown …` (#33, #51, #66, #160). Pure: no
//! app, window or filesystem state, so every rule is unit-tested here.
//!
//! - `--version`/`-V` and `--help`/`-h` (first argument only) print and exit.
//! - Other arguments starting with `-` are flags, not paths.
//! - After `--`, every argument is a path, even one starting with `-`.
//! - Paths resolve against the launching process's cwd (a second launch
//!   forwards its own cwd to the running app).

/// Forces folders into a new window (#66).
pub const NEW_WINDOW_FLAG: &str = "--new-window";

/// Ends flags: everything after it is a path.
pub const END_OF_FLAGS: &str = "--";

/// What `sparkdown <first arg>` should print and exit with, for the flags that
/// must never open a window (#33). Only the first argument counts, so a file
/// that happens to be named `--help` later on the command line still opens.
pub fn cli_info(first_arg: Option<&str>) -> Option<String> {
    let version = env!("CARGO_PKG_VERSION");
    match first_arg? {
        "--version" | "-V" => Some(format!("SparkDown {version}\n")),
        "--help" | "-h" => Some(format!(
            "SparkDown {version}: a Markdown editor and agent cockpit.\n\n\
             Usage:\n  \
             sparkdown [FILE|FOLDER]...   open files or a folder in the app\n                               (in the open window, if SparkDown is running)\n  \
             sparkdown --new-window FOLDER  open FOLDER in a new window (focuses it if already open)\n  \
             sparkdown -- PATH...         treat every following argument as a path\n  \
             sparkdown --mcp-stdio        run the stdio MCP bridge for agent CLIs\n  \
             sparkdown --version, -V      print the version and exit\n  \
             sparkdown --help, -h         print this help and exit\n"
        )),
        _ => None,
    }
}

/// The raw path arguments of `argv` (argv[0] skipped), honouring `--`.
fn path_args(argv: &[String]) -> impl Iterator<Item = &String> {
    let mut after_end = false;
    argv.iter().skip(1).filter(move |a| {
        if after_end {
            return !a.is_empty();
        }
        if a.as_str() == END_OF_FLAGS {
            after_end = true;
            return false;
        }
        !a.is_empty() && !a.starts_with('-')
    })
}

/// True when `--new-window` appears before any `--`.
pub fn wants_new_window(argv: &[String]) -> bool {
    argv.iter()
        .skip(1)
        .take_while(|a| a.as_str() != END_OF_FLAGS)
        .any(|a| a == NEW_WINDOW_FLAG)
}

/// Trim trailing separators; keep a root a root (`/`, `C:\`).
fn normalize(p: &str) -> String {
    let t = p.trim_end_matches(['/', '\\']);
    if t.is_empty() {
        "/".to_string()
    } else if t.ends_with(':') {
        format!("{t}\\") // `C:` alone would mean "the cwd on C:"
    } else {
        t.to_string()
    }
}

/// Paths a `sparkdown …` launch passed, made absolute against that launch's
/// working directory (not the running app's). `sparkdown .` → `<cwd>`.
pub fn forwarded_paths(argv: &[String], cwd: &str) -> Vec<String> {
    path_args(argv)
        .map(|a| {
            let p = std::path::Path::new(a);
            let joined = if p.is_absolute() || cwd.is_empty() {
                p.to_path_buf()
            } else {
                std::path::Path::new(cwd).join(p)
            };
            let abs = std::path::absolute(&joined).unwrap_or(joined);
            normalize(&abs.to_string_lossy())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn version_and_help_flags_print_instead_of_opening_the_app() {
        let v = cli_info(Some("--version")).unwrap();
        assert_eq!(v, format!("SparkDown {}\n", env!("CARGO_PKG_VERSION")));
        assert_eq!(cli_info(Some("-V")), Some(v));
        let help = cli_info(Some("--help")).unwrap();
        assert!(
            help.contains("--mcp-stdio") && help.contains("--version"),
            "{help}"
        );
        assert_eq!(cli_info(Some("-h")), Some(help));
        for other in [
            None,
            Some("notes.md"),
            Some("--mcp-stdio"),
            Some("-psn_0_1"),
            Some("--"),
        ] {
            assert_eq!(cli_info(other), None, "{other:?}");
        }
    }

    #[test]
    fn drive_roots_and_roots_stay_roots() {
        assert_eq!(normalize("C:"), r"C:\");
        assert_eq!(normalize(r"C:\"), r"C:\");
        assert_eq!(normalize(r"D:\work\"), r"D:\work");
        assert_eq!(normalize("/"), "/");
        assert_eq!(normalize("/tmp/x//"), "/tmp/x");
    }

    #[test]
    fn new_window_flag_only_counts_before_end_of_flags() {
        assert!(wants_new_window(&argv(&["sparkdown", "--new-window", "a"])));
        assert!(wants_new_window(&argv(&["sparkdown", "a", "--new-window"])));
        assert!(!wants_new_window(&argv(&[
            "sparkdown",
            "--",
            "--new-window"
        ])));
        assert!(!wants_new_window(&argv(&["sparkdown", "a"])));
    }

    #[cfg(unix)]
    #[test]
    fn paths_resolve_against_the_launching_cwd() {
        assert_eq!(
            forwarded_paths(&argv(&["sparkdown", "."]), "/home/u/proj"),
            vec!["/home/u/proj"]
        );
        assert_eq!(
            forwarded_paths(&argv(&["sparkdown", "./"]), "/home/u/proj"),
            vec!["/home/u/proj"]
        );
        assert_eq!(
            forwarded_paths(&argv(&["sparkdown", "notes", "a.md"]), "/home/u"),
            vec!["/home/u/notes", "/home/u/a.md"]
        );
        assert_eq!(
            forwarded_paths(&argv(&["/usr/bin/sparkdown", "/tmp/x/"]), "/home/u"),
            vec!["/tmp/x"]
        );
        assert_eq!(forwarded_paths(&argv(&["sparkdown", "/"]), "/h"), vec!["/"]);
        assert!(forwarded_paths(&argv(&["sparkdown"]), "/h").is_empty());
        assert!(forwarded_paths(&argv(&["sparkdown", ""]), "/h").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn flags_are_skipped_wherever_they_appear() {
        assert!(forwarded_paths(&argv(&["sparkdown", "--foo"]), "/h").is_empty());
        assert_eq!(
            forwarded_paths(&argv(&["sparkdown", "a.md", "--new-window", "b"]), "/h"),
            vec!["/h/a.md", "/h/b"]
        );
        assert_eq!(
            forwarded_paths(&argv(&["sparkdown", "-psn_0_1", "a"]), "/h"),
            vec!["/h/a"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn end_of_flags_makes_dash_names_paths() {
        assert_eq!(
            forwarded_paths(&argv(&["sparkdown", "--", "-notes.md", "--help"]), "/h"),
            vec!["/h/-notes.md", "/h/--help"]
        );
        assert_eq!(
            forwarded_paths(&argv(&["sparkdown", "a", "--", "--"]), "/h"),
            vec!["/h/a", "/h/--"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_and_drive_roots() {
        assert_eq!(
            forwarded_paths(&argv(&["sparkdown.exe", "notes"]), r"C:\Users\u"),
            vec![r"C:\Users\u\notes"]
        );
        assert_eq!(
            forwarded_paths(&argv(&["sparkdown.exe", "."]), r"C:\Users\u"),
            vec![r"C:\Users\u"]
        );
        assert_eq!(
            forwarded_paths(&argv(&["sparkdown.exe", r"D:\"]), r"C:\x"),
            vec![r"D:\"]
        );
    }
}
