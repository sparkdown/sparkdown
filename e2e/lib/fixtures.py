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


def seed_config(**prefs):
    """Start from a clean config with the given preferences (external agents
    on so the harness can query each window's MCP tools; tmux off, as the
    checklist's quit step asks)."""
    d = config_dir()
    d.mkdir(parents=True, exist_ok=True)
    cfg = {"mcp_external_agents": True, "use_tmux": False}
    cfg.update(prefs)
    (d / "config.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return d / "config.json"


def read_config():
    p = config_dir() / "config.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
