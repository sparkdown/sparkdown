"""Windows E2E: the real sparkdown.exe (built with --features e2e-webdriver),
WebDriver (msedgedriver attached over CDP) for web content and input, UI
Automation for windows, dialogs and the popup menu.
Usage: python e2e/windows/run.py sparkdown.exe msedgedriver.exe OUT_DIR"""
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

EXE, DRIVER, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
R = Report("Windows" + fixtures.variant(), OUT)
UIA = str(pathlib.Path(__file__).with_name("uia.ps1"))
PORT = 9222
SUF = flow.SUF


def uia(*args, timeout=40):
    p = subprocess.run(["pwsh", "-NoProfile", "-File", UIA, *args], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if p.returncode:
        R.log(f"uia {args[0]} error: {p.stderr.strip()[:300]}")
        return None
    try:
        return json.loads(p.stdout) if p.stdout.strip() else None
    except ValueError:
        R.log(f"uia {args[0]} non-JSON: {p.stdout[:200]}")
        return None


class Desktop:
    exe = EXE
    job_name = "ping"
    close_how = "the in-app close button (×)"

    def __init__(self):
        self.env = dict(os.environ, SPARKDOWN_E2E_WEBVIEW2_ARGS=f"--remote-debugging-port={PORT}")
        self.log = open(pathlib.Path(OUT) / "app.log", "a")
        self.driver = subprocess.Popen([DRIVER, "--port=9515", f"--log-path={pathlib.Path(OUT) / 'msedgedriver.log'}"])
        self.wd = None
        self.n = 0
        self.app = None

    def _attach(self):
        if self.wd:
            self.wd.quit()
        for _ in range(30):
            try:
                self.wd = wd.Session("http://127.0.0.1:9515", {"browserName": "webview2", "ms:edgeOptions": {"debuggerAddress": f"127.0.0.1:{PORT}"}})
                return
            except Exception as e:  # noqa: BLE001
                R.log("attach retry:", str(e)[:120])
                time.sleep(2)
        raise RuntimeError("could not attach msedgedriver to the app's WebView2")

    def start(self, folder):
        self.app = subprocess.Popen([EXE, folder], env=self.env, stdout=self.log, stderr=subprocess.STDOUT)
        time.sleep(8)
        self._attach()

    def relaunch(self):
        self.app = subprocess.Popen([EXE], env=self.env, stdout=self.log, stderr=subprocess.STDOUT)
        time.sleep(10)
        self._attach()

    def cli(self, folder):
        subprocess.run([EXE, folder], env=self.env, timeout=30, capture_output=True)
        time.sleep(1)

    def procs(self):
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq sparkdown.exe", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
        return sum(1 for line in out.splitlines() if line.startswith('"sparkdown.exe"'))

    def windows(self):
        ws = uia("windows") or []
        return [w["name"] for w in ws if w.get("name", "").endswith("SparkDown")]

    def foreground(self):
        return uia("foreground")

    def handle(self, title):
        m = wd.map_windows(self.wd, R.log)
        if title not in m:
            raise RuntimeError(f"no webview for {title!r}; WebDriver sees {list(m)}")
        self.wd.switch(m[title])
        return m[title]

    def focus(self, title):
        self.handle(title)
        try:
            self.wd.js_async("const d=arguments[arguments.length-1]; const T=window.__TAURI_INTERNALS__; "
                             "T.invoke('plugin:window|set_focus',{label:T.metadata.currentWindow.label}).then(()=>d(1),e=>d(String(e)))")
        except wd.WebDriverError as e:
            R.log("set_focus:", e)
        time.sleep(0.5)

    def keys(self, title, *chord):
        self.handle(title)
        self.wd.find("body")
        self.wd.chord(*chord)

    def new_window_keys(self, title):
        self.keys(title, "ctrl", "shift", "N")

    def quit_keys(self, title):
        self.keys(title, "ctrl", "q")

    def focus_editor(self, title):
        """Take focus out of a restored terminal: xterm keeps plain Ctrl+Q."""
        self.handle(title)
        self.wd.click(self.wd.find(".cm-content"))

    def save(self, title):
        self.handle(title)
        self.wd.click(self.wd.find(".cm-content"))
        self.wd.chord("ctrl", "s")
        time.sleep(1)

    def close_window(self, title):
        self.handle(title)
        self.wd.click(self.wd.find("#btn-window-close"))
        time.sleep(1)

    def start_job(self, title):
        self.handle(title)
        self.wd.click(self.wd.find("#btn-terminal"))  # seeded open: hide…
        time.sleep(1.5)
        self.wd.click(self.wd.find("#btn-terminal"))  # …and show, focused
        ta = self.wd.find(".xterm-helper-textarea", wait=20)
        time.sleep(3)
        self.wd.type(ta, "ping -n 300 127.0.0.1" + wd.KEYS["enter"])
        time.sleep(3)

    def job_alive(self):
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq PING.EXE", "/NH"], capture_output=True, text=True).stdout
        return "PING.EXE" in out.upper()

    def kill_job(self):
        subprocess.run(["taskkill", "/IM", "PING.EXE", "/F"], capture_output=True)
        time.sleep(1)

    def dialogs(self):
        out = []
        for d in uia("dialogs") or []:
            out.append({"name": d["name"], "id": d["hwnd"], "text": f"{d['name']}\n{d['text']}", "buttons": d["buttons"]})
        return out

    def cancel_dialog(self, d):
        R.log("cancel:", uia("click", str(d["id"]), "Cancel"))
        time.sleep(1.5)

    def wait_ready(self, title):
        return wd.wait_ready(self.wd, title, R.log) if self.wd else (time.sleep(6) or None)

    def window_menu(self, names):
        title = names[0] + SUF
        self.handle(title)
        self.wd.click(self.wd.find("#btn-app-menu"))
        time.sleep(2)
        top = uia("menu") or []
        sub = uia("menu", "Window") or []
        self.shot("window-menu")
        left = uia("escape-menus")
        R.log("popup menus:", top, sub, "left open:", left)
        items = [i for m in sub for i in (m.get("sub") or [])]
        entries = [i for i in items if i in names or i in ("alpha", "beta", "gamma", "Untitled window")]
        if not items:
            return "FAIL", f"could not read the popup menu's Window submenu (menus: {top})"
        ok = sorted(entries) == sorted(names) and len(entries) == len(set(entries))
        return ("PASS" if ok else "FAIL"), f"Window submenu entries={entries} (items: {items[:14]})"

    def webview_check(self, title, folder, edit):
        self.handle(title)
        text = self.wd.js("return document.body.innerText")
        content = self.wd.js("return (document.querySelector('.cm-content')||{}).innerText || ''")
        dot = self.wd.js("return Array.from(document.querySelectorAll('*')).some(e => e.children.length===0 && e.textContent==='●')")
        self.wd.screenshot(str(pathlib.Path(OUT) / "webview-alpha.png"))
        ok = folder in text and "notes.md" in text and edit in content and dot
        return ("PASS" if ok else "FAIL"), f"sidebar shows {folder}={folder in text}; editor has the edit={edit in content}; unsaved dot={dot}"

    def shot(self, name):
        self.n += 1
        uia("shot", str(pathlib.Path(OUT) / f"{self.n:02d}-{name}.png"))

    def stop(self):
        if self.wd:
            self.wd.quit()
        subprocess.run(["taskkill", "/IM", "sparkdown.exe", "/F"], capture_output=True)
        self.driver.terminate()


def main():
    D = Desktop()
    try:
        flow.run(R, D)
    finally:
        D.stop()
    R.manual("manual-smartscreen", "SmartScreen and the installer (first run of the downloaded setup.exe)",
             "unsigned CI build; the upgrade path is covered by windows-package.yml")
    R.manual("manual-notifications", "Notifications, snap layouts, multi-monitor DPI", "not automatable on hosted runners")
    return R.write()


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
