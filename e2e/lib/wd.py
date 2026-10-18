"""Minimal W3C WebDriver client (no Selenium dependency)."""
import base64
import json
import time
import urllib.error
import urllib.request

ELEM = "element-6066-11e4-a52e-4f735466cecf"
KEYS = {"enter": "\ue007", "ctrl": "\ue009", "shift": "\ue008", "esc": "\ue00c", "meta": "\ue03d"}


class WebDriverError(RuntimeError):
    pass


class Session:
    def __init__(self, base, caps, timeout=120):
        self.base = base.rstrip("/")
        r = self._req("POST", "/session", {"capabilities": {"alwaysMatch": caps}}, timeout=timeout)
        self.id = r["sessionId"]

    def _req(self, method, path, body=None, timeout=60):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as f:
                return json.load(f).get("value")
        except urllib.error.HTTPError as e:
            raise WebDriverError(f"{method} {path}: {e.code} {e.read().decode()[:400]}") from None

    def cmd(self, method, path, body=None, timeout=60):
        return self._req(method, f"/session/{self.id}{path}", body, timeout)

    def handles(self):
        return self.cmd("GET", "/window/handles")

    def switch(self, h):
        self.cmd("POST", "/window", {"handle": h})

    def js(self, script, *args):
        return self.cmd("POST", "/execute/sync", {"script": script, "args": list(args)})

    def js_async(self, script, *args, timeout=30):
        return self.cmd("POST", "/execute/async", {"script": script, "args": list(args)}, timeout=timeout)

    def find(self, css, wait=10):
        end = time.time() + wait
        while True:
            try:
                return self.cmd("POST", "/element", {"using": "css selector", "value": css})[ELEM]
            except WebDriverError:
                if time.time() > end:
                    raise
                time.sleep(0.5)

    def find_xpath(self, xp, wait=10):
        end = time.time() + wait
        while True:
            try:
                return self.cmd("POST", "/element", {"using": "xpath", "value": xp})[ELEM]
            except WebDriverError:
                if time.time() > end:
                    raise
                time.sleep(0.5)

    def click(self, el):
        self.cmd("POST", f"/element/{el}/click", {})

    def type(self, el, text):
        self.cmd("POST", f"/element/{el}/value", {"text": text})

    def chord(self, *keys):
        """Press keys together, e.g. chord('ctrl', 'q')."""
        seq = [KEYS.get(k, k) for k in keys]
        actions = [{"type": "keyDown", "value": k} for k in seq] + [{"type": "keyUp", "value": k} for k in reversed(seq)]
        self.cmd("POST", "/actions", {"actions": [{"type": "key", "id": "kbd", "actions": actions}]})
        try:
            self.cmd("DELETE", "/actions")
        except WebDriverError:
            pass

    def screenshot(self, path):
        try:
            png = self.cmd("GET", "/screenshot", timeout=30)
            open(path, "wb").write(base64.b64decode(png))
        except Exception:  # noqa: BLE001
            pass

    def quit(self):
        try:
            self.cmd("DELETE", "", timeout=20)
        except Exception:  # noqa: BLE001
            pass


TITLE_JS = """
const done = arguments[arguments.length - 1];
try {
  const T = window.__TAURI_INTERNALS__;
  const label = T.metadata.currentWindow.label;
  T.invoke('plugin:window|title', { label }).then(t => done({label, title: t}), e => done({label, title: null, err: String(e)}));
} catch (e) { done({label: null, title: null, err: String(e)}); }
"""


def map_windows(s, log=print):
    """{title: handle} for every webview WebDriver can see."""
    out = {}
    for h in s.handles():
        try:
            s.switch(h)
            r = s.js_async(TITLE_JS)
            log(f"handle {h[:8]}: {r}")
            if r and r.get("title"):
                out[r["title"]] = h
        except WebDriverError as e:
            log(f"handle {h[:8]}: {e}")
    return out
