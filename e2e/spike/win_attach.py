"""Spike B: launch sparkdown.exe ourselves with a WebView2 CDP port, attach msedgedriver
(debuggerAddress), and see whether every window's webview is a WebDriver window handle."""
import json, os, subprocess, sys, tempfile, time, urllib.request, base64, pathlib
out = pathlib.Path(os.environ.get("OUT", "e2e-out")); out.mkdir(exist_ok=True)
exe, native = sys.argv[1], sys.argv[2]
log = open(out / "win-attach.log", "a")
def p(*a):
    s = " ".join(str(x) for x in a); print(s); log.write(s + "\n"); log.flush()
def get(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as f: return json.load(f)
    except Exception as e: return {"err": str(e)}
def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request("http://127.0.0.1:9515" + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=120) as f: return json.load(f)
    except urllib.error.HTTPError as e: return {"http_error": e.code, "body": e.read().decode()[:1500]}
for f in ("alpha", "beta"):
    d = os.path.join(tempfile.gettempdir(), f); os.makedirs(d, exist_ok=True); open(os.path.join(d, "notes.md"), "w").write(f"# {f}\n")
A, B = (os.path.join(tempfile.gettempdir(), f) for f in ("alpha", "beta"))
env = dict(os.environ, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222")
app = subprocess.Popen([exe, A], env=env)
time.sleep(10)
p("cdp targets (1 folder)", json.dumps([(t.get("type"), t.get("title"), t.get("url")) for t in get("http://127.0.0.1:9222/json")] if isinstance(get("http://127.0.0.1:9222/json"), list) else get("http://127.0.0.1:9222/json")))
subprocess.run([exe, B], env=env, timeout=30)   # second launch: single-instance forwards it
time.sleep(8)
t = get("http://127.0.0.1:9222/json")
p("cdp targets (2 folders)", json.dumps([(x.get("type"), x.get("title"), x.get("url")) for x in t] if isinstance(t, list) else t))
drv = subprocess.Popen([native, "--port=9515", "--verbose", f"--log-path={out / 'msedgedriver.log'}"])
time.sleep(3)
s = req("POST", "/session", {"capabilities": {"alwaysMatch": {"browserName": "webview2", "ms:edgeOptions": {"debuggerAddress": "127.0.0.1:9222"}}}})
p("session", json.dumps(s)[:400])
sid = s.get("value", {}).get("sessionId")
if sid:
    h = req("GET", f"/session/{sid}/window/handles").get("value", [])
    p("handles", h)
    for i, hd in enumerate(h):
        req("POST", f"/session/{sid}/window", {"handle": hd})
        p("window", hd, req("POST", f"/session/{sid}/execute/sync", {"script": "return [document.title, location.href]", "args": []}))
        shot = req("GET", f"/session/{sid}/screenshot").get("value")
        if isinstance(shot, str): (out / f"win-attach-{i}.png").write_bytes(base64.b64decode(shot))
ps = subprocess.run(["pwsh", "-NoProfile", "-Command", "(Get-Process sparkdown -ErrorAction SilentlyContinue | Measure-Object).Count"], capture_output=True, text=True)
p("sparkdown process count", ps.stdout.strip())
uia = subprocess.run(["pwsh", "-NoProfile", "-File", "e2e/spike/win-uia.ps1"], capture_output=True, text=True)
p("uia", uia.stdout, uia.stderr[-800:])
drv.terminate(); app.terminate()
sys.exit(0 if sid else 1)
