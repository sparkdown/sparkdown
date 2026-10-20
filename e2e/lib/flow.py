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


def _paths(v):
    """Every string in an MCP answer (to find folder paths in it)."""
    if isinstance(v, str):
        return [v]
    if isinstance(v, dict):
        return [p for x in v.values() for p in _paths(x)]
    if isinstance(v, list):
        return [p for x in v for p in _paths(x)]
    return []


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
        for cid in ("one-process-focus", "window-menu", "empty-reuse", "mcp-isolation", "close-folder", "red-close", "quit-prompt", "restore", "close-folder-relaunch"):
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

    def close_folder():
        """#127 File > Close Folder on gamma: its job prompt and its save
        prompt both Cancel cleanly; a confirmed close empties the SAME
        window, stops gamma's terminals (tmux sessions too) and frees the
        folder; `sparkdown gamma` then reopens it fresh in that window."""
        g = "gamma" + SUF
        gnote = os.path.join(C, "notes.md")
        if not hasattr(D, "command"):
            return "MANUAL", "no command-palette driver on this OS"
        tm0 = set(fixtures.tmux_sessions()) if fixtures.TMUX else set()
        D.start_job(g)
        gsess = (set(fixtures.tmux_sessions()) - tm0) if fixtures.TMUX else set()
        mcp.call(D.exe, C, "sparkdown_open_file", {"path": gnote})
        time.sleep(2)
        mcp.call(D.exe, C, "sparkdown_edit_buffer", {"path": gnote, "content": f"# gamma\n\n{EDIT}\n"})
        time.sleep(2)
        if not D.job_alive():
            return "FAIL", f"setup: could not start the {D.job_name} job in gamma's terminal"
        n = len(D.windows())
        R.log(f"close-folder: gamma tmux sessions={sorted(gsess)}")

        def still_there(tag):
            okc, ctx = mcp.context(D.exe, C)
            t = mcp.tab(ctx, gnote) if okc else None
            okb, buf = mcp.call(D.exe, C, "sparkdown_read_buffer", {"path": gnote})
            kept = bool(t and t.get("dirty")) and EDIT in str(buf)
            w = D.windows()
            R.log(f"[{tag}] windows={w} kept={kept}")
            return g in w and len(w) == n and kept

        # 1) A job runs: the Close Folder prompt names it; Cancel keeps all.
        D.command(g, "Close folder")
        ds = wait_for(D.dialogs, 12)
        D.shot("close-folder-job-prompt")
        R.log("close-folder job prompt:", ds)
        if not ds:
            return "FAIL", "no prompt for gamma's running job"
        d = ds[0]
        missing = None
        if d.get("text") is not None:
            txt = d["text"].replace("\u2019", "'").lower()
            missing = [x for x in ("close folder", D.job_name, "will stop") if x not in txt]
        for x in ds:
            D.cancel_dialog(x)
        wait_for(lambda: not D.dialogs(), 8)
        if missing:
            return "FAIL", f"job prompt is missing {missing}: {d}"
        if not (still_there("job-cancel") and D.job_alive()):
            return "FAIL", "Cancel on the job prompt did not keep gamma, its edit and its job"
        # 2) No job, an unsaved edit: the save prompt; Cancel keeps all.
        D.kill_job()
        D.command(g, "Close folder")
        ds = wait_for(D.dialogs, 12)
        D.shot("close-folder-save-prompt")
        R.log("close-folder save prompt:", ds)
        if not ds:
            return "FAIL", "no unsaved-changes prompt for gamma's edit"
        for x in ds:
            D.cancel_dialog(x)
        wait_for(lambda: not D.dialogs(), 8)
        if not still_there("save-cancel"):
            return "FAIL", "Cancel on the save prompt did not keep gamma and its edit"
        # 3) Saved: Close Folder empties the same window, no prompt.
        D.save(g)
        D.command(g, "Close folder")
        emptied = wait_for(lambda: g not in D.windows() and "SparkDown" in D.windows(), 15)
        stray = D.dialogs()
        for x in stray:
            D.cancel_dialog(x)
        w = D.windows()
        D.shot("close-folder-empty")
        if not emptied or len(w) != n or stray:
            return "FAIL", f"after Close Folder: windows={w} (want {n}, gamma replaced by an empty window); prompts={stray}"
        if fixtures.TMUX:
            left = gsess & set(fixtures.tmux_sessions())
            if left:
                return "FAIL", f"gamma's tmux sessions survived Close Folder: {sorted(left)}"
        okw, wins = mcp.call(D.exe, A, "sparkdown_list_windows")
        if okw and mcp.norm(C) in {mcp.norm(x) for x in _paths(wins)}:
            return "FAIL", f"the registry still binds gamma: {str(wins)[:300]}"
        # 4) Reopen: the same (empty) window takes gamma, fresh.
        time.sleep(3)
        D.cli(C)
        wait_for(lambda: g in D.windows(), 20)
        w2 = D.windows()
        okc, ctx = mcp.context(D.exe, C)
        root = ctx.get("workspace_root") if okc and isinstance(ctx, dict) else None
        old_tab = mcp.tab(ctx, gnote) if okc else None
        D.shot("close-folder-reopened")
        ok = g in w2 and len(w2) == n and mcp.norm(root) == mcp.norm(C) and old_tab is None
        return ("PASS" if ok else "FAIL"), (f"job prompt and save prompt cancelled cleanly; closed -> {w}; "
                                            f"tmux sessions stopped={sorted(gsess) or 'n/a'}; reopened -> {w2}, "
                                            f"root={root!r}, old notes.md tab restored={old_tab is not None}")
    def close_folder_checked():
        res = close_folder()
        if res[0] == "FAIL":
            # Leave gamma as later checks expect it: no job, nothing unsaved.
            for x in D.dialogs():
                D.cancel_dialog(x)
            D.kill_job()
            if ("gamma" + SUF) in D.windows():
                D.save("gamma" + SUF)
        return res
    R.run("close-folder", close_folder_checked)

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

        def nested_check():
            """#110: B's pane wraps its shell in a nested pty (kiro-cli-term
            style); the job runs on the inner tty. Quit must list it."""
            s = fixtures.tmux_busy_session()
            if not s:
                return "FAIL", "setup: no busy sd-* session (B's sleep)"
            fixtures.stop_pane_job(s)
            ok, det = fixtures.nested_pty_job(s, R.log)
            R.log(f"nested-pty setup: {ok} {det}")
            if not ok:
                fixtures.end_nested(s)
                return "FAIL", f"setup is not the bug's shape: {det}"
            res = quit_and_check("nested", 0, want=["still running", "sleep", "beta"])
            fixtures.end_nested(s)
            return res[0], f"{det}; {res[1]}"
        R.run("tmux-nested-pty", nested_check)

    if D.wd is not None:
        R.run("webview-content", lambda: D.webview_check("alpha" + SUF, "alpha", EDIT))
    if D.wd is not None and hasattr(D, "explorer_delete"):
        R.run("explorer-delete", lambda: D.explorer_delete("alpha" + SUF, A))

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
    def reload_keeps_jobs():
        """#108: reload both webviews; the quit prompt must still list the
        tmux job of every window (the core is the source of truth)."""
        D.start_job("alpha" + SUF)
        time.sleep(2)
        ok_a = D.reload("alpha" + SUF)
        ok_b = D.reload("beta" + SUF)
        time.sleep(10)
        R.log(f"reload-keeps-jobs: reloaded alpha={ok_a} beta={ok_b} windows={D.windows()}")
        if not (ok_a and ok_b):
            return "FAIL", "could not reload the webviews"
        if not D.job_alive():
            return "FAIL", f"the {D.job_name} job is gone after the reload"
        # A's unsaved edit lived in its webview; put it back for `restore`.
        mcp.call(D.exe, A, "sparkdown_open_file", {"path": note})
        time.sleep(2)
        mcp.call(D.exe, A, "sparkdown_edit_buffer", {"path": note, "content": f"# alpha\n\n{EDIT}\n"})
        time.sleep(2)
        return quit_and_check("reloaded", 0, want=["still running", f"{D.job_name} — alpha", f"{D.job_name} — beta"])
    if fixtures.TMUX and hasattr(D, "reload"):
        R.run("reload-keeps-jobs", reload_keeps_jobs)

    R.run("restore", restore)

    def close_folder_relaunch():
        """#127: a folder closed with Close Folder is not restored on relaunch."""
        b = "beta" + SUF
        if not hasattr(D, "command"):
            return "MANUAL", "no command-palette driver on this OS"
        if b not in D.windows():
            return "FAIL", f"setup: beta is not open after the restore: {D.windows()}"
        D.command(b, "Close folder")
        wait_for(lambda: b not in D.windows(), 15)
        stray = D.dialogs()
        for x in stray:
            D.cancel_dialog(x)
        mid = D.windows()
        if b in mid or stray:
            return "FAIL", f"Close Folder on beta: windows={mid}; prompts={stray}"
        D.shot("close-folder-beta-closed")
        # Let beta's webview finish reloading into the empty state.
        time.sleep(8)
        # Give alpha's page keyboard focus first (as `restore` does): a key
        # sent to a freshly relaunched page that was never clicked is lost
        # with or without Close Folder (checked locally on X11).
        D.save("alpha" + SUF)
        D.quit_keys("alpha" + SUF)
        if not wait_for(lambda: D.procs() == 0, 40):
            ds = D.dialogs()
            D.shot("close-folder-no-exit")
            info = f"windows={D.windows()} foreground={D.foreground()!r} procs={D.procs()}"
            for x in ds:
                D.cancel_dialog(x)
            return "FAIL", f"no clean exit; prompts={ds}; {info}"
        D.relaunch()
        wait_for(lambda: ("alpha" + SUF) in D.windows(), 60)
        time.sleep(4)
        w = D.windows()
        D.shot("close-folder-relaunched")
        ok = ("alpha" + SUF) in w and b not in w
        return ("PASS" if ok else "FAIL"), f"before quit={mid}; after relaunch={w} (beta's folder was closed and must not come back)"
    R.run("close-folder-relaunch", close_folder_relaunch)
    D.stop()
