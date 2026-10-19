"""The multi-window must-pass, shared by the Windows, Ubuntu (X11) and
Hyprland runners. Each OS supplies a Desktop adapter (see the runners)."""
import os
import pathlib
import tempfile
import time

import fixtures
import mcp

SUF = " — SparkDown"
EDIT = "E2E unsaved edit."


def titled(*names):
    return {n + SUF for n in names}


def wait_for(pred, secs=20, step=0.5):
    end = time.time() + secs
    while time.time() < end:
        v = pred()
        if v:
            return v
        time.sleep(step)
    return pred()


def run(R, D):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="sd-e2e-"))
    F = fixtures.make_folders(tmp)
    A, B, C = F["alpha"], F["beta"], F["gamma"]
    note = os.path.join(A, "notes.md")
    fixtures.seed_config()
    D.start(A)
    got = wait_for(lambda: titled("alpha") <= set(D.windows()), 60)
    R.log("first window:", D.windows())
    D.shot("alpha")
    if not got:
        R.add("two-windows", "FAIL", f"the app did not open alpha: {D.windows()}")
        for cid in ("one-process-focus", "window-menu", "empty-reuse", "mcp-isolation", "red-close", "quit-prompt", "restore"):
            R.add(cid, "FAIL", "not run: the app never opened its first window")
        return

    def two_windows():
        D.cli(B)
        wait_for(lambda: titled("alpha", "beta") <= set(D.windows()), 25)
        w = D.windows()
        D.shot("two-windows")
        n = D.procs()
        ok = set(w) == titled("alpha", "beta") and n == 1
        return ("PASS" if ok else "FAIL"), f"windows={w}; app processes={n}"
    R.run("two-windows", two_windows)

    def one_process_focus():
        before = D.windows()
        D.cli(A)
        time.sleep(3)
        after, fg, n = D.windows(), D.foreground(), D.procs()
        D.shot("same-folder-focus")
        same = len(after) == len(before) and n == 1
        if not same:
            return "FAIL", f"windows {before}→{after}; processes={n}"
        if fg == "alpha" + SUF:
            return "PASS", f"still {len(after)} windows, 1 process; foreground={fg!r}"
        ok, wins = mcp.call(D.exe, A, "sparkdown_list_windows")
        return "PARTIAL", (f"still {len(after)} windows, 1 process, but the OS foreground is {fg!r} "
                           f"(app's own focus state: {str(wins)[:160]})")
    R.run("one-process-focus", one_process_focus)

    def cli_forward_keeps_b():
        """`sparkdown <A>` as a second process with A and B open: B's
        frontend must still show B (its published workspace root)."""
        before = D.windows()
        D.cli(A)
        time.sleep(4)
        after, fg, n = D.windows(), D.foreground(), D.procs()
        roots = {}
        for name, path in (("alpha", A), ("beta", B)):
            ok, ctx = mcp.context(D.exe, path)
            roots[name] = ctx.get("workspace_root") if ok and isinstance(ctx, dict) else f"ERR {str(ctx)[:100]}"
        R.log(f"cli-forward: windows {before}->{after} fg={fg!r} procs={n} roots={roots}")
        D.shot("cli-forward")
        bad = []
        if n != 1: bad.append(f"{n} processes")
        if set(after) != set(before): bad.append(f"windows {before}->{after}")
        if mcp.norm(roots["beta"]) != mcp.norm(B): bad.append(f"B's webview root is {roots['beta']!r}, not beta")
        if mcp.norm(roots["alpha"]) != mcp.norm(A): bad.append(f"A's webview root is {roots['alpha']!r}")
        if bad:
            return "FAIL", "; ".join(bad)
        tail = "" if fg == "alpha" + SUF else f" (OS foreground {fg!r})"
        return ("PASS" if not tail else "PARTIAL"), f"1 process; B still shows beta, A shows alpha{tail}"
    R.run("cli-forward-keeps-b", cli_forward_keeps_b)

    R.run("window-menu", lambda: D.window_menu(["alpha", "beta"]))

    def empty_reuse():
        D.focus("alpha" + SUF)
        D.new_window_keys("alpha" + SUF)
        got = wait_for(lambda: "SparkDown" in D.windows(), 15)
        mid = D.windows()
        D.shot("empty-window")
        if not got:
            return "FAIL", f"no empty window after Ctrl+Shift+N: {mid}"
        # Let the new window finish loading before handing it a folder: a
        # path forwarded while its webview is still starting is dropped
        # (the backend emits to it before its listener exists).
        ready = D.wait_ready("SparkDown") if hasattr(D, "wait_ready") else (time.sleep(6) or None)
        R.log(f"empty window ready: {ready}")
        time.sleep(2)
        D.cli(C)
        wait_for(lambda: ("gamma" + SUF) in D.windows(), 20)
        w = D.windows()
        D.shot("gamma-in-empty")
        ok = set(w) == titled("alpha", "beta", "gamma") and len(w) == len(mid)
        return ("PASS" if ok else "FAIL"), f"after Ctrl+Shift+N: {mid}; after `sparkdown gamma`: {w}"
    R.run("empty-reuse", empty_reuse)

    R.run("mcp-isolation", lambda: mcp.isolation_check(D.exe, {"alpha": A, "beta": B, "gamma": C}, R.log))

    def red_close():
        D.close_window("gamma" + SUF)
        wait_for(lambda: ("gamma" + SUF) not in D.windows(), 15)
        w = D.windows()
        D.shot("closed-gamma")
        ok = set(w) == titled("alpha", "beta") and D.procs() == 1
        return ("PASS" if ok else "FAIL"), f"closed gamma via {D.close_how}: windows={w}"
    R.run("red-close", red_close)

    def quit_prompt():
        D.start_job("beta" + SUF)
        ok1, r1 = mcp.call(D.exe, A, "sparkdown_open_file", {"path": note})
        time.sleep(2)
        ok2, r2 = mcp.call(D.exe, A, "sparkdown_edit_buffer",
                           {"path": note, "content": f"# alpha\n\n{EDIT}\n"})
        time.sleep(2)
        R.log("open/edit via MCP:", ok1, r1, ok2, r2)
        if not D.job_alive():
            return "FAIL", f"could not start the {D.job_name} job in beta's terminal"
        return quit_and_check("quit", 0)

    def quit_and_check(tag, bg_wait, want=None, dlg_wait=12):
        if bg_wait:
            # Paulo's case: A focused, B (running job) left in the background
            # long enough for webview throttling, then quit from A.
            D.focus("alpha" + SUF) if hasattr(D, "focus") else None
            R.log(f"waiting {bg_wait}s with alpha focused, beta in the background")
            time.sleep(bg_wait)
            if not D.job_alive():
                return "FAIL", f"the {D.job_name} job in beta's terminal is gone"
        # A prompt left over from the previous check (e.g. Hyprland, where a
        # dialog Escape can't close is closed via hyprctl, and the old quit
        # flow may go on to its save prompt) must not be read as this
        # check's prompt: let it surface, log it, cancel it.
        time.sleep(3)
        for d in D.dialogs():
            R.log(f"[{tag}] stray prompt from the previous check, cancelling: {d}")
            D.cancel_dialog(d)
        wait_for(lambda: not D.dialogs(), 8)
        if fixtures.TMUX and tag != "wedged":
            fixtures.tmux_diag(R.log, tag)
        before = D.windows()
        D.quit_keys("alpha" + SUF)
        ds = wait_for(D.dialogs, dlg_wait)
        D.shot("quit-prompt")
        R.log("dialogs:", ds)
        if not ds:
            return "FAIL", "no prompt appeared"
        if len(ds) != 1:
            for d in ds:
                D.cancel_dialog(d)
            return "FAIL", f"{len(ds)} prompts appeared: {ds}"
        d = ds[0]
        missing = None
        if d.get("text") is not None:
            want = want or ["still running", D.job_name, "beta", "Unsaved changes", "alpha"]
            missing = [x for x in want if x.lower() not in d["text"].replace("\u2019", "'").lower()]
        D.cancel_dialog(d)
        gone = wait_for(lambda: not D.dialogs(), 8)
        after = D.windows()
        okc, ctx = mcp.context(D.exe, A)
        t = mcp.tab(ctx, note) if okc else None
        okb, buf = mcp.call(D.exe, A, "sparkdown_read_buffer", {"path": note})
        kept = bool(t and t.get("dirty")) and EDIT in str(buf)
        alive = D.procs() == 1 and D.job_alive()
        D.shot("quit-cancelled")
        base = (f"prompt closed by Cancel={gone}; after Cancel: windows={after}, alpha's edit unsaved and kept={kept}, "
                f"app and {D.job_name} still running={alive}")
        if not (gone and set(after) == set(before) and kept and alive) or missing:
            return "FAIL", f"prompt={d}; missing={missing}; {base}"
        if missing is None:
            return "PARTIAL", (f"one prompt ({d.get('name')}) appeared and Cancel kept everything ({base}); "
                               "its text can't be read on this platform (screenshot attached)")
        return "PASS", f"one prompt: {d['text'][:200]!r}; {base}"
    R.run("quit-prompt", quit_prompt)
    R.run("quit-prompt-bg-occluded", lambda: quit_and_check("bgquit", int(os.environ.get("E2E_BG_WAIT", "45"))))

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
            return quit_and_check("wedged", 0, WANT, 30)
        finally:
            fixtures.resume(pid)
            R.log(f"tmux server {pid} resumed (SIGCONT)")
    if fixtures.TMUX:
        R.run("quit-prompt-probe-timeout", wedged_check)

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
        return quit_and_check("flap", 0)
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
            return quit_and_check("split", 0)
        finally:
            fixtures.tmux_kill_pane(pane)
    if fixtures.TMUX:
        R.run("tmux-split-pane", split_check)
        R.run("tmux-transient-failure", flap_check)

    if D.wd is not None:
        R.run("webview-content", lambda: D.webview_check("alpha" + SUF, "alpha", EDIT))

    def restore():
        D.kill_job()
        D.save("alpha" + SUF)
        saved = wait_for(lambda: EDIT in pathlib.Path(note).read_text(encoding="utf-8"), 10)
        before = D.windows()
        D.quit_keys("alpha" + SUF)
        gone = wait_for(lambda: D.procs() == 0, 25)
        D.shot("after-quit")
        if not gone:
            ds = D.dialogs()
            for d in ds:
                D.cancel_dialog(d)
            return "FAIL", f"no clean exit (saved={bool(saved)}); prompts={ds}"
        D.relaunch()
        wait_for(lambda: titled("alpha", "beta") <= set(D.windows()), 60)
        time.sleep(3)
        w = D.windows()
        D.shot("restored")
        ok = set(w) == titled("alpha", "beta") and saved
        return ("PASS" if ok else "FAIL"), (f"saved alpha={bool(saved)}; before quit={before}; "
                                            f"after relaunch={w} (gamma was closed and must stay closed)")
    R.run("restore", restore)
    D.stop()
