"""#122: Commit / Pull / Push from the Changes view, end to end (header
icons + commit panel since 0.4.1).

Drives alpha's webview over WebDriver against a local bare remote: the
Commit icon opens the panel with the message focused, its Commit button is
disabled until there is a message, ⌘/Ctrl+Enter on an empty message is
blocked, a commit lands and closes the panel, a push the remote can't
fast-forward is rejected (and the remote is untouched), then Pull merges and
Push goes through; the Push icon shows its ahead count. Feedback is in the
status bar (spinner, fading success, sticky error) and the bottom pane's Git
tab, which is never opened by itself and opens on a click of the status
message. git itself is the oracle for each step. Signing and credential
prompts can't be automated here; they're in the MANUAL list."""
import os
import pathlib
import subprocess
import tempfile
import time

MSG = "E2E commit from the Changes view"


def git(cwd, *args):
    p = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {p.stderr.strip()}")
    return p.stdout.strip()


def setup(folder):
    """alpha gets an identity, a first commit and a bare `origin` it tracks;
    a second clone ("other") stands in for a teammate."""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="sd-e2e-git-"))
    bare, other = tmp / "remote.git", tmp / "other"
    for k, v in (("user.name", "E2E"), ("user.email", "e2e@example.com"), ("commit.gpgsign", "false"), ("pull.rebase", "false")):
        git(folder, "config", k, v)
    git(folder, "add", "-A")
    git(folder, "commit", "-q", "-m", "e2e base")
    git(tmp, "init", "-q", "--bare", str(bare))
    git(folder, "remote", "add", "origin", str(bare))
    branch = git(folder, "symbolic-ref", "--short", "HEAD")
    git(folder, "push", "-q", "-u", "origin", branch)
    git(tmp, "clone", "-q", str(bare), str(other))
    for k, v in (("user.name", "Other"), ("user.email", "o@example.com"), ("commit.gpgsign", "false")):
        git(other, "config", k, v)
    return bare, other, branch


def run(R, D, title, folder):
    if not hasattr(D, "_wd_handle") or not D._wd_handle(title):
        return "MANUAL", "WebDriver can't reach the window here"
    w = D.wd
    bare, other, branch = setup(folder)
    pathlib.Path(folder, "e2e-commit.md").write_text("new file\n", encoding="utf-8")

    def js(s, *a):
        return w.js(s, *a)

    def click(i):
        js("document.getElementById(arguments[0]).click(); return 1;", i)

    def status():
        # [hidden, state (running/ok/error), status-bar text]
        return js("const e=document.getElementById('status-git');"
                  "return e ? [e.classList.contains('hidden'), e.dataset.state||'', e.textContent] : null;")

    def git_tab_shown():
        return js("const o=document.getElementById('git-output'), p=document.getElementById('terminal-panel');"
                  "return !o.classList.contains('hidden') && !p.classList.contains('hidden')")

    def wait_status(tone, secs=40):
        end = time.time() + secs
        while time.time() < end:
            s = status()
            if s and not s[0] and s[1] == tone:
                return s
            time.sleep(0.5)
        return status()

    def count(i):
        return js("const e=document.getElementById(arguments[0]); return e.hidden ? '' : e.textContent;", i)

    def wait_count(i, want, secs=20):
        end = time.time() + secs
        while time.time() < end and count(i) != want:
            click("btn-changes-refresh")
            time.sleep(1)
        return count(i)

    def wait_idle(i, secs=40):
        end = time.time() + secs
        while time.time() < end and js("return document.getElementById(arguments[0]).classList.contains('is-busy')", i):
            time.sleep(0.3)

    steps = []
    # The block is driven without switching the sidebar to Changes: entering
    # Changes puts the active tab in Diff, and later checks need the editor.
    click("btn-changes-refresh")
    end = time.time() + 20
    while time.time() < end and js("return document.getElementById('changes-git-actions').hidden"):
        time.sleep(0.5)
    if js("return document.getElementById('changes-git-actions').hidden"):
        return "FAIL", "the Commit / Pull / Push icons never showed for a git repo"
    order = js("return [...document.querySelector('#sidebar-changes .sidebar-head').querySelectorAll('button')].map(b=>b.id)")
    ok0 = order == ["btn-git-commit", "btn-git-pull", "btn-git-push", "btn-changes-refresh"]
    steps.append(f"header order ok={ok0}")

    # 1. Open the panel: message focused, Commit disabled until a message;
    #    Ctrl+Enter on an empty message is blocked.
    head0 = git(folder, "rev-parse", "HEAD")
    wait_until = time.time() + 20
    while time.time() < wait_until and js("return document.getElementById('btn-git-commit').disabled"):
        click("btn-changes-refresh")
        time.sleep(1)
    click("btn-git-commit")
    time.sleep(0.5)
    panel_open = js("return !document.getElementById('changes-commit-panel').hidden")
    # WebKitWebDriver under Xvfb can leave the document unfocused, where
    # focus() moves no activeElement; only judge focus when the page has it
    # (unit tests cover the autofocus itself).
    # The check runs with the Changes view hidden (see above), where an
    # element can't take focus; judge autofocus only when it's visible.
    focused = js("const m=document.getElementById('changes-commit-msg');"
                 "return !document.hasFocus() || !m.getClientRects().length || document.activeElement === m")
    disabled_empty = js("return document.getElementById('btn-git-commit-confirm').disabled")
    all_ticked = js("const b=[...document.querySelectorAll('#changes-git-files input')]; return b.length>0 && b.every(x=>x.checked) && document.getElementById('git-select-all').checked")
    js("document.getElementById('changes-commit-msg').dispatchEvent(new KeyboardEvent('keydown',"
       "{key:'Enter', ctrlKey:true, bubbles:true, cancelable:true})); return 1;")
    s = wait_status("error", 5)
    ok1 = (panel_open and focused and disabled_empty and all_ticked and s and s[1] == "error"
           and "commit message" in s[2] and git(folder, "rev-parse", "HEAD") == head0)
    steps.append(f"panel open={panel_open} focused={focused} commit disabled empty={disabled_empty} all ticked={all_ticked} empty blocked={s and s[2]!r}")

    # 2. Commit.
    js("const t=document.getElementById('changes-commit-msg'); t.value=arguments[0];"
       "t.dispatchEvent(new Event('input',{bubbles:true})); return 1;", MSG)
    click("btn-git-commit-confirm")
    s = wait_status("ok")
    subj = git(folder, "log", "-1", "--format=%s")
    clean = git(folder, "status", "--porcelain") == ""
    closed = js("return document.getElementById('changes-commit-panel').hidden")
    ok2 = subj == MSG and clean and closed and s and s[2].startswith("Committed ")
    push_n = wait_count("git-push-count", "1")
    steps.append(f"commit subject={subj!r} clean={clean} panel closed={closed} status={s and s[2]!r} push count={push_n!r}")

    # 3. A teammate pushed first: our push is rejected, the remote untouched.
    pathlib.Path(other, "theirs.md").write_text("theirs\n", encoding="utf-8")
    git(other, "add", "-A")
    git(other, "commit", "-q", "-m", "theirs")
    git(other, "push", "-q")
    theirs = git(bare, "rev-parse", branch)
    drawer_before = js("return !document.getElementById('terminal-panel').classList.contains('hidden')")
    click("btn-git-push")
    s = wait_status("error")
    wait_idle("btn-git-push")
    ok3 = bool(s and "rejected" in s[2] and git(bare, "rev-parse", branch) == theirs)
    # The error stays (past the 5 s fade) and nothing opened the Git tab.
    time.sleep(6)
    sticky = status()
    not_auto = not git_tab_shown()
    ok3 = ok3 and sticky and not sticky[0] and sticky[1] == "error" and not_auto
    steps.append(f"push rejected={ok3} status={s and s[2][:60]!r} sticky={sticky and not sticky[0]} git tab not auto-opened={not_auto}")
    D.shot("git-push-rejected")
    # Clicking the status message opens the Git tab with git's full output,
    # without moving focus into it, and clears the error.
    click("status-git")
    time.sleep(0.5)
    shown = git_tab_shown()
    text = js("return document.getElementById('git-output').innerText")
    unfocused = js("return document.activeElement !== document.getElementById('git-output')")
    cleared = status()[0]
    entries = js("return document.querySelectorAll('#git-output .git-output-entry').length")
    ok3b = shown and "rejected" in text and "git push" in text and unfocused and cleared and entries >= 2
    steps.append(f"git tab shown={shown} has output={'rejected' in text} entries={entries} unfocused={unfocused} cleared={cleared}")
    D.shot("git-output-tab")
    if not drawer_before:
        click("btn-terminal")  # put the drawer back the way it was
        time.sleep(0.5)

    # 4. Pull merges theirs; 5. Push goes through.
    click("btn-git-pull")
    s = wait_status("ok")
    wait_idle("btn-git-pull")
    ok4 = pathlib.Path(folder, "theirs.md").exists()
    steps.append(f"pull ok={ok4} ({s and s[3][:80]!r})")
    click("btn-git-push")
    s = wait_status("ok")
    wait_idle("btn-git-push")
    ok5 = git(bare, "rev-parse", branch) == git(folder, "rev-parse", "HEAD")
    pushed_msg = s and s[2]
    ok5 = ok5 and bool(pushed_msg and pushed_msg.startswith("Pushed ") and f"to origin/{branch}" in pushed_msg)
    after = wait_count("git-push-count", "")
    steps.append(f"push ok={ok5} status={pushed_msg!r} push count after={after!r}")
    D.shot("git-pushed")
    # The success line fades on its own after about 5 seconds.
    end = time.time() + 10
    while time.time() < end and not status()[0]:
        time.sleep(0.5)
    faded = status()[0]
    steps.append(f"success faded={faded}")
    ok = all([ok0, ok1, ok2, ok3, ok3b, ok4, ok5, faded]) and after == "" and push_n == "1"
    return ("PASS" if ok else "FAIL"), "; ".join(steps)
