"""Test folders and an isolated app config for one E2E run."""
import json
import os
import pathlib
import subprocess
import sys


def make_folders(root):
    """alpha, beta, gamma: small git repos with a notes.md each."""
    root = pathlib.Path(root)
    out = {}
    for name in ("alpha", "beta", "gamma"):
        d = root / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "notes.md").write_text(f"# {name}\n\nE2E fixture.\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q", str(d)], check=False)
        out[name] = str(d.resolve())
    return out


def config_dir(home=None):
    """The app's config dir (Tauri app_config_dir for com.sparkdown.editor)."""
    ident = "com.sparkdown.editor"
    if sys.platform == "darwin":
        return pathlib.Path(home or os.path.expanduser("~")) / "Library/Application Support" / ident
    if sys.platform == "win32":
        return pathlib.Path(os.environ["APPDATA"]) / ident
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home or os.path.expanduser("~"), ".config")
    return pathlib.Path(base) / ident


TMUX = os.environ.get("E2E_TMUX", "off") == "on"
# A launchd/Finder-like PATH: what an app opened from the Dock or Finder gets
# (no Homebrew, no shell profile). Linux desktop launchers are similar.
LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"


def variant():
    """Suffix for the report name: each OS runs with tmux off and on."""
    return " · tmux on" if TMUX else " · tmux off"


def app_env():
    """Environment for launching the app the way Finder / a desktop launcher
    does: a minimal PATH, so tool lookups can't lean on the harness's PATH."""
    env = dict(os.environ)
    env["PATH"] = LAUNCHD_PATH
    for k in ("TMUX", "TMUX_PANE"):
        env.pop(k, None)
    return env


def seed_config(**prefs):
    """Start from a clean config with the given preferences (external agents
    on so the harness can query each window's MCP tools; tmux from
    $E2E_TMUX, default off). Defaults in Settings have tmux on."""
    d = config_dir()
    d.mkdir(parents=True, exist_ok=True)
    cfg = {"mcp_external_agents": True, "agent_context_enabled": True, "use_tmux": TMUX,
           # Agent tools only see a window once its terminal has been shown
           # (privacy gate in agent-context.ts), so every window opens with it.
           "terminal_visible": True}
    cfg.update(prefs)
    (d / "config.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return d / "config.json"


def read_config():
    p = config_dir() / "config.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def tmux_diag(log, tag):
    """What the app's tmux busy probe sees, logged for the quit checks."""
    tmux = next((t for t in ("/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux") if os.path.exists(t)), "tmux")
    ls = subprocess.run([tmux, "ls", "-F", "#{session_name} pane_pid=#{pane_pid} tty=#{pane_tty}"],
                        capture_output=True, text=True)
    log(f"[{tag}] tmux ls rc={ls.returncode}: {ls.stdout.strip()} {ls.stderr.strip()[:200]}")
    v = subprocess.run([tmux, "-V"], capture_output=True, text=True)
    log(f"[{tag}] {v.stdout.strip()}")
    for line in ls.stdout.splitlines():
        parts = dict(x.split("=", 1) for x in line.split()[1:] if "=" in x)
        pid = parts.get("pane_pid")
        if pid:
            ps = subprocess.run(["ps", "-o", "pid=,pgid=,tpgid=,tty=,comm=", "-p", pid], capture_output=True, text=True)
            log(f"[{tag}]   ps -o pid,pgid,tpgid,tty,comm -p {pid}: {ps.stdout.strip()!r} rc={ps.returncode} {ps.stderr.strip()[:200]}")
        tty = parts.get("tty")
        if tty:
            ps = subprocess.run(["ps", "-o", "pid=,pgid=,tpgid=,comm=", "-t", tty.replace("/dev/", "")], capture_output=True, text=True)
            log(f"[{tag}]   ps -t {tty}: {ps.stdout.strip()!r}")


def _tmux():
    return next((t for t in ("/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux") if os.path.exists(t)), "tmux")


def tmux_busy_session():
    """Name of the sd-* tmux session whose pane runs a foreground job."""
    ls = subprocess.run([_tmux(), "ls", "-F", "#{session_name} #{pane_pid}"], capture_output=True, text=True)
    for line in ls.stdout.splitlines():
        name, _, pid = line.partition(" ")
        if not name.startswith("sd-") or not pid.isdigit():
            continue
        ps = subprocess.run(["ps", "-o", "pgid=,tpgid=", "-p", pid], capture_output=True, text=True).stdout.split()
        if len(ps) == 2 and ps[0] != ps[1] and int(ps[1]) > 0:
            return name
    return None


def tmux_rename(old, new):
    p = subprocess.run([_tmux(), "rename-session", "-t", f"={old}", new], capture_output=True, text=True)
    d = subprocess.run([_tmux(), "display-message", "-p", "-t", f"={old}:", "#{session_name} #{pane_pid}"],
                       capture_output=True, text=True)
    print(f"display-message for the old name now: rc={d.returncode} out={d.stdout.strip()!r} err={d.stderr.strip()!r}", flush=True)
    return p.returncode == 0, p.stderr.strip()
