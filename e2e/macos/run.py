"""macOS E2E: drive the real SparkDown.app with System Events (osascript).
Usage: python3 e2e/macos/run.py /path/to/SparkDown.app OUT_DIR"""
import os
import pathlib
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lib"))
import fixtures  # noqa: E402
import mcp  # noqa: E402
from report import Report  # noqa: E402

APP = pathlib.Path(sys.argv[1])
BIN = str(APP / "Contents/MacOS/sparkdown")
R = Report("macOS", sys.argv[2])
SUF = " — SparkDown"
PROC = "sparkdown"
step_n = [0]


def osa(*lines, timeout=30):
    args = ["osascript"]
    for line in lines:
        args += ["-e", line]
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        R.log(f"osascript error: {p.stderr.strip()[:300]}")
    return p.stdout.strip()


def se(expr):
    return osa(f'tell application "System Events" to tell process "{PROC}" to {expr}')


def shot(name):
    step_n[0] += 1
    subprocess.run(["screencapture", "-x", str(R.out / f"{step_n[0]:02d}-{name}.png")], check=False)


def windows():
    out = osa(
        'set AppleScript\'s text item delimiters to linefeed',
        f'tell application "System Events" to tell process "{PROC}" to set n to name of every window',
        'return n as text')
    return [w for w in out.split("\n") if w]


def front():
    return se("name of window 1")


def procs():
    p = subprocess.run(["pgrep", "-x", "sparkdown"], capture_output=True, text=True)
    return len(p.stdout.split())


def wait_for(pred, secs=20, step=0.5):
    end = time.time() + secs
    while time.time() < end:
        v = pred()
        if v:
            return v
        time.sleep(step)
    return pred()


def titled(names):
    return {n + SUF for n in names}


def activate():
    osa(f'tell application "System Events" to set frontmost of process "{PROC}" to true')
    time.sleep(0.5)


def key(k, mods="command down"):
    activate()
    osa(f'tell application "System Events" to keystroke "{k}" using {{{mods}}}')


def window_menu_entries():
    out = osa(
        'set AppleScript\'s text item delimiters to linefeed',
        f'tell application "System Events" to tell process "{PROC}" to set n to name of every menu item of menu "Window" of menu bar item "Window" of menu bar 1',
        'return n as text')
    items = [i for i in out.split("\n") if i and i != "missing value"]
    return [i for i in items if i.endswith(SUF) or i == "SparkDown"], items


DIALOGS = r'''
set out to ""
set AppleScript's text item delimiters to "¦"
tell application "System Events" to tell process "sparkdown"
  repeat with w in (every window)
    set wn to name of w
    repeat with s in (every sheet of w)
      set t to (value of every static text of s) as text
      set b to (name of every button of s) as text
      set out to out & "sheet" & tab & wn & tab & t & tab & b & linefeed
    end repeat
    set sr to ""
    try
      set sr to subrole of w
    end try
    if sr is not "AXStandardWindow" then
      set t to (value of every static text of w) as text
      set b to (name of every button of w) as text
      set out to out & "window" & tab & wn & tab & t & tab & b & linefeed
    end if
  end repeat
end tell
return out
'''


def dialogs():
    out = osa(*DIALOGS.strip().split("\n"))
    res = []
    for line in out.split("\n"):
        parts = line.split("\t")
        if len(parts) == 4:
            res.append({"kind": parts[0], "window": parts[1], "text": parts[2], "buttons": parts[3].split("¦")})
    return res


def click_dialog_button(d, name):
    if d["kind"] == "sheet":
        se(f'click button "{name}" of sheet 1 of window "{d["window"]}"')
    else:
        se(f'click button "{name}" of window "{d["window"]}"')


def close_window(title):
    se(f'click (first button of window "{title}" whose subrole is "AXCloseButton")')


def cli(path):
    subprocess.run([BIN, path], timeout=30, capture_output=True)


def main():
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="sd-e2e-"))
    F = fixtures.make_folders(tmp)
    A, B, C = F["alpha"], F["beta"], F["gamma"]
    fixtures.seed_config()
    log = open(R.out / "app.log", "w")
    subprocess.Popen([BIN, A], stdout=log, stderr=subprocess.STDOUT)
    wait_for(lambda: titled(["alpha"]) <= set(windows()), 40)
    R.log("windows:", windows())
    shot("alpha")

    def two_windows():
        cli(B)
        w = wait_for(lambda: titled(["alpha", "beta"]) <= set(windows()) and windows(), 20)
        shot("two-windows")
        n = procs()
        if set(w) == titled(["alpha", "beta"]) and n == 1:
            return "PASS", f"windows={w}; app processes={n}"
        return "FAIL", f"windows={w}; app processes={n}"
    R.run("two-windows", two_windows)

    def one_process_focus():
        before = windows()
        cli(A)
        time.sleep(3)
        after, f, n = windows(), front(), procs()
        shot("same-folder-focus")
        ok = len(after) == len(before) and f == "alpha" + SUF and n == 1
        return ("PASS" if ok else "FAIL"), f"windows {len(before)}→{len(after)}; front={f!r}; app processes={n}"
    R.run("one-process-focus", one_process_focus)

    def window_menu():
        entries, items = window_menu_entries()
        R.log("Window menu:", items)
        ok = sorted(entries) == sorted(titled(["alpha", "beta"]))
        return ("PASS" if ok else "FAIL"), f"window entries={entries}"
    R.run("window-menu", window_menu)

    def empty_reuse():
        key("n", "command down, shift down")
        got = wait_for(lambda: "SparkDown" in windows(), 15)
        n_mid = len(windows())
        shot("empty-window")
        if not got:
            return "FAIL", f"no empty window after ⌘⇧N: {windows()}"
        cli(C)
        w = wait_for(lambda: ("gamma" + SUF) in windows() and windows(), 15)
        shot("gamma-in-empty")
        ok = set(w) == titled(["alpha", "beta", "gamma"]) and len(w) == n_mid
        entries, _ = window_menu_entries()
        menu_ok = sorted(entries) == sorted(titled(["alpha", "beta", "gamma"]))
        return ("PASS" if ok and menu_ok else "FAIL"), f"empty window → {w}; Window menu entries={entries}"
    R.run("empty-reuse", empty_reuse)

    R.run("mcp-isolation", lambda: mcp.isolation_check(BIN, {"alpha": A, "beta": B, "gamma": C}, R.log))

    def red_close():
        close_window("gamma" + SUF)
        w = wait_for(lambda: ("gamma" + SUF) not in windows() and windows(), 10)
        entries, _ = window_menu_entries()
        shot("red-close")
        ok = set(w) == titled(["alpha", "beta"]) and sorted(entries) == sorted(titled(["alpha", "beta"]))
        return ("PASS" if ok else "FAIL"), f"after red close of gamma: windows={w}; Window menu={entries}"
    R.run("red-close", red_close)

    def dock_reopen():
        close_window("beta" + SUF)
        time.sleep(1.5)
        close_window("alpha" + SUF)
        none = wait_for(lambda: not windows(), 10)
        shot("no-windows")
        if procs() != 1:
            return "FAIL", "app quit when its last window closed (macOS should stay in the dock)"
        osa('tell application "System Events" to tell process "Dock" to click UI element "SparkDown" of list 1')
        w = wait_for(windows, 15)
        shot("dock-reopen")
        ok = bool(w) and bool(none)
        # Put both folders back for the next checks.
        cli(A)
        cli(B)
        wait_for(lambda: titled(["alpha", "beta"]) <= set(windows()), 15)
        return ("PASS" if ok else "FAIL"), f"all windows closed, app still running={bool(none)}; after dock click: {w}"
    R.run("dock-reopen", dock_reopen)

    note = A + "/notes.md"
    edit = "# alpha\n\nE2E unsaved edit.\n"

    def setup_quit():
        cli(B)
        time.sleep(1)
        activate()
        se('click menu item "Toggle Terminal" of menu "View" of menu bar item "View" of menu bar 1')
        time.sleep(4)
        osa('tell application "System Events" to keystroke "sleep 300"', 'tell application "System Events" to key code 36')
        time.sleep(2)
        ok1, r1 = mcp.call(BIN, A, "sparkdown_open_file", {"path": note})
        time.sleep(2)
        ok2, r2 = mcp.call(BIN, A, "sparkdown_edit_buffer", {"path": note, "content": edit})
        time.sleep(2)
        R.log("open/edit via MCP:", ok1, r1, ok2, r2)
        busy = subprocess.run(["pgrep", "-x", "sleep"], capture_output=True, text=True).stdout.split()
        R.log("sleep pids:", busy)
        return bool(busy) and ok2

    def quit_check(trigger, label):
        before = windows()
        trigger()
        ds = wait_for(dialogs, 10)
        shot(f"{label}-prompt")
        R.log("dialogs:", ds)
        if not ds:
            return "FAIL", "no prompt appeared"
        if len(ds) != 1:
            for d in ds:
                if "Cancel" in d["buttons"]:
                    click_dialog_button(d, "Cancel")
            return "FAIL", f"{len(ds)} prompts: {ds}"
        d = ds[0]
        text = d["text"]
        want = ["still running", "sleep", "beta", "Unsaved changes", "alpha"]
        missing = [w for w in want if w not in text]
        click_dialog_button(d, "Cancel")
        time.sleep(2)
        after = windows()
        ok, ctx = mcp.context(BIN, A)
        t = mcp.tab(ctx, note) if ok else None
        okb, buf = mcp.call(BIN, A, "sparkdown_read_buffer", {"path": note})
        kept = bool(t and t.get("dirty")) and "E2E unsaved edit" in str(buf)
        alive = procs() == 1 and bool(subprocess.run(["pgrep", "-x", "sleep"], capture_output=True).stdout)
        shot(f"{label}-after-cancel")
        good = not missing and set(after) == set(before) and kept and alive and not dialogs()
        detail = (f"1 prompt ({d['kind']}): {text[:220]!r}; buttons={d['buttons']}; missing={missing}; "
                  f"after Cancel windows={after}, A dirty+edit kept={kept}, app+sleep alive={alive}")
        return ("PASS" if good else "FAIL"), detail

    ready = setup_quit()
    R.run("quit-prompt", lambda: quit_check(lambda: key("q"), "cmdq") if ready else ("FAIL", "could not start `sleep` in B or edit A"))

    def menu_quit():
        activate()
        se('click menu item "Quit SparkDown" of menu 1 of menu bar item "SparkDown" of menu bar 1')
    R.run("quit-prompt-menu", lambda: quit_check(menu_quit, "menuquit") if ready else ("FAIL", "setup failed"))

    def restore():
        subprocess.run(["pkill", "-x", "sleep"])
        cli(A)
        time.sleep(1)
        key("s")
        time.sleep(2)
        saved = "E2E unsaved edit" in pathlib.Path(note).read_text()
        before = windows()
        key("q")
        gone = wait_for(lambda: procs() == 0, 25)
        shot("after-quit")
        if not gone:
            ds = dialogs()
            return "FAIL", f"app did not exit on a clean ⌘Q (saved={saved}); dialogs={ds}"
        subprocess.Popen([BIN], stdout=log, stderr=subprocess.STDOUT)
        w = wait_for(lambda: titled(["alpha", "beta"]) <= set(windows()) and windows(), 40)
        time.sleep(2)
        w = windows()
        shot("restored")
        ok = set(w) == titled(["alpha", "beta"]) and saved
        return ("PASS" if ok else "FAIL"), f"saved A={saved}; before quit={before}; after relaunch={w} (gamma was closed, must stay closed)"
    R.run("restore", restore)

    R.manual("manual-gatekeeper", "Gatekeeper first launch of the signed, notarized build", "CI builds are unsigned; see e2e/README.md")
    R.manual("manual-spaces", "Spaces / Mission Control / gestures / notifications", "not automatable on hosted runners")
    subprocess.run(["pkill", "-x", "sparkdown"])
    return R.write()


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
