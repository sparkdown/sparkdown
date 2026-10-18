"""Press a control inside a SparkDown window over AT-SPI (no pointer needed,
works on Wayland). Usage: atspi_click.py WINDOW_TITLE ACCESSIBLE_NAME
Prints JSON {"ok": bool, "how": str}."""
import json
import sys

try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception as e:  # noqa: BLE001
    print(json.dumps({"ok": False, "how": f"no AT-SPI: {e}"}))
    sys.exit(0)

TITLE, NAME = sys.argv[1], sys.argv[2]


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


seen = []
for app in kids(Atspi.get_desktop(0)):
    if (app.get_name() or "").lower() != "sparkdown":
        continue
    for win in kids(app):
        seen.append(win.get_name())
        if win.get_name() != TITLE:
            continue
        for n in walk(win):
            try:
                if (n.get_name() or "") != NAME or "button" not in n.get_role_name():
                    continue
                act = n.get_action_iface()
                if act is None or act.get_n_actions() < 1:
                    continue
                names = [act.get_action_name(i) for i in range(act.get_n_actions())]
                i = next((k for k, a in enumerate(names) if a in ("press", "click", "activate")), 0)
                act.do_action(i)
                print(json.dumps({"ok": True, "how": f"{n.get_role_name()} {NAME!r} action {names[i]!r}"}))
                sys.exit(0)
            except Exception:  # noqa: BLE001
                continue
print(json.dumps({"ok": False, "how": f"no {NAME!r} button in {TITLE!r}; windows over AT-SPI: {seen}"}))
