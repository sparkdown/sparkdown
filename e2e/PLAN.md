# E2E plan: 0.4.0 multi-window must-pass on GitHub-hosted runners (draft for Sparky)

Branch: `e2e/multi-window` (off frozen main 77fc1cc). Spikes: `.github/workflows/e2e-spike.yml`, `e2e/spike/`.
Final spike run: https://github.com/sparkdown/sparkdown/actions/runs/39081607848

## Approach per OS
- macOS (macos-latest, macOS 26.6): unsigned release `.app` driven by `osascript`/System Events
  (Accessibility + AppleEvents + ScreenCapture are pre-granted to bash/osascript in the runner's TCC.db).
  The WKWebView content is visible through AX (sidebar, editor text, status bar), so no WebDriver needed.
- Windows (windows-latest): UIA (PowerShell) for native windows/dialogs; WebDriver (msedgedriver over CDP)
  for webview content. Needs a small app change: WebView2 154 ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  because wry always sets its own args, so the app must append that env var (test-only effect).
- Omarchy-like (ubuntu-latest + `archlinux:latest` container, --privileged): Hyprland 0.56 on a vkms DRM
  device (seatd), grim + hyprctl. WLR/AQ "headless" backends do not work with aquamarine.
  The app is built from source in Arch; WebKitWebDriver is not packaged in Arch's webkit2gtk-4.1, so it's hyprctl + wtype/ydotool + the app's own state.
