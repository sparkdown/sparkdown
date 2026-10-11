//! Stdio MCP shim (`sparkdown --mcp-stdio`).
//!
//! Every agent CLI can start a *stdio* MCP server: it launches a command and
//! speaks JSON-RPC over that child's stdin/stdout. So instead of injecting a
//! URL into each agent's config, the user installs THIS binary in stdio mode
//! as an MCP server (once, per agent, via the agent's own `mcp add`). The
//! shim is a thin bridge:
//!
//!   - If `$SPARKDOWN_MCP` names a live SparkDown socket, forward every line
//!     both ways. The agent gets the real tools.
//!   - If it is unset or dead (the user is NOT in a SparkDown terminal), still
//!     answer `initialize` and `ping`, but advertise ZERO tools. The agent
//!     sees a valid server with nothing to offer and moves on — no error, no
//!     noise. This is the whole point of the env-var gate.
//!
//! Runs before Tauri: no window, no webview, just line I/O. Exits when the
//! agent closes stdin.

use serde_json::{json, Value};

/// Entry point from main.rs when argv contains `--mcp-stdio`. Never returns a
/// value the caller uses; the process exits when stdin closes.
pub fn run() {
    exit_when_orphaned();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();

    // Connected mode: a live socket named by the environment.
    if let Some(sock) = connect_socket() {
        bridge(sock);
        return;
    }

    // Offline mode: valid server, no tools.
    let out = stdout.lock();
    crate::mcp::serve_lines(stdin.lock(), out, offline_reply);
}

/// How often the orphan check looks at the parent pid.
#[cfg(unix)]
const PARENT_POLL: std::time::Duration = std::time::Duration::from_secs(2);

/// Whether the shim lost the agent that launched it: its parent pid changed
/// (the kernel re-parents an orphan to init or a subreaper). A shim started
/// already orphaned (`start <= 1`) has nothing to watch.
#[cfg(unix)]
fn is_orphaned(start: u32, now: u32) -> bool {
    start > 1 && now != start
}

/// Safety net (#31): normally the shim ends when the agent closes stdin
/// (EOF) or the app's socket hangs up. If the agent dies while something
/// else still holds our stdin pipe open (a grandchild, a shell wrapper), EOF
/// never comes; poll `getppid()` and exit once the parent is gone. Portable
/// across Linux and macOS (no `prctl(PR_SET_PDEATHSIG)`, which is Linux-only
/// and fires on the death of the parent *thread*, not process). Windows has
/// no re-parenting signal; there the stdin EOF and socket hang-up paths
/// apply.
#[cfg(unix)]
fn exit_when_orphaned() {
    let start = std::os::unix::process::parent_id();
    if start <= 1 {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(PARENT_POLL);
        if is_orphaned(start, std::os::unix::process::parent_id()) {
            std::process::exit(0);
        }
    });
}

#[cfg(not(unix))]
fn exit_when_orphaned() {}

/// Connect to `$SPARKDOWN_MCP` if it is a working SparkDown socket.
#[cfg(unix)]
fn connect_socket() -> Option<std::os::unix::net::UnixStream> {
    let path = std::env::var_os(crate::mcp::SOCKET_ENV)?;
    std::os::unix::net::UnixStream::connect(path).ok()
}

/// Windows: `$SPARKDOWN_MCP` names the per-user pipe (`\\.\pipe\…`).
#[cfg(windows)]
fn connect_socket() -> Option<interprocess::local_socket::Stream> {
    use interprocess::local_socket::{prelude::*, GenericFilePath, Stream};
    let path = std::env::var_os(crate::mcp::SOCKET_ENV)?;
    let name = path.to_fs_name::<GenericFilePath>().ok()?;
    Stream::connect(name).ok()
}

#[cfg(unix)]
fn bridge(sock: std::os::unix::net::UnixStream) {
    let Ok(sock_read) = sock.try_clone() else {
        return;
    };
    let mut sock_write = sock;
    let half_close = {
        let Ok(s) = sock_write.try_clone() else {
            return;
        };
        move || {
            let _ = s.shutdown(std::net::Shutdown::Write);
        }
    };
    bridge_io(sock_read, &mut sock_write, half_close);
}

#[cfg(windows)]
fn bridge(sock: interprocess::local_socket::Stream) {
    use interprocess::local_socket::traits::Stream as _;
    let (read_half, mut write_half) = sock.split();
    // Named pipes have no half-close; the bounded drain in `bridge_io` covers
    // the replies still in flight when the agent closes stdin.
    bridge_io(read_half, &mut write_half, || {});
}

/// Pump agent stdin → server and server → agent stdout until either side
/// ends. Transport-agnostic: `half_close` signals EOF to the server (where
/// the transport can) so it answers what it has read and hangs up.
fn bridge_io<R, W, F>(mut sock_read: R, sock_write: &mut W, half_close: F)
where
    R: std::io::Read + Send + 'static,
    W: std::io::Write,
    F: FnOnce(),
{
    use std::sync::mpsc::channel;
    // Server → agent stdout, on its own thread.
    let (done_tx, done_rx) = channel::<()>();
    std::thread::spawn(move || {
        let mut out = std::io::stdout();
        let _ = std::io::copy(&mut sock_read, &mut out);
        let _ = done_tx.send(());
        // Server hung up (app quit): end the whole shim so the agent's client
        // sees its server exit, instead of blocking on stdin forever.
        std::process::exit(0);
    });
    // Agent stdin → server, on this thread.
    let mut input = std::io::stdin();
    let _ = std::io::copy(&mut input, sock_write);
    let _ = sock_write.flush();
    // Agent closed stdin (it is exiting). Let the server finish answering
    // what it has read; drain those replies, but never wait on a server that
    // does not hang up.
    half_close();
    let _ = done_rx.recv_timeout(std::time::Duration::from_secs(2));
    std::process::exit(0);
}

/// Offline responses: enough of MCP to be a well-behaved server with no tools.
fn offline_reply(msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned()?; // notifications: ignore
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => json!({
            "protocolVersion": "2025-06-18",
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "sparkdown", "version": env!("CARGO_PKG_VERSION") },
            "instructions":
                "SparkDown is not running, or this shell is not a SparkDown terminal. \
                 No editor tools are available right now."
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": [] }),
        "resources/list" => json!({ "resources": [] }),
        "prompts/list" => json!({ "prompts": [] }),
        _ => {
            return Some(json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": "Method not found" }
            }))
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn orphan_check_fires_only_when_the_parent_changes() {
        assert!(!is_orphaned(4242, 4242));
        assert!(is_orphaned(4242, 1)); // re-parented to init
        assert!(is_orphaned(4242, 777)); // or to a subreaper
        assert!(!is_orphaned(1, 1)); // started orphaned: nothing to watch
    }

    #[test]
    fn offline_initialize_and_empty_tools() {
        let init = offline_reply(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }))
            .expect("has reply");
        assert_eq!(init["result"]["serverInfo"]["name"], "sparkdown");
        let tools = offline_reply(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))
            .expect("has reply");
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn offline_ignores_notifications() {
        assert!(
            offline_reply(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
                .is_none()
        );
    }
}
