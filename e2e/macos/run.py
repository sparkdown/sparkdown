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
R = Report("macOS" + fixtures.variant(), sys.argv[2])
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
on textsOf(e)
  set ts to ""
  set bs to ""
  tell application "System Events"
  try
    set items_ to entire contents of e
  on error
    set items_ to {}
  end try
  repeat with x in items_
    try
      set r to role of x
      if r is "AXStaticText" or r is "AXTextArea" then
        set v to value of x
        if v is not missing value then set ts to ts & (v as text) & "¦"
      else if r is "AXButton" then
        set n to name of x
        if n is not missing value then set bs to bs & (n as text) & "¦"
      end if
    end try
  end repeat
  end tell
  return {ts, bs}
end textsOf

set AppleScript's text item delimiters to ","
-- Records end with RS (ASCII 30), not linefeed: alert text has newlines.
set RS to character id 30
set out to ""
tell application "System Events" to tell process "sparkdown"
  set i to 0
  repeat with w in (every window)
    set i to i + 1
    set wn to ""
    try
      set wn to name of w
      if wn is missing value then set wn to ""
    end try
    set sr to ""
    try
      set sr to subrole of w
      if sr is missing value then set sr to ""
    end try
    set kids to ""
    try
      set kids to (role of every UI element of w) as text
    end try
    set out to out & "#win" & tab & i & tab & wn & tab & sr & " kids=" & kids & RS
    try
      set nk to count of UI elements of w
      repeat with k from 1 to nk
        set el to UI element k of w
        if role of el is "AXSheet" then
          set ts to ""
          set bs to ""
          set items_ to entire contents of el
          repeat with x in items_
            try
              set r to role of x
              if r is "AXStaticText" or r is "AXTextArea" then
                set v to value of x
                if v is not missing value then set ts to ts & (v as text) & "¦"
              else if r is "AXButton" then
                set n to name of x
                if n is not missing value then set bs to bs & (n as text) & "¦"
              end if
            end try
          end repeat
          set out to out & "sheet" & tab & i & tab & ts & tab & bs & RS
        end if
      end repeat
    on error errMsg
      set out to out & "#err" & tab & i & tab & errMsg & RS
    end try
    if sr is not "AXStandardWindow" then
      set tb to my textsOf(w)
      set out to out & "window" & tab & i & tab & (item 1 of tb) & tab & (item 2 of tb) & RS
    end if
  end repeat
end tell
try
  tell application "System Events"
    set fp to first process whose frontmost is true
    set out to out & "#front" & tab & (name of fp) & tab & ((name of every window of fp) as text) & RS
  end tell
end try
return out
'''


def dialogs():
    out = osa(*DIALOGS.strip().split("\n"), timeout=60)
    res = []
    for line in out.split("\x1e"):
        parts = line.strip("\r\n").split("\t")
        if parts[0] in ("#win", "#front", "#err"):
            R.log("  ax window:", parts[1:])
        elif len(parts) == 4:
            res.append({"kind": parts[0], "window": int(parts[1]), "text": parts[2].replace("¦", "\n"),
                        "buttons": [b for b in parts[3].split("¦") if b]})
    return res


def click_dialog_button(d, name):
    if d["kind"] == "sheet":
        se(f'click (first button of (first UI element of window {d["window"]} whose role is "AXSheet") whose name is "{name}")')
    else:
        se(f'click (first button of window {d["window"]} whose name is "{name}")')
    time.sleep(1)
    if name == "Cancel" and dialogs():
        # Buttons nested deeper than the sheet: Escape is Cancel on an alert.
        R.log("Cancel button not clickable by name; pressing Escape")
        activate()
        osa('tell application "System Events" to key code 53')
        time.sleep(1)


def close_window(title):
    se(f'click (first button of window "{title}" whose subrole is "AXCloseButton")')


def launch(*args):
    """Start the app the way Finder / the Dock does: through LaunchServices
    (`open`), so it gets launchd's environment (minimal PATH, no shell
    profile, no Homebrew), not this harness's. If LaunchServices won't start
    it, run the binary with launchd's minimal environment instead (logged)."""
    logf = str(R.out / "app.log")
    cmd = ["open", "-a", str(APP.resolve()), "--stdout", logf, "--stderr", logf]
    if args:
        cmd += ["--args", *args]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    R.log(f"open rc={p.returncode} {p.stdout.strip()[:200]} {p.stderr.strip()[:300]}")
    how = "open (LaunchServices)"
    if not wait_for(lambda: procs() >= 1, 15):
        env = {"PATH": fixtures.LAUNCHD_PATH, "HOME": os.environ["HOME"], "USER": os.environ.get("USER", ""),
               "SHELL": os.environ.get("SHELL", "/bin/zsh"), "TMPDIR": os.environ.get("TMPDIR", "/tmp/")}
        subprocess.Popen([BIN, *args], stdout=open(logf, "a"), stderr=subprocess.STDOUT, env=env,
                         start_new_session=True)
        how = "direct exec with launchd's minimal env (open didn't start it)"
        wait_for(lambda: procs() >= 1, 15)
    pid = subprocess.run(["pgrep", "-x", "sparkdown"], capture_output=True, text=True).stdout.split()
    path = "PATH=<not visible>"
    if pid:
        env = subprocess.run(["ps", "eww", "-o", "command=", "-p", pid[0]], capture_output=True, text=True).stdout
        path = next((w for w in env.split() if w.startswith("PATH=")), path)
    R.log(f"launched via {how}: pid={pid} {path}")

def cli(path):
    subprocess.run([BIN, path], timeout=30, capture_output=True)


def main():
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="sd-e2e-"))
    F = fixtures.make_folders(tmp)
    A, B, C = F["alpha"], F["beta"], F["gamma"]
    fixtures.seed_config()
    log = open(R.out / "app.log", "w")
    launch(A)
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
        # Seeded open: hide then show so the terminal takes keyboard focus.
        se('click menu item "Toggle Terminal" of menu "View" of menu bar item "View" of menu bar 1')
        time.sleep(1.5)
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
        if fixtures.TMUX:
            fixtures.tmux_diag(R.log, label)
        before = windows()
        trigger()
        ds = wait_for(dialogs, 10)
        shot(f"{label}-prompt")
        R.log("dialogs:", ds)
        if not ds:
            # Don't leave an undetected alert up for the next checks.
            activate()
            osa('tell application "System Events" to key code 53')
            return "FAIL", "no prompt found via Accessibility (see screenshot; Escape pressed)"
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
        launch()
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
