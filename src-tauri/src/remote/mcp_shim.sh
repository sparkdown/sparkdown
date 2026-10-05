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
# Bridges, in order: socat, python3, nc -U. Offline mode needs python3.

sock="${SPARKDOWN_MCP:-}"

py_bridge=$(cat <<'PY'
import os, socket, sys, threading
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sys.argv[1])
def to_sock():
    # stdin -> socket. On EOF half-close, so the server still answers what
    # it has read, then closes; the main loop below drains that and exits.
    try:
        while True:
            b = os.read(0, 65536)
            if not b:
                break
            s.sendall(b)
    except Exception:
        pass
    try:
        s.shutdown(socket.SHUT_WR)
    except Exception:
        pass
threading.Thread(target=to_sock, daemon=True).start()
try:
    while True:
        b = s.recv(65536)
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

if [ -n "$sock" ] && [ -S "$sock" ]; then
  if command -v socat >/dev/null 2>&1; then
    exec socat - "UNIX-CONNECT:$sock"
  fi
  if command -v python3 >/dev/null 2>&1; then
    exec python3 -c "$py_bridge" "$sock"
  fi
  if command -v nc >/dev/null 2>&1; then
    exec nc -U "$sock"
  fi
  echo "sparkdown mcp-shim: need socat, python3, or nc -U to reach $sock" >&2
  exit 1
fi

# Offline: no SparkDown socket in this shell. Advertise zero tools.
if command -v python3 >/dev/null 2>&1; then
  exec python3 -c "$py_offline"
fi
echo "sparkdown mcp-shim: SparkDown is not connected in this shell" >&2
exit 1
