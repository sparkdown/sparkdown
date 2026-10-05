//! Test-only fake agent CLIs for the Windows smoke tests (terminal.rs,
//! mcp.rs). Each fake is installed the way npm installs a real agent CLI
//! (cmd-shim): `<bin>.cmd` and, optionally, `<bin>.ps1`, both starting
//! `node dump.js` with the arguments. `dump.js` writes the argv it received
//! and the environment variables the tests care about as JSON, so a test
//! can check that every argument and variable arrived intact through
//! PowerShell, cmd.exe and the Windows command-line quoting.
//!
//! The base dir name has a space and an apostrophe on purpose (like
//! `C:\Users\Jane O'Brien`): the shims and PATH must cope with it.
//!
//! Node.js is required (GitHub's windows-latest has it). Without it the
//! tests skip, unless `SPARKDOWN_WIN_SMOKE=1` (set in CI) makes that a
//! failure.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Writes `{"argv": [...], "env": {...}}` to `$SD_SMOKE_OUT`, else to
/// `last-run.json` next to itself. Write-then-rename, so a poller never
/// reads a half-written file.
const DUMP_JS: &str = r#"const fs = require('fs');
const path = require('path');
const out = process.env.SD_SMOKE_OUT || path.join(__dirname, 'last-run.json');
const env = {};
for (const k of ['OPENCODE_CONFIG_CONTENT', 'SPARKDOWN_LAUNCH']) {
  if (k in process.env) env[k] = process.env[k];
}
fs.writeFileSync(out + '.tmp', JSON.stringify({ argv: process.argv.slice(2), env }));
fs.renameSync(out + '.tmp', out);
"#;

/// npm's cmd-shim `.cmd`, reduced to what matters: `%~dp0` (the shim's own
/// dir, with a trailing backslash) and `%*` (the raw argument string).
const SHIM_CMD: &str = "@ECHO off\r\nnode \"%~dp0dump.js\" %*\r\n";

/// npm's cmd-shim `.ps1`, reduced the same way: PowerShell prefers it over
/// the `.cmd` when both exist, and it re-passes `$args` to node.
const SHIM_PS1: &str = "$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent\r\n\
    & node \"$basedir/dump.js\" $args\r\n\
    exit $LASTEXITCODE\r\n";

pub struct FakeAgents {
    /// Holds the shims (put first on PATH).
    pub bin_dir: PathBuf,
    /// Scratch space for output files (removed on drop).
    pub base: PathBuf,
}

impl FakeAgents {
    /// Install fake `bins`; `with_ps1` adds the `.ps1` shim next to each
    /// `.cmd`, as npm does.
    pub fn new(tag: &str, bins: &[&str], with_ps1: bool) -> Self {
        let base =
            std::env::temp_dir().join(format!("sd smoke O'Brien {} {tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let bin_dir = base.join("npm bin");
        std::fs::create_dir_all(&bin_dir).expect("create fake agent dir");
        std::fs::write(bin_dir.join("dump.js"), DUMP_JS).unwrap();
        for bin in bins {
            std::fs::write(bin_dir.join(format!("{bin}.cmd")), SHIM_CMD).unwrap();
            if with_ps1 {
                std::fs::write(bin_dir.join(format!("{bin}.ps1")), SHIM_PS1).unwrap();
            }
        }
        FakeAgents { bin_dir, base }
    }

    /// PATH with the fake agents first.
    pub fn path_env(&self) -> std::ffi::OsString {
        let mut dirs = vec![self.bin_dir.clone()];
        if let Some(p) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&p));
        }
        std::env::join_paths(dirs).expect("join PATH")
    }

    /// Where `dump.js` writes when `SD_SMOKE_OUT` is not set.
    pub fn default_out(&self) -> PathBuf {
        self.bin_dir.join("last-run.json")
    }
}

impl Drop for FakeAgents {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

/// True when Node.js can run the fakes. False = skip the test, except in CI
/// (`SPARKDOWN_WIN_SMOKE=1`), where a missing node is a failure.
pub fn node_ready() -> bool {
    let ok = std::process::Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ok && std::env::var_os("SPARKDOWN_WIN_SMOKE").is_some() {
        panic!("SPARKDOWN_WIN_SMOKE is set but `node` is not on PATH");
    }
    ok
}

/// Wait for `path` to appear (up to `timeout`) and return its text.
pub fn wait_for_file(path: &Path, timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        // Non-empty only: Set-Content creates the file before it writes.
        if let Some(bytes) = std::fs::read(path).ok().filter(|b| !b.is_empty()) {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            return Some(text.trim_start_matches('\u{feff}').to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

/// Parse a `dump.js` record.
pub fn parse_dump(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|e| panic!("bad dump.js output {text:?}: {e}"))
}

/// The argv of a `dump.js` record as strings.
pub fn dump_argv(dump: &Value) -> Vec<String> {
    dump["argv"]
        .as_array()
        .expect("argv array")
        .iter()
        .map(|v| v.as_str().expect("string arg").to_string())
        .collect()
}
