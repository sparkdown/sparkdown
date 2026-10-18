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
import flow  # noqa: E402
import wd  # noqa: E402
from report import Report  # noqa: E402

MODE, BIN, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
R = Report("Ubuntu (X11, WebKitWebDriver)" if MODE == "x11" else "Arch + Hyprland (vkms)", OUT)
SUF = flow.SUF
DIALOG_TITLES = ("Quit SparkDown", "Unsaved Changes")


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
        self.driver = subprocess.Popen(["tauri-driver", "--native-driver", "/usr/bin/WebKitWebDriver"],
                                       stdout=self.log, stderr=subprocess.STDOUT)
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
        return [{"name": t, "id": w, "text": None} for w, t in self._xwins() if t in DIALOG_TITLES]

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
        sh("xdotool", "key", "Escape")
        time.sleep(0.5)
        sh("xdotool", "key", "Escape")
        return "PARTIAL", ("menu popup opened (screenshot); its native GTK entries can't be read by "
                           "WebDriver or xdotool; the entry model is unit-tested (window_menu_has_one_entry_per_live_window)")

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
        subprocess.Popen([BIN, folder], stdout=self.log, stderr=subprocess.STDOUT)
        time.sleep(6)

    def relaunch(self):
        subprocess.Popen([BIN], stdout=self.log, stderr=subprocess.STDOUT)
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
        return [{"name": c["title"], "id": c["address"], "text": None} for c in self._clients() if c["title"] in DIALOG_TITLES]

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
        return "MANUAL", "no WebDriver here and the GTK popup isn't inspectable; covered as PARTIAL on Ubuntu and by unit tests"

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
        R.manual("manual-linux-dialog", "Quit prompt wording on GTK", "dialog text isn't readable here; read it on a desktop")
    return R.write()


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
