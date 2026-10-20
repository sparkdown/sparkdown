"""Print SparkDown's open dialogs as JSON via AT-SPI (GTK accessibility):
[{"name": title, "text": all label text, "buttons": [...]}]. With
`--press NAME`, also activate that button in each dialog.

Used by the Ubuntu job so the quit prompt's wording can be read instead of
only seen in a screenshot. Prints [] when the accessibility bus is absent."""
import json
import sys

try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception:  # noqa: BLE001
    print("[]")
    sys.exit(0)

TITLES = ("Quit SparkDown", "Unsaved Changes")
press = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == "--press" else None


def walk(node, depth=0):
    if node is None or depth > 25:
        return
    yield node
    for i in range(node.get_child_count()):
        try:
            yield from walk(node.get_child_at_index(i), depth + 1)
        except Exception:  # noqa: BLE001
            continue


out = []
desk = Atspi.get_desktop(0)
seen = []
for a in range(desk.get_child_count()):
    app = desk.get_child_at_index(a)
    try:
        seen.append((app.get_name(), [(app.get_child_at_index(j).get_name(), app.get_child_at_index(j).get_role_name())
                                      for j in range(app.get_child_count())]))
    except Exception:  # noqa: BLE001
        pass
    if app is None or (app.get_name() or "").lower() != "sparkdown":
        continue
    for w in range(app.get_child_count()):
        win = app.get_child_at_index(w)
        if win is None:
            continue
        name = win.get_name() or ""
        role = win.get_role_name()
        if name not in TITLES and role not in ("dialog", "alert"):
            continue
        texts, buttons = [], []
        for n in walk(win):
            r = n.get_role_name()
            if r in ("label", "static", "text"):
                t = n.get_name() or ""
                if not t:
                    try:
                        ti = n.get_text_iface()
                        t = ti.get_text(0, ti.get_character_count()) if ti else ""
                    except Exception:  # noqa: BLE001
                        t = ""
                if t:
                    texts.append(t)
            elif r == "push button":
                b = n.get_name() or ""
                buttons.append(b)
                if press and b.replace("_", "") == press:
                    try:
                        n.get_action_iface().do_action(0)
                    except Exception:  # noqa: BLE001
                        pass
        out.append({"name": name, "role": role, "text": "\n".join(texts), "buttons": buttons})
if not out:
    print(f"at-spi apps: {seen}", file=sys.stderr)
print(json.dumps(out))
