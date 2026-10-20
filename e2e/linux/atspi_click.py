"""Press a control inside a SparkDown window over AT-SPI (no pointer needed,
works on Wayland). Usage: atspi_click.py WINDOW_TITLE ACCESSIBLE_NAME
Prints JSON {"ok": bool, "how": str}."""
import json
import sys
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)

try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception as e:  # noqa: BLE001
    print(json.dumps({"ok": False, "how": f"no AT-SPI: {e}"}))
    sys.exit(0)

TITLE, NAME = sys.argv[1], sys.argv[2]
ALIASES = {NAME.lower(), "menu"}  # aria-label, then the title attribute


def kids(n):
    out = []
    for i in range(n.get_child_count()):
        try:
            c = n.get_child_at_index(i)
            if c is not None:
                out.append(c)
        except Exception:  # noqa: BLE001
            pass
    return out


def walk(n, d=0):
    if d > 30:
        return
    yield n
    for c in kids(n):
        yield from walk(c, d + 1)


seen, named = [], []
for app in kids(Atspi.get_desktop(0)):
    if (app.get_name() or "").lower() != "sparkdown":
        continue
    for win in kids(app):
        seen.append(win.get_name())
        if win.get_name() != TITLE:
            continue
        for n in walk(win):
            try:
                nm = (n.get_name() or "").strip()
                if nm and len(named) < 40:
                    named.append(f"{n.get_role_name()}:{nm[:30]}")
                role = n.get_role_name()
                if nm.lower() not in ALIASES or not ("button" in role or role == "combo box"):
                    continue
                act = n.get_action_iface()
                if act is None or act.get_n_actions() < 1:
                    continue
                names = [act.get_action_name(i) for i in range(act.get_n_actions())]
                i = next((k for k, a in enumerate(names) if a in ("press", "click", "activate")), 0)
                # Report first: the action's D-Bus reply can block while the
                # app's popup menu is up, so the caller doesn't wait for us.
                print(json.dumps({"ok": True, "how": f"{role} {nm!r} action {names[i]!r}"}), flush=True)
                act.do_action(i)
                sys.exit(0)
            except Exception:  # noqa: BLE001
                continue
print(json.dumps({"ok": False, "how": f"no {NAME!r} button in {TITLE!r}; windows over AT-SPI: {seen}; named nodes: {named}"}))
