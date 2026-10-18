"""Print the open popup menu of SparkDown as JSON via AT-SPI:
{"top": [labels], "Window": [labels of the Window submenu]}.
With `--activate LABEL`, also activate that Window-submenu item, which closes
the popup (on headless Hyprland a popup ignores Escape: nothing grabs keys)."""
import json
import sys
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)
ACTIVATE = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == "--activate" else None

try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception:  # noqa: BLE001
    print("{}")
    sys.exit(0)


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
    if d > 12:
        return
    yield n
    for c in kids(n):
        yield from walk(c, d + 1)


def item_label(n):
    return (n.get_name() or "").replace("_", "")


res, seen = {}, []
desk = Atspi.get_desktop(0)
for app in kids(desk):
    if (app.get_name() or "").lower() != "sparkdown":
        continue
    for win in kids(app):
        seen.append((win.get_name(), win.get_role_name()))
        for n in walk(win):
            if n.get_role_name() != "menu" and n.get_role_name() != "popup menu":
                continue
            items = [c for c in kids(n) if c.get_role_name() in ("menu item", "menu", "check menu item", "radio menu item")]
            labels = [item_label(c) for c in items]
            if "Window" in labels and "top" not in res:
                res["top"] = labels
                w = items[labels.index("Window")]
                sub = [c for c in walk(w) if c is not w and c.get_role_name() in ("menu item", "check menu item", "radio menu item")]
                res["Window"] = [item_label(c) for c in sub]
                if ACTIVATE:
                    hit = next((c for c in sub if item_label(c) == ACTIVATE), None)
                    act = hit.get_action_iface() if hit is not None else None
                    res["activated"] = bool(act)
                    print(json.dumps(res), flush=True)  # the action's reply may block
                    if act:
                        act.do_action(0)
                    sys.exit(0)
if not res:
    print(f"at-spi windows: {seen}", file=sys.stderr)
print(json.dumps(res))
