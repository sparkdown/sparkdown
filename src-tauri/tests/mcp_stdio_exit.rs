//! The `--mcp-stdio` shim must not outlive its agent (#31): it exits on stdin
//! EOF, and (Unix) when its parent dies even if stdin stays open.

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_sparkdown");

// Integration tests can't reach the crate's `proc::command`.
#[allow(clippy::disallowed_methods)]
fn shim() -> Command {
    let mut c = Command::new(BIN);
    c.arg("--mcp-stdio").env_remove("SPARKDOWN_MCP");
    c
}

#[test]
fn exits_on_stdin_eof_after_answering() {
    let mut child = shim()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n")
            .unwrap();
        // Dropping stdin = the agent closed the pipe (EOF).
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            panic!("shim still running 10 s after stdin EOF");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut out = String::new();
    use std::io::Read;
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut out)
        .unwrap();
    assert!(out.contains("\"id\":1"), "{out}");
}

/// The parent shell exits while `sleep` keeps the shim's stdin open, so no
/// EOF arrives: only the parent-death check can end it. The shell lingers a
/// second so the shim records it as its parent before it dies.
#[cfg(target_os = "linux")]
#[test]
#[allow(clippy::disallowed_methods)]
fn exits_when_its_parent_dies_with_stdin_still_open() {
    let out = Command::new("sh")
        .arg("-c")
        .arg("sleep 30 | \"$0\" --mcp-stdio >/dev/null 2>&1 & echo $!; sleep 1")
        .arg(BIN)
        .env_remove("SPARKDOWN_MCP")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .unwrap();
    let pid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert!(!pid.is_empty());
    // Alive (and not a zombie) = /proc/<pid>/stat exists with a state != Z.
    let alive = || {
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|s| {
                let state = s.rsplit(')').next().unwrap_or("").trim_start();
                !state.starts_with('Z')
            })
            .unwrap_or(false)
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while alive() {
        if Instant::now() >= deadline {
            let _ = Command::new("kill").arg(&pid).status();
            panic!("shim {pid} still running 10 s after its parent exited");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
