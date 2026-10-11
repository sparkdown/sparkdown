//! Embedded terminal backend.
//!
//! A pty (via `portable-pty`) hosts the user's real shell; the frontend renders
//! it with xterm.js. SparkDown never runs an agent itself — the user runs
//! `claude`, `codex`, `cursor-cli`, etc. in this shell exactly as they would in
//! any terminal. The value is that these terminals live beside the explorer /
//! editor / preview and share a working directory with them.
//!
//! Multiple terminals run in parallel, keyed by a frontend-supplied id (a
//! common workflow: one agent session per terminal, several at once). All
//! events carry the id so the frontend routes output to the right tab:
//!   - keystrokes -> `terminal_write {id}`  -> that pty's stdin
//!   - pty output -> `terminal://data` {id, chunk} -> that tab's xterm.js
//!   - shell/session exit -> `terminal://exit` {id}  (frontend closes that tab)

// portable-pty's own `MasterPty` trait is renamed on import so the term stays
// confined to this single alias. The crate's field names on `PtyPair`
// (`master`, `slave`) are destructured into inclusive names at every use site.
use portable_pty::{
    ChildKiller, CommandBuilder, MasterPty as PtyController, NativePtySystem, PtyPair, PtySize,
    PtySystem,
};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// The rc file a shell reads for interactive setup (PATH additions, aliases).
/// Empty for shells we don't special-case.
fn rc_source_for(shell_name: &str) -> &'static str {
    match shell_name {
        "zsh" => r#"[ -f "${ZDOTDIR:-$HOME}/.zshrc" ] && . "${ZDOTDIR:-$HOME}/.zshrc""#,
        "bash" => r#"[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc""#,
        _ => "",
    }
}

/// Login-shell wrapper that runs the agent chip's command (passed in
/// `$SPARKDOWN_LAUNCH`) once shell init has finished, then drops the user into
/// a fresh login shell when the agent exits. Running it as the shell's own
/// process (not typed keystrokes) removes the "typed before the prompt was
/// ready" race and submits the command immediately.
///
/// We source the interactive rc EXPLICITLY: when a shell runs `-c`, it comes
/// up non-interactive (verified: under tmux `zsh -lic` reports
/// `interactive=off`), so it never reads `~/.zshrc` on its own. Without this,
/// PATH additions there — e.g. the dir holding `claude` — are missing and the
/// agent fails with "command not found". Errors during sourcing (a stray
/// `bindkey` with ZLE absent) are non-fatal, so they are dropped. Unix only.
fn launch_wrapper(shell_name: &str) -> String {
    let rc = rc_source_for(shell_name);
    let prefix = if rc.is_empty() {
        String::new()
    } else {
        format!("{rc} 2>/dev/null; ")
    };
    format!(r#"{prefix}eval "$SPARKDOWN_LAUNCH"; exec "${{SHELL:-/bin/sh}}" -l"#)
}

/// PowerShell script (for `-Command`) that runs an agent chip's launch line
/// on Windows, the counterpart of [`launch_wrapper`]. The line travels in
/// `$env:SPARKDOWN_LAUNCH`, so it is never quoted into this script or into
/// the command line; the frontend (terminal.ts `powershellLaunchCommand`)
/// writes it in PowerShell syntax, and `Invoke-Expression` runs it in the
/// shell's own session, after the user's profile has loaded (we pass no
/// `-NoProfile`), like typing it at the prompt. `-NoExit` keeps that
/// PowerShell open when the agent exits, like `exec $SHELL -l` on Unix. The
/// variable is removed first so the agent and later commands do not inherit
/// it. The script holds no `"` and no `\`, so the Windows command-line
/// quoting of this one argument cannot change it.
pub(crate) const PS_LAUNCH_SCRIPT: &str = "& { $sparkdownLaunch = $env:SPARKDOWN_LAUNCH; \
     Remove-Item Env:SPARKDOWN_LAUNCH -ErrorAction SilentlyContinue; \
     Invoke-Expression $sparkdownLaunch }";

/// Arguments for a PowerShell (`pwsh` or `powershell.exe`) that runs the
/// `$env:SPARKDOWN_LAUNCH` line, then stays open (see [`PS_LAUNCH_SCRIPT`]).
pub(crate) fn powershell_launch_args() -> [&'static str; 4] {
    ["-NoLogo", "-NoExit", "-Command", PS_LAUNCH_SCRIPT]
}

/// The local (non-tmux) PTY command: the shell alone, or the shell running
/// an agent chip's `launch` line. `powershell` selects the Windows form
/// (a parameter, not `cfg!`, so both forms are unit-tested on every OS).
fn local_shell_command(
    shell: &ShellLaunch,
    launch: Option<&str>,
    powershell: bool,
) -> CommandBuilder {
    let mut c = CommandBuilder::new(&shell.program);
    match launch {
        Some(line) => {
            if powershell {
                c.args(powershell_launch_args());
            } else {
                c.arg("-lic");
                c.arg(launch_wrapper(&shell.name));
            }
            c.env("SPARKDOWN_LAUNCH", line);
        }
        None => {
            for arg in &shell.args {
                c.arg(arg);
            }
        }
    }
    c
}

/// Shell syntax for an agent chip's launch line: `"powershell"` for a local
/// terminal on Windows, else `"posix"`. A remote workspace is always POSIX,
/// also from Windows: its terminal runs the REMOTE login shell over ssh.
pub(crate) fn launch_shell_family(windows: bool, remote: bool) -> &'static str {
    if windows && !remote {
        "powershell"
    } else {
        "posix"
    }
}

/// Which syntax the frontend must use for an agent launch line right now
/// (see [`launch_shell_family`]).
#[tauri::command]
pub fn terminal_launch_shell() -> &'static str {
    launch_shell_family(cfg!(windows), crate::remote::is_active())
}

/// True when the process environment already selects a UTF-8 locale via any
/// of the standard variables. Used to avoid overriding the user's own locale
/// while still seeding one for a GUI process that inherited none.
fn has_utf8_locale() -> bool {
    ["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|k| {
        std::env::var(k)
            .map(|v| {
                let v = v.to_ascii_lowercase();
                v.contains("utf-8") || v.contains("utf8")
            })
            .unwrap_or(false)
    })
}

/// Program + args + short tab label for the user's interactive shell.
struct ShellLaunch {
    program: PathBuf,
    args: Vec<String>,
    name: String,
}

/// Pick the shell the embedded PTY should run.
///
/// Windows: PowerShell (pwsh if present, else Windows PowerShell). Windows
/// Terminal (`wt.exe`) is a GUI host, not something we can put in a ConPTY —
/// the user asked for "Windows Terminal or PowerShell"; PowerShell is the
/// actual shell. Unix: `$SHELL -l`, falling back to zsh.
fn default_shell() -> ShellLaunch {
    #[cfg(windows)]
    {
        if let Some(pwsh) = crate::context::find_on_path("pwsh.exe") {
            return ShellLaunch {
                name: "pwsh".into(),
                program: pwsh,
                args: vec!["-NoLogo".into()],
            };
        }
        let program =
            crate::context::find_on_path("powershell.exe").unwrap_or_else(windows_powershell_path);
        ShellLaunch {
            name: "powershell".into(),
            program,
            args: vec!["-NoLogo".into()],
        }
    }
    #[cfg(not(windows))]
    {
        let program = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let name = program
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("shell")
            .to_string();
        ShellLaunch {
            program: PathBuf::from(program),
            args: vec!["-l".into()],
            name,
        }
    }
}

#[cfg(windows)]
fn windows_powershell_path() -> PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    PathBuf::from(root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

/// Live pty handle: stdin writer + controller side (for resize). The child
/// (pane) side MUST be dropped after spawn — holding it open prevents the
/// controller from observing EOF when the shell exits on Unix (Linux keeps the
/// controller readable forever; the frontend then never gets `terminal://exit`
/// and the tab stays as a zombie). On Windows ConPTY, dropping the pane side
/// is nearly a no-op (controller and pane share one PseudoConsole Arc);
/// holding the controller for resize can keep the session alive so the output
/// pipe never EOFs after PowerShell exits — we therefore also wait on the
/// child and emit exit on process end.
pub struct Terminal {
    /// Keystrokes/paste are handed to a per-terminal writer thread through this
    /// channel instead of being written under the global terminal-map lock: a
    /// blocking pty `write_all` (e.g. a big paste into a program that isn't
    /// reading its input) would otherwise stall the main thread and make every
    /// other terminal's write/resize/close wait on the mutex. Dropping the
    /// sender (on close/replace) ends the writer thread.
    input_tx: mpsc::Sender<Vec<u8>>,
    controller: Box<dyn PtyController + Send>,
    /// Raised when this spawn is being replaced by a new one under the same id
    /// (a webview reload restarts frontend ids at `term-1`). The reader / child
    /// waiter / tmux watchdog threads check it and fall silent, so the old
    /// pty's `terminal://exit` can't close the freshly created tab and its
    /// leftover output can't bleed into it.
    silenced: Arc<AtomicBool>,
    /// Kills the spawned process so a replaced terminal's threads wind down
    /// promptly (and the old pty doesn't leak) instead of lingering until the
    /// shell happens to exit on its own.
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// All open terminals, keyed by frontend id.
#[derive(Default)]
pub struct TerminalState(pub Arc<Mutex<HashMap<String, Terminal>>>);

/// Payload for the `terminal://data` event: which terminal, and its output.
#[derive(Serialize, Clone)]
struct TermData {
    id: String,
    chunk: String,
}

#[derive(Serialize, Clone)]
struct TermExit {
    id: String,
}

/// tmux binary on the login shell's PATH, if installed (cached).
/// Not used on Windows — tmux isn't a native ConPTY host, and `$SHELL`/`tmux`
/// from a WSL PATH would spawn a Linux binary the Win32 PTY can't run.
fn tmux_path() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        None
    }
    #[cfg(not(windows))]
    {
        use std::sync::OnceLock;
        static TMUX: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
        TMUX.get_or_init(|| crate::context::find_on_path("tmux"))
            .clone()
    }
}

/// True when a tmux session of this name currently exists on the default server.
fn tmux_session_exists(name: &str) -> bool {
    let Some(tmux) = tmux_path() else {
        return false;
    };
    crate::proc::command(tmux)
        // `=name` forces an exact match: tmux otherwise falls back to unique
        // prefix then fnmatch, so `has-session -t sd-..-1` would report alive
        // while only `sd-..-10` exists.
        .args(["has-session", "-t", &format!("={name}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Force `detach-on-destroy on` for this session (chained after `new-session`).
///
/// Users (Omarchy included) often set `detach-on-destroy off` globally so
/// destroying a session switches the client to another session instead of
/// exiting. That leaves our outer `tmux` client — and thus the PTY — alive
/// after the user types `exit` in the tab's shell, so `terminal://exit` never
/// fires and the tab stays as a zombie. Session-scoped `on` makes *this*
/// session's death detach/exit our client → controller EOF → tab close.
fn tmux_force_detach_on_destroy(cmd: &mut CommandBuilder, session: &str) {
    cmd.arg(";");
    // set-option takes a *pane* target: exact-match a session with
    // `=session:` (a bare `=session` is "no such session" for pane targets
    // and the option silently never applied).
    cmd.args([
        "set-option",
        "-t",
        &format!("={session}:"),
        "detach-on-destroy",
        "on",
    ]);
}

/// Hide tmux's status line in this session only (chained after
/// `new-session`, like [`tmux_force_detach_on_destroy`]).
///
/// SparkDown already shows a header per terminal pane, so tmux's own bar
/// ("[sd-…:zsh*] … date") is noise at the bottom of every pane. The option
/// is set on the exact `=session:` target — never `-g` — so the user's own
/// tmux sessions and `~/.tmux.conf` are untouched. It is re-applied on each
/// `-A` reattach, so sessions made by older builds lose the bar too.
fn tmux_hide_status_line(cmd: &mut CommandBuilder, session: &str) {
    cmd.arg(";");
    cmd.args(["set-option", "-t", &format!("={session}:"), "status", "off"]);
}

/// Spawn a shell in a new pty under `id`, rooted at `cwd`, streaming output via
/// `terminal://data`. If `id` already exists it is replaced (old shell dropped).
///
/// When tmux is installed and `session` is provided, the pty runs
/// `tmux new-session -A -s <session>` instead of a bare shell: the session
/// (and anything running in it — e.g. an agent) SURVIVES SparkDown quitting,
/// and `-A` reattaches to it on next launch. Without tmux, falls back to a
/// plain login shell exactly as before. Returns "tmux" or "shell" so the
/// frontend knows which mode it got.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: params map to one JS call.
pub fn terminal_start(
    app: AppHandle,
    state: tauri::State<'_, TerminalState>,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    session: Option<String>,
    launch: Option<String>,
) -> Result<String, String> {
    // Replacing an id that's still live (a webview reload restarts ids at
    // `term-1` while the previous pty's threads are still running): silence and
    // kill the old spawn up front, so its reader/waiter/watchdog can't emit a
    // stale `terminal://exit` that would close the new tab, can't bleed the old
    // pty's output into it, and the old pty doesn't leak. `insert` below then
    // drops the old controller/sender, unblocking those threads to exit.
    if let Ok(mut guard) = state.0.lock() {
        if let Some(old) = guard.get_mut(&id) {
            old.silenced.store(true, Ordering::SeqCst);
            let _ = old.killer.kill();
        }
    }

    let pty_system = NativePtySystem::default();
    // Rename portable-pty's `PtyPair { master, slave }` fields on destructure
    // so no non-inclusive term is used past this point. The two names are:
    //   - controller: our side (resize, reader, writer)
    //   - pane_side:  the child's side (dropped after spawn on Unix so the
    //                 controller can observe EOF when the shell exits)
    let PtyPair {
        master: controller,
        slave: pane_side,
    } = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    // Sanitize the session name: tmux forbids ':' and '.'; keep it simple.
    let session = session.map(|s| {
        s.chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect::<String>()
    });

    // An agent chip passes the command to run (e.g. `claude …`). We run it as
    // the shell's foreground process AFTER the login shell has fully
    // initialized, instead of typing keystrokes once the prompt looks idle:
    // that removes the "typed before zsh was ready" race and the command is
    // already submitted. The command travels in $SPARKDOWN_LAUNCH so it never
    // has to be quoted into the wrapper script. Local Windows: PowerShell runs
    // it (`local_shell_command`); a remote terminal (also from Windows) runs
    // it in the remote POSIX login shell.
    let launch_cmd = launch.as_deref().filter(|s| !s.is_empty());

    let remote_cmd =
        crate::remote::terminal_command(cwd.as_deref(), session.as_deref(), launch_cmd);
    let is_remote = remote_cmd.is_some();
    let (mut cmd, mode) = if let Some(pair) = remote_cmd {
        pair
    } else {
        match (tmux_path(), session.as_deref()) {
            (Some(tmux), Some(name)) if !name.is_empty() => {
                let mut c = CommandBuilder::new(tmux);
                // -u: force UTF-8. A GUI-launched app inherits no locale, so
                // tmux would otherwise assume a non-UTF-8 terminal and replace
                // every multibyte glyph (the prompt's `❯`, emoji) with `_`.
                // -A: attach if the session exists, create otherwise — this is
                // what makes terminals survive an app restart.
                c.args(["-u", "new-session", "-A", "-s", name]);
                // Seed the CREATED session's environment (tmux ≥ 3.2). A
                // session made on an ALREADY-RUNNING tmux server does NOT
                // inherit this client's env — only the server's global env +
                // update-environment — so the `cmd.env(...)` calls below reach
                // a plain fallback shell but NOT a tmux session. Without `-e`,
                // workspace B's terminals would see workspace A's
                // SPARKDOWN_CONTEXT (or, if the user's own tmux server was
                // already up, no SPARKDOWN_MCP at all). Like SPARKDOWN_LAUNCH,
                // `-e` applies only on create, not on `-A` reattach (the
                // session already has its env then).
                if let Some(dir) = cwd.as_deref().filter(|d| !d.is_empty()) {
                    c.arg("-e");
                    c.arg(format!(
                        "SPARKDOWN_CONTEXT={}",
                        crate::context::context_dir_for(dir).to_string_lossy()
                    ));
                }
                if let Some(sock) = crate::mcp::running_socket_path() {
                    c.arg("-e");
                    c.arg(format!(
                        "{}={}",
                        crate::mcp::SOCKET_ENV,
                        sock.to_string_lossy()
                    ));
                }
                if let Some(cmd_str) = launch_cmd {
                    // `-e` seeds the env only when the session is CREATED
                    // (tmux ≥ 3.2); on reattach the agent is already running,
                    // so we must not relaunch it. `--` ends tmux's own flags.
                    c.arg("-e");
                    c.arg(format!("SPARKDOWN_LAUNCH={cmd_str}"));
                    c.arg("--");
                    let shell = default_shell();
                    c.arg(&shell.program);
                    c.arg("-lic");
                    c.arg(launch_wrapper(&shell.name));
                }
                tmux_force_detach_on_destroy(&mut c, name);
                tmux_hide_status_line(&mut c, name);
                (c, "tmux")
            }
            _ => (
                local_shell_command(&default_shell(), launch_cmd, cfg!(windows)),
                "shell",
            ),
        }
    };
    if !is_remote {
        if let Some(dir) = cwd.as_deref().filter(|d| !d.is_empty()) {
            cmd.cwd(dir);
        }
    }
    // Advertise a fully color-capable terminal. Without these, CLIs (claude,
    // codex, git, ls, …) detect a dumb/unknown terminal and disable color and
    // rich output. xterm.js implements the xterm-256color feature set and
    // truecolor, so claim both.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Locale: Terminal.app exports LANG for you, but a GUI (launchd) process
    // inherits none. Without a UTF-8 locale, tmux drops to non-UTF-8 mode and
    // renders multibyte glyphs as underscores, and zsh miscomputes widths.
    // Seed a UTF-8 locale only when the environment selects none, so a user's
    // own locale is never overridden.
    if !is_remote && !has_utf8_locale() {
        cmd.env("LANG", "en_US.UTF-8");
        cmd.env("LC_CTYPE", "en_US.UTF-8");
    }
    // Agent context bridge: agents in this shell can read what the user is
    // viewing in the editor from $SPARKDOWN_CONTEXT/context.json (see
    // context.rs). Set per-workspace so multiple windows don't collide.
    if !is_remote {
        if let Some(dir) = cwd.as_deref().filter(|d| !d.is_empty()) {
            cmd.env(
                "SPARKDOWN_CONTEXT",
                crate::context::context_dir_for(dir)
                    .to_string_lossy()
                    .to_string(),
            );
        }
        // MCP gate: the stdio shim serves the editor tools ONLY when this is
        // set to a live socket. Exported here so agents in this terminal (and
        // any registered via `mcp add`) reach the running app; unset
        // elsewhere, so the same config is silent outside SparkDown. Remote
        // shells can't reach a local socket, so they keep the file bridge.
        if let Some(sock) = crate::mcp::running_socket_path() {
            cmd.env(crate::mcp::SOCKET_ENV, sock);
        }
    }

    let mut child = pane_side
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell failed: {e}"))?;
    // portable-pty examples all drop the pane (child) side after spawn.
    // Keeping it open means the controller never sees EOF when the shell exits
    // on Linux — read() blocks forever, so we never emit terminal://exit and
    // the UI tab stays open as a zombie. macOS can still surface EIO earlier,
    // which hid the bug there. On Windows ConPTY the pane side is just another
    // Arc to the PseudoConsole; the child-exit watchdog below covers that
    // platform.
    drop(pane_side);

    let mut reader = controller
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = controller
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    // Pump pty output to the frontend. Runs until the shell exits (read → 0)
    // or the controller is dropped (frontend close / child-exit → tab close).
    //
    // pty reads split on arbitrary byte boundaries, so a multibyte UTF-8
    // character (box-drawing, braille spinners, ⏺, emoji — common in agent
    // TUIs) can straddle two reads. Decoding each chunk independently would
    // mangle both halves into U+FFFD (�). We carry any incomplete trailing
    // sequence over to the next read, so only whole characters are decoded.
    //
    // Exit is emitted at most once from any of:
    //   1. controller EOF / read error (Unix plain shell, or tmux client that
    //      actually detached),
    //   2. child-exit watchdog (required on Windows ConPTY — see below; also
    //      belt-and-suspenders on Unix),
    //   3. tmux-session watchdog (sd-* session vanished while the outer client
    //      lingered under detach-on-destroy off).
    let app_for_thread = app.clone();
    let id_for_thread = id.clone();
    let exit_emitted = Arc::new(AtomicBool::new(false));
    // Raised when a later `terminal_start` replaces this id; the reader, child
    // waiter and tmux watchdog all consult it before emitting so a replaced
    // spawn goes silent instead of closing the new tab (see Terminal.silenced).
    let silenced = Arc::new(AtomicBool::new(false));
    let emit_exit: Arc<dyn Fn() + Send + Sync> = {
        let app = app_for_thread.clone();
        let id = id_for_thread.clone();
        let flag = exit_emitted.clone();
        let silenced = silenced.clone();
        Arc::new(move || {
            if silenced.load(Ordering::SeqCst) {
                return;
            }
            if flag.swap(true, Ordering::SeqCst) {
                return;
            }
            let _ = app.emit("terminal://exit", TermExit { id: id.clone() });
        })
    };

    // Clone the killer before moving `child` into the wait thread. One copy
    // lives in the map so a replacing `terminal_start` can kill this spawn; the
    // tmux watchdog gets its own to force-exit a lingering LOCAL client.
    let map_killer = child.clone_killer();
    // Skip the watchdog for remote tmux: `mode` is also "tmux" there, but the
    // session lives on the remote server while `tmux_session_exists` polls the
    // LOCAL one — so it would either do nothing useful or, worse, kill the
    // remote terminal when an unrelated same-named local session ends. The
    // child-exit waiter (the ssh process ending) already closes remote tabs.
    let tmux_killer = if mode == "tmux" && !is_remote {
        Some(child.clone_killer())
    } else {
        None
    };

    // Child-exit watchdog: wait on the spawned process and emit
    // `terminal://exit` when it ends — even if the controller never EOFs.
    //
    // Windows ConPTY (portable-pty): the controller and pane sides share one
    // PseudoConsole Arc; dropping the pane side is nearly a no-op. Holding the
    // controller for resize keeps the HPCON alive, and without
    // ReleasePseudoConsole (Win11 24H2+, unused by portable-pty 0.9) the
    // output pipe often never EOFs after PowerShell exits — so a reader-only
    // path leaves a zombie tab. Waiting on the child closes that gap: frontend
    // closes the tab → terminal_close drops the controller →
    // ClosePseudoConsole unblocks the reader.
    //
    // Unix: dropping the pane side already yields EOF for plain shells; this
    // is belt-and-suspenders. For tmux it reaps the outer client and
    // complements the session watchdog below (which kills the client when the
    // sd-* session vanishes).
    {
        let emit_exit = emit_exit.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            emit_exit();
        });
    }

    // tmux watchdog: if the session this tab represents is gone but the outer
    // client is still alive (switched to another session under
    // detach-on-destroy off), kill the client so the waiter/reader unblock and
    // the tab closes. Skip until we've observed the session at least once so
    // we don't race session creation.
    if let Some(mut killer) = tmux_killer {
        if let Some(sess) = session.clone() {
            let flag = exit_emitted.clone();
            let emit_exit = emit_exit.clone();
            std::thread::spawn(move || {
                let mut seen = false;
                loop {
                    if flag.load(Ordering::SeqCst) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(300));
                    if flag.load(Ordering::SeqCst) {
                        break;
                    }
                    if tmux_session_exists(&sess) {
                        seen = true;
                    } else if seen {
                        let _ = killer.kill();
                        emit_exit();
                        break;
                    }
                }
            });
        }
    }

    {
        let silenced = silenced.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            let emit = |text: String| {
                if !text.is_empty() && !silenced.load(Ordering::SeqCst) {
                    let _ = app_for_thread.emit(
                        "terminal://data",
                        TermData {
                            id: id_for_thread.clone(),
                            chunk: text,
                        },
                    );
                }
            };
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        // Decode everything decodable now, keeping only a
                        // genuinely incomplete trailing sequence for the next
                        // read (flush=false).
                        emit(decode_pty_utf8(&mut pending, false));
                    }
                    Err(_) => break,
                }
            }
            // EOF: nothing more will arrive, so replace any leftover bytes
            // (an interrupted multibyte tail) with U+FFFD rather than dropping.
            emit(decode_pty_utf8(&mut pending, true));
            emit_exit();
        });
    }

    // Per-terminal writer thread (see Terminal.input_tx): owns the pty writer
    // and drains the channel, so `terminal_write` only does a cheap, non-
    // blocking `send` while holding the map lock. Ends when the sender is
    // dropped (close/replace) or the pty write fails.
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
    {
        let mut writer = writer;
        std::thread::spawn(move || {
            while let Ok(data) = input_rx.recv() {
                if writer.write_all(&data).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        });
    }

    state
        .0
        .lock()
        .map_err(|_| "terminal state poisoned")?
        .insert(
            id,
            Terminal {
                input_tx,
                controller,
                silenced,
                killer: map_killer,
            },
        );
    Ok(mode.to_string())
}

/// Decode a running byte stream from a pty into UTF-8 text.
///
/// `pending` accumulates raw pty bytes across reads (a multibyte character can
/// straddle two reads). This drains every byte it can turn into text, appending
/// U+FFFD for each invalid sequence, and returns the decoded text. It leaves
/// only a genuinely incomplete trailing multibyte sequence in `pending` for the
/// next read — unless `flush` is set (EOF), when that tail is also replaced with
/// U+FFFD so no bytes are silently dropped. Pure and side-effect-free apart from
/// mutating `pending`, so it can be unit-tested directly.
fn decode_pty_utf8(pending: &mut Vec<u8>, flush: bool) -> String {
    let mut out = String::new();
    loop {
        if pending.is_empty() {
            break;
        }
        match std::str::from_utf8(pending) {
            Ok(s) => {
                out.push_str(s);
                pending.clear();
                break;
            }
            Err(e) => {
                let valid_up_to = e.valid_up_to();
                if valid_up_to > 0 {
                    // SAFETY: bytes [0, valid_up_to) are valid UTF-8.
                    out.push_str(unsafe { std::str::from_utf8_unchecked(&pending[..valid_up_to]) });
                }
                match e.error_len() {
                    // Genuine invalid byte(s): emit one replacement char and
                    // keep decoding the bytes that follow.
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        pending.drain(..valid_up_to + bad);
                    }
                    // Incomplete final char (split read): drop the decoded
                    // prefix and keep the trailing bytes for the next read. At
                    // EOF there is no next read, so replace them instead.
                    None => {
                        pending.drain(..valid_up_to);
                        if flush {
                            out.push('\u{FFFD}');
                            pending.clear();
                        }
                        break;
                    }
                }
            }
        }
    }
    out
}

/// tmux sessions belonging to this workspace (prefix match on the workspace
/// key), so the frontend can reattach them as tabs on launch. Empty when tmux
/// is absent or no sessions exist.
///
/// `async` + `spawn_blocking`: on a remote session this is a blocking ssh
/// call; even locally it forks and waits on `tmux list-sessions`. A sync
/// `#[tauri::command]` would run on Tauri 2's main thread and could freeze
/// the UI on a half-open SSH connection.
#[tauri::command]
pub async fn tmux_sessions(prefix: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || tmux_sessions_impl(prefix))
        .await
        .unwrap_or_default()
}

fn tmux_sessions_impl(prefix: String) -> Vec<String> {
    if crate::remote::is_active() {
        return crate::remote::tmux_sessions(&prefix);
    }
    let Some(tmux) = tmux_path() else {
        return vec![];
    };
    let Ok(output) = crate::proc::command(tmux)
        .args(["list-sessions", "-F", "#{session_name}"])
        .output()
    else {
        return vec![];
    };
    if !output.status.success() {
        return vec![]; // no server running → no sessions
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| l.starts_with(&prefix))
        .map(str::to_string)
        .collect()
}

/// Type literal text into a tmux session's active pane WITHOUT submitting it
/// (no Enter) — used to pre-fill an agent launch command for the user to
/// review. Going through `send-keys` (rather than writing raw bytes to the
/// pty) lets tmux insert the text into its own serialized input/redraw cycle,
/// so it can't interleave with tmux's startup redraw and render twice. The
/// `-l` flag sends the text literally; `--` guards text starting with `-`.
/// Only SparkDown's own tmux sessions may be typed into or killed. The
/// frontend names them `sd-<workspace-hash>-…`; anything else (or tmux
/// target syntax like `other:1.2`) is refused, so a compromised webview
/// cannot reach the user's unrelated tmux sessions.
pub(crate) fn validate_own_session(session: &str) -> Result<(), String> {
    let ok = session.starts_with("sd-")
        && session.len() <= 128
        && session
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err("not a SparkDown tmux session".into())
    }
}

/// Type literal text into a tmux session's active pane WITHOUT submitting.
///
/// `async` + `spawn_blocking`: the ssh (or local `tmux send-keys`) round trip
/// stays off Tauri 2's main thread — same rationale as [`tmux_sessions`].
#[tauri::command]
pub async fn tmux_send_keys(session: String, text: String) -> Result<(), String> {
    validate_own_session(&session)?;
    tauri::async_runtime::spawn_blocking(move || tmux_send_keys_impl(&session, &text))
        .await
        .map_err(|e| format!("tmux_send_keys task failed: {e}"))?
}

fn tmux_send_keys_impl(session: &str, text: &str) -> Result<(), String> {
    if crate::remote::is_active() {
        return crate::remote::tmux_send_keys(session, text);
    }
    let Some(tmux) = tmux_path() else {
        return Err("tmux not found".into());
    };
    crate::proc::command(tmux)
        // `=session` forces an exact match so keys can't be typed into a
        // same-prefixed session's active pane (e.g. sd-..-1 vs sd-..-10).
        // Pane target: `=session:` (exact session, its active pane).
        .args(["send-keys", "-t", &format!("={session}:"), "-l", "--", text])
        .output()
        .map_err(|e| format!("tmux send-keys: {e}"))?;
    Ok(())
}

/// Kill a tmux session (the explicit close action — detach is just dropping
/// the pty). Best-effort.
///
/// `async` + `spawn_blocking`: same reasoning as [`tmux_sessions`] — keeps a
/// half-open SSH from freezing the Tauri 2 main thread.
#[tauri::command]
pub async fn tmux_kill_session(session: String) -> Result<(), String> {
    validate_own_session(&session)?;
    tauri::async_runtime::spawn_blocking(move || tmux_kill_session_impl(&session))
        .await
        .map_err(|e| format!("tmux_kill_session task failed: {e}"))?
}

fn tmux_kill_session_impl(session: &str) -> Result<(), String> {
    if crate::remote::is_active() {
        return crate::remote::tmux_kill_session(session);
    }
    let Some(tmux) = tmux_path() else {
        return Ok(());
    };
    crate::proc::command(tmux)
        // `=session` forces an exact match so we can't kill a same-prefixed
        // session (e.g. sd-..-1 vs sd-..-10).
        .args(["kill-session", "-t", &format!("={session}")])
        .output()
        .map_err(|e| format!("tmux kill-session: {e}"))?;
    Ok(())
}

/// Forward user input (keystrokes) to terminal `id`.
#[tauri::command]
pub fn terminal_write(
    state: tauri::State<'_, TerminalState>,
    id: String,
    data: String,
) -> Result<(), String> {
    // Hand the bytes to this terminal's writer thread and return immediately.
    // The map lock is held only for the channel send (never for the pty write),
    // so a paste into a program that isn't reading its input can't stall the
    // main thread or block other terminals' write/resize/close on the mutex.
    let guard = state.0.lock().map_err(|_| "terminal state poisoned")?;
    if let Some(term) = guard.get(&id) {
        // Err only if the writer thread has already gone (terminal closing);
        // nothing useful to do with the bytes then.
        let _ = term.input_tx.send(data.into_bytes());
    }
    Ok(())
}

/// Resize terminal `id`'s pty grid.
#[tauri::command]
pub fn terminal_resize(
    state: tauri::State<'_, TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|_| "terminal state poisoned")?;
    if let Some(term) = guard.get(&id) {
        term.controller
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize failed: {e}"))?;
    }
    Ok(())
}

/// Close terminal `id`: drop its pty (which kills the shell) and forget it.
#[tauri::command]
pub fn terminal_close(state: tauri::State<'_, TerminalState>, id: String) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "terminal state poisoned")?
        .remove(&id);
    Ok(())
}

/// Basename of the user's login shell ("zsh", "bash", "powershell") — used as
/// the default tab name for terminals opened with "+".
#[tauri::command]
pub fn shell_name() -> String {
    default_shell().name
}

#[cfg(test)]
mod tests {
    use super::{
        decode_pty_utf8, default_shell, launch_shell_family, local_shell_command,
        tmux_force_detach_on_destroy, tmux_hide_status_line, tmux_session_exists,
        validate_own_session, ShellLaunch, PS_LAUNCH_SCRIPT,
    };
    use portable_pty::{CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
    use std::io::Read;
    use std::time::{Duration, Instant};

    #[test]
    fn default_shell_has_a_program_and_name() {
        let shell = default_shell();
        assert!(!shell.program.as_os_str().is_empty());
        assert!(!shell.name.is_empty());
    }

    #[test]
    fn launch_wrapper_sources_rc_and_runs_then_execs() {
        use super::launch_wrapper;
        // The command runs from $SPARKDOWN_LAUNCH; a fresh login shell follows.
        let w = launch_wrapper("zsh");
        assert!(w.contains(r#"eval "$SPARKDOWN_LAUNCH""#), "{w}");
        assert!(w.contains(r#"exec "${SHELL:-/bin/sh}" -l"#), "{w}");
        // zsh/bash: source the interactive rc explicitly (a -c shell is
        // non-interactive and would otherwise skip it, losing PATH additions).
        assert!(w.contains(".zshrc"), "{w}");
        assert!(launch_wrapper("bash").contains(".bashrc"));
        // Unknown shells: no rc line, still run + exec.
        let f = launch_wrapper("fish");
        assert!(!f.contains(".zshrc") && !f.contains(".bashrc"));
        assert!(f.contains(r#"eval "$SPARKDOWN_LAUNCH""#));
    }

    type SharedWriter = std::sync::Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>;

    /// Read a pty's output on a thread into a buffer, and answer the
    /// cursor-position query (`ESC[6n`) ConPTY sends at start: portable-pty
    /// opens it with PSEUDOCONSOLE_INHERIT_CURSOR, and ConPTY then waits for
    /// the reply before the child runs. In the app, xterm.js answers it.
    fn drain_answering_dsr(
        controller: &dyn portable_pty::MasterPty,
    ) -> (SharedWriter, std::sync::Arc<std::sync::Mutex<String>>) {
        use std::sync::{Arc, Mutex};
        let writer: SharedWriter = Arc::new(Mutex::new(controller.take_writer().expect("writer")));
        let mut reader = controller.try_clone_reader().expect("reader");
        let screen = Arc::new(Mutex::new(String::new()));
        let (w, s) = (writer.clone(), screen.clone());
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                        if text.contains("\x1b[6n") {
                            if let Ok(mut w) = w.lock() {
                                let _ = w.write_all(b"\x1b[1;1R");
                                let _ = w.flush();
                            }
                        }
                        if let Ok(mut s) = s.lock() {
                            s.push_str(&text);
                        }
                    }
                }
            }
        });
        (writer, screen)
    }

    fn argv(cmd: &CommandBuilder) -> Vec<String> {
        cmd.get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn powershell_launch_runs_the_env_line_and_stays_open() {
        let shell = ShellLaunch {
            program: r"C:\Program Files\PowerShell\7\pwsh.exe".into(),
            args: vec!["-NoLogo".into()],
            name: "pwsh".into(),
        };
        let line = r"claude --mcp-config 'C:\Users\Jane O''Brien\x.json'";
        let cmd = local_shell_command(&shell, Some(line), true);
        let a = argv(&cmd);
        assert_eq!(a[0], r"C:\Program Files\PowerShell\7\pwsh.exe");
        assert_eq!(
            &a[1..],
            ["-NoLogo", "-NoExit", "-Command", PS_LAUNCH_SCRIPT]
        );
        // The line is NOT on the command line: it travels in the env.
        assert!(!a.iter().any(|x| x.contains("claude")), "{a:?}");
        assert_eq!(
            cmd.get_env("SPARKDOWN_LAUNCH")
                .map(|v| v.to_string_lossy().into_owned()),
            Some(line.to_string())
        );
        // One argument whose Windows quoting cannot change it, run with
        // Invoke-Expression after the variable is removed from the env.
        assert!(!PS_LAUNCH_SCRIPT.contains('"') && !PS_LAUNCH_SCRIPT.contains('\\'));
        assert!(PS_LAUNCH_SCRIPT.contains("Invoke-Expression $sparkdownLaunch"));
        assert!(PS_LAUNCH_SCRIPT.contains("Remove-Item Env:SPARKDOWN_LAUNCH"));
        // No launch: the plain shell with its usual args.
        let plain = local_shell_command(&shell, None, true);
        assert_eq!(&argv(&plain)[1..], ["-NoLogo"]);
        assert!(plain.get_env("SPARKDOWN_LAUNCH").is_none());
    }

    #[test]
    fn posix_launch_is_unchanged() {
        let shell = ShellLaunch {
            program: "/bin/zsh".into(),
            args: vec!["-l".into()],
            name: "zsh".into(),
        };
        let cmd = local_shell_command(&shell, Some("claude"), false);
        let a = argv(&cmd);
        assert_eq!(a[1], "-lic");
        assert_eq!(a[2], super::launch_wrapper("zsh"));
        assert_eq!(a.len(), 3);
        assert_eq!(
            &argv(&local_shell_command(&shell, None, false))[1..],
            ["-l"]
        );
    }

    #[test]
    fn launch_syntax_is_powershell_only_for_local_windows() {
        assert_eq!(launch_shell_family(true, false), "powershell");
        // Remote from Windows: the remote host's POSIX shell runs the line.
        assert_eq!(launch_shell_family(true, true), "posix");
        assert_eq!(launch_shell_family(false, false), "posix");
        assert_eq!(launch_shell_family(false, true), "posix");
    }

    #[test]
    fn only_sparkdown_sessions_can_be_targeted() {
        assert!(validate_own_session("sd-ab12-zsh-3").is_ok());
        assert!(validate_own_session("sd-ab12-zsh-3-a-claude").is_ok());
        // Another user session, tmux target syntax, empty, or a bare prefix.
        assert!(validate_own_session("work").is_err());
        assert!(validate_own_session("other:1.2").is_err());
        assert!(validate_own_session("sd-ab12:0").is_err());
        assert!(validate_own_session("").is_err());
        assert!(validate_own_session("SD-ab12").is_err());
    }

    /// Regression for the Omarchy/Linux zombie-tab bug: after the shell exits,
    /// the controller must observe EOF so we can emit `terminal://exit`. That
    /// only happens once every child-side fd is closed — including ours.
    /// Holding the pane side open (as Terminal used to via PtyPair) leaves
    /// read() blocked.
    #[cfg(unix)]
    #[test]
    fn controller_sees_eof_after_shell_exit_when_pane_dropped() {
        let pty_system = NativePtySystem::default();
        let PtyPair {
            master: controller,
            slave: pane_side,
        } = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("exit 0");
        let mut child = pane_side.spawn_command(cmd).expect("spawn");
        drop(pane_side);

        let mut reader = controller.try_clone_reader().expect("reader");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut buf = [0u8; 1024];
        let mut saw_eof = false;
        while Instant::now() < deadline {
            match reader.read(&mut buf) {
                Ok(0) => {
                    saw_eof = true;
                    break;
                }
                Ok(_) => continue,
                Err(_) => {
                    saw_eof = true;
                    break;
                }
            }
        }
        assert!(
            saw_eof,
            "controller should EOF within 5s after shell exit + pane-side drop"
        );
        let status = child.wait().expect("wait");
        assert!(status.success());
    }

    /// Windows ConPTY strategy: detect shell exit via `child.wait()` even
    /// while the controller (PseudoConsole) stays alive for resize. On ConPTY,
    /// holding the HPCON can prevent the output pipe from EOFing after
    /// PowerShell exits, so the production path emits `terminal://exit` from a
    /// wait thread rather than relying on the reader alone. This test asserts
    /// that wait observes exit under a held controller (cross-platform
    /// stand-in for that gap).
    #[test]
    fn child_wait_observes_exit_while_controller_held() {
        let pty_system = NativePtySystem::default();
        let PtyPair {
            master: controller,
            slave: pane_side,
        } = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        #[cfg(windows)]
        let cmd = {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/C");
            c.arg("exit 0");
            c
        };
        #[cfg(not(windows))]
        let cmd = {
            let mut c = CommandBuilder::new("sh");
            c.arg("-c");
            c.arg("exit 0");
            c
        };
        let mut child = pane_side.spawn_command(cmd).expect("spawn");
        drop(pane_side);
        // Read the output like the app does (else ConPTY waits for an answer
        // to its cursor query and the child never runs).
        let _io = drain_answering_dsr(&*controller);
        // Keep the controller alive the way Terminal does for resize.
        let _controller = controller;

        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Ok(None) => panic!("child did not exit within 5s while controller held"),
                Err(e) => panic!("try_wait failed: {e}"),
            }
        };
        assert!(status.success(), "{status:?}");
    }

    /// emit_exit once-flag contract: concurrent "EOF" and "child exited"
    /// paths must not double-fire. Mirrors the AtomicBool swap in
    /// `terminal_start` without needing a Tauri AppHandle.
    #[test]
    fn exit_emit_flag_fires_only_once() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::Arc;
        let flag = Arc::new(AtomicBool::new(false));
        let count = Arc::new(AtomicUsize::new(0));
        let emit: Arc<dyn Fn() + Send + Sync> = {
            let flag = flag.clone();
            let count = count.clone();
            Arc::new(move || {
                if flag.swap(true, Ordering::SeqCst) {
                    return;
                }
                count.fetch_add(1, Ordering::SeqCst);
            })
        };
        let emit2 = emit.clone();
        let t1 = std::thread::spawn(move || emit());
        let t2 = std::thread::spawn(move || emit2());
        t1.join().unwrap();
        t2.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn tmux_force_detach_on_destroy_chains_set_option() {
        let mut cmd = CommandBuilder::new("tmux");
        cmd.args(["-u", "new-session", "-A", "-s", "sd-ab12-bash-1"]);
        tmux_force_detach_on_destroy(&mut cmd, "sd-ab12-bash-1");
        let argv = format!("{:?}", cmd.get_argv());
        assert!(argv.contains("set-option"), "{argv}");
        assert!(argv.contains("detach-on-destroy"), "{argv}");
        assert!(argv.contains("sd-ab12-bash-1"), "{argv}");
        // Command separator so tmux runs set-option after new-session.
        assert!(argv.contains(";"), "{argv}");
    }

    /// The exact-match target forms against the real tmux binary, on a
    /// private throwaway server (`-L`), so the owner's sessions are never
    /// touched. Pane-target commands (set-option, send-keys) need
    /// `=name:`; a bare `=name` is "no such session" for them and the
    /// options silently never applied. Skipped where tmux is not installed.
    #[test]
    fn tmux_exact_targets_work_on_real_tmux() {
        if crate::proc::command("tmux").arg("-V").output().is_err() {
            return;
        }
        let sock = format!("sdtest-{}", std::process::id());
        let name = "sdtest-ab12-zsh-1";
        let run = |args: &[&str]| {
            crate::proc::command("tmux")
                .args(["-L", &sock, "-f", "/dev/null"])
                .args(args)
                .output()
                .expect("tmux")
        };
        let created = run(&["new-session", "-d", "-s", name, "-x", "80", "-y", "24"]);
        if !created.status.success() {
            return; // no usable tmux server here (e.g. sandboxed CI)
        }
        let target = format!("={name}:");
        let set = run(&["set-option", "-t", &target, "status", "off"]);
        let set2 = run(&["set-option", "-t", &target, "detach-on-destroy", "on"]);
        let show = run(&["show-options", "-t", &target, "status"]);
        let has = run(&["has-session", "-t", &format!("={name}")]);
        // Prefix of a longer name must not match exactly.
        let prefix = run(&["has-session", "-t", "=sdtest-ab12-zsh"]);
        let _ = run(&["kill-server"]);
        assert!(
            set.status.success(),
            "{}",
            String::from_utf8_lossy(&set.stderr)
        );
        assert!(
            set2.status.success(),
            "{}",
            String::from_utf8_lossy(&set2.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&show.stdout).trim(), "status off");
        assert!(has.status.success());
        assert!(!prefix.status.success());
    }

    #[test]
    fn tmux_hide_status_line_is_session_scoped() {
        let name = "sdtest-ab12-zsh-1";
        let mut cmd = CommandBuilder::new("tmux");
        cmd.args(["-u", "new-session", "-A", "-s", name]);
        tmux_force_detach_on_destroy(&mut cmd, name);
        tmux_hide_status_line(&mut cmd, name);
        let argv: Vec<String> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let tail = &argv[argv.len() - 6..];
        assert_eq!(
            tail,
            [
                ";",
                "set-option",
                "-t",
                "=sdtest-ab12-zsh-1:",
                "status",
                "off"
            ],
            "{argv:?}"
        );
        // Never global: no `-g` anywhere, so the user's tmux is untouched.
        assert!(!argv.iter().any(|a| a == "-g"), "{argv:?}");
    }

    #[test]
    fn decode_pty_utf8_passes_ascii_and_whole_multibyte() {
        let mut p = b"hello \xE2\x9D\xAF world".to_vec(); // "hello ❯ world"
        assert_eq!(decode_pty_utf8(&mut p, false), "hello ❯ world");
        assert!(p.is_empty());
    }

    #[test]
    fn decode_pty_utf8_carries_incomplete_tail_across_reads() {
        // "❯" is E2 9D AF; split after the first two bytes.
        let mut p = b"a\xE2\x9D".to_vec();
        assert_eq!(decode_pty_utf8(&mut p, false), "a");
        assert_eq!(p, b"\xE2\x9D"); // tail kept, not mangled
                                    // Second read completes the char plus more text.
        p.extend_from_slice(b"\xAFb");
        assert_eq!(decode_pty_utf8(&mut p, false), "❯b");
        assert!(p.is_empty());
    }

    #[test]
    fn decode_pty_utf8_emits_replacement_then_continues() {
        // The reported bug: a lone invalid byte must not swallow the valid
        // bytes that follow it in the same read.
        let mut p = b"\xff$ ".to_vec();
        assert_eq!(decode_pty_utf8(&mut p, false), "\u{FFFD}$ ");
        assert!(p.is_empty());
    }

    #[test]
    fn decode_pty_utf8_handles_multiple_invalid_bytes() {
        let mut p = b"x\xff\xfey".to_vec();
        assert_eq!(decode_pty_utf8(&mut p, false), "x\u{FFFD}\u{FFFD}y");
        assert!(p.is_empty());
    }

    #[test]
    fn decode_pty_utf8_flush_replaces_incomplete_tail_at_eof() {
        let mut p = b"hi\xE2\x9D".to_vec(); // trailing incomplete "❯"
                                            // Without flush the tail is held back.
        assert_eq!(decode_pty_utf8(&mut p, false), "hi");
        assert_eq!(p, b"\xE2\x9D");
        // At EOF the tail is replaced, never silently dropped.
        assert_eq!(decode_pty_utf8(&mut p, true), "\u{FFFD}");
        assert!(p.is_empty());
    }

    #[test]
    fn tmux_session_exists_is_false_for_missing_session() {
        // Safe even when tmux is absent: helper returns false.
        assert!(!tmux_session_exists(
            "sd-sparkdown-definitely-missing-session-xyz"
        ));
    }

    /// Windows smoke test of the real launch path, end to end: each launch
    /// line of the shared fixture (the exact strings terminal.ts builds,
    /// checked by vitest) runs through `local_shell_command` in a ConPTY,
    /// in PowerShell 7 AND Windows PowerShell 5.1, against npm-style fake
    /// agents (`.ps1` + `.cmd`, and `.cmd` only) that record what they got.
    /// It checks that every argument and OPENCODE_CONFIG_CONTENT arrive
    /// intact, that SPARKDOWN_LAUNCH does not leak, and that the shell stays
    /// open and interactive after the agent exits (it then runs a typed
    /// command, which also shows opencode's variable was removed).
    #[cfg(windows)]
    #[test]
    fn windows_smoke_agent_launch_lines_arrive_intact() {
        use crate::win_test_agents::{node_ready, FakeAgents};
        if !node_ready() {
            return;
        }
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests-fixtures/windows-launch-cases.json"))
                .expect("fixture");
        let cases = fixture["cases"].as_array().expect("cases");
        let mut shells = Vec::new();
        match crate::context::find_on_path("pwsh.exe") {
            Some(p) => shells.push(("pwsh", p)),
            None if std::env::var_os("SPARKDOWN_WIN_SMOKE").is_some() => {
                panic!("SPARKDOWN_WIN_SMOKE is set but pwsh.exe is not on PATH")
            }
            None => {}
        }
        shells.push(("powershell", super::windows_powershell_path()));
        let bins = ["claude", "codex", "opencode", "gemini"];
        let mut failures = Vec::new();
        let mut runs = 0;
        for with_ps1 in [true, false] {
            let kind = if with_ps1 { "ps1+cmd" } else { "cmd-only" };
            let agents = FakeAgents::new(kind, &bins, with_ps1);
            for (shell_name, program) in &shells {
                for (i, case) in cases.iter().enumerate() {
                    runs += 1;
                    if let Err(e) = run_smoke_case(&agents, shell_name, program, i, case) {
                        failures.push(format!(
                            "[{shell_name}, {kind} shims] {}: {e}",
                            case["name"]
                        ));
                    }
                }
            }
        }
        assert!(
            failures.is_empty(),
            "{} of {runs} launches failed:\n\n{}",
            failures.len(),
            failures.join("\n\n")
        );
        // Proof in the CI log (`--show-output`) that nothing was skipped.
        let names: Vec<&str> = shells.iter().map(|(n, _)| *n).collect();
        println!(
            "windows smoke: {runs} launches OK ({} cases x shells {names:?} x 2 shim layouts)",
            cases.len()
        );
        assert_eq!(runs, cases.len() * shells.len() * 2);
    }

    #[cfg(windows)]
    fn run_smoke_case(
        agents: &crate::win_test_agents::FakeAgents,
        shell_name: &str,
        program: &std::path::Path,
        i: usize,
        case: &serde_json::Value,
    ) -> Result<(), String> {
        use crate::win_test_agents::{dump_argv, parse_dump, wait_for_file};
        use serde_json::Value;
        use std::io::Write;

        let launch = case["launch"].as_str().expect("launch");
        let out = agents.base.join(format!("out-{shell_name}-{i}.json"));
        let alive = agents.base.join(format!("alive-{shell_name}-{i}.txt"));
        let shell = ShellLaunch {
            program: program.to_path_buf(),
            args: vec!["-NoLogo".into()],
            name: shell_name.into(),
        };
        let mut cmd = local_shell_command(&shell, Some(launch), true);
        cmd.env("PATH", agents.path_env());
        cmd.env("SD_SMOKE_OUT", &out);
        cmd.env("SD_SMOKE_ALIVE", &alive);
        cmd.cwd(&agents.base);

        let PtyPair {
            master: controller,
            slave: pane_side,
        } = NativePtySystem::default()
            .openpty(PtySize {
                rows: 40,
                cols: 200,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {e}"))?;
        let mut child = pane_side
            .spawn_command(cmd)
            .map_err(|e| format!("spawn: {e}"))?;
        drop(pane_side);
        let (writer, screen) = drain_answering_dsr(&*controller);

        let check = || -> Result<(), String> {
            let text = wait_for_file(&out, Duration::from_secs(60))
                .ok_or("the agent did not run within 60 s")?;
            let dump = parse_dump(&text);
            let got = dump_argv(&dump);
            let want: Vec<String> = case["argv"]
                .as_array()
                .expect("argv")
                .iter()
                .map(|v| v.as_str().expect("arg").to_string())
                .collect();
            if got != want {
                return Err(format!("argv\n  got:  {got:?}\n  want: {want:?}"));
            }
            let want_oc = &case["opencodeConfig"];
            match dump["env"].get("OPENCODE_CONFIG_CONTENT") {
                None if want_oc.is_null() => {}
                Some(Value::String(s)) if !want_oc.is_null() => {
                    let got_oc: Value = serde_json::from_str(s)
                        .map_err(|e| format!("OPENCODE_CONFIG_CONTENT is not JSON ({e}): {s}"))?;
                    if &got_oc != want_oc {
                        return Err(format!(
                            "OPENCODE_CONFIG_CONTENT\n  got:  {got_oc}\n  want: {want_oc}"
                        ));
                    }
                }
                other => {
                    return Err(format!(
                        "OPENCODE_CONFIG_CONTENT: got {other:?}, want {want_oc}"
                    ))
                }
            }
            if let Some(v) = dump["env"].get("SPARKDOWN_LAUNCH") {
                return Err(format!("SPARKDOWN_LAUNCH leaked to the agent: {v}"));
            }
            // The agent has exited; the same PowerShell must take a command.
            {
                let mut w = writer.lock().map_err(|_| "writer poisoned")?;
                w.write_all(
                    b"Set-Content -LiteralPath $env:SD_SMOKE_ALIVE -Value ('alive:' + \
                      $env:OPENCODE_CONFIG_CONTENT + ':' + $env:SPARKDOWN_LAUNCH)\r",
                )
                .map_err(|e| format!("type: {e}"))?;
                let _ = w.flush();
            }
            let a = wait_for_file(&alive, Duration::from_secs(30))
                .ok_or("the shell did not stay open (or ignored input) after the agent exited")?;
            if a.trim() != "alive::" {
                return Err(format!(
                    "after the agent: want no OPENCODE_CONFIG_CONTENT / SPARKDOWN_LAUNCH left in the shell, got {:?}",
                    a.trim()
                ));
            }
            Ok(())
        };
        let result = check();
        let _ = child.kill();
        drop(controller);
        result.map_err(|e| {
            let s = screen.lock().map(|s| s.clone()).unwrap_or_default();
            let tail: String = s
                .chars()
                .rev()
                .take(1500)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            format!(
                "{e}\n  launch: {launch}\n  terminal (tail): {}",
                tail.escape_debug()
            )
        })
    }
}
