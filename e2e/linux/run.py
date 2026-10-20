"""Linux E2E.
  python3 e2e/linux/run.py x11 BIN OUT_DIR   Ubuntu: Xvfb + openbox, tauri-driver/WebKitWebDriver, xdotool
  python3 e2e/linux/run.py hyprland BIN OUT  Arch container: Hyprland on vkms, hyprctl, wtype, grim"""
import json
import os
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lib"))
import fixtures  # noqa: E402
import flow  # noqa: E402
import wd  # noqa: E402
from report import Report  # noqa: E402

MODE, BIN, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
R = Report(("Ubuntu (X11, WebKitWebDriver)" if MODE == "x11" else "Arch + Hyprland (vkms)") + fixtures.variant(), OUT)
SUF = flow.SUF
DIALOG_TITLES = ("Quit SparkDown", "Unsaved Changes")
ATSPI = str(pathlib.Path(__file__).with_name("atspi_dialogs.py"))


def atspi_texts():
    """{dialog title: text} read over AT-SPI; {} when unavailable."""
    try:
        p = subprocess.run(["/usr/bin/python3", ATSPI], capture_output=True, text=True, timeout=20)
        res = {d["name"]: d for d in json.loads(p.stdout or "[]")}
        R.log("at-spi dialogs:", res, p.stderr.strip()[-400:])
        return res
    except Exception as e:  # noqa: BLE001
        R.log("at-spi failed:", e)
        return {}


def with_text(ds):
    if not ds:
        return ds
    acc = atspi_texts()
    vals = list(acc.values())
    for d in ds:
        # GTK names the alert "Warning"/"Question"; its labels hold the title.
        a = acc.get(d["name"]) or next((v for v in vals if d["name"] in v.get("text", "")), None)
        if a is None and len(ds) == 1 and len(vals) == 1:
            a = vals[0]
        if a and a.get("text"):
            d["text"] = f"{d['name']}\n{a['text']}"
            d["buttons"] = a.get("buttons", [])
    return ds


def read_window_menu(names, dismiss):
    """Read the open GTK popup's Window submenu over AT-SPI, then dismiss it."""
    menu = {}
    try:
        p = subprocess.run(["/usr/bin/python3", str(pathlib.Path(__file__).with_name("atspi_menu.py"))],
                           capture_output=True, text=True, timeout=30)
        menu = json.loads(p.stdout or "{}")
        R.log("at-spi menu:", menu, p.stderr.strip()[-300:])
    except Exception as e:  # noqa: BLE001
        R.log("at-spi menu failed:", e)
    dismiss()
    time.sleep(0.5)
    items = menu.get("Window") or []
    if not items:
        return "PARTIAL", ("menu popup opened (screenshot); its GTK entries couldn't be read over AT-SPI; "
                           "the entry model is unit-tested (window_menu_has_one_entry_per_live_window)")
    entries = [i for i in items if i in names or i in ("alpha", "beta", "gamma", "Untitled window")]
    ok = sorted(entries) == sorted(names) and len(entries) == len(set(entries))
    return ("PASS" if ok else "FAIL"), f"Window submenu entries={entries} (items over AT-SPI: {items[:14]})"


def sh(*args, timeout=30):
    p = subprocess.run(list(args), capture_output=True, text=True, timeout=timeout)
    return p.stdout.strip()


def is_main(t):
    return t.endswith(SUF) or t == "SparkDown"


class Base:
    exe = BIN
    job_name = "sleep"
    wd = None

    def __init__(self):
        self.n = 0
        self.log = open(pathlib.Path(OUT) / "app.log", "a")

    def cli(self, folder):
        subprocess.run([BIN, folder], timeout=30, capture_output=True)
        time.sleep(1.5)

    def procs(self):
        return len(sh("pgrep", "-x", "sparkdown").split())

    def job_alive(self):
        return bool(sh("pgrep", "-x", "sleep"))

    def kill_job(self):
        subprocess.run(["pkill", "-x", "sleep"])
        time.sleep(1)


class X11(Base):
    close_how = "the in-app close button (×)"

    def __init__(self):
        super().__init__()
        self.wd = None
        self._driver()

    def _driver(self):
        # The app inherits the driver's env: a desktop-launcher PATH.
        import shutil
        self.driver = subprocess.Popen([shutil.which("tauri-driver") or "tauri-driver", "--native-driver", "/usr/bin/WebKitWebDriver"],
                                       stdout=self.log, stderr=subprocess.STDOUT, env=fixtures.app_env())
        time.sleep(2)

    def _session(self, args):
        if self.wd:
            self.wd.quit()
        self.wd = wd.Session("http://127.0.0.1:4444", {"tauri:options": {"application": BIN, "args": args}})

    def start(self, folder):
        self._session([folder])
        time.sleep(6)

    def relaunch(self):
        # The old session's app has quit; start a fresh driver so a stale
        # session can't hit "Maximum number of active sessions".
        if self.wd:
            self.wd.quit()
            self.wd = None
        self.driver.terminate()
        try:
            self.driver.wait(10)
        except subprocess.TimeoutExpired:
            self.driver.kill()
        subprocess.run(["pkill", "-x", "WebKitWebDriver"])
        self._driver()
        self._session([])
        time.sleep(8)

    def _xwins(self):
        out = []
        for wid in sh("xdotool", "search", "--onlyvisible", "--name", "SparkDown|Unsaved Changes").split():
            out.append((wid, sh("xdotool", "getwindowname", wid)))
        return out

    def windows(self):
        return [t for _, t in self._xwins() if is_main(t)]

    def _wid(self, title):
        return next((w for w, t in self._xwins() if t == title), None)

    def foreground(self):
        return sh("xdotool", "getactivewindow", "getwindowname")

    def focus(self, title):
        wid = self._wid(title)
        if wid:
            sh("xdotool", "windowactivate", "--sync", wid)
        time.sleep(0.5)

    def _wd_handle(self, title):
        m = wd.map_windows(self.wd, R.log)
        if title in m:
            self.wd.switch(m[title])
            return True
        return False

    def reload(self, title):
        """Reload `title`'s webview (the web-content process restart a
        compositor or memory pressure can cause)."""
        if not self._wd_handle(title):
            return False
        try:
            self.wd.js("setTimeout(() => location.reload(), 50); return 1;")
        except Exception as e:  # the page goes away under the call
            R.log(f"reload {title}: {e}")
        return True

    def keys(self, title, xkeys, *chord):
        if self._wd_handle(title):
            self.wd.find("body")
            self.wd.chord(*chord)
        else:
            self.focus(title)
            sh("xdotool", "key", "--clearmodifiers", xkeys)

    def new_window_keys(self, title):
        self.keys(title, "ctrl+shift+n", "ctrl", "shift", "N")

    def quit_keys(self, title):
        self.keys(title, "ctrl+q", "ctrl", "q")

    def save(self, title):
        if self._wd_handle(title):
            self.wd.click(self.wd.find(".cm-content"))
        self.keys(title, "ctrl+s", "ctrl", "s")
        time.sleep(1)

    def close_window(self, title):
        if self._wd_handle(title):
            self.wd.click(self.wd.find("#btn-window-close"))
        else:
            self.close_how = "wmctrl -c (WM close request)"
            sh("wmctrl", "-c", title)
        time.sleep(1)

    def start_job(self, title):
        if self._wd_handle(title):
            # The drawer starts open (seeded); hide and show it so the
            # terminal takes keyboard focus.
            self.wd.click(self.wd.find("#btn-terminal"))
            time.sleep(1.5)
            self.wd.click(self.wd.find("#btn-terminal"))
            ta = self.wd.find(".xterm-helper-textarea", wait=20)
            time.sleep(3)
            self.wd.type(ta, "sleep 300" + wd.KEYS["enter"])
        else:
            self.focus(title)
            sh("xdotool", "key", "--clearmodifiers", "ctrl+grave")
            time.sleep(1.5)
            sh("xdotool", "key", "--clearmodifiers", "ctrl+grave")
            time.sleep(4)
            sh("xdotool", "type", "--delay", "40", "sleep 300")
            sh("xdotool", "key", "Return")
        time.sleep(3)

    def dialogs(self):
        return with_text([{"name": t, "id": w, "text": None} for w, t in self._xwins() if t in DIALOG_TITLES])

    def cancel_dialog(self, d):
        sh("xdotool", "windowactivate", "--sync", d["id"])
        sh("xdotool", "key", "Escape")
        time.sleep(1)

    def wait_ready(self, title):
        return wd.wait_ready(self.wd, title, R.log) if self.wd else (time.sleep(6) or None)

    def window_menu(self, names):
        if not self._wd_handle(names[0] + SUF):
            return "MANUAL", "WebDriver can't reach the window to open its menu"
        self.wd.click(self.wd.find("#btn-app-menu"))
        time.sleep(2)
        self.shot("app-menu-open")
        return read_window_menu(names, lambda: (sh("xdotool", "key", "Escape"), time.sleep(0.5), sh("xdotool", "key", "Escape")))

    def webview_check(self, title, folder, edit):
        if not self._wd_handle(title):
            return "FAIL", f"WebDriver can't see {title}"
        text = self.wd.js("return document.body.innerText")
        content = self.wd.js("return (document.querySelector('.cm-content')||{}).innerText || ''")
        dot = self.wd.js("return Array.from(document.querySelectorAll('*')).some(e => e.children.length===0 && e.textContent==='●')")
        self.wd.screenshot(str(pathlib.Path(OUT) / "webview-alpha.png"))
        handles = len(self.wd.handles())
        ok = folder in text and "notes.md" in text and edit in content and dot
        return ("PASS" if ok else "FAIL"), (f"sidebar shows {folder}={folder in text}; editor has the edit={edit in content}; "
                                            f"unsaved dot={dot}; WebDriver window handles={handles}")

    def terminal_clipboard(self, title):
        """#130: Omarchy's Super+V / Super+C reach SparkDown as plain
        Ctrl+V / Ctrl+C. Real X key events (xdotool) into the terminal:
        Ctrl+V pastes the clipboard, Shift+Insert pastes, and Ctrl+C with no
        selection still interrupts the running job."""
        import shutil
        if not shutil.which("xclip"):
            return "MANUAL", "xclip is not installed on this runner"
        if not self._wd_handle(title):
            return "MANUAL", "WebDriver can't reach the window"
        self.kill_job()
        out1, out2 = pathlib.Path("/tmp/sd130-ctrlv.txt"), pathlib.Path("/tmp/sd130-shiftins.txt")
        for o in (out1, out2):
            o.unlink(missing_ok=True)

        def clip(text):
            # xclip forks to keep serving the selection; run() returns then.
            subprocess.run(["xclip", "-selection", "clipboard"], input=text, text=True, timeout=10)

        def focus_term():
            # As start_job: hide and show the drawer so the terminal is up.
            self.wd.click(self.wd.find("#btn-terminal"))
            time.sleep(1.5)
            self.wd.click(self.wd.find("#btn-terminal"))
            time.sleep(2)
            ta = self.wd.find(".xterm-helper-textarea", wait=20)
            self.wd.js("arguments[0].focus()", {wd.ELEM: ta})
            sh("xdotool", "windowactivate", "--sync", self._wid(title))
            time.sleep(1)

        focus_term()
        clip(f"echo SD130V > {out1}")
        sh("xdotool", "key", "--clearmodifiers", "ctrl+v")
        time.sleep(1)
        sh("xdotool", "key", "Return")
        v_ok = flow.wait_for(lambda: out1.exists() and "SD130V" in out1.read_text(), 10)
        clip(f"echo SD130I > {out2}")
        sh("xdotool", "key", "--clearmodifiers", "shift+Insert")
        time.sleep(1)
        sh("xdotool", "key", "Return")
        i_ok = flow.wait_for(lambda: out2.exists() and "SD130I" in out2.read_text(), 10)
        sh("xdotool", "type", "--delay", "40", "sleep 300")
        sh("xdotool", "key", "Return")
        started = flow.wait_for(self.job_alive, 10)
        sh("xdotool", "key", "--clearmodifiers", "ctrl+c")
        stopped = flow.wait_for(lambda: not self.job_alive(), 10)
        self.shot("terminal-clipboard")
        if not stopped:
            self.kill_job()
        ok = v_ok and i_ok and started and stopped
        return ("PASS" if ok else "FAIL"), (f"Ctrl+V pasted={bool(v_ok)}; Shift+Insert pasted={bool(i_ok)}; "
                                            f"Ctrl+C (no selection) interrupted sleep={bool(started and stopped)}")

    def shot(self, name):
        self.n += 1
        subprocess.run(["import", "-window", "root", str(pathlib.Path(OUT) / f"{self.n:02d}-{name}.png")], capture_output=True)

    def stop(self):
        if self.wd:
            self.wd.quit()
        subprocess.run(["pkill", "-x", "sparkdown"])
        self.driver.terminate()


class Hypr(Base):
    close_how = "Hyprland closewindow (what Super+W does)"

    def _clients(self):
        try:
            return [c for c in json.loads(sh("hyprctl", "clients", "-j")) if c.get("mapped")]
        except ValueError:
            return []

    def start(self, folder):
        subprocess.Popen([BIN, folder], stdout=self.log, stderr=subprocess.STDOUT, env=fixtures.app_env())
        time.sleep(6)

    def relaunch(self):
        subprocess.Popen([BIN], stdout=self.log, stderr=subprocess.STDOUT, env=fixtures.app_env())
        time.sleep(8)

    def windows(self):
        return [c["title"] for c in self._clients() if is_main(c["title"])]

    def _addr(self, title):
        return next((c["address"] for c in self._clients() if c["title"] == title), None)

    def foreground(self):
        try:
            return json.loads(sh("hyprctl", "activewindow", "-j")).get("title")
        except ValueError:
            return None

    def focus(self, title):
        a = self._addr(title)
        if a:
            sh("hyprctl", "dispatch", "focuswindow", f"address:{a}")
        time.sleep(0.7)

    def wtype(self, *args):
        sh("wtype", *args)
        time.sleep(0.3)

    def new_window_keys(self, title):
        self.focus(title)
        self.wtype("-M", "ctrl", "-M", "shift", "n", "-m", "shift", "-m", "ctrl")

    def quit_keys(self, title):
        self.focus(title)
        self.wtype("-M", "ctrl", "q", "-m", "ctrl")

    def save(self, title):
        self.focus(title)
        self.wtype("-M", "ctrl", "s", "-m", "ctrl")
        time.sleep(1)

    def close_window(self, title):
        a = self._addr(title)
        sh("hyprctl", "dispatch", "closewindow", f"address:{a}")
        time.sleep(1)

    def start_job(self, title):
        self.focus(title)
        self.wtype("-M", "ctrl", "-k", "grave", "-m", "ctrl")
        time.sleep(1.5)
        self.wtype("-M", "ctrl", "-k", "grave", "-m", "ctrl")
        time.sleep(4)
        self.wtype("sleep 300")
        self.wtype("-k", "Return")
        time.sleep(3)

    def dialogs(self):
        return with_text([{"name": c["title"], "id": c["address"], "text": None} for c in self._clients() if c["title"] in DIALOG_TITLES])

    def cancel_dialog(self, d):
        sh("hyprctl", "dispatch", "focuswindow", f"address:{d['id']}")
        time.sleep(0.5)
        self.wtype("-k", "Escape")
        time.sleep(1.5)
        if any(x["id"] == d["id"] for x in self.dialogs()):
            # Closing the dialog window answers it like Cancel (GTK delete-event).
            R.log("Escape didn't close the dialog; closing it via hyprctl")
            sh("hyprctl", "dispatch", "closewindow", f"address:{d['id']}")
            time.sleep(1.5)

    def window_menu(self, names):
        # No WebDriver or pointer here: press the in-app menu button over
        # AT-SPI (WebKitGTK exposes web content), then read the GTK popup.
        title = names[0] + SUF
        self.focus(title)
        out = pathlib.Path(OUT) / "atspi-click.json"
        err = pathlib.Path(OUT) / "atspi-click.err"
        with open(out, "w") as f, open(err, "w") as e:
            # Don't wait: the press's D-Bus reply can block while the popup is up.
            clicker = subprocess.Popen(["/usr/bin/python3", str(pathlib.Path(__file__).with_name("atspi_click.py")), title, "Open menu"],
                                       stdout=f, stderr=e)
        time.sleep(4)
        click = {"ok": False, "how": (err.read_text()[-200:] or "no answer from atspi_click")}
        for line in out.read_text().splitlines():
            try:
                click = json.loads(line)
            except ValueError:
                pass
        R.log("at-spi click:", click)
        self.shot("app-menu-open")

        def dismiss():
            # Always close the popup: one left up breaks every later check.
            # Escape doesn't reach it here, so activate this window's own
            # Window-menu entry (it only focuses this window), over AT-SPI.
            try:
                p = subprocess.Popen(["/usr/bin/python3", str(pathlib.Path(__file__).with_name("atspi_menu.py")),
                                      "--activate", names[0]], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                time.sleep(3)
                p.kill()
                R.log("menu dismissed via:", (p.stdout.read() or "")[-200:])
            except Exception as e:  # noqa: BLE001
                R.log("menu dismiss failed:", e)
            self.wtype("-k", "Escape")
            time.sleep(0.5)
            self.focus(title)
            self.shot("app-menu-closed")

        try:
            if not click.get("ok"):
                dismiss()
                return "MANUAL", (f"couldn't open the in-app menu without a pointer ({click.get('how', '')[:200]}); "
                                  "covered on Ubuntu and by unit tests")
            st, detail = read_window_menu(names, dismiss)
            if st == "PARTIAL":
                # Nothing readable: we can't tell whether the press opened it.
                return "MANUAL", f"pressed {click.get('how')}, but no GTK popup was readable over AT-SPI; covered on Ubuntu and by unit tests"
            return st, detail + f" (opened by AT-SPI: {click.get('how')})"
        finally:
            time.sleep(1)
            clicker.kill()

    def shot(self, name):
        self.n += 1
        subprocess.run(["grim", str(pathlib.Path(OUT) / f"{self.n:02d}-{name}.png")], capture_output=True, timeout=20)

    def stop(self):
        subprocess.run(["pkill", "-x", "sparkdown"])


def main():
    D = X11() if MODE == "x11" else Hypr()
    try:
        flow.run(R, D)
    finally:
        D.stop()
    if MODE == "hyprland":
        R.manual("manual-omarchy", "Real Omarchy config (keybindings, Waybar, walker) and a real GPU",
                 "container runs stock Hyprland on a virtual display with software rendering")
    else:
        R.manual("manual-linux-dialog", "Quit prompt look on a real GTK desktop", "CI reads its text over AT-SPI where available; theme and layout are only in the screenshot")
    return R.write()


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
