# Benchmark runbook — Paulo's Mac (Apple Silicon)

Compares SparkDown Tauri 0.4.1 with the native spike using the same script and
method as the CI pass. Takes about 25–35 minutes. Do not use the Mac while it
runs (it launches and quits each app ~40 times and sends one Cmd+D keystroke
per "loaded" run).

## Before you start
1. Quit SparkDown (the script refuses to run while it is open). Your SparkDown
   config (`~/Library/Application Support/com.sparkdown.editor`) is backed up
   and restored automatically, even if the script is interrupted (Ctrl+C).
2. Xcode or the Command Line Tools must be installed (`swiftc` builds a small probe).
3. Accessibility: the "loaded" scenario sends Cmd+D through System Events. The
   first time, macOS asks to let your terminal app control the computer —
   allow it in System Settings → Privacy & Security → Accessibility.
   Screen Recording is only needed for the optional screenshots.
4. Cold starts use `sudo purge`. Run `sudo -v` right before the script so it
   can purge without a prompt; otherwise cold runs are recorded as `no-purge`
   (they're then warm runs and should be ignored).
5. Plug in power, close other heavy apps.

## Get the builds
```bash
mkdir -p ~/sdbench && cd ~/sdbench
curl -fLO https://github.com/sparkdown/sparkdown/releases/download/v0.4.1/SparkDown_0.4.1_aarch64.dmg
# Native spike: download the "SparkDownNative-spike" artifact from the latest
# native-mac-spike workflow run on branch spike/native-mac, unzip it here.
git clone --depth 1 --branch spike/native-mac https://github.com/sparkdown/sparkdown.git sd-spike
```

## Run
```bash
cd ~/sdbench
sudo -v
sd-spike/native-mac/bench/bench.sh \
  --tauri SparkDown_0.4.1_aarch64.dmg \
  --native dist/SparkDownNative_spike_aarch64.dmg \
  --runs 5 --cat-runs 3 --out ~/sdbench/results-$(date +%Y%m%d-%H%M)
```
Results: `summary.md` (median, range, n), `runs.csv` (every run), `sizes.csv`,
`bench.log`, and screenshots of the loaded scenario.

## What each number means (identical for both apps)
- **Launch**: the app's executable is started directly with the same
  environment (`ZDOTDIR` points at a benchmark `.zshrc`, `SHELL=/bin/zsh`).
- **First window**: first on-screen, layer-0 window ≥200×200 owned by the app
  process (CGWindowList, polled every 2 ms).
- **Interactive**: the restored terminal's zsh finished `.zshrc` (timestamp
  written by the shell). It means the UI, the terminal and its pty are up.
- **Cold**: after `sudo purge`; **warm**: immediately repeated launch.
- **Idle RAM**: no folder, welcome screen, 10 s after launch.
- **Loaded RAM**: restored folder with 5 open tabs and a terminal, Cmd+D to
  split a second terminal, 10 s settle.
- RAM = `phys_footprint` (what Activity Monitor calls Memory) of the app process
  plus the XPC helpers it's responsible for (WebKit WebContent, Networking and
  GPU processes). Shells running in the terminals are excluded for both apps.
- **Throughput**: 2 s after the first terminal's shell starts, it `cat`s a
  100 MB base64 text file, then sends a cursor-position query (`ESC[6n`). The
  terminal answers only after it has parsed everything before it, so the time
  to the answer is "terminal consumed 100 MB". The time for `cat` alone (pty
  drain) and the grid size are in `runs.csv` as `pty_drain_s` / `grid`.
- WebKit helpers are attributed by macOS responsibility, or failing that as
  WebKit processes started after the app launched — so keep Safari and other
  WebKit apps closed during the run.
