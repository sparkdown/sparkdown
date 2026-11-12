#!/bin/sh
# SparkDown MCP stdio shim (remote host).
#
# SparkDown installs this file into ~/.cache/sparkdown/ when a remote
# workspace connects. Agents run it as a stdio MCP server. It forwards
# stdin/stdout to the Unix socket named by $SPARKDOWN_MCP: an SSH
# reverse-forwarded channel to the SparkDown app on your machine.
#
# $SPARKDOWN_MCP is exported only in SparkDown terminals. Anywhere else this
# answers as an MCP server with ZERO tools, so an agent config that points
# here is silent outside SparkDown. Arguments are ignored (SparkDown's local
# shim takes --mcp-stdio; agent configs pass it along).
#
# A per-session secret ($SPARKDOWN_MCP_WINDOW_TOKEN), exported only in
# SparkDown terminals, accompanies each connection to the window's socket.
# The bridge sends a sparkdown_hello with that token as the first line and
# swallows the server's one-line ack; a direct connection that skips this is
# refused.
#
# Bridge: python3 (needed for the handshake). Offline mode also needs python3.

sock="${SPARKDOWN_MCP:-}"
tok="${SPARKDOWN_MCP_WINDOW_TOKEN:-}"

py_bridge=$(cat <<'PY'
import json, os, socket, sys, threading
sock_path, token = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sock_path)
sf = s.makefile("rwb", buffering=0)
# Send the token before relaying anything in either direction: a per-window
# socket drops every message until it sees a sparkdown_hello with the
# matching token.
hello = {"sparkdown_hello": {"token": token, "terminal": True}}
sf.write((json.dumps(hello) + "\n").encode("utf-8"))
sf.flush()
ack_line = sf.readline()
try:
    ack = json.loads(ack_line.decode("utf-8", "replace"))
    ok = bool(ack.get("sparkdown_ack", {}).get("ok"))
except Exception:
    ok = False
if not ok:
    sys.stderr.write("sparkdown mcp-shim: SparkDown refused this connection (bad or missing window token)\n")
    sys.exit(1)
def to_sock():
    # stdin -> socket. On EOF half-close, so the server still answers what
    # it has read, then closes; the main loop below drains that and exits.
    try:
        while True:
            b = os.read(0, 65536)
            if not b:
                break
            sf.write(b)
            sf.flush()
    except Exception:
        pass
    try:
        s.shutdown(socket.SHUT_WR)
    except Exception:
        pass
threading.Thread(target=to_sock, daemon=True).start()
try:
    while True:
        b = sf.read(65536)
        if not b:
            break
        os.write(1, b)
except Exception:
    pass
os._exit(0)
PY
)

py_offline=$(cat <<'PY'
import json, sys
def reply(rid, result=None, error=None):
    m = {"jsonrpc": "2.0", "id": rid}
    if error is not None:
        m["error"] = error
    else:
        m["result"] = result
    sys.stdout.write(json.dumps(m) + "\n")
    sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    if "id" not in msg:
        continue  # notification: no reply
    rid, method = msg["id"], msg.get("method", "")
    if method == "initialize":
        reply(rid, {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "sparkdown", "version": "remote-shim"},
            "instructions": "SparkDown is not connected in this shell; no tools are available.",
        })
    elif method == "ping":
        reply(rid, {})
    elif method == "tools/list":
        reply(rid, {"tools": []})
    elif method == "resources/list":
        reply(rid, {"resources": []})
    elif method == "prompts/list":
        reply(rid, {"prompts": []})
    else:
        reply(rid, error={"code": -32601, "message": "Method not found"})
PY
)

if [ -n "$sock" ] && [ -S "$sock" ] && [ -n "$tok" ]; then
  if command -v python3 >/dev/null 2>&1; then
    exec python3 -c "$py_bridge" "$sock" "$tok"
  fi
  echo "sparkdown mcp-shim: need python3 to reach $sock" >&2
  exit 1
fi

# Offline: no SparkDown socket in this shell, or no window token. Advertise
# zero tools so an agent config pointed at this file is silent.
if command -v python3 >/dev/null 2>&1; then
  exec python3 -c "$py_offline"
fi
echo "sparkdown mcp-shim: SparkDown is not connected in this shell" >&2
exit 1
