# Terminal comfort — box QA (Linux)

Prep tip: `prep/terminal-comfort` (includes `f49a094`, whitespace trim, and the box-retest fixes for Settings save, Ctrl/Cmd-only URL opens and tmux wheel scrolling).
Do **not** merge this PR until Sparky reports a passing box test and Paulo gives the go.

## Binary (standalone: frontend bundled, no vite / dev server)

The retest binary embeds the built frontend (`cargo build --features tauri/custom-protocol`),
so it loads `tauri://localhost` and needs **no** `npm run dev` / port 1420.

| Item | Path |
|---|---|
| Standalone debug binary | `/workspace/prep/terminal-comfort/bin/sparkdown-standalone` |
| SHA-256 | `/workspace/prep/terminal-comfort/bin/sparkdown-standalone.sha256` |
| Built from | PR #184 head (see `git -C /workspace/prep/terminal-comfort log -1`) |
| Record-only `xdg-open` | `/workspace/local-night/gui-test/opener/xdg-open` (appends `http(s)` URLs to `/workspace/local-night/gui-test/external-opens.log`) |

The old `bin/sparkdown-debug` (e646633…) is a dev-server build of the previous head: do not use it for the retest.

### Rebuild (if the binary is missing)

```bash
source /workspace/build-env/env.sh
export RUSTUP_TOOLCHAIN=stable
export PATH="/home/box/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$PATH"
export CARGO_INCREMENTAL=0
export CARGO_BUILD_JOBS=1
export CARGO_TARGET_DIR=/workspace/build-env/target-comfort-fix

cd /workspace/prep/terminal-comfort/frontend
npm test
npm run build            # must run first: the binary embeds frontend/dist

cd /workspace/prep/terminal-comfort/src-tauri
cargo build --features tauri/custom-protocol
mkdir -p /workspace/prep/terminal-comfort/bin
cp -f "$CARGO_TARGET_DIR/debug/sparkdown" /workspace/prep/terminal-comfort/bin/sparkdown-standalone
```

## Launch with fresh roots (X display)

Use your own display and **new** roots. A private `TMUX_TMPDIR` keeps the app's tmux
server away from any other tmux server on the box.

```bash
source /workspace/build-env/env.sh
export DISPLAY=:2
R=/tmp/sparkdown-comfort-qa
tmux -S "$R/tmux/tmux-$(id -u)/default" kill-server 2>/dev/null
rm -rf "$R"; mkdir -p "$R"/{config,data,cache,tmux,runtime,project}; chmod 700 "$R/tmux" "$R/runtime"
export XDG_CONFIG_HOME=$R/config XDG_DATA_HOME=$R/data XDG_CACHE_HOME=$R/cache XDG_RUNTIME_DIR=$R/runtime TMUX_TMPDIR=$R/tmux
export PATH=/workspace/local-night/gui-test/opener:$PATH
: > /workspace/local-night/gui-test/external-opens.log

/workspace/prep/terminal-comfort/bin/sparkdown-standalone "$R/project"
```

Config file: `$XDG_CONFIG_HOME/com.sparkdown.editor/config.json`.

```bash
python3 -c "import json,os; p=os.environ['XDG_CONFIG_HOME']+'/com.sparkdown.editor/config.json'; c=json.load(open(p)); print('terminal_scrollback=', c.get('terminal_scrollback'), 'use_tmux=', c.get('use_tmux'))"
```

tmux state of the app's pane (same shell as above):

```bash
tmux -S "$TMUX_TMPDIR/tmux-$(id -u)/default" display -p -t "$(tmux -S "$TMUX_TMPDIR/tmux-$(id -u)/default" ls -F '#S' | head -1)" 'in_mode=#{pane_in_mode} pos=#{scroll_position}'
```

## Retest checks (what changed after the e646633 FAIL)

### 1) Settings scrollback persists

Root cause of the FAIL: the field had `step=100` based at `min=200`, so `350` was a
`stepMismatch`; the save handler bailed on `!validity.valid` and the value was dropped.
Now any whole number commits (Tab/blur, **Enter**, or closing Settings with ×/Escape);
out-of-range values clamp to 200..50000 and the field shows the clamp. A committed
Settings change is written to `config.json` immediately (no 2 s debounce).

1. `Ctrl+,` → **Scrollback lines** → select all, type `350`, press **Tab**, close Settings.
2. Pass: `config.json` shows `terminal_scrollback= 350` within ~1 s; reopening Settings shows `350`.
3. Quit (`Ctrl+Q`), relaunch with the same roots. Pass: Settings still `350`, config still `350`.

### 2) Link clicks

Root cause: URL activation required only the primary button, so the **plain left click**
opened (the 2nd open in the old log was the Ctrl+click). Right and middle clicks already
did not open. Now a URL opens only on **Ctrl+click** (Linux/Windows) or **Cmd+click** (macOS).
File paths in terminal output still open in the editor on a plain click (unchanged).

1. In the terminal: `printf 'see https://example.com/comfort-qa\n'`.
2. Hover (underline + hand pointer), then: plain left click, right click, middle click, Ctrl+click.
3. Pass: `external-opens.log` has exactly **one** line, `https://example.com/comfort-qa`, and it appears only after the Ctrl+click.

Note: on X11 a middle click is a *primary-selection paste* into the terminal (standard X11
terminal behavior, like xterm/GNOME Terminal). If you had text selected anywhere, it is
typed at the prompt. That is expected, not a link open.

### 3) Find (unchanged; regression check)

`Ctrl+Shift+F` focuses the input; type a query (e.g. `FIND_ALPHA` ×4 → `1 of 4`/`1 of 5`
including the echoed command); Enter / Shift+Enter move; Escape closes and returns focus to the terminal.

### 4) Scrollback / mouse wheel

Root cause: with `use_tmux` on (the default) tmux draws in xterm's **alternate screen**,
which has no scrollback, and tmux runs without its `mouse` option. xterm.js then turns the
wheel into Up/Down **keys**, so the wheel recalled shell history at the prompt (that can
look like a pasted path) and never scrolled; "394" was just the visible viewport.
Now the wheel on a tmux pane scrolls **tmux's own history** (copy mode, tmux
`history-limit`, default 2000), leaves copy mode when you scroll back to the bottom or
start typing, and never types at a prompt. Full-screen apps inside tmux (vim, less) still
get Up/Down. The Settings value applies to xterm's buffer, i.e. plain shells (`use_tmux` off).

With tmux on (default):
1. `seq 1 400`, wheel up. Pass: the view scrolls (a `[n/393]` copy-mode marker top-right), keeps going to `1`, and nothing appears at the prompt.
2. Wheel back down to the bottom. Pass: the marker disappears (copy mode left).
3. Wheel up a little, type `echo hi` + Enter. Pass: it runs in the shell (not swallowed by copy mode).

With tmux off (Settings → turn off tmux, then open a **new** terminal tab):
4. Scrollback 350, `seq 1 1000`, wheel to the top. Pass: oldest visible line is ~640–660 (350 lines above the viewport), not `1`.
5. Lower scrollback to 200 (Enter), wheel to the top again. Pass: the oldest line number rises (~790), live, without reopening the terminal.

## Local automated evidence (not a substitute for the box retest)

- Frontend: **866** tests / **61** files; `tsc && vite build` OK
- Rust: app **422** passed, **0** failed, **7** ignored (incl. a live tmux wheel test on a private socket); CLI **2**; MCP **2**
- `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings`: pass
- Native run of the standalone binary (fresh Xvfb, fresh XDG + tmux roots, own WebDriver port, real X pointer/wheel events via xdotool): all checks above pass, harness `/workspace/local-night/gui-test/fix184/run.py`, results `tmux-results.json` and `restart-plain-results.json` in that folder

## Out of scope for this box pass

- macOS / Windows GUI
- Claiming release readiness without Paulo’s merge go after Sparky’s report
