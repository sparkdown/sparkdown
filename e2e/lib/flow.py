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
        if fixtures.TMUX:
            fixtures.tmux_diag(R.log, "quit")
        before = D.windows()
        D.quit_keys("alpha" + SUF)
        ds = wait_for(D.dialogs, 12)
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
            want = ["still running", D.job_name, "beta", "Unsaved changes", "alpha"]
            missing = [x for x in want if x.lower() not in d["text"].lower()]
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
