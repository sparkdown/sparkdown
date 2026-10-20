"""#122: Commit / Pull / Push from the Changes view, end to end.

Drives alpha's webview over WebDriver against a local bare remote: an empty
message is blocked, a commit lands, a push the remote can't fast-forward is
rejected (and the remote is untouched), then Pull merges and Push goes
through. git itself is the oracle for each step. Signing and credential
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
        return js("const e=document.getElementById('changes-git-status');"
                  "return e ? [e.hidden, e.dataset.tone||'', e.dataset.kind||'', e.innerText] : null;")

    def wait_status(tone, secs=40):
        end = time.time() + secs
        while time.time() < end:
            s = status()
            if s and not s[0] and s[1] == tone:
                return s
            time.sleep(0.5)
        return status()

    def label(i):
        return js("return document.getElementById(arguments[0]).textContent;", i)

    def wait_label(i, want, secs=20):
        end = time.time() + secs
        while time.time() < end and label(i) != want:
            click("btn-changes-refresh")
            time.sleep(1)
        return label(i)

    steps = []
    # The block is driven without switching the sidebar to Changes: entering
    # Changes puts the active tab in Diff, and later checks need the editor.
    click("btn-changes-refresh")
    end = time.time() + 20
    while time.time() < end and js("return document.getElementById('changes-git').hidden"):
        time.sleep(0.5)
    if js("return document.getElementById('changes-git').hidden"):
        return "FAIL", "the Commit / Pull / Push block never showed for a git repo"
    D.shot("git-actions")

    # 1. Empty message: blocked, no commit.
    head0 = git(folder, "rev-parse", "HEAD")
    click("btn-git-commit")
    s = wait_status("error", 5)
    ok1 = s and s[2] == "empty_message" and git(folder, "rev-parse", "HEAD") == head0
    steps.append(f"empty message blocked={bool(ok1)} ({s})")

    # 2. Commit.
    js("const t=document.getElementById('changes-commit-msg'); t.value=arguments[0];"
       "t.dispatchEvent(new Event('input',{bubbles:true})); return 1;", MSG)
    click("btn-git-commit")
    s = wait_status("ok")
    subj = git(folder, "log", "-1", "--format=%s")
    clean = git(folder, "status", "--porcelain") == ""
    ok2 = subj == MSG and clean
    push_lbl = wait_label("btn-git-push", "Push ↑1")
    steps.append(f"commit subject={subj!r} clean={clean} push button={push_lbl!r}")

    # 3. A teammate pushed first: our push is rejected, the remote untouched.
    pathlib.Path(other, "theirs.md").write_text("theirs\n", encoding="utf-8")
    git(other, "add", "-A")
    git(other, "commit", "-q", "-m", "theirs")
    git(other, "push", "-q")
    theirs = git(bare, "rev-parse", branch)
    click("btn-git-push")
    s = wait_status("error")
    ok3 = s and s[2] == "rejected" and git(bare, "rev-parse", branch) == theirs
    steps.append(f"push rejected={bool(ok3)} kind={s and s[2]}")
    D.shot("git-push-rejected")

    # 4. Pull merges theirs; 5. Push goes through.
    click("btn-git-pull")
    s = wait_status("ok")
    ok4 = pathlib.Path(folder, "theirs.md").exists()
    steps.append(f"pull ok={ok4} ({s and s[3][:80]!r})")
    click("btn-git-push")
    s = wait_status("ok")
    ok5 = git(bare, "rev-parse", branch) == git(folder, "rev-parse", "HEAD")
    ab = wait_label("btn-git-push", "Push")
    steps.append(f"push ok={ok5} push button after={ab!r}")
    D.shot("git-pushed")
    ok = all([ok1, ok2, ok3, ok4, ok5]) and ab == "Push" and push_lbl == "Push ↑1"
    return ("PASS" if ok else "FAIL"), "; ".join(steps)
