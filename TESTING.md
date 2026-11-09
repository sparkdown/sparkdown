# Terminal comfort — box QA (Linux)

Prep tip: `prep/terminal-comfort` (includes `f49a094` + whitespace trim).
Do **not** merge this PR until Sparky reports a passing box test and Paulo gives the go.

## Binary

| Item | Path |
|---|---|
| Debug binary (built on this box from prep) | `/workspace/prep/terminal-comfort/bin/sparkdown-debug` |
| Same build artifact (Cargo target) | `/workspace/build-env/target-comfort/debug/sparkdown` |
| SHA-256 | `e64663397bba9a88d86efb5c4dfbf14cd1110849bf7483c8354ca34cd6dea437` |
| Record-only `xdg-open` | `/workspace/local-night/gui-test/opener/xdg-open` (appends `http(s)` URLs to `/workspace/local-night/gui-test/external-opens.log`) |

### Rebuild (if the binary is missing)

```bash
source /workspace/build-env/env.sh
export RUSTUP_TOOLCHAIN=stable
export PATH="/home/box/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$PATH"
export CARGO_INCREMENTAL=0
export CARGO_BUILD_JOBS=1
export CARGO_TARGET_DIR=/workspace/build-env/target-comfort

cd /workspace/prep/terminal-comfort/frontend
npm test
npm run build

cd /workspace/prep/terminal-comfort/src-tauri
cargo build
mkdir -p /workspace/prep/terminal-comfort/bin
cp -f /workspace/build-env/target-comfort/debug/sparkdown /workspace/prep/terminal-comfort/bin/sparkdown-debug
```

## Launch with a fresh XDG config root (X display)

This box already has `DISPLAY=:4`. Use a **new** config root so you do not touch a real user profile.

```bash
source /workspace/build-env/env.sh
export DISPLAY=:4
export XDG_CONFIG_HOME=/tmp/sparkdown-comfort-qa-config
export XDG_DATA_HOME=/tmp/sparkdown-comfort-qa-data
export XDG_CACHE_HOME=/tmp/sparkdown-comfort-qa-cache
rm -rf "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" /tmp/sparkdown-comfort-qa-project
# Put the record-only opener first on PATH so link opens are logged, not sent to a browser.
export PATH=/workspace/local-night/gui-test/opener:$PATH
: > /workspace/local-night/gui-test/external-opens.log

/workspace/prep/terminal-comfort/bin/sparkdown-debug /tmp/sparkdown-comfort-qa-project
```

Config file the app writes (Linux / Tauri `app_config_dir`):

```text
$XDG_CONFIG_HOME/com.sparkdown.editor/config.json
# e.g. /tmp/sparkdown-comfort-qa-config/com.sparkdown.editor/config.json
```

Confirm the key after Settings changes:

```bash
python3 -c "import json; p='/tmp/sparkdown-comfort-qa-config/com.sparkdown.editor/config.json'; c=json.load(open(p)); print('terminal_scrollback=', c.get('terminal_scrollback')); print('path=', p)"
```

## Four checks

### 1) Settings scrollback persists across a restart

1. Open Settings (`Ctrl+,`).
2. Find the single **Terminal scrollback** field (`[data-setting-scrollback]`).
3. Set it to a non-default value in range 200..50000 (e.g. `350`), leave the field so the debounced save runs (Tab or close Settings), wait ~1s.
4. Confirm the live file shows that value (command above).
5. Quit the app fully, launch again with the **same** `XDG_CONFIG_HOME` / `XDG_DATA_HOME`.
6. Pass if Settings still shows `350` **and** `config.json` still has `"terminal_scrollback": 350`.

### 2) Link clicks (record-only opener)

With `PATH` including `/workspace/local-night/gui-test/opener` and an empty `external-opens.log`:

1. In the terminal pane, print a plain https URL, e.g. `printf 'see https://example.com/comfort-qa\n'`.
2. **Plain left click** the URL (no Ctrl/Cmd).
3. **Ctrl+click** (Linux) or **Cmd+click** the same URL.
4. Inspect `/workspace/local-night/gui-test/external-opens.log`.

**QA gate to report:** plain left click does nothing; Ctrl/Cmd+click opens (one `https://…` line in the log).

**Code note (prep tip):** current handlers open on primary `button === 0` with no modifier check (`frontend/src/terminal.ts` OSC8 + detected-link `activate`). Report **actual** behavior vs the gate above; do not pass the gate if plain left click already opens.

Right/middle click must not open. Only `http`/`https` may open.

### 3) Find (`Ctrl+Shift+F`, Enter / Shift+Enter, Escape)

1. Focus a terminal pane and generate several matches (e.g. print `FIND_ALPHA` four times).
2. `Ctrl+Shift+F` — Find bar opens and its input is focused.
3. Type the query — match count updates (e.g. `1 of 4`).
4. `Enter` — next match; `Shift+Enter` — previous match.
5. `Escape` — Find closes; focus returns to the terminal.
6. Pass if all of the above hold on this box WebKit build.

### 4) Scrollback retention

1. With scrollback set (default 5000 or the value from check 1), emit more lines than the viewport (e.g. `seq 1 400`).
2. Scroll up (mouse wheel or scrollbar) and confirm earlier lines are still visible.
3. Optional: lower scrollback in Settings and confirm the buffer truncates toward the new cap (xterm behavior).
4. Pass if history above the viewport is retained up to the configured limit after the output burst.

## Local automated evidence already recorded (not a substitute for the four checks)

- Frontend: **857** tests / **61** files; `npm run build` OK — `/tmp/prep-logs/terminal-comfort-frontend.log`
- Rust: app **420** passed, **0** failed, **7** ignored; CLI **2**; MCP **2** — `/tmp/prep-logs/terminal-comfort-cargo-test.log`
- Clippy: `cargo clippy --all-targets -- -D warnings` exit 0 — `/tmp/prep-logs/terminal-comfort-clippy.log`
- `git diff --check` vs `origin/main`: PASS on tip after whitespace trim commit

## Out of scope for this box pass

- macOS / Windows GUI
- Claiming release readiness without Paulo’s merge go after Sparky’s report
