"""Talk to a running SparkDown through its stdio MCP shim, as an external
agent would (`sparkdown --mcp-stdio` with $SPARKDOWN_FOLDER)."""
import json
import time
import os
import subprocess


def call(exe, folder, tool, args=None, timeout=30):
    """Run one tool in the window of `folder`. Returns (ok, value): value is
    the parsed JSON text result when possible, else the raw text/error."""
    env = dict(os.environ)
    env.pop("SPARKDOWN_MCP", None)
    env.pop("SPARKDOWN_MCP_TOKEN", None)
    if folder:
        env["SPARKDOWN_FOLDER"] = folder
    else:
        env.pop("SPARKDOWN_FOLDER", None)
    msgs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "sparkdown-e2e", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": args or {}}},
    ]
    data = "".join(json.dumps(m) + "\n" for m in msgs)
    p = subprocess.run([exe, "--mcp-stdio"], input=data, capture_output=True, text=True, timeout=timeout, env=env)
    reply = None
    for line in p.stdout.splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("id") == 2:
            reply = m
    if reply is None:
        return False, f"no reply (stdout={p.stdout[-400:]!r} stderr={p.stderr[-400:]!r})"
    if "error" in reply:
        return False, reply["error"].get("message", str(reply["error"]))
    res = reply.get("result", {})
    text = "".join(c.get("text", "") for c in res.get("content", []))
    if res.get("isError"):
        return False, text
    try:
        return True, json.loads(text)
    except ValueError:
        return True, text


def context(exe, folder):
    return call(exe, folder, "sparkdown_get_context")


def norm(p):
    return os.path.normcase(os.path.realpath(p)) if p else p


def isolation_check(exe, folders, log):
    """Each folder's agent sees its own workspace root; list_windows lists
    them all. Returns (status, detail)."""
    roots = {}
    stale = []
    for name, path in folders.items():
        # A window that just opened its folder publishes its snapshot after
        # a short debounce; give it a few seconds before judging.
        end = time.time() + 15
        while True:
            ok, ctx = context(exe, path)
            log(f"mcp {name}: ok={ok} {str(ctx)[:300]}")
            good = ok and isinstance(ctx, dict) and norm(ctx.get("workspace_root")) == norm(path)
            if good or time.time() > end:
                break
            time.sleep(1.5)
        if not ok or not isinstance(ctx, dict):
            return "FAIL", f"{name}: get_context failed: {str(ctx)[:200]}"
        if ctx.get("workspace_root") is None and ctx.get("updated_at") is None:
            # Routed to a window that never published (no root, no update):
            # known gap when an empty window adopts a folder from a second
            # launch (openDroppedPaths doesn't publish). Confirm the routing
            # by opening a file there, which does publish.
            note = os.path.join(path, "notes.md")
            ok_o, r_o = call(exe, path, "sparkdown_open_file", {"path": note})
            time.sleep(3)
            ok, ctx = context(exe, path)
            log(f"mcp {name} after open_file ({ok_o} {str(r_o)[:120]}): ok={ok} {str(ctx)[:300]}")
            if ok and isinstance(ctx, dict) and norm(ctx.get("workspace_root")) == norm(path):
                stale.append(name)
        roots[name] = ctx.get("workspace_root") if isinstance(ctx, dict) else None
    bad = [n for n, r in roots.items() if norm(r) != norm(folders[n])]
    if bad:
        return "FAIL", f"wrong workspace_root for {bad}: {roots}"
    first = next(iter(folders.values()))
    ok, wins = call(exe, first, "sparkdown_list_windows")
    log(f"mcp list_windows: {str(wins)[:400]}")
    listed = json.dumps(wins)
    missing = [n for n in folders if n not in listed]
    if not ok or missing:
        return "FAIL", f"list_windows missing {missing}: {str(wins)[:200]}"
    ok2, err = call(exe, None, "sparkdown_get_context")
    named = not ok2 and all(n in str(err) for n in folders)
    base = f"each of {sorted(folders)} sees only its own root; list_windows lists all"
    if stale:
        return "PARTIAL", (base + f"; BUG: {stale} (a reused empty window) published no agent context "
                           "after `sparkdown <dir>` until a file was opened in it")
    if named:
        return "PASS", base + "; a call with no folder errors and names every window"
    return "PARTIAL", base + f"; but a call with no folder gave ok={ok2} {str(err)[:120]}"


def tab(ctx, path):
    for t in (ctx or {}).get("tabs", []):
        if norm(t.get("path")) == norm(path):
            return t
    return None
