//! The real binary prints `--version` / `--help` and exits without opening a
//! window (#33). A GUI launch would hang here (or fail with no display), so a
//! deadline guards the run.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn run(flag: &str) -> (bool, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_sparkdown"))
        .arg(flag)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn sparkdown");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            let mut out = String::new();
            use std::io::Read;
            child
                .stdout
                .take()
                .unwrap()
                .read_to_string(&mut out)
                .unwrap();
            return (status.success(), out);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("`sparkdown {flag}` did not exit (it probably opened the app)");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn version_prints_and_exits() {
    let (ok, out) = run("--version");
    assert!(ok);
    assert_eq!(out, format!("SparkDown {}\n", env!("CARGO_PKG_VERSION")));
}

#[test]
fn help_prints_and_exits() {
    let (ok, out) = run("--help");
    assert!(ok);
    assert!(out.contains("Usage:") && out.contains("--version"), "{out}");
}
