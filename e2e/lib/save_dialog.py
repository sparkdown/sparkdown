"""Save dialog start folder (0.4.1, from the Mac test of 16e9543).

Untitled + Ctrl+S must start the native Save dialog in the opened folder,
not its parent. The dialog plugin is fed `<folder>/untitled.md`; a bare
"untitled.md" used to reach it, so no directory was set and the OS fell back
to its last-used place. Over WebDriver we capture what the webview hands
`plugin:dialog|save` (and answer Cancel), which is the whole input the
native side gets; macOS reads the real sheet in e2e/macos/run.py."""
import time

HOOK = """
const T = window.__TAURI_INTERNALS__;
if (!T.__sdSaveHook) {
  const orig = T.invoke.bind(T);
  T.__sdSaveCalls = [];
  T.invoke = (cmd, args, opts) => {
    if (cmd === 'plugin:dialog|save') {
      T.__sdSaveCalls.push((args && args.options) || {});
      return Promise.resolve(null);
    }
    return orig(cmd, args, opts);
  };
  T.__sdSaveHook = orig;
}
T.__sdSaveCalls.length = 0;
return 1;
"""

UNHOOK = """
const T = window.__TAURI_INTERNALS__;
if (T.__sdSaveHook) { T.invoke = T.__sdSaveHook; delete T.__sdSaveHook; }
return 1;
"""


def key(w, k):
    w.js("document.dispatchEvent(new KeyboardEvent('keydown',"
         "{key: arguments[0], ctrlKey: true, bubbles: true, cancelable: true})); return 1;", k)


def run(R, D, title, folder):
    if not hasattr(D, "_wd_handle") or not D._wd_handle(title):
        return "MANUAL", "WebDriver can't reach the window here"
    w = D.wd
    w.js(HOOK)
    try:
        key(w, "n")
        time.sleep(1)
        key(w, "s")
        end = time.time() + 10
        calls = []
        while time.time() < end and not calls:
            calls = w.js("return window.__TAURI_INTERNALS__.__sdSaveCalls.slice()") or []
            time.sleep(0.3)
    finally:
        w.js(UNHOOK)
    if not calls:
        return "FAIL", "Ctrl+S on an Untitled tab never opened the Save dialog"
    got = calls[-1].get("defaultPath") or ""
    norm = lambda p: p.replace("\\", "/").rstrip("/").lower()
    want = norm(folder) + "/untitled.md"
    ok = norm(got) == want
    return ("PASS" if ok else "FAIL"), f"defaultPath={got!r} (want {folder}/untitled.md)"
