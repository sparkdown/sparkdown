"""Spike: launch the real sparkdown.exe through tauri-driver (WebDriver)."""
import json, os, subprocess, sys, tempfile, time, urllib.request, base64, pathlib

out = pathlib.Path(os.environ.get("OUT", "e2e-out")); out.mkdir(exist_ok=True)
exe, native = sys.argv[1], sys.argv[2]
log = open(out / "win-driver.log", "a")
def p(*a):
    s = " ".join(str(x) for x in a); print(s); log.write(s + "\n"); log.flush()

os.environ["RUST_LOG"] = "debug"
drv = subprocess.Popen(["tauri-driver", "--native-driver", native], stdout=log, stderr=log)
time.sleep(3)
def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request("http://127.0.0.1:4444" + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=120) as f:
            return json.load(f)
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()[:2000]}

folder = tempfile.mkdtemp(prefix="alpha")
open(os.path.join(folder, "notes.md"), "w").write("# A\n")
t = time.time()
s = req("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": exe, "args": [folder]}}}})
p("session", json.dumps(s)[:600], f"{time.time()-t:.1f}s")
ps = subprocess.run(["pwsh", "-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name like 'sparkdown%' or Name like 'msedgewebview2%'\" | Select-Object -First 6 ProcessId,Name,@{n='cmd';e={$_.CommandLine.Substring(0,[Math]::Min(300,$_.CommandLine.Length))}} | Format-List | Out-String -Width 400"], capture_output=True, text=True)
p("procs during session", ps.stdout)
sid = s.get("value", {}).get("sessionId")
ok = bool(sid)
if sid:
    time.sleep(4)
    p("title", req("GET", f"/session/{sid}/title"))
    p("handles", req("GET", f"/session/{sid}/window/handles"))
    p("js", req("POST", f"/session/{sid}/execute/sync", {"script": "return [document.title, location.href, !!window.__TAURI_INTERNALS__]", "args": []}))
    p("find editor", json.dumps(req("POST", f"/session/{sid}/elements", {"using": "css selector", "value": ".cm-content"}))[:300])
    shot = req("GET", f"/session/{sid}/screenshot").get("value")
    if isinstance(shot, str):
        (out / "win-webdriver.png").write_bytes(base64.b64decode(shot))
    # UIA view of the same process's top-level windows
    ps = subprocess.run(["pwsh", "-NoProfile", "-File", "e2e/spike/win-uia.ps1"], capture_output=True, text=True)
    p("uia", ps.stdout, ps.stderr)
    p("handles after ctrl+shift+n", req("GET", f"/session/{sid}/window/handles"))
    req("DELETE", f"/session/{sid}")
drv.terminate()
sys.exit(0 if ok else 1)
