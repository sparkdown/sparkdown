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


def finder_env():
    """The environment a Finder/Dock launch gets on a real Mac: launchd's
    per-user env. Hosted runners' launchd domain carries the runner's full
    PATH (`open` showed /opt/homebrew/bin etc.), so `open` alone does NOT
    reproduce Finder there; build launchd's env explicitly (no LANG, minimal
    PATH, zsh as the login shell like a default Mac account)."""
    return {"PATH": fixtures.LAUNCHD_PATH, "HOME": os.environ["HOME"], "USER": os.environ.get("USER", ""),
            "LOGNAME": os.environ.get("USER", ""), "SHELL": "/bin/zsh",
            "TMPDIR": os.environ.get("TMPDIR", "/tmp/"), "__CF_USER_TEXT_ENCODING": "0x1F5:0x0:0x0"}


def launch(*args):
    """Start the app with Finder's environment (see finder_env)."""
    logf = str(R.out / "app.log")
    env = finder_env()
    lp = subprocess.run(["/bin/zsh", "-lc", 'printf %s "$PATH"'], env=env, capture_output=True, text=True, timeout=20)
    R.log(f"login shell (zsh -lc) PATH under Finder env: {lp.stdout!r} rc={lp.returncode}")
    subprocess.Popen([os.path.abspath(str(BIN)), *args], stdout=open(logf, "a"), stderr=subprocess.STDOUT,
                     env=env, start_new_session=True, cwd="/")
    wait_for(lambda: procs() >= 1, 20)
    pid = subprocess.run(["pgrep", "-x", "sparkdown"], capture_output=True, text=True).stdout.split()
    path = "PATH=<not visible>"
    if pid:
        e = subprocess.run(["ps", "eww", "-o", "command=", "-p", pid[0]], capture_output=True, text=True).stdout
        path = next((w for w in e.split() if w.startswith("PATH=")), path)
    R.log(f"launched with Finder env: pid={pid} {path}")

def ax_texts(title):
    """The accessibility text of window `title` (WKWebView maps the DOM to
    AX, so this is what B's webview renders: #sidebar-title, tabs, editor)."""
    out = osa(
        'set AppleScript\'s text item delimiters to linefeed',
        f'tell application "System Events" to tell process "{PROC}"',
        f'set es to entire contents of window "{title}"',
        'set acc to {}',
        'repeat with e in es',
        'try',
        'set v to value of e',
        'if v is not missing value and class of v is text then set end of acc to v',
        'end try',
        'try',
        'set n to name of e',
        'if n is not missing value and n is not "" then set end of acc to n',
        'end try',
        'end repeat',
        'end tell',
        'return acc as text', timeout=90)
    return [l.strip() for l in out.split("\n") if l.strip()]


def webview_root(title, folder):
    """(frontend workspace_root via the folder's MCP route, AX root guess)."""
    ok, ctx = mcp.context(BIN, folder)
    root = ctx.get("workspace_root") if ok and isinstance(ctx, dict) else f"ERR {str(ctx)[:120]}"
    texts = ax_texts(title)
    return root, texts


def cli_forward_check(tag, A, B, outside=True):
    """`sparkdown <A>` from another app with A and B open: one process, A
    focused, and B's webview still shows B (frontend root + AX text)."""
    if outside:
        osa('tell application "Finder" to activate')
        time.sleep(1)
    before = windows()
    cli(A)
    time.sleep(4)
    after, f, n = windows(), front(), procs()
    rb, tb = webview_root("beta" + SUF, B)
    ra, ta = webview_root("alpha" + SUF, A)
    shot(f"cli-forward-{tag}")
    R.log(f"cli-forward {tag}: windows {before}->{after} front={f!r} procs={n}")
    R.log(f"cli-forward {tag}: B root={rb!r} B ax={tb[:40]}")
    R.log(f"cli-forward {tag}: A root={ra!r} A ax={ta[:40]}")
    b_ax_alpha = any(t.lower() in ("alpha", "# alpha") for t in tb)
    b_ax_beta = any(t.lower() in ("beta", "# beta") for t in tb)
    bad = []
    if n != 1: bad.append(f"{n} app processes")
    if set(after) != set(before): bad.append(f"windows {before}->{after}")
    if f != "alpha" + SUF: bad.append(f"focused {f!r}, not alpha")
    if mcp.norm(rb) != mcp.norm(B): bad.append(f"B's webview root is {rb!r}, not beta")
    if mcp.norm(ra) != mcp.norm(A): bad.append(f"A's webview root is {ra!r}")
    if b_ax_alpha and not b_ax_beta: bad.append("B's window renders alpha (AX), not beta")
    if bad:
        return "FAIL", "; ".join(bad)
    return "PASS", f"1 process, alpha focused, B's webview root={rb} (AX beta={b_ax_beta} alpha={b_ax_alpha})"


def webcontent_reload():
    """Make macOS end the WebKit web-content processes (as memory pressure
    or a crash does); Tauri then reloads each webview, which re-runs the
    frontend's startup (get_pending_files, session restore)."""
    pids = subprocess.run(["pgrep", "-f", "com.apple.WebKit.WebContent"], capture_output=True, text=True).stdout.split()
    # The newest one is B's (B's window opened after A's); A keeps its
    # unsaved edit.
    pids = sorted(pids, key=int)[-1:]
    R.log(f"killing B's WebContent process {pids}")
    for pid in pids:
        subprocess.run(["kill", "-9", pid])
    time.sleep(8)
    return pids


def reload_keeps_jobs(A, B, note, edit, quit_check, phys_cmd_q):
    pids = subprocess.run(["pgrep", "-f", "com.apple.WebKit.WebContent"], capture_output=True, text=True).stdout.split()
    R.log(f"reload-keeps-jobs: killing every WebContent process {pids}")
    for pid in pids:
        subprocess.run(["kill", "-9", pid])
    time.sleep(10)
    # A's unsaved edit lived in its webview; put it back so the prompt is
    # the combined one.
    ok, r = mcp.call(BIN, A, "sparkdown_open_file", {"path": note})
    time.sleep(2)
    ok2, r2 = mcp.call(BIN, A, "sparkdown_edit_buffer", {"path": note, "content": edit + " (reloaded)"})
    time.sleep(2)
    R.log(f"reload-keeps-jobs: windows={windows()} reopen={ok} edit={ok2} {str(r2)[:120]}")
    if fixtures.TMUX:
        fixtures.tmux_diag(R.log, "reloaded")
    return quit_check(phys_cmd_q, "reloaded", ["still running", "sleep", "beta", "Python", "alpha"])


def cli(path):
    subprocess.run([BIN, path], timeout=30, capture_output=True)


def main():
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="sd-e2e-"))
    F = fixtures.make_folders(tmp)
    A, B, C = F["alpha"], F["beta"], F["gamma"]
    fixtures.seed_config()
    log = open(R.out / "app.log", "w")
    if fixtures.TMUX:
        # A real Mac user who has tmux usually already has their own server
        # running (started from Terminal, full env, their ~/.tmux.conf), so
        # SparkDown's sessions are created on THAT server, not a fresh one.
        conf = pathlib.Path.home() / ".tmux.conf"
        conf.write_text("set -g base-index 1\nsetw -g pane-base-index 1\nset -g mouse on\n"
                        "set -g default-terminal tmux-256color\nset -g detach-on-destroy off\n")
        t = subprocess.run(["tmux", "new-session", "-d", "-s", "user", "-x", "120", "-y", "40"],
                           capture_output=True, text=True)
        R.log(f"pre-existing user tmux server: rc={t.returncode} {t.stderr.strip()}")
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
    R.run("cli-forward-keeps-b", lambda: cli_forward_check("live", A, B))

    def open_with_keeps_b():
        """`open -a SparkDown <A>` (what a shell alias or Finder "Open With"
        does): an Apple Event to the running app. B must stay on B, and the
        path must not linger in the startup queue for the next window."""
        osa('tell application "Finder" to activate')
        time.sleep(1)
        p = subprocess.run(["open", "-a", str(APP.resolve()), A], capture_output=True, text=True, timeout=30)
        time.sleep(4)
        rb, tb = webview_root("beta" + SUF, B)
        f, w = front(), windows()
        R.log(f"open-with: rc={p.returncode} {p.stderr.strip()[:200]} front={f!r} windows={w} B root={rb!r} B ax={tb[:30]}")
        bad = []
        if mcp.norm(rb) != mcp.norm(B): bad.append(f"B's webview root is {rb!r}")
        if f != "alpha" + SUF: bad.append(f"focused {f!r}")
        # A new empty window must start empty, not with A from a stale queue.
        key("n", "command down, shift down")
        got = wait_for(lambda: "SparkDown" in windows(), 15)
        time.sleep(4)
        w2 = windows()
        R.log(f"open-with: after ⌘⇧N windows={w2}")
        if not got:
            ex = [t for t in w2 if t not in w]
            bad.append(f"the new window is not empty: new titles {ex}")
        else:
            ax = ax_texts("SparkDown")
            R.log(f"open-with: empty window ax={ax[:30]}")
            if any(t.lower() == "alpha" for t in ax):
                bad.append("the new empty window rendered alpha (stale startup queue)")
        if "SparkDown" in windows():
            osa(f'tell application "System Events" to tell process "{PROC}" to click (first button of window "SparkDown" whose subrole is "AXCloseButton")')
            time.sleep(2)
        return ("FAIL", "; ".join(bad)) if bad else ("PASS", f"B still beta, alpha focused, a new window starts empty ({w2})")
    R.run("open-with-keeps-b", open_with_keeps_b)

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

    def quit_check(trigger, label, want=None, dlg_wait=10):
        if fixtures.TMUX and label != "wedged":
            fixtures.tmux_diag(R.log, label)
        before = windows()
        trigger()
        ds = wait_for(dialogs, dlg_wait)
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
        want = want or ["still running", "sleep", "beta", "Unsaved changes", "alpha"]
        norm = text.replace('\u2019', "'").lower()
        missing = [w for w in want if w.lower() not in norm]
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

    # Paulo's case: A focused, B (with the running job) still open but fully
    # hidden behind A, left alone long enough for App Nap / occlusion / timer
    # throttling to kick in, then quit from A. Variant: B minimized.
    BG_WAIT = int(os.environ.get("E2E_BG_WAIT", "45"))
    wa, wb = "alpha" + SUF, "beta" + SUF

    def hide_b_behind_a(minimize=False):
        se(f'set value of attribute "AXMinimized" of window "{wb}" to false')
        time.sleep(1)
        if minimize:
            se(f'set value of attribute "AXMinimized" of window "{wb}" to true')
        else:
            se(f'set position of window "{wb}" to {{100, 100}}')
            se(f'set size of window "{wb}" to {{600, 400}}')
            se(f'set position of window "{wa}" to {{40, 40}}')
            se(f'set size of window "{wa}" to {{900, 650}}')
        se(f'perform action "AXRaise" of window "{wa}"')
        activate()
        R.log(f"B {'minimized' if minimize else 'occluded behind A'}; front={front()!r}; waiting {BG_WAIT}s")
        shot("b-hidden")
        time.sleep(BG_WAIT)
        R.log(f"after wait front={front()!r}")

    def bg_check(trigger, label, minimize=False):
        hide_b_behind_a(minimize)
        def raw():
            osa(f'tell application "System Events" to keystroke "q" using {{command down}}') if trigger == "cmdq" else \
                se('click menu item "Quit SparkDown" of menu 1 of menu bar item "SparkDown" of menu bar 1')
        res = quit_check(raw, label)
        se(f'set value of attribute "AXMinimized" of window "{wb}" to false')
        return res
    R.run("quit-prompt-bg-occluded", lambda: bg_check("cmdq", "bgocc") if ready else ("FAIL", "setup failed"))
    R.run("quit-prompt-bg-occluded-menu", lambda: bg_check("menu", "bgoccmenu") if ready else ("FAIL", "setup failed"))
    R.run("quit-prompt-bg-minimized", lambda: bg_check("cmdq", "bgmin", True) if ready else ("FAIL", "setup failed"))

    def wedged_check():
        """The job check can't finish: the tmux server is wedged (SIGSTOP),
        so every tmux call hangs while B's job keeps running. The quit must
        still prompt and say it couldn't check, not skip the prompt or hang."""
        WANT = ["couldn't check", "Unsaved changes", "alpha"]
        pid = fixtures.stop_tmux_server()
        R.log(f"tmux server {pid} stopped (SIGSTOP)")
        if not pid:
            return "FAIL", "tmux server pid not found"
        try:
            return quit_check(lambda: key("q"), "wedged", WANT, 30)
        finally:
            fixtures.resume(pid)
            R.log(f"tmux server {pid} resumed (SIGCONT)")
    if fixtures.TMUX:
        R.run("quit-prompt-probe-timeout", lambda: wedged_check() if ready else ("FAIL", "setup failed"))

    def flap_check():
        """B's tmux session vanishes for ~0.7 s (a transient tmux failure)
        while `sleep` runs in it, then is back. B's tab must survive, and the
        quit prompt must still list the sleep."""
        name = fixtures.tmux_busy_session()
        if not name:
            return "FAIL", "no tmux session with a running job found"
        ok, err = fixtures.flap_session(name)
        R.log(f"flapped {name} for 0.7 s: {ok} {err}")
        time.sleep(3)
        att = fixtures.tmux_attached(name)
        R.log(f"right before quit: {name} attached clients={att}")
        if not att:
            return "FAIL", f"B's tab is gone before ⌘Q: session {name} has no attached SparkDown client ({att})"
        return quit_check(lambda: key("q"), "flap")
    def split_check():
        """B's tmux window split by the user: the new idle pane is active,
        `sleep` runs in the other pane. The quit prompt must still list it."""
        name = fixtures.tmux_busy_session()
        if not name:
            return "FAIL", "no tmux session with a running job found"
        pane, err = fixtures.tmux_split_idle_pane(name)
        R.log(f"split {name}: new active pane {pane} {err}; attached={fixtures.tmux_attached(name)}")
        if not pane:
            return "FAIL", f"split-window failed: {err}"
        try:
            return quit_check(lambda: key("q"), "split")
        finally:
            fixtures.tmux_kill_pane(pane)
    if fixtures.TMUX:
        R.run("tmux-split-pane", (lambda: split_check() if ready else ("FAIL", "setup failed")))
        R.run("tmux-transient-failure", (lambda: flap_check() if ready else ("FAIL", "setup failed")))

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

    # 0.4.0 must-pass step 3, as on Paulo's Mac: pre-existing tmux server
    # (tmux on), B's terminal split into two SparkDown panes with `sleep` in
    # the new one, a long-lived "agent" process in A's terminal, A unsaved,
    # A focused, a PHYSICAL ⌘Q (key code 12). Then a real Quit: with tmux on
    # the sleep must survive it (no job killed).
    def toggle_terminal():
        se('click menu item "Toggle Terminal" of menu "View" of menu bar item "View" of menu bar 1')

    def type_line(text):
        osa(f'tell application "System Events" to keystroke "{text}"', 'tell application "System Events" to key code 36')

    def phys_cmd_q():
        osa('tell application "System Events" to key code 12 using {command down}')

    def must_pass_3():
        subprocess.run(["pkill", "-x", "sleep"])
        if procs() == 0:
            launch(A)
            wait_for(lambda: titled(["alpha"]) <= set(windows()), 30)
        cli(B)
        time.sleep(2)
        activate()
        toggle_terminal(); time.sleep(1.5); toggle_terminal(); time.sleep(4)
        osa('tell application "System Events" to keystroke "d" using {command down}')  # split right
        time.sleep(4)
        type_line("sleep 300")
        time.sleep(1)
        cli(A)
        time.sleep(2)
        activate()
        toggle_terminal(); time.sleep(1.5); toggle_terminal(); time.sleep(4)
        type_line("python3 -c 'import time; time.sleep(900)'")
        time.sleep(2)
        ok2, r2 = mcp.call(BIN, A, "sparkdown_edit_buffer", {"path": note, "content": edit + " (step 3)"})
        cli(A)
        time.sleep(2)
        sleeps = subprocess.run(["pgrep", "-x", "sleep"], capture_output=True, text=True).stdout.split()
        R.log(f"step3 setup: front={front()!r} sleep pids={sleeps} edit={ok2}")
        if fixtures.TMUX:
            fixtures.tmux_diag(R.log, "step3")
        if not sleeps or not ok2:
            return "FAIL", f"setup failed: sleep={sleeps} edit={ok2} {r2}"
        # Paulo's path: an Apple Event open of A earlier (`open -a`, Open
        # With, dock drop), then B's webview re-initialises (web-content
        # process ended → Tauri reloads it), then `sparkdown <A>`.
        subprocess.run(["open", "-a", str(APP.resolve()), A], capture_output=True, timeout=30)
        time.sleep(3)
        webcontent_reload()
        fw = cli_forward_check("step3", A, B)
        R.log(f"step3 cli-forward: {fw}")
        if fw[0] != "PASS":
            return "FAIL", f"after `sparkdown <A>` from outside: {fw[1]}"
        res = quit_check(phys_cmd_q, "step3", ["still running", "sleep", "beta", "Unsaved changes", "alpha"])
        if res[0] != "PASS" or not fixtures.TMUX:
            return res
        # #108: reload BOTH webviews (macOS ends their web-content
        # processes; Tauri reloads them). The core must still know every
        # window's tmux sessions: both jobs stay in the prompt.
        rl = reload_keeps_jobs(A, B, note, edit, quit_check, phys_cmd_q)
        R.add("reload-keeps-jobs", *rl)
        if rl[0] != "PASS":
            return "FAIL", f"after reloading both webviews: {rl[1]}"
        # Real quit: Quit, then Don't Save. tmux jobs must outlive the app.
        phys_cmd_q()
        ds = wait_for(dialogs, 15)
        for _ in range(4):
            if not ds:
                break
            d = ds[0]
            btn = "Quit" if "Quit" in d["buttons"] else ("Don't Save" if "Don't Save" in d["buttons"] else None)
            R.log(f"step3 quit: answering {btn!r} to {d['text'][:80]!r}")
            if not btn:
                break
            click_dialog_button(d, btn)
            time.sleep(2)
            ds = dialogs()
        gone = wait_for(lambda: procs() == 0, 25)
        time.sleep(2)
        alive = subprocess.run(["pgrep", "-x", "sleep"], capture_output=True, text=True).stdout.split()
        fixtures.tmux_diag(R.log, "after-quit")
        if not gone:
            return "FAIL", f"{res[1]}; app did not exit after Quit/Don't Save"
        if not alive:
            return "FAIL", f"{res[1]}; QUIT KILLED THE tmux JOB: no sleep left after the app exited"
        return "PASS", f"{res[1]}; after a real Quit the tmux sleep {alive} still runs"
    R.run("must-pass-3", must_pass_3)

    def must_pass_3_relaunched():
        """Paulo's cases 2-3 came after a relaunch: the windows and B's split
        come back reattached to the surviving tmux sessions, and the sleep
        started before the quit still runs in one of them."""
        alive = subprocess.run(["pgrep", "-x", "sleep"], capture_output=True, text=True).stdout.split()
        if procs() != 0 or not alive:
            return "FAIL", f"precondition: app should be quit with the tmux sleep alive (procs={procs()}, sleep={alive})"
        launch()
        w = wait_for(lambda: titled(["alpha", "beta"]) <= set(windows()), 40)
        time.sleep(8)  # restored panes reattach
        R.log(f"relaunched: windows={windows()}")
        ok2, r2 = mcp.call(BIN, A, "sparkdown_edit_buffer", {"path": note, "content": edit + " (relaunched)"})
        cli(A)
        time.sleep(2)
        fixtures.tmux_diag(R.log, "relaunched")
        if not w or not ok2:
            return "FAIL", f"setup: windows={windows()} edit={ok2} {r2}"
        fw = cli_forward_check("relaunched", A, B)
        R.log(f"relaunched cli-forward: {fw}")
        res = quit_check(phys_cmd_q, "relaunched", ["still running", "sleep", "beta", "Unsaved changes", "alpha"])
        subprocess.run(["pkill", "-x", "sleep"])
        if fw[0] != "PASS":
            return "FAIL", f"after `sparkdown <A>`: {fw[1]}; quit: {res[0]} {res[1]}"
        return res
    if fixtures.TMUX:
        R.run("must-pass-3-relaunched", must_pass_3_relaunched)

    R.manual("manual-gatekeeper", "Gatekeeper first launch of the signed, notarized build", "CI builds are unsigned; see e2e/README.md")
    R.manual("manual-spaces", "Spaces / Mission Control / gestures / notifications", "not automatable on hosted runners")
    subprocess.run(["pkill", "-x", "sparkdown"])
    return R.write()


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
