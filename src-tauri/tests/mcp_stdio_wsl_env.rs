//! #116: an agent under WSL starts the Windows shim with only what WSL
//! forwards through `WSLENV` (the pipe name and the routing token). The
//! shim must reach the app and route by that token from those two
//! variables alone: no config file, no home dir, any working directory
//! (WSL hands a Windows process a `\\wsl.localhost\…` cwd for a Linux
//! folder). Unix sockets stand in for the Windows named pipe; the pipe
//! itself and WSL's forwarding need a real Windows + WSL run.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixListener;
use std::process::{Command, Stdio};
use std::time::Duration;

const BIN: &str = env!("CARGO_BIN_EXE_sparkdown");

fn scratch(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("sd-wsl-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// The shim, run with an EMPTY environment plus `vars`, from `cwd`.
// Integration tests can't reach the crate's `proc::command`.
#[allow(clippy::disallowed_methods)]
fn run_shim(vars: &[(&str, &str)], cwd: &std::path::Path, input: &str) -> String {
    let mut c = Command::new(BIN);
    c.arg("--mcp-stdio").env_clear().current_dir(cwd);
    for (k, v) in vars {
        c.env(k, v);
    }
    let mut child = c
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap(); // dropped: EOF
    let mut out = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut out)
        .unwrap();
    let _ = child.wait();
    out
}

/// A one-connection fake app: records the hello, answers `ack`, then
/// echoes a result for each request it reads.
fn fake_app(sock: &std::path::Path, ack: &'static str) -> std::thread::JoinHandle<String> {
    let listener = UnixListener::bind(sock).unwrap();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut w = stream.try_clone().unwrap();
        let mut r = BufReader::new(stream);
        let mut hello = String::new();
        r.read_line(&mut hello).unwrap();
        writeln!(w, "{ack}").unwrap();
        let mut line = String::new();
        while r.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
            let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
            let reply = serde_json::json!({"jsonrpc":"2.0","id":v["id"],"result":{"from":"app"}});
            writeln!(w, "{reply}").unwrap();
            line.clear();
        }
        hello
    })
}

#[test]
fn shim_routes_by_the_forwarded_token_alone() {
    let dir = scratch("ok");
    let sock = dir.join("mcp.sock");
    let app = fake_app(&sock, r#"{"sparkdown_ack":{"ok":true}}"#);
    // What a WSL agent's Windows shim sees: the two forwarded routing vars,
    // WSLENV itself and the /p-translated shim path. Nothing else.
    let token = "f0f1f2f3-window-token";
    let elsewhere = scratch("cwd"); // not the window's folder
    let out = run_shim(
        &[
            ("SPARKDOWN_MCP", sock.to_str().unwrap()),
            ("SPARKDOWN_MCP_TOKEN", token),
            (
                "WSLENV",
                "SPARKDOWN_MCP:SPARKDOWN_MCP_TOKEN:SPARKDOWN_MCP_SHIM/p",
            ),
            ("SPARKDOWN_MCP_SHIM", BIN),
        ],
        &elsewhere,
        "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/list\"}\n",
    );
    let hello: serde_json::Value = serde_json::from_str(app.join().unwrap().trim()).unwrap();
    let h = &hello["sparkdown_hello"];
    assert_eq!(h["terminal"], true, "{hello}");
    assert_eq!(h["token"], token, "{hello}");
    // The bridged request reached the app and its answer came back.
    assert!(
        out.contains("\"id\":7") && out.contains("\"from\":\"app\""),
        "{out}"
    );
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&elsewhere);
}

#[test]
fn refused_shim_goes_offline_with_no_tools() {
    let dir = scratch("refused");
    let sock = dir.join("mcp.sock");
    let app = fake_app(&sock, r#"{"sparkdown_ack":{"ok":false,"error":"no"}}"#);
    let out = run_shim(
        &[
            ("SPARKDOWN_MCP", sock.to_str().unwrap()),
            ("SPARKDOWN_MCP_TOKEN", "stale"),
        ],
        &dir,
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n",
    );
    let _ = app.join();
    assert!(out.contains("\"tools\":[]"), "{out}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn without_forwarded_vars_the_shim_is_offline_not_misrouted() {
    // A `wsl` shell from an OLD build (no WSLENV entries): the shim sees no
    // SPARKDOWN_MCP. With no app socket to find either, it must answer as a
    // valid server with zero tools.
    let dir = scratch("none");
    let out = run_shim(
        &[("XDG_RUNTIME_DIR", dir.to_str().unwrap())],
        &dir,
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n",
    );
    assert!(out.contains("\"tools\":[]"), "{out}");
    let _ = std::fs::remove_dir_all(&dir);
}
