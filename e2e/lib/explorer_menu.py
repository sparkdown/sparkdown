"""0.4.1: the explorer's contextual right-click menu and inline New File /
New Folder, plus "no webview Reload/Inspect menu outside text fields".

Over WebDriver: a synthetic right-click opens SparkDown's own menu (its
labels are read back), New Folder on the root and New File inside that
folder take a typed name, and the disk is the oracle. A contextmenu event
on plain UI must be default-prevented (the native webview menu never
shows); one on the editor must not (it keeps Cut / Copy / Paste)."""
import os
import time

RCLICK = """
const el = arguments[0] ? [...document.querySelectorAll('.tree-item[data-path]')].find(e => e.dataset.path === arguments[0]) : null;
if (arguments[0] && !el) return null;
const t = el || document.querySelector('#file-tree .tree-spacer');
if (!t) return null;
const r = t.getBoundingClientRect();
const e = new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5});
t.dispatchEvent(e);
return Array.from(document.querySelectorAll('.sd-ctxmenu .sd-ctxmenu-item')).map(i => i.textContent);
"""

PICK = """
const it = Array.from(document.querySelectorAll('.sd-ctxmenu .sd-ctxmenu-item')).find(i => i.textContent === arguments[0]);
if (!it) return 0;
it.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
return 1;
"""

TYPE = """
const i = document.querySelector('.tree-new-input');
if (!i) return 0;
i.value = arguments[0];
i.dispatchEvent(new Event('input', {bubbles: true}));
i.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
return 1;
"""

NATIVE = """
const t = document.querySelector(arguments[0]);
if (!t) return null;
const e = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});
t.dispatchEvent(e);
document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
return e.defaultPrevented;
"""


def run(R, D, title, folder):
    if not hasattr(D, "_wd_handle") or not D._wd_handle(title):
        return "MANUAL", "WebDriver can't reach the window here"
    w = D.wd
    steps, ok = [], True

    def wait(pred, secs=15):
        end = time.time() + secs
        while time.time() < end:
            if pred():
                return True
            time.sleep(0.3)
        return pred()

    empty = w.js(RCLICK, None) or []
    w.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return 1;")
    steps.append(f"empty-space menu={empty}")
    ok &= empty == ["New File", "New Folder"]

    # New Folder at the root.
    w.js(RCLICK, None)
    w.js(PICK, "New Folder")
    wait(lambda: w.js("return !!document.querySelector('.tree-new-input')"), 5)
    w.js(TYPE, "e2e-made")
    made = os.path.join(folder, "e2e-made")
    okd = wait(lambda: os.path.isdir(made))
    steps.append(f"New Folder made dir={okd}")
    ok &= okd

    # Folder row: full contextual menu, then New File inside it.
    wait(lambda: w.js("return [...document.querySelectorAll('.tree-item[data-path]')].some(e => e.dataset.path === arguments[0])", made), 10)
    items = w.js(RCLICK, made) or []
    steps.append(f"folder menu={items}")
    ok &= items[:3] == ["New File", "New Folder", "Delete…"] and items[-1] == "Copy Path" \
        and any(i.startswith("Reveal in ") for i in items) and "Reload" not in items
    w.js(PICK, "New File")
    wait(lambda: w.js("return !!document.querySelector('.tree-new-input')"), 5)
    w.js(TYPE, "inside.md")
    newf = os.path.join(made, "inside.md")
    okf = wait(lambda: os.path.isfile(newf))
    opened = wait(lambda: "inside.md" in (w.js("return document.getElementById('tab-bar')?.innerText || ''") or ""), 10)
    steps.append(f"New File inside folder={okf} opened in a tab={opened}")
    ok &= okf and opened
    D.shot("explorer-new-file")
    # Close the new (clean, empty) tab so notes.md is active again: later
    # checks save "the active tab" and expect notes.md.
    if opened:
        w.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'w',code:'KeyW',ctrlKey:true,bubbles:true,cancelable:true})); return 1;")
        time.sleep(0.5)

    blocked = w.js(NATIVE, "#sidebar")
    kept = w.js(NATIVE, ".cm-content")
    steps.append(f"webview menu blocked on sidebar={blocked} kept in editor={kept is False}")
    ok &= blocked is True and kept is False
    return ("PASS" if ok else "FAIL"), "; ".join(steps)
