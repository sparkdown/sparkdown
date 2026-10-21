"""Test folders and an isolated app config for one E2E run."""
import json
import os
import tempfile
import time
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


def tmux_sessions():
    """Names of the sd-* tmux sessions that exist now."""
    ls = subprocess.run([_tmux(), "ls", "-F", "#{session_name}"], capture_output=True, text=True)
    return [s for s in ls.stdout.split() if s.startswith("sd-")]


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


def tmux_server_pid():
    p = subprocess.run([_tmux(), "display-message", "-p", "#{pid}"], capture_output=True, text=True, timeout=10)
    v = p.stdout.strip()
    return int(v) if v.isdigit() else None


def stop_tmux_server():
    """Wedge the tmux server (SIGSTOP): any tmux client call hangs, the panes'
    programs keep running. Returns the pid to resume with resume()."""
    import signal
    pid = tmux_server_pid()
    if pid:
        os.kill(pid, signal.SIGSTOP)
    return pid


def resume(pid):
    import signal
    if pid:
        os.kill(pid, signal.SIGCONT)


def flap_session(name, secs=0.7):
    """Transient tmux failure: the session's name stops resolving for ~2
    polls of the app's 300 ms watchdog, then comes back. The pane and its
    job never stop."""
    tmp = name + "-flap"
    ok1, e1 = tmux_rename(name, tmp)
    time.sleep(secs)
    ok2, e2 = tmux_rename(tmp, name)
    return ok1 and ok2, f"{e1} {e2}".strip()


def tmux_attached(name):
    """Clients attached to session `name` (SparkDown's tab is one). None = unknown."""
    p = subprocess.run([_tmux(), "display-message", "-p", "-t", f"={name}:", "#{session_name} #{session_attached}"],
                       capture_output=True, text=True, timeout=10)
    got, _, n = p.stdout.strip().rpartition(" ")
    return int(n) if got == name and n.isdigit() else None


def tmux_split_idle_pane(name):
    """Split B's window: the new idle pane becomes the ACTIVE one, the
    running job stays in the other pane. Returns the new pane id."""
    p = subprocess.run([_tmux(), "split-window", "-t", f"={name}:", "-P", "-F", "#{pane_id}"],
                       capture_output=True, text=True, timeout=10)
    return p.stdout.strip() or None, p.stderr.strip()


def tmux_kill_pane(pane_id):
    subprocess.run([_tmux(), "kill-pane", "-t", pane_id], capture_output=True, timeout=10)


WRAP_PY = """import pty, os, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp('bash', ['bash', '--norc', '--noprofile', '-ic', sys.argv[1] + '; true'])
while True:
    try:
        if not os.read(fd, 4096):
            break
    except OSError:
        break
os.waitpid(pid, 0)
"""


def _ps_row(pid):
    p = subprocess.run(["ps", "-o", "pid=,pgid=,tpgid=,tty=,comm=", "-p", str(pid)], capture_output=True, text=True)
    return p.stdout.strip()


def nested_pty_job(session, log, job="sleep 301"):
    """#110: like kiro-cli-term, start a python pty wrapper (in the
    background) inside `session`'s pane: the pane's own tty stays idle, the
    inner shell's tty runs `job` in the foreground. Returns (ok, detail).
    `ok` is True only when the setup is the bug's exact shape (genuineness):
    the session keeps its name and its client, the pane tty's foreground is
    the pane shell itself, and the inner tty's foreground is sleep."""
    wrap = os.path.join(tempfile.gettempdir(), "sd-e2e-wrap.py")
    with open(wrap, "w") as f:
        f.write(WRAP_PY)
    subprocess.run([_tmux(), "send-keys", "-t", f"={session}:", f"python3 {wrap} '{job}' >/dev/null 2>&1 &", "Enter"],
                   capture_output=True, timeout=10)
    time.sleep(3)
    d = subprocess.run([_tmux(), "list-panes", "-s", "-t", f"={session}", "-F", "#{session_name} #{pane_pid} #{session_attached}"],
                       capture_output=True, text=True, timeout=10).stdout.split()
    if len(d) < 3 or d[0] != session:
        return False, f"session {session} not found as itself: {d}"
    pane = d[1]
    outer = _ps_row(pane).split()
    sl = subprocess.run(["pgrep", "-f", f"^{job}$"], capture_output=True, text=True).stdout.split()
    inner = [_ps_row(p).split() for p in sl]
    log(f"nested-pty {session}: attached={d[2]} pane={outer} inner sleep={inner}")
    if len(outer) < 4 or outer[2] != outer[0]:
        return False, f"pane tty is not idle (pane row {outer}): not the bug's shape"
    hit = [r for r in inner if len(r) >= 4 and r[2] == r[0] and r[3] != outer[3]]
    if not hit:
        return False, f"no sleep in the foreground of a nested tty: {inner}"
    return True, f"pane {pane} on {outer[3]} idle (tpgid={outer[2]}); sleep {hit[0][0]} foreground on nested {hit[0][3]}; client attached={d[2]}"


def stop_pane_job(session):
    """Ctrl-C the pane's foreground job (the plain sleep), leaving its shell."""
    subprocess.run([_tmux(), "send-keys", "-t", f"={session}:", "C-c"], capture_output=True, timeout=10)
    time.sleep(1.5)


def end_nested(session, job="sleep 301"):
    subprocess.run(["pkill", "-f", f"^{job}$"])
    subprocess.run(["pkill", "-f", "sd-e2e-wrap.py"])
    time.sleep(1)
    subprocess.run([_tmux(), "send-keys", "-t", f"={session}:", "sleep 300", "Enter"], capture_output=True, timeout=10)
    time.sleep(2)
