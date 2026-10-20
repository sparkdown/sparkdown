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
pub fn terminal_launch_shell(webview_window: tauri::WebviewWindow) -> &'static str {
    let _scope = crate::windows::enter(webview_window.label());
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
        let program = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(fallback_shell);
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
    /// The spawned process (the shell, or the local tmux client / ssh).
    shell_pid: Option<u32>,
    /// Local tmux session this pane attaches to (the pty child is then the
    /// tmux client, so its foreground says nothing about the pane).
    tmux_session: Option<String>,
    /// Remote terminal: the pty child is ssh; the remote shell is not visible.
    remote: bool,
}

/// All open terminals, keyed by frontend id.
#[derive(Default)]
pub struct TerminalState(pub Arc<Mutex<HashMap<String, Terminal>>>);

/// The core's record of every local tmux session a window started (#108):
/// session name → window label. It outlives the terminal map's entries,
/// which are keyed by webview-chosen ids (`term-N`): a reloaded webview
/// restarts at `term-1` and its new pane replaces the old entry even when it
/// attaches a different session (or none), so the old session would drop
/// out of the quit probe. This record is the source of truth instead; an
/// entry goes only when the session is killed on purpose or tmux confirms
/// it is gone.
#[derive(Default)]
pub(crate) struct WindowSessions(HashMap<String, String>);

impl WindowSessions {
    pub(crate) fn record(&mut self, session: &str, label: &str) {
        self.0.insert(session.to_string(), label.to_string());
    }
    pub(crate) fn forget(&mut self, session: &str) {
        self.0.remove(session);
    }
    /// Sessions of `label`, sorted.
    pub(crate) fn of(&self, label: &str) -> Vec<String> {
        let mut v: Vec<String> = self
            .0
            .iter()
            .filter(|(_, l)| l.as_str() == label)
            .map(|(s, _)| s.clone())
            .collect();
        v.sort();
        v
    }
    /// Recorded sessions no live terminal entry covers, with their window,
    /// for windows that are still open.
    pub(crate) fn uncovered(
        &self,
        covered: &std::collections::HashSet<String>,
        window_open: impl Fn(&str) -> bool,
    ) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self
            .0
            .iter()
            .filter(|(s, l)| !covered.contains(s.as_str()) && window_open(l))
            .map(|(s, l)| (s.clone(), l.clone()))
            .collect();
        v.sort();
        v
    }
}

pub(crate) fn window_sessions() -> std::sync::MutexGuard<'static, WindowSessions> {
    static W: std::sync::OnceLock<Mutex<WindowSessions>> = std::sync::OnceLock::new();
    W.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// tmux sessions this window started, from the core (#108): a reloaded
/// webview reattaches these, whatever its own memory or layout store says.
#[tauri::command]
pub async fn tmux_window_sessions(webview_window: tauri::WebviewWindow) -> Vec<String> {
    let label = webview_window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mine = window_sessions().of(&label);
        mine.into_iter()
            // A single Gone may be a transient tmux hiccup (#102): skip it
            // now, but only the watchdog's confirmed-gone or a deliberate
            // kill forgets it. Unknown: keep; `new-session -A` reattaches.
            .filter(|s| tmux_session_probe(s) != SessionProbe::Gone)
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Core map key of window `label`'s terminal `id` (ids repeat across
/// windows: each starts at `term-1`).
pub(crate) fn term_key(label: &str, id: &str) -> String {
    format!("{label}/{id}")
}

impl TerminalState {
    /// Close every terminal of a window (the window closed). Dropping the
    /// entries drops their writers/controllers; killing ends the shells.
    pub fn release_window(&self, label: &str) {
        let prefix = format!("{label}/");
        let gone: Vec<Terminal> = match self.0.lock() {
            Ok(mut g) => {
                let keys: Vec<String> = g
                    .keys()
                    .filter(|k| k.starts_with(&prefix))
                    .cloned()
                    .collect();
                keys.into_iter().filter_map(|k| g.remove(&k)).collect()
            }
            Err(_) => return,
        };
        for mut t in gone {
            t.silenced.store(true, Ordering::SeqCst);
            // A tmux client is only detached (its session survives, as on quit).
            let _ = t.killer.kill();
        }
    }
}

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
#[cfg(test)]
fn tmux_session_exists(name: &str) -> bool {
    let Some(tmux) = tmux_path() else {
        return false;
    };
    crate::proc::command(tmux)
        // `=name` forces an exact match: tmux otherwise falls back to unique
        // prefix then fnmatch, so `has-session -t sd-..-1` would report alive
        // while only `sd-..-10` exists.
        .args(["has-session", "-t", &format!("={name}")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// One poll of the tmux session-alive watchdog (#102).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionProbe {
    Alive,
    /// tmux answered that the session does not exist.
    Gone,
    /// tmux could not be asked (spawn error, timeout, any other error).
    Unknown,
}

/// `tmux has-session` for exactly `name`, bounded. Only tmux's own "no such
/// session" / "no server" answers count as `Gone`; anything else is `Unknown`.
fn tmux_session_probe(name: &str) -> SessionProbe {
    let Some(tmux) = tmux_path() else {
        return SessionProbe::Unknown;
    };
    let target = format!("={name}");
    let out = crate::mcp::run_with_timeout(
        &tmux,
        &["has-session", "-t", target.as_str()],
        &std::env::temp_dir(),
        Duration::from_secs(2),
    );
    classify_has_session(out)
}

/// [`tmux_session_probe`]'s verdict from tmux's (ok, stdout, stderr).
pub(crate) fn classify_has_session(out: Result<(bool, String, String), String>) -> SessionProbe {
    match out {
        Ok((true, _, _)) => SessionProbe::Alive,
        Ok((false, _, err)) => {
            let e = err.to_ascii_lowercase();
            if e.contains("can't find session")
                || e.contains("no server running")
                || e.contains("session not found")
            {
                SessionProbe::Gone
            } else {
                SessionProbe::Unknown
            }
        }
        Err(_) => SessionProbe::Unknown,
    }
}

/// Watchdog state for one tmux tab (#102). The tab is closed only after
/// `GONE_POLLS` consecutive `Gone` answers AND no process of the pane is
/// still alive. `Alive` and `Unknown` reset the count; nothing is counted
/// before the session was seen once (creation race).
#[derive(Debug, Default)]
pub(crate) struct SessionWatch {
    seen: bool,
    gone: u32,
}

pub(crate) const GONE_POLLS: u32 = 3;

impl SessionWatch {
    /// Feed one poll; `live` says whether any tracked process of the pane
    /// (shell, foreground job) still runs. True = close the tab now.
    pub(crate) fn observe(&mut self, probe: SessionProbe, live: impl FnOnce() -> bool) -> bool {
        match probe {
            SessionProbe::Alive => {
                self.seen = true;
                self.gone = 0;
                false
            }
            SessionProbe::Unknown => {
                self.gone = 0;
                false
            }
            SessionProbe::Gone => {
                if !self.seen {
                    return false;
                }
                self.gone = self.gone.saturating_add(1);
                self.gone >= GONE_POLLS && !live()
            }
        }
    }
}

/// Pids worth keeping a tab for: the pane's shell and its tty's foreground
/// job, read while the session was alive. Bounded; `None` = unknown.
fn tmux_pane_pids(name: &str) -> Option<Vec<u32>> {
    let tmux = tmux_path()?;
    let target = format!("={name}");
    let (ok, out, _) = crate::mcp::run_with_timeout(
        &tmux,
        &[
            "list-panes",
            "-s",
            "-t",
            target.as_str(),
            "-F",
            "#{session_name} #{pane_pid}",
        ],
        &std::env::temp_dir(),
        Duration::from_secs(2),
    )
    .ok()?;
    if !ok {
        return None;
    }
    // #104: every pane's shell and foreground job, not just the active pane.
    let mut pids = Vec::new();
    for pane in parse_session_panes(name, &out)? {
        pids.push(pane);
        if let Ok((_, tpgid)) = pgid_and_tty_foreground(pane) {
            if tpgid > 0 && tpgid as u32 != pane {
                pids.push(tpgid as u32);
            }
        }
    }
    Some(pids)
}

/// True if any pid in `pids` is still running, or if that can't be told
/// (never drop what might be alive). An empty list = nothing known = alive.
pub(crate) fn any_alive(pids: &[u32], alive: impl Fn(u32) -> Option<bool>) -> bool {
    pids.is_empty() || pids.iter().any(|&p| alive(p).unwrap_or(true))
}

/// Whether process `pid` exists. `None` when it can't be told.
fn pid_alive(pid: u32) -> Option<bool> {
    #[cfg(target_os = "linux")]
    {
        Some(std::path::Path::new(&format!("/proc/{pid}")).exists())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let p = pid.to_string();
        let (_, out, _) = crate::mcp::run_with_timeout(
            "ps",
            &["-o", "pid=", "-p", p.as_str()],
            &std::env::temp_dir(),
            Duration::from_secs(2),
        )
        .ok()?;
        Some(out.split_whitespace().any(|v| v == p))
    }
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
    webview_window: tauri::WebviewWindow,
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
    let label = webview_window.label().to_string();
    let _scope = crate::windows::enter(&label);
    // Ids are per window (`term-N`); the core map keys them by window too.
    let key = term_key(&label, &id);
    if let Ok(mut guard) = state.0.lock() {
        if let Some(old) = guard.get_mut(&key) {
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
                if let Some(t) = crate::windows::token_for_current_window(cwd.as_deref()) {
                    c.arg("-e");
                    c.arg(format!("{}={t}", crate::mcp::TOKEN_ENV));
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
        // Which window's folder this terminal's agents act on (#64).
        if let Some(t) = crate::windows::token_for_current_window(cwd.as_deref()) {
            cmd.env(crate::mcp::TOKEN_ENV, t);
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
        let label = label.clone();
        let flag = exit_emitted.clone();
        let silenced = silenced.clone();
        Arc::new(move || {
            if silenced.load(Ordering::SeqCst) {
                return;
            }
            if flag.swap(true, Ordering::SeqCst) {
                return;
            }
            let _ = app.emit_to(
                label.as_str(),
                "terminal://exit",
                TermExit { id: id.clone() },
            );
        })
    };

    // Clone the killer before moving `child` into the wait thread. One copy
    // lives in the map so a replacing `terminal_start` can kill this spawn; the
    // tmux watchdog gets its own to force-exit a lingering LOCAL client.
    let map_killer = child.clone_killer();
    let shell_pid = child.process_id();
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
                // #102: one failed poll must not close a tab whose job is
                // still running in tmux. See SessionWatch for the rules.
                let mut watch = SessionWatch::default();
                let mut pids: Vec<u32> = Vec::new();
                let mut polls: u32 = 0;
                loop {
                    if flag.load(Ordering::SeqCst) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(300));
                    if flag.load(Ordering::SeqCst) {
                        break;
                    }
                    let probe = tmux_session_probe(&sess);
                    if probe == SessionProbe::Alive {
                        // Refresh the pane's pids now and then (~3 s), and
                        // on first sight, so a later "gone" can be checked.
                        if pids.is_empty() || polls.is_multiple_of(10) {
                            if let Some(p) = tmux_pane_pids(&sess) {
                                pids = p;
                            }
                        }
                        polls = polls.wrapping_add(1);
                    }
                    if watch.observe(probe, || any_alive(&pids, pid_alive)) {
                        // Confirmed gone (#102 rule): the core forgets it.
                        window_sessions().forget(&sess);
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
        let label = label.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            let emit = |text: String| {
                if !text.is_empty() && !silenced.load(Ordering::SeqCst) {
                    let _ = app_for_thread.emit_to(
                        label.as_str(),
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

    let tmux_session = if mode == "tmux" && !is_remote {
        session.clone()
    } else {
        None
    };
    let mut guard = state.0.lock().map_err(|_| "terminal state poisoned")?;
    if let Some(s) = &tmux_session {
        window_sessions().record(s, &label);
        // A reloaded webview reattaching this session under a new id: the
        // previous webview's client of it goes (one tab per session).
        let prefix = format!("{label}/");
        let stale: Vec<String> = guard
            .iter()
            .filter(|(k, t)| {
                k.starts_with(&prefix) && **k != key && t.tmux_session.as_deref() == Some(s)
            })
            .map(|(k, _)| k.clone())
            .collect();
        for k in stale {
            if let Some(mut old) = guard.remove(&k) {
                old.silenced.store(true, Ordering::SeqCst);
                let _ = old.killer.kill();
            }
        }
    }
    guard.insert(
        key,
        Terminal {
            input_tx,
            controller,
            silenced,
            killer: map_killer,
            shell_pid,
            tmux_session,
            remote: is_remote,
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
pub async fn tmux_sessions(webview_window: tauri::WebviewWindow, prefix: String) -> Vec<String> {
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        tmux_sessions_impl(prefix)
    })
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
pub async fn tmux_send_keys(
    webview_window: tauri::WebviewWindow,
    session: String,
    text: String,
) -> Result<(), String> {
    validate_own_session(&session)?;
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        tmux_send_keys_impl(&session, &text)
    })
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
pub async fn tmux_kill_session(
    webview_window: tauri::WebviewWindow,
    session: String,
) -> Result<(), String> {
    validate_own_session(&session)?;
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        tmux_kill_session_impl(&session)
    })
    .await
    .map_err(|e| format!("tmux_kill_session task failed: {e}"))?
}

fn tmux_kill_session_impl(session: &str) -> Result<(), String> {
    window_sessions().forget(session);
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

/// #127 Close Folder: every tmux session `label` owns: the ones its
/// terminals hold plus the ones only [`WindowSessions`] remembers (#108).
pub(crate) fn sessions_of_window(state: &TerminalState, label: &str) -> Vec<String> {
    let prefix = format!("{label}/");
    let mut v: Vec<String> = match state.0.lock() {
        Ok(g) => g
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .filter_map(|(_, t)| t.tmux_session.clone())
            .collect(),
        Err(_) => Vec::new(),
    };
    v.extend(window_sessions().of(label));
    v.sort();
    v.dedup();
    v
}

/// #127: stop (kill, not detach) every tmux session of `label`, so closing
/// its folder really ends its jobs and nothing reattaches later. Must run
/// scoped to `label` (a remote session's tmux is on that window's host).
pub(crate) fn kill_window_sessions(state: &TerminalState, label: &str) -> Vec<String> {
    let sessions = sessions_of_window(state, label);
    for s in &sessions {
        let _ = tmux_kill_session_impl(s);
    }
    sessions
}

/// Forward user input (keystrokes) to terminal `id`.
#[tauri::command]
pub fn terminal_write(
    webview_window: tauri::WebviewWindow,
    state: tauri::State<'_, TerminalState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let id = term_key(webview_window.label(), &id);
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
    webview_window: tauri::WebviewWindow,
    state: tauri::State<'_, TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let id = term_key(webview_window.label(), &id);
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

/// What runs in terminal `id` besides its idle shell, by name, or None when
/// the shell is idle (#43). The frontend asks before closing a busy pane.
///
/// - Unix: the pty's foreground process group (tcgetpgrp on the controller)
///   vs the shell pid: a running command is its own foreground job.
/// - Local tmux: the pty child is the tmux client, so ask tmux for the
///   active pane's shell (`pane_pid`) and compare its tty's foreground
///   process group with the shell's own (#48). Never by name.
/// - Windows (ConPTY): whether the shell has child processes (Toolhelp32).
/// - Remote (ssh): the remote shell is not visible from here: None.
#[tauri::command]
pub async fn terminal_busy(
    webview_window: tauri::WebviewWindow,
    state: tauri::State<'_, TerminalState>,
    id: String,
) -> Result<Option<String>, String> {
    let id = term_key(webview_window.label(), &id);
    let probe = {
        let guard = state.0.lock().map_err(|_| "terminal state poisoned")?;
        let Some(t) = guard.get(&id) else {
            return Ok(None);
        };
        if t.remote {
            return Ok(None);
        }
        BusyProbe {
            shell_pid: t.shell_pid,
            tmux_session: t.tmux_session.clone(),
            #[cfg(unix)]
            fg_pgrp: t.controller.process_group_leader(),
        }
    };
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || Ok(probe.run()))
        .await
        .map_err(|e| format!("busy check failed: {e}"))?
}

/// What one terminal's job check found (#99). A check that fails or times
/// out is `Unknown`, never `Idle`: the quit prompt must not drop a window it
/// could not check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobState {
    Idle,
    Busy(String),
    Unknown(String),
}

/// Upper bound for one helper (tmux, ps) a job check runs. A wedged tmux
/// server must not hang the quit, nor be read as "nothing running".
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// One terminal in the quit status: its window label, what runs in it,
/// whether it survives the quit (tmux, #88), or why it couldn't be checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuitProbe {
    pub label: String,
    pub command: String,
    pub survives: bool,
    pub unchecked: Option<String>,
}

/// Terminals running a program at quit, across every window. Detection is
/// all in Rust, from the process table and tmux, so it does not depend on
/// any window's webview being awake. tmux-backed ones are listed too (#88)
/// with `survives` = true. Remote ones are left out (not visible). A check
/// that fails is listed with `unchecked` set (#99). Blocking.
pub fn busy_on_quit(state: &TerminalState) -> Vec<QuitProbe> {
    let probes: Vec<(String, BusyProbe)> = match state.0.lock() {
        Ok(g) => g
            .iter()
            .filter(|(_, t)| !t.remote)
            .map(|(k, t)| {
                let label = k.split_once('/').map(|(l, _)| l).unwrap_or("").to_string();
                (
                    label,
                    BusyProbe {
                        shell_pid: t.shell_pid,
                        tmux_session: t.tmux_session.clone(),
                        #[cfg(unix)]
                        fg_pgrp: t.controller.process_group_leader(),
                    },
                )
            })
            .collect(),
        Err(_) => {
            return vec![QuitProbe {
                label: String::new(),
                command: String::new(),
                survives: false,
                unchecked: Some("terminal state unavailable".into()),
            }]
        }
    };
    // One row per tmux session, whichever entry holds it.
    let mut covered = std::collections::HashSet::new();
    let probes: Vec<(String, BusyProbe)> = probes
        .into_iter()
        .filter(|(_, p)| {
            p.tmux_session
                .as_ref()
                .is_none_or(|s| covered.insert(s.clone()))
        })
        .collect();
    // #113: one process table per quit, taken only if some pane needs the
    // nested-pty walk, and every pane probed at once instead of one after
    // another. Each probe keeps its own bound, and so does the table, so the
    // prompt waits for the slowest single check, not the sum of all of them.
    let table = SharedTable::default();
    let mut out: Vec<QuitProbe> = std::thread::scope(|sc| {
        let handles: Vec<_> = probes
            .iter()
            .map(|(_, p)| sc.spawn(|| p.check_with(&|| table.get())))
            .collect();
        probes
            .iter()
            .zip(handles)
            .filter_map(|((label, p), h)| {
                let state = h
                    .join()
                    .unwrap_or_else(|_| JobState::Unknown("check panicked".into()));
                quit_probe(label.clone(), p.tmux_session.is_some(), state)
            })
            .collect()
    });
    // #108: sessions a window started that no terminal entry holds any more
    // (its webview reloaded and has not reattached them): the core still
    // checks them, so their jobs stay in the quit prompt.
    let extra = window_sessions().uncovered(&covered, |l| crate::windows::registry().contains(l));
    for (session, label) in extra {
        match tmux_session_probe(&session) {
            // Not forgotten on one answer (#102); simply not running now.
            SessionProbe::Gone => {}
            SessionProbe::Unknown => out.extend(quit_probe(
                label,
                true,
                JobState::Unknown("tmux did not answer".into()),
            )),
            SessionProbe::Alive => out.extend(quit_probe(
                label,
                true,
                tmux_job_state_with(&session, &|| table.get()),
            )),
        }
    }
    out
}

/// A terminal's [`JobState`] as a quit-status row; idle ones are left out.
pub(crate) fn quit_probe(label: String, survives: bool, state: JobState) -> Option<QuitProbe> {
    match state {
        JobState::Idle => None,
        JobState::Busy(command) => Some(QuitProbe {
            label,
            command,
            survives,
            unchecked: None,
        }),
        JobState::Unknown(why) => Some(QuitProbe {
            label,
            command: String::new(),
            survives,
            unchecked: Some(why),
        }),
    }
}

/// The facts [`terminal_busy`] reads under the lock; probed off it.
struct BusyProbe {
    shell_pid: Option<u32>,
    tmux_session: Option<String>,
    #[cfg(unix)]
    fg_pgrp: Option<i32>,
}

/// #113: the process table, read at most once and shared by every probe of
/// one quit check. A failed read is shared too, so each pane that needed it
/// shows "couldn't check".
pub(crate) struct SharedTable {
    cell: std::sync::OnceLock<Result<Vec<PsRow>, String>>,
    read: fn() -> Result<Vec<PsRow>, String>,
}

impl Default for SharedTable {
    fn default() -> Self {
        Self::reading(process_table)
    }
}

impl SharedTable {
    pub(crate) fn reading(read: fn() -> Result<Vec<PsRow>, String>) -> Self {
        Self {
            cell: std::sync::OnceLock::new(),
            read,
        }
    }

    pub(crate) fn get(&self) -> Result<Vec<PsRow>, String> {
        self.cell.get_or_init(self.read).clone()
    }
}

type TableFn<'a> = &'a (dyn Fn() -> Result<Vec<PsRow>, String> + Sync);

impl BusyProbe {
    fn check(&self) -> JobState {
        self.check_with(&process_table)
    }

    fn check_with(&self, table: TableFn<'_>) -> JobState {
        if let Some(session) = &self.tmux_session {
            return tmux_job_state_with(session, table);
        }
        let Some(shell) = self.shell_pid else {
            return JobState::Idle;
        };
        #[cfg(unix)]
        {
            with_nested(
                pty_job_state(shell, self.fg_pgrp, process_name),
                &[shell],
                table,
            )
        }
        #[cfg(windows)]
        {
            let procs = windows_process_table();
            match first_child_name(shell, &procs) {
                Some(n) => JobState::Busy(n),
                None => JobState::Idle,
            }
        }
    }

    /// Single-terminal check (close one terminal): a failed check counts
    /// as busy, so the close still asks.
    fn run(&self) -> Option<String> {
        match self.check() {
            JobState::Idle => None,
            JobState::Busy(c) => Some(c),
            JobState::Unknown(_) => Some("A program (couldn't check)".into()),
        }
    }
}

/// Local pty: busy when the tty's foreground process group is not the
/// shell's (#43). No foreground group readable = `Unknown`.
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) fn pty_job_state(
    shell_pid: u32,
    fg_pgrp: Option<i32>,
    name: impl Fn(u32) -> Option<String>,
) -> JobState {
    match fg_pgrp {
        None => JobState::Unknown("couldn't read the terminal's foreground job".into()),
        Some(p) => match foreground_job(shell_pid, Some(p)) {
            Some(fg) => JobState::Busy(name(fg).unwrap_or_else(|| "A program".into())),
            None => JobState::Idle,
        },
    }
}

/// The foreground process group, when it is not the shell's own (#43).
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) fn foreground_job(shell_pid: u32, fg_pgrp: Option<i32>) -> Option<u32> {
    match fg_pgrp {
        Some(p) if p > 0 && p as u32 != shell_pid => Some(p as u32),
        _ => None,
    }
}

/// tmux pane: busy when the foreground process group of the pane's tty is
/// not the pane shell's own (#48). Never by name: an agent that is itself a
/// bash script runs as `bash` too. `pane_pid` is the pane's shell; its pgid
/// and the tty's foreground pgid (`tpgid`) come from the process table.
pub(crate) fn pane_foreground_job(pane_pid: u32, pane_pgid: i32, tpgid: i32) -> Option<u32> {
    if tpgid <= 0 || tpgid as u32 == pane_pid || tpgid == pane_pgid {
        None
    } else {
        Some(tpgid as u32)
    }
}

/// (pgid, tpgid) of process `pid`: its own process group and the
/// foreground process group of its controlling tty. Blocking, bounded.
fn pgid_and_tty_foreground(pid: u32) -> Result<(i32, i32), String> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map_err(|e| format!("pane shell {pid}: {e}"))?;
        parse_proc_stat_pgrps(&stat)
            .ok_or_else(|| format!("pane shell {pid}: unreadable /proc stat"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let pid_s = pid.to_string();
        let out = crate::mcp::run_with_timeout(
            "ps",
            &["-o", "pgid=,tpgid=", "-p", pid_s.as_str()],
            &std::env::temp_dir(),
            PROBE_TIMEOUT,
        )
        .map_err(|_| format!("ps did not answer within {} s", PROBE_TIMEOUT.as_secs()))?;
        parse_ps_pgrps(&out.1)
            .ok_or_else(|| format!("ps -p {pid}: no process group ({})", out.2.trim()))
    }
}

/// `ps -o pgid=,tpgid=` output → (pgid, tpgid).
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub(crate) fn parse_ps_pgrps(text: &str) -> Option<(i32, i32)> {
    let mut it = text.split_whitespace().map(|v| v.parse::<i32>().ok());
    Some((it.next()??, it.next()??))
}

/// `/proc/<pid>/stat` → (pgrp, tpgid). The command name (field 2) is in
/// parentheses and may hold spaces or ')', so split after the LAST ')'.
/// Then: state ppid pgrp session tty_nr tpgid ...
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn parse_proc_stat_pgrps(stat: &str) -> Option<(i32, i32)> {
    let rest = &stat[stat.rfind(')')? + 1..];
    let f: Vec<&str> = rest.split_whitespace().collect();
    Some((f.get(2)?.parse().ok()?, f.get(5)?.parse().ok()?))
}

/// Ask tmux for the active pane's shell pid of `session`, then compare its
/// tty's foreground process group with the shell's own. Blocking, bounded.
///
/// #113: the process table is supplied, so one quit check shares one read.
fn tmux_job_state_with(session: &str, table: TableFn<'_>) -> JobState {
    let Some(tmux) = tmux_path() else {
        return JobState::Unknown("tmux not found".into());
    };
    // #104: every pane in every window of the session, not just the
    // active one: a job in a split or another tmux window counts too.
    let target = format!("={session}");
    let out = crate::mcp::run_with_timeout(
        &tmux,
        &[
            "list-panes",
            "-s",
            "-t",
            target.as_str(),
            "-F",
            "#{session_name} #{pane_pid}",
        ],
        &std::env::temp_dir(),
        PROBE_TIMEOUT,
    )
    .map_err(|_| format!("tmux did not answer within {} s", PROBE_TIMEOUT.as_secs()));
    let panes = out
        .as_ref()
        .ok()
        .and_then(|(ok, o, _)| ok.then(|| parse_session_panes(session, o)).flatten())
        .unwrap_or_default();
    let state = tmux_state_from(session, out, pgid_and_tty_foreground, process_name);
    with_nested(state, &panes, table)
}

/// #110: a pane can wrap its shell in a nested pty (kiro-cli-term,
/// script(1), a python pty wrapper). The pane's own tty then reads idle
/// while the inner shell's tty has a foreground job. When the pane-tty
/// check says Idle, walk each pane's descendants (one bounded `ps`) and
/// check every nested tty too. A failed `ps` is "couldn't check".
pub(crate) fn with_nested(
    state: JobState,
    roots: &[u32],
    table: impl FnOnce() -> Result<Vec<PsRow>, String>,
) -> JobState {
    if state != JobState::Idle || roots.is_empty() {
        return state;
    }
    match table() {
        Err(e) => JobState::Unknown(e),
        Ok(rows) => roots
            .iter()
            .find_map(|r| nested_foreground(*r, &rows))
            .map(JobState::Busy)
            .unwrap_or(JobState::Idle),
    }
}

/// One `ps` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PsRow {
    pub pid: u32,
    pub ppid: u32,
    pub pgid: i32,
    pub tpgid: i32,
    pub tty: String,
    pub comm: String,
}

/// `ps -A -o pid=,ppid=,pgid=,tpgid=,tty=,comm=` → rows (comm may hold
/// spaces: it is the rest of the line).
pub(crate) fn parse_ps_table(text: &str) -> Vec<PsRow> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let ppid = it.next()?.parse().ok()?;
            let pgid = it.next()?.parse().ok()?;
            let tpgid = it.next()?.parse().ok()?;
            let tty = it.next()?.to_string();
            let comm = it.collect::<Vec<_>>().join(" ");
            Some(PsRow {
                pid,
                ppid,
                pgid,
                tpgid,
                tty,
                comm,
            })
        })
        .collect()
}

fn no_tty(t: &str) -> bool {
    matches!(t, "?" | "??" | "-" | "")
}

/// The foreground job on a nested tty under `root`, as a short command
/// name, or None. For each distinct controlling tty among `root` and its
/// descendants, the shallowest process on it is that tty's shell; the tty
/// is busy when its foreground group (tpgid) is neither that shell's pid
/// nor its group. The deepest busy tty wins (the inner command, e.g.
/// `sleep`, not the wrapper).
pub(crate) fn nested_foreground(root: u32, rows: &[PsRow]) -> Option<String> {
    let by_pid: HashMap<u32, &PsRow> = rows.iter().map(|r| (r.pid, r)).collect();
    by_pid.get(&root)?;
    // BFS with depth over the parent links.
    let mut depth: HashMap<u32, usize> = HashMap::from([(root, 0)]);
    let mut queue = std::collections::VecDeque::from([root]);
    while let Some(p) = queue.pop_front() {
        let d = depth[&p];
        for c in rows.iter().filter(|r| r.ppid == p && r.pid != p) {
            if let std::collections::hash_map::Entry::Vacant(e) = depth.entry(c.pid) {
                e.insert(d + 1);
                queue.push_back(c.pid);
            }
        }
    }
    // tty → (depth, leader)
    let mut leaders: HashMap<&str, (usize, &PsRow)> = HashMap::new();
    for (pid, d) in &depth {
        let r = by_pid[pid];
        if no_tty(&r.tty) {
            continue;
        }
        let e = leaders.entry(r.tty.as_str()).or_insert((*d, r));
        if *d < e.0 || (*d == e.0 && r.pid < e.1.pid) {
            *e = (*d, r);
        }
    }
    let mut busy: Vec<(usize, &PsRow)> = leaders
        .into_values()
        .filter(|(_, l)| l.tpgid > 0 && l.tpgid as u32 != l.pid && l.tpgid != l.pgid)
        .collect();
    busy.sort_by_key(|x| std::cmp::Reverse(x.0));
    let (_, l) = busy.first()?;
    let fg = rows
        .iter()
        .find(|r| r.pid == l.tpgid as u32)
        .or_else(|| rows.iter().find(|r| r.pgid == l.tpgid));
    let name = fg
        .map(|r| {
            r.comm
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(&r.comm)
                .trim()
                .to_string()
        })
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "A program".into());
    Some(name.trim_start_matches('-').to_string())
}

/// The process table, one bounded `ps`.
fn process_table() -> Result<Vec<PsRow>, String> {
    let out = crate::mcp::run_with_timeout(
        "ps",
        &["-A", "-o", "pid=,ppid=,pgid=,tpgid=,tty=,comm="],
        &std::env::temp_dir(),
        PROBE_TIMEOUT,
    )
    .map_err(|_| format!("ps did not answer within {} s", PROBE_TIMEOUT.as_secs()))?;
    if !out.0 {
        return Err(format!("ps failed: {}", out.2.trim()));
    }
    Ok(parse_ps_table(&out.1))
}

/// `list-panes -F "#{session_name} #{pane_pid}"` output → the pane pids of
/// `session`. `None` when any line is not for `session` or not a pid, or
/// there are no panes (tmux answered for something else, #99/#104).
pub(crate) fn parse_session_panes(session: &str, out: &str) -> Option<Vec<u32>> {
    let mut pids = Vec::new();
    for line in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let (name, pid) = line.rsplit_once(' ')?;
        if name != session {
            return None;
        }
        pids.push(pid.parse().ok()?);
    }
    (!pids.is_empty()).then_some(pids)
}

/// [`tmux_job_state`] with its helpers injected, so the error, timeout and
/// multi-pane paths are unit-tested (#99, #104). `list` is tmux's
/// (ok, stdout, stderr). Busy if ANY pane's tty foreground process group is
/// not its shell's; else Unknown if any pane couldn't be read; else Idle.
pub(crate) fn tmux_state_from(
    session: &str,
    list: Result<(bool, String, String), String>,
    pgrps: impl Fn(u32) -> Result<(i32, i32), String>,
    name: impl Fn(u32) -> Option<String>,
) -> JobState {
    let (ok, stdout, stderr) = match list {
        Ok(v) => v,
        Err(e) => return JobState::Unknown(e),
    };
    if !ok {
        let why = stderr.trim();
        return JobState::Unknown(if why.is_empty() {
            "tmux error".into()
        } else {
            format!("tmux: {why}")
        });
    }
    let Some(panes) = parse_session_panes(session, &stdout) else {
        return JobState::Unknown(format!("tmux: no panes for session {session}"));
    };
    let mut unknown = None;
    for pane_pid in panes {
        match pgrps(pane_pid) {
            Ok((pgid, tpgid)) => {
                if let Some(fg) = pane_foreground_job(pane_pid, pgid, tpgid) {
                    return JobState::Busy(name(fg).unwrap_or_else(|| "A program".into()));
                }
            }
            Err(e) => unknown = unknown.or(Some(e)),
        }
    }
    match unknown {
        Some(e) => JobState::Unknown(e),
        None => JobState::Idle,
    }
}

/// Old shape kept for the live tmux test: the busy command, if any.
#[cfg(test)]
fn tmux_busy_command(session: &str) -> Option<String> {
    match tmux_job_state_with(session, &process_table) {
        JobState::Busy(c) => Some(c),
        _ => None,
    }
}

/// Short name of process `pid` (`claude`, `node`, `vim`). Blocking.
#[cfg_attr(windows, allow(dead_code))]
fn process_name(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
        let comm = comm.trim();
        (!comm.is_empty()).then(|| comm.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let out = crate::proc::command("ps")
            .args(["-o", "comm=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let name = String::from_utf8_lossy(&out.stdout);
        let name = name.trim();
        let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
        (!name.is_empty()).then(|| name.to_string())
    }
}

/// The first child of `parent` in a process table of (pid, parent pid,
/// exe name), without its `.exe`. Pure, so it is unit-tested everywhere.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn first_child_name(parent: u32, procs: &[(u32, u32, String)]) -> Option<String> {
    procs
        .iter()
        .find(|(pid, ppid, _)| *ppid == parent && *pid != parent)
        .map(|(_, _, name)| {
            let lower = name.to_ascii_lowercase();
            match lower.strip_suffix(".exe") {
                Some(_) => name[..name.len() - 4].to_string(),
                None => name.clone(),
            }
        })
}

/// Every process as (pid, parent pid, exe name), from a Toolhelp32 snapshot.
#[cfg(windows)]
fn windows_process_table() -> Vec<(u32, u32, String)> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    // SAFETY: plain Win32 calls; the entry struct is zeroed with its size
    // set as the API requires, and the snapshot handle is closed below.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut entry) != 0;
        while ok {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            out.push((entry.th32ProcessID, entry.th32ParentProcessID, name));
            ok = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
    out
}

/// Close terminal `id`: drop its pty (which kills the shell) and forget it.
#[tauri::command]
pub fn terminal_close(
    webview_window: tauri::WebviewWindow,
    state: tauri::State<'_, TerminalState>,
    id: String,
) -> Result<(), String> {
    let id = term_key(webview_window.label(), &id);
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
pub fn shell_name(webview_window: tauri::WebviewWindow) -> String {
    let _scope = crate::windows::enter(webview_window.label());
    default_shell().name
}

/// `$SHELL` unset (some desktop launchers): the first of zsh, bash, sh
/// that exists, so a box without zsh still gets a shell.
#[cfg(not(windows))]
fn fallback_shell() -> String {
    ["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .unwrap_or("/bin/sh")
        .to_string()
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use crate::terminal::*;

    fn row(pid: u32, ppid: u32, pgid: i32, tpgid: i32, tty: &str, comm: &str) -> super::PsRow {
        super::PsRow {
            pid,
            ppid,
            pgid,
            tpgid,
            tty: tty.into(),
            comm: comm.into(),
        }
    }

    /// Paulo's Mac (#110): kiro-cli-term wraps the pane's zsh 6406
    /// (ttys017, idle) around an inner /bin/zsh 6422 on ttys018 whose
    /// foreground job is sleep 11561.
    fn kiro() -> Vec<super::PsRow> {
        vec![
            row(1, 0, 1, -1, "??", "/sbin/launchd"),
            row(6406, 6400, 6406, 6406, "ttys017", "-zsh"),
            row(
                6410,
                6406,
                6410,
                6406,
                "ttys017",
                "/Users/p/.local/bin/kiro-cli-term",
            ),
            row(6422, 6410, 6422, 11561, "ttys018", "/bin/zsh"),
            row(11561, 6422, 11561, 11561, "ttys018", "sleep"),
            row(7000, 1, 7000, 7000, "ttys020", "sleep"), // unrelated
        ]
    }

    #[test]
    fn nested_pty_job_is_busy_with_the_inner_command() {
        assert_eq!(
            super::nested_foreground(6406, &kiro()).as_deref(),
            Some("sleep")
        );
        assert_eq!(
            super::with_nested(JobState::Idle, &[6406], || Ok(kiro())),
            JobState::Busy("sleep".into())
        );
    }

    #[test]
    fn nested_pty_idle_inner_shell_is_idle() {
        let mut t = kiro();
        t.retain(|r| r.pid != 11561);
        t.iter_mut().find(|r| r.pid == 6422).unwrap().tpgid = 6422;
        assert_eq!(super::nested_foreground(6406, &t), None);
        assert_eq!(
            super::with_nested(JobState::Idle, &[6406], || Ok(t)),
            JobState::Idle
        );
    }

    #[test]
    fn nested_check_keeps_couldnt_check_and_busy() {
        assert_eq!(
            super::with_nested(JobState::Idle, &[6406], || Err(
                "ps did not answer within 3 s".into()
            )),
            JobState::Unknown("ps did not answer within 3 s".into())
        );
        let u = JobState::Unknown("tmux did not answer".into());
        assert_eq!(
            super::with_nested(u.clone(), &[6406], || panic!("not asked")),
            u
        );
        let b = JobState::Busy("vim".into());
        assert_eq!(
            super::with_nested(b.clone(), &[6406], || panic!("not asked")),
            b
        );
    }

    #[test]
    fn quit_check_reads_the_process_table_once_for_all_panes() {
        // #113: many idle panes, many threads, one `ps`.
        static READS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        fn read() -> Result<Vec<PsRow>, String> {
            READS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(50));
            Ok(parse_ps_table(
                "10 1 10 30 pts/1 kiro-cli-term\n20 10 20 30 pts/2 bash\n30 20 30 30 pts/2 sleep\n",
            ))
        }
        let table = SharedTable::reading(read);
        let states: Vec<JobState> = std::thread::scope(|sc| {
            let hs: Vec<_> = (0..8)
                .map(|i| {
                    let t = &table;
                    sc.spawn(move || {
                        let root = if i == 0 { 10 } else { 999 };
                        with_nested(JobState::Idle, &[root], || t.get())
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(READS.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(states[0], JobState::Busy("sleep".into()));
        assert!(states[1..].iter().all(|s| *s == JobState::Idle));
    }

    #[test]
    fn quit_check_shares_a_failed_table_as_couldnt_check() {
        fn read() -> Result<Vec<PsRow>, String> {
            Err("ps did not answer within 3 s".into())
        }
        let table = SharedTable::reading(read);
        for root in [1, 2] {
            assert!(matches!(
                with_nested(JobState::Idle, &[root], || table.get()),
                JobState::Unknown(_)
            ));
        }
        // Busy / Unknown from the tty check never need the table.
        assert_eq!(
            with_nested(JobState::Busy("vim".into()), &[1], || table.get()),
            JobState::Busy("vim".into())
        );
    }

    #[test]
    fn nested_check_covers_every_pane() {
        let mut t = kiro();
        t.push(row(500, 1, 500, 500, "ttys030", "-zsh")); // idle first pane
        assert_eq!(
            super::with_nested(JobState::Idle, &[500, 6406], || Ok(t)),
            JobState::Busy("sleep".into())
        );
    }

    #[test]
    fn plain_pane_job_still_found_and_unrelated_ttys_ignored() {
        let t = vec![
            row(10, 1, 10, 12, "pts/1", "bash"),
            row(12, 10, 12, 12, "pts/1", "vim"),
        ];
        assert_eq!(super::nested_foreground(10, &t).as_deref(), Some("vim"));
        // pane 6406's tree doesn't include pid 7000 on ttys020.
        let mut k = kiro();
        k.retain(|r| r.pid != 11561 && r.pid != 6422);
        assert_eq!(super::nested_foreground(6406, &k), None);
        assert_eq!(
            super::nested_foreground(999, &k),
            None,
            "pane not in the table"
        );
    }

    #[test]
    fn ps_table_parses_macos_and_linux_rows() {
        let mac = "  6406  6400  6406  6406 ttys017  -zsh\n 6410 6406 6410 6406 ttys017  /Applications/Kiro CLI.app/kiro-cli-term\n    1     0     1     0 ??       /sbin/launchd\n";
        let r = super::parse_ps_table(mac);
        assert_eq!(r.len(), 3);
        assert_eq!(r[1].comm, "/Applications/Kiro CLI.app/kiro-cli-term");
        let linux = " 674471  674469  674471  674472 pts/0    bash\n";
        assert_eq!(super::parse_ps_table(linux)[0].tpgid, 674472);
    }

    /// Live: a python pty wrapper inside a tmux pane (#110), like
    /// kiro-cli-term. The pane's own tty stays idle; the inner tty runs sleep.
    #[test]
    #[cfg(unix)]
    fn live_nested_pty_wrapper_in_tmux_pane() {
        let Some(tmux) = tmux_path() else { return };
        if crate::proc::command("python3").arg("-V").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("sd-nested-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wrap = dir.join("wrap.py");
        std::fs::write(&wrap, "import pty,os,sys\npid,fd=pty.fork()\nif pid==0:\n    os.execvp('bash',['bash','--norc','--noprofile','-ic',sys.argv[1]+'; true'])\nwhile True:\n    try:\n        if not os.read(fd,4096): break\n    except OSError: break\nos.waitpid(pid,0)\n").unwrap();
        let sock = dir.join("tmux.sock");
        let session = format!("sd-nested-{}", std::process::id());
        let t = |args: &[&str]| {
            crate::proc::command(&tmux)
                .arg("-S")
                .arg(&sock)
                .args(args)
                .output()
                .unwrap()
        };
        assert!(t(&[
            "new-session",
            "-d",
            "-s",
            &session,
            "bash --norc --noprofile -i"
        ])
        .status
        .success());
        std::thread::sleep(std::time::Duration::from_millis(800));
        let cmd = format!("python3 {} 'sleep 301' >/dev/null 2>&1 &", wrap.display());
        t(&["send-keys", "-t", &format!("={session}:"), &cmd, "Enter"]);
        std::thread::sleep(std::time::Duration::from_millis(2000));
        let out = t(&[
            "list-panes",
            "-s",
            "-t",
            &format!("={session}"),
            "-F",
            "#{session_name} #{pane_pid}",
        ]);
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let panes = parse_session_panes(&session, &stdout).unwrap();
        let old = tmux_state_from(
            &session,
            Ok((true, stdout.clone(), String::new())),
            pgid_and_tty_foreground,
            process_name,
        );
        let new = with_nested(old.clone(), &panes, process_table);
        t(&["kill-server"]);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            old,
            JobState::Idle,
            "the pane's own tty reads idle (the bug's precondition)"
        );
        assert_eq!(new, JobState::Busy("sleep".into()));
    }

    #[test]
    fn close_folder_finds_every_session_of_the_window() {
        // #127: the ones only WindowSessions remembers count too (#108).
        let state = TerminalState::default();
        window_sessions().record("sd-close-a-1", "w-close-a");
        window_sessions().record("sd-close-b-1", "w-close-b");
        assert_eq!(
            sessions_of_window(&state, "w-close-a"),
            vec!["sd-close-a-1".to_string()]
        );
        window_sessions().forget("sd-close-a-1");
        window_sessions().forget("sd-close-b-1");
        assert!(sessions_of_window(&state, "w-close-a").is_empty());
    }

    #[test]
    fn window_sessions_outlive_terminal_ids() {
        let mut w = super::WindowSessions::default();
        w.record("sd-a-zsh-1", "w-a");
        w.record("sd-a-zsh-2-a-claude", "w-a");
        w.record("sd-b-zsh-3", "w-b");
        assert_eq!(w.of("w-a"), vec!["sd-a-zsh-1", "sd-a-zsh-2-a-claude"]);
        // After A's reload its new term-1 holds zsh-1 only: zsh-2 is still
        // checked; B's session is covered by B's live entry.
        let covered: std::collections::HashSet<String> =
            ["sd-a-zsh-1".to_string(), "sd-b-zsh-3".to_string()].into();
        assert_eq!(
            w.uncovered(&covered, |_| true),
            vec![("sd-a-zsh-2-a-claude".to_string(), "w-a".to_string())]
        );
        // A closed window's sessions are not this quit's concern.
        assert!(w.uncovered(&covered, |l| l != "w-a").is_empty());
        w.forget("sd-a-zsh-2-a-claude");
        assert!(w.uncovered(&covered, |_| true).is_empty());
    }

    #[test]
    fn rerecording_moves_a_session_to_its_new_window() {
        let mut w = super::WindowSessions::default();
        w.record("sd-x-zsh-1", "w-a");
        w.record("sd-x-zsh-1", "w-b");
        assert!(w.of("w-a").is_empty());
        assert_eq!(w.of("w-b"), vec!["sd-x-zsh-1"]);
    }

    #[test]
    fn foreground_job_is_busy_only_when_not_the_shell() {
        use super::foreground_job;
        assert_eq!(foreground_job(100, Some(100)), None);
        assert_eq!(foreground_job(100, Some(4242)), Some(4242));
        assert_eq!(foreground_job(100, None), None);
        assert_eq!(foreground_job(100, Some(0)), None);
        assert_eq!(foreground_job(100, Some(-1)), None);
    }

    #[test]
    fn pane_busy_is_by_process_group_not_by_name() {
        use super::{pane_foreground_job, parse_proc_stat_pgrps};
        // Idle: the tty's foreground group is the shell's own.
        assert_eq!(pane_foreground_job(100, 100, 100), None);
        // A shell that is not its group leader (pgid != pid) is still idle.
        assert_eq!(pane_foreground_job(100, 90, 90), None);
        // No controlling tty / unknown.
        assert_eq!(pane_foreground_job(100, 100, -1), None);
        assert_eq!(pane_foreground_job(100, 100, 0), None);
        // Any other foreground group is busy, whatever it is called
        // (a bash-script agent shows as "bash", like the shell).
        assert_eq!(pane_foreground_job(100, 100, 250), Some(250));
        // /proc/<pid>/stat: the name may hold spaces and ')'.
        let stat = "4242 (my agent) x) S 4000 4242 4242 34817 4300 4194560 0 0";
        assert_eq!(parse_proc_stat_pgrps(stat), Some((4242, 4300)));
        assert_eq!(parse_proc_stat_pgrps("garbage"), None);
    }

    #[test]
    fn first_child_name_finds_the_shells_child() {
        use super::first_child_name;
        let procs = vec![
            (4, 0, "System".to_string()),
            (10, 4, "pwsh.exe".to_string()),
            (11, 1, "conhost.exe".to_string()),
            (12, 10, "node.EXE".to_string()),
        ];
        assert_eq!(first_child_name(10, &procs).as_deref(), Some("node"));
        assert_eq!(first_child_name(12, &procs), None);
        // Idle shell: no children.
        let idle = vec![
            (10, 4, "pwsh.exe".to_string()),
            (11, 1, "conhost.exe".to_string()),
        ];
        assert_eq!(first_child_name(10, &idle), None);
    }

    /// #104: every pane of the session is checked.
    #[test]
    fn session_panes_parse() {
        use super::parse_session_panes;
        assert_eq!(
            parse_session_panes("sd-x", "sd-x 10\nsd-x 20\n\n"),
            Some(vec![10, 20])
        );
        assert_eq!(parse_session_panes("sd-x", ""), None, "no panes");
        assert_eq!(
            parse_session_panes("sd-x", "sd-x 10\nother 20\n"),
            None,
            "another session"
        );
        assert_eq!(parse_session_panes("sd-x", "sd-x abc\n"), None);
        assert_eq!(parse_session_panes("sd-x", "10\n"), None);
    }

    #[test]
    fn a_job_in_any_pane_is_busy() {
        use super::{tmux_state_from, JobState};
        let out = || {
            Ok((
                true,
                "sd-x 10\nsd-x 20\nsd-x 30\n".to_string(),
                String::new(),
            ))
        };
        let name = |p: u32| Some(format!("job{p}"));
        // job only in the 2nd (non-active) pane
        let pg = |p: u32| {
            Ok(if p == 20 {
                (20, 99)
            } else {
                (p as i32, p as i32)
            })
        };
        assert_eq!(
            tmux_state_from("sd-x", out(), pg, name),
            JobState::Busy("job99".into())
        );
        // all idle
        assert_eq!(
            tmux_state_from("sd-x", out(), |p| Ok((p as i32, p as i32)), name),
            JobState::Idle
        );
        // one pane unreadable, none busy: couldn't check
        let pg = |p: u32| {
            if p == 30 {
                Err("ps did not answer".into())
            } else {
                Ok((p as i32, p as i32))
            }
        };
        assert!(matches!(
            tmux_state_from("sd-x", out(), pg, name),
            JobState::Unknown(_)
        ));
        // one unreadable but another busy: busy wins
        let pg = |p: u32| match p {
            10 => Err("ps did not answer".into()),
            30 => Ok((30, 77)),
            _ => Ok((p as i32, p as i32)),
        };
        assert_eq!(
            tmux_state_from("sd-x", out(), pg, name),
            JobState::Busy("job77".into())
        );
    }

    /// #102: the session-alive watchdog's counter.
    #[test]
    fn session_watch_needs_three_consecutive_gone_and_resets_on_success() {
        use super::{SessionProbe::*, SessionWatch};
        let dead = || false;
        let mut w = SessionWatch::default();
        // nothing counts before the session was seen
        assert!(!w.observe(Gone, dead));
        assert!(!w.observe(Gone, dead));
        assert!(!w.observe(Gone, dead));
        assert!(!w.observe(Alive, dead));
        // 1-2 gone, then success: reset
        assert!(!w.observe(Gone, dead));
        assert!(!w.observe(Gone, dead));
        assert!(!w.observe(Alive, dead));
        assert!(!w.observe(Gone, dead));
        assert!(!w.observe(Gone, dead));
        // an unknown (transient tmux error) breaks the streak too
        assert!(!w.observe(Unknown, dead));
        assert!(!w.observe(Gone, dead));
        assert!(!w.observe(Gone, dead));
        // third consecutive gone with nothing alive: close
        assert!(w.observe(Gone, dead));
    }

    #[test]
    fn session_watch_never_closes_while_a_process_lives() {
        use super::{SessionProbe::*, SessionWatch};
        let mut w = SessionWatch::default();
        assert!(!w.observe(Alive, || false));
        for _ in 0..10 {
            assert!(!w.observe(Gone, || true));
        }
        // the job ended: next gone poll closes
        assert!(w.observe(Gone, || false));
    }

    #[test]
    fn unknown_never_closes() {
        use super::{SessionProbe::*, SessionWatch};
        let mut w = SessionWatch::default();
        w.observe(Alive, || false);
        for _ in 0..20 {
            assert!(!w.observe(Unknown, || false));
        }
    }

    #[test]
    fn has_session_errors_are_unknown_not_gone() {
        use super::{classify_has_session, SessionProbe};
        assert_eq!(
            classify_has_session(Ok((true, String::new(), String::new()))),
            SessionProbe::Alive
        );
        assert_eq!(
            classify_has_session(Ok((
                false,
                String::new(),
                "can't find session: =sd-x\n".into()
            ))),
            SessionProbe::Gone
        );
        assert_eq!(
            classify_has_session(Ok((
                false,
                String::new(),
                "no server running on /tmp/tmux-1/default\n".into()
            ))),
            SessionProbe::Gone
        );
        assert_eq!(
            classify_has_session(Ok((false, String::new(), "lost server\n".into()))),
            SessionProbe::Unknown
        );
        assert_eq!(
            classify_has_session(Ok((false, String::new(), String::new()))),
            SessionProbe::Unknown
        );
        assert_eq!(
            classify_has_session(Err("timed out".into())),
            SessionProbe::Unknown
        );
    }

    #[test]
    fn pane_liveness_is_conservative() {
        use super::any_alive;
        assert!(any_alive(&[], |_| Some(false)), "no pids known: keep");
        assert!(!any_alive(&[1, 2], |_| Some(false)));
        assert!(
            any_alive(&[1, 2], |p| Some(p == 2)),
            "foreground job alive: keep"
        );
        assert!(any_alive(&[1], |_| None), "can't tell: keep");
    }

    #[cfg(unix)]
    #[test]
    fn pid_alive_sees_this_process_and_not_a_dead_one() {
        assert_eq!(super::pid_alive(std::process::id()), Some(true));
        let mut c = crate::proc::command("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let pid = c.id();
        c.wait().unwrap();
        assert_eq!(super::pid_alive(pid), Some(false));
    }

    /// #99: a job check that fails or times out is never "nothing running".
    #[test]
    fn tmux_check_errors_and_timeouts_are_unknown_not_idle() {
        use super::{tmux_state_from, JobState};
        let never = |_: u32| -> Result<(i32, i32), String> { panic!("must not probe ps") };
        let name = |_: u32| Some("sleep".to_string());
        // tmux timed out
        assert!(matches!(
            tmux_state_from("sd-x", Err("tmux did not answer within 3 s".into()), never, name),
            JobState::Unknown(w) if w.contains("did not answer")
        ));
        // tmux failed (session renamed / gone, server mismatch)
        assert!(matches!(
            tmux_state_from("sd-x", Ok((false, String::new(), "can't find session: =sd-x\n".into())), never, name),
            JobState::Unknown(w) if w.contains("can't find session")
        ));
        // unparsable pane pid
        assert!(matches!(
            tmux_state_from("sd-x", Ok((true, "\n".into(), String::new())), never, name),
            JobState::Unknown(_)
        ));
        // ps / proc failed
        assert!(matches!(
            tmux_state_from("sd-x", Ok((true, "sd-x 42\n".into(), String::new())), |_| Err("ps did not answer".into()), name),
            JobState::Unknown(w) if w.contains("ps")
        ));
        // healthy: busy and idle still work
        assert_eq!(
            tmux_state_from(
                "sd-x",
                Ok((true, "sd-x 42\n".into(), String::new())),
                |_| Ok((42, 77)),
                name
            ),
            JobState::Busy("sleep".into())
        );
        assert_eq!(
            tmux_state_from(
                "sd-x",
                Ok((true, "sd-x 42\n".into(), String::new())),
                |_| Ok((42, 42)),
                name
            ),
            JobState::Idle
        );
    }

    #[test]
    fn pty_check_without_foreground_group_is_unknown() {
        use super::{pty_job_state, JobState};
        let name = |_: u32| Some("sleep".to_string());
        assert!(matches!(
            pty_job_state(10, None, name),
            JobState::Unknown(_)
        ));
        assert_eq!(pty_job_state(10, Some(10), name), JobState::Idle);
        assert_eq!(
            pty_job_state(10, Some(11), name),
            JobState::Busy("sleep".into())
        );
    }

    #[test]
    fn unknown_terminals_stay_in_the_quit_status() {
        use super::{quit_probe, JobState};
        assert!(quit_probe("w".into(), false, JobState::Idle).is_none());
        let p = quit_probe("w".into(), true, JobState::Unknown("tmux: boom".into())).unwrap();
        assert_eq!(p.unchecked.as_deref(), Some("tmux: boom"));
        assert!(p.survives);
        let b = quit_probe("w".into(), false, JobState::Busy("sleep".into())).unwrap();
        assert_eq!((b.command.as_str(), b.unchecked), ("sleep", None));
    }

    #[test]
    fn ps_pgrps_parse() {
        assert_eq!(super::parse_ps_pgrps(" 5974  6111\n"), Some((5974, 6111)));
        assert_eq!(super::parse_ps_pgrps(""), None);
    }

    /// #43 with tmux: the active pane's foreground command decides.
    #[cfg(unix)]
    #[test]
    fn tmux_pane_busy_follows_its_foreground_command() {
        use super::{tmux_busy_command, tmux_path};
        use std::time::{Duration, Instant};
        let Some(tmux) = tmux_path() else {
            eprintln!("tmux test skipped: no tmux on PATH");
            return;
        };
        if !std::path::Path::new("/bin/bash").exists() {
            return;
        }
        let name = format!("sd-busy-test-{}", std::process::id());
        // #48: the "agent" is itself a bash script, so by name it looks
        // exactly like the pane's bash. Only the process group tells.
        let dir = std::env::temp_dir().join(format!("sd-busy-agent-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let agent = dir.join("agent.sh");
        std::fs::write(&agent, "#!/bin/bash\nwhile :; do sleep 1; done\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let run = |args: &[&str]| {
            crate::proc::command(&tmux)
                .args(args)
                .env_remove("TMUX")
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };
        if !run(&[
            "new-session",
            "-d",
            "-s",
            &name,
            "/bin/bash --norc --noprofile -i",
        ]) {
            eprintln!("tmux test skipped: no usable tmux server");
            return;
        }
        let wait = |want_busy: bool| {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let got = tmux_busy_command(&name);
                if got.is_some() == want_busy {
                    return got;
                }
                assert!(
                    Instant::now() < deadline,
                    "want busy={want_busy}, got {got:?}"
                );
                std::thread::sleep(Duration::from_millis(100));
            }
        };
        wait(false);
        let target = format!("={name}:");
        run(&["send-keys", "-t", &target, agent.to_str().unwrap(), "Enter"]);
        let got = wait(true);
        // Between fork and exec the new job is still named "bash": busy is
        // already right, the name settles a moment later (CI flake).
        #[cfg(target_os = "linux")]
        {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut got = got;
            while got.as_deref() != Some("agent.sh") && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
                got = tmux_busy_command(&name);
            }
            assert_eq!(got.as_deref(), Some("agent.sh"));
        }
        #[cfg(not(target_os = "linux"))]
        let _ = got;
        run(&["send-keys", "-t", &target, "C-c", ""]);
        wait(false);
        run(&["send-keys", "-t", &target, "sleep 30", "Enter"]);
        wait(true);
        run(&["kill-session", "-t", &format!("={name}")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #48: an agent chip whose agent is a bash script is busy too (the
    /// launch wrapper runs it as its own foreground job).
    #[cfg(unix)]
    #[test]
    fn real_pty_bash_script_agent_is_busy() {
        use super::{foreground_job, launch_wrapper};
        use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
        use std::time::{Duration, Instant};
        if !std::path::Path::new("/bin/bash").exists() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("sd-busy-pty-agent-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let agent = dir.join("agent.sh");
        std::fs::write(&agent, "#!/bin/bash\nwhile :; do sleep 1; done\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/bash");
        cmd.arg("-lic");
        cmd.arg(launch_wrapper("bash"));
        cmd.env("SPARKDOWN_LAUNCH", agent.to_str().unwrap());
        cmd.env("SHELL", "/bin/bash");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let controller = pair.master;
        let mut reader = controller.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(std::io::Read::read(&mut reader, &mut buf), Ok(n) if n > 0) {}
        });
        let shell = child.process_id().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let fg = loop {
            if let Some(fg) = foreground_job(shell, controller.process_group_leader()) {
                break fg;
            }
            assert!(
                Instant::now() < deadline,
                "bash-script agent never became busy"
            );
            std::thread::sleep(Duration::from_millis(50));
        };
        // The name settles at exec, a moment after the job takes the tty.
        #[cfg(target_os = "linux")]
        {
            let deadline = Instant::now() + Duration::from_secs(10);
            while super::process_name(fg).as_deref() != Some("agent.sh")
                && Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert_eq!(super::process_name(fg).as_deref(), Some("agent.sh"));
        }
        let _ = fg;
        let _ = child.kill();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #43: an agent chip's launch (`bash -lic <wrapper>`) runs the command
    /// as its own foreground job too, so closing that pane asks.
    #[cfg(unix)]
    #[test]
    fn real_pty_launch_wrapper_command_is_a_foreground_job() {
        use super::{foreground_job, launch_wrapper};
        use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
        use std::time::{Duration, Instant};
        if !std::path::Path::new("/bin/bash").exists() {
            return;
        }
        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/bash");
        cmd.arg("-lic");
        cmd.arg(launch_wrapper("bash"));
        cmd.env("SPARKDOWN_LAUNCH", "sleep 30");
        cmd.env("SHELL", "/bin/bash");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let controller = pair.master;
        let mut reader = controller.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(std::io::Read::read(&mut reader, &mut buf), Ok(n) if n > 0) {}
        });
        let shell = child.process_id().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while foreground_job(shell, controller.process_group_leader()).is_none() {
            assert!(
                Instant::now() < deadline,
                "launched command never became busy"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
    }

    /// #43 on a real pty: an interactive bash is idle at its prompt, busy
    /// while `sleep` runs (its own foreground job), idle again after ^C.
    #[cfg(unix)]
    #[test]
    fn real_pty_foreground_job_follows_the_running_command() {
        use super::foreground_job;
        use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
        use std::io::Write;
        use std::time::{Duration, Instant};
        if !std::path::Path::new("/bin/bash").exists() {
            return;
        }
        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/bash");
        cmd.args(["--norc", "--noprofile", "-i"]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let controller = pair.master;
        let mut reader = controller.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(std::io::Read::read(&mut reader, &mut buf), Ok(n) if n > 0) {}
        });
        let mut writer = controller.take_writer().unwrap();
        let shell = child.process_id().unwrap();
        let wait_for = |want_busy: bool| {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let fg = foreground_job(shell, controller.process_group_leader());
                if fg.is_some() == want_busy {
                    return fg;
                }
                assert!(Instant::now() < deadline, "busy={want_busy} never seen");
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        wait_for(false);
        writer.write_all(b"sleep 30\n").unwrap();
        let fg = wait_for(true).unwrap();
        #[cfg(target_os = "linux")]
        assert_eq!(super::process_name(fg).as_deref(), Some("sleep"));
        let _ = fg;
        writer.write_all(b"\x03").unwrap();
        wait_for(false);
        let _ = child.kill();
    }

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
