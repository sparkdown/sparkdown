//! The macOS launcher script opens the bundle it lives in by path, not by the
//! name "SparkDown". Runs under any bash with a stand-in `open` on PATH.

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

// An integration test can't reach the crate's `proc::command`.
#[allow(clippy::disallowed_methods)]
fn run_launcher(args: &[&str]) -> Vec<String> {
    let root =
        std::env::temp_dir().join(format!("sd-launcher-{}-{}", std::process::id(), args.len()));
    let _ = fs::remove_dir_all(&root);
    let app = root.join("Other Name.app");
    let bin_dir = app.join("Contents/Resources/bin");
    fs::create_dir_all(&bin_dir).unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/bin/sparkdown");
    let launcher = bin_dir.join("sparkdown");
    fs::copy(&script, &launcher).unwrap();
    let fake = root.join("fake-bin");
    fs::create_dir_all(&fake).unwrap();
    let log = root.join("open.log");
    let open = fake.join("open");
    fs::write(
        &open,
        format!(
            "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> '{}'; done\n",
            log.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&open, fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!(
        "{}:{}",
        fake.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let status = Command::new("bash")
        .arg(&launcher)
        .args(args)
        .env("PATH", path)
        .status()
        .expect("run launcher");
    assert!(status.success());
    let out = fs::read_to_string(&log).unwrap_or_default();
    let canon = app.canonicalize().unwrap();
    let _ = fs::remove_dir_all(&root);
    let mut lines: Vec<String> = out.lines().map(str::to_string).collect();
    // The script may report the bundle with or without symlinks resolved
    // (macOS temp folders live under /var, a link to /private/var).
    for l in &mut lines {
        if *l == canon.to_string_lossy() || *l == app.to_string_lossy() {
            *l = "<app>".to_string();
        }
    }
    lines
}

#[test]
fn launcher_opens_the_bundle_by_path() {
    assert_eq!(run_launcher(&[]), ["-a", "<app>"]);
    assert_eq!(
        run_launcher(&["--new-window"]),
        ["-a", "<app>", "--args", "--new-window"]
    );
    assert_eq!(run_launcher(&["/tmp/a.md"]), ["-a", "<app>", "/tmp/a.md"]);
    assert_eq!(
        run_launcher(&["--new-window", "/tmp/a.md"]),
        ["-a", "<app>", "/tmp/a.md", "--args", "--new-window"]
    );
}
