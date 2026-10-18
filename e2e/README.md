# End-to-end tests (multi-window must-pass)

`.github/workflows/e2e.yml` builds the real app and drives it on free
GitHub-hosted runners. It runs on pull requests to `main` and by hand
(Actions → E2E → Run workflow). It never runs on tags or releases.

| Job | Runner | How it drives the app |
|---|---|---|
| macOS | macos-latest | Unsigned release `.app`; `osascript`/System Events (Accessibility is pre-granted to bash/osascript on hosted runners) for windows, menus, sheets and the Dock |
| Windows | windows-latest | `sparkdown.exe` built with `--features e2e-webdriver`; msedgedriver attached to WebView2 over CDP for web content and input; UI Automation (`e2e/windows/uia.ps1`) for windows, dialogs and the popup menu |
| Ubuntu | ubuntu-latest | Release binary (default features) under Xvfb + openbox; tauri-driver + WebKitWebDriver for web content; xdotool for windows; AT-SPI for the GTK quit dialog text and the Window submenu |
| Arch + Hyprland | ubuntu-latest, `archlinux:latest` container (`--privileged`) | The same Linux binary under Hyprland on a `vkms` virtual DRM device (seatd), with Omarchy's `focus_on_activate = true`; `hyprctl` for windows/focus, `wtype` for keys, `grim` for screenshots, AT-SPI to press the in-app menu button and read dialogs/menus |

All jobs use the app's own MCP tools (as an external agent with
`SPARKDOWN_FOLDER`) to check per-window routing and to read back buffers, so
"Cancel kept the unsaved edit" is verified from the app's state, not a
screenshot. Each job uploads `e2e-<os>` with screenshots, logs,
`results.json` and `summary.md`; the `summary` job aggregates every OS into one
table (`e2e-summary`).

Statuses: **PASS** (fully verified), **FAIL**, **PARTIAL** (verified only in
part, or blocked by a known app bug; the detail says which), **MANUAL** (not
automatable here). A job fails if any of its checks is FAIL; the summary job
fails if any OS has a FAIL or reported nothing.

App bugs the suite found are in [KNOWN_ISSUES.md](KNOWN_ISSUES.md). Checks
for open ones stay PARTIAL until the app is fixed (#95 is fixed by #96).

Artifacts per run: `e2e-macos`, `e2e-windows`, `e2e-ubuntu`,
`e2e-omarchy-hyprland` (screenshots, `e2e.log`, `app.log`, `results.json`,
`summary.md`; Windows adds `msedgedriver.log`, Hyprland adds the compositor
logs and package versions), `e2e-release-gate` (gate test output),
`e2e-summary` (all-OS table) and `e2e-linux-binary` (the tested binary, 7 days).

## The test-only `e2e-webdriver` feature

WebView2 154 ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` because wry always
sets its own browser arguments, so WebDriver can't attach to a normal build.
The cargo feature `e2e-webdriver` (off by default) makes the app append
`$SPARKDOWN_E2E_WEBVIEW2_ARGS` (e.g. `--remote-debugging-port=9222`). Without
the feature the env read is compiled out. Guards:

- `windows::tests::release_build_ignores_e2e_webview2_args`: a default build
  ignores the variable and passes no extra argument (runs in CI on every OS).
- `scripts/check-release-gate.sh`: fails if any workflow other than `e2e.yml`
  or any script mentions the feature, if it is ever a default feature, or
  if a given binary contains the gated code (the Linux job checks the
  release-built binary; the Windows job checks that the feature build *is*
  detected, as a positive control).

## Run locally

- macOS: build (`frontend/node_modules/.bin/tauri build --bundles app`), then
  `python3 e2e/macos/run.py src-tauri/target/release/bundle/macos/SparkDown.app out`.
  Your terminal needs Accessibility permission. It uses a fresh config, so
  quit your own SparkDown first.
- Linux X11: `xvfb-run -a dbus-run-session -- bash -c 'openbox & python3 e2e/linux/run.py x11 <binary> out'`
  (needs tauri-driver, WebKitWebDriver, xdotool, wmctrl, imagemagick).

## Remaining manual checks

These can't be automated on hosted runners. Check them by hand before a
release:

1. **Gatekeeper first launch (macOS):** download the signed, notarized DMG,
   open it, and launch it the first time. No "damaged"/"unidentified developer"
   prompt, and the app opens.
2. **SmartScreen (Windows):** run the downloaded `setup.exe` on a clean
   Windows 10/11. Note the SmartScreen prompt, then install and upgrade.
3. **Real Omarchy config and GPU:** on a real Omarchy machine (its keybindings,
   Waybar, walker, real GPU), run must-pass steps 2–4, 10–12. CI only covers
   stock Hyprland (plus Omarchy's `focus_on_activate`) on a virtual display
   with software rendering, no Waybar/walker, no real input devices.
4. **Gestures:** trackpad swipe between windows/Spaces, pinch, and scrolling
   feel on macOS.
5. **Spaces / Mission Control (macOS):** windows on different Spaces, and
   the Window menu and dock reopen with windows on another Space.
6. **Notifications:** any OS notification the app raises shows correctly
   (macOS Notification Center, Windows toasts, mako on Omarchy).
7. **Quit prompt look on Linux:** CI reads the GTK dialog's text over AT-SPI;
   check its theme and layout once on a real desktop.
8. **Open Folder dialog:** CI opens folders with `sparkdown <dir>` (same routing
   code); pick a folder once in the native dialog per OS.
