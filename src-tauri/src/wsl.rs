//! Agent tools under WSL (#116).
//!
//! A SparkDown terminal on Windows runs PowerShell with `$SPARKDOWN_MCP`
//! (the secret per-launch pipe name) and `$SPARKDOWN_MCP_TOKEN` (the
//! window's routing token) set. Typing `wsl` there starts a Linux shell,
//! and WSL drops every Windows variable that `%WSLENV%` does not list, so
//! an agent in that shell saw neither: its `sparkdown` server (if any)
//! went offline and the agent fell back to reading SparkDown's config
//! files.
//!
//! The fix keeps the native design (env-var gate + per-window token) and
//! only carries it across the boundary:
//!
//! - SparkDown's local Windows terminals list the routing variables in
//!   `WSLENV`. WSL then copies them into the Linux shell, and copies them
//!   back into any Windows program that shell starts — notably the
//!   Windows `sparkdown.exe --mcp-stdio` shim a WSL agent registers. That
//!   shim is a Windows process, so it opens the named pipe exactly like a
//!   native agent's shim, with the same user-only DACL, and routes by the
//!   same token. Nothing listens on TCP or a Linux socket.
//! - `$SPARKDOWN_MCP_SHIM` names the shim program. It is forwarded with
//!   the `/p` flag, so inside WSL it reads `/mnt/c/…/sparkdown.exe` and an
//!   agent can be registered with it (`… mcp add sparkdown
//!   "$SPARKDOWN_MCP_SHIM" --mcp-stdio`; see docs/windows.md).
//!
//! `WSLENV` holds variable NAMES and flags, never values, so it leaks
//! nothing by itself. The values reach only processes started from a
//! SparkDown terminal (as for native agents), all running as the same
//! Windows user.
//!
//! Pure string logic here, so it is tested on every OS; the terminal sets
//! the result only for local Windows terminals.

/// Env var naming the Windows shim program (forwarded into WSL as a path).
pub const SHIM_ENV: &str = "SPARKDOWN_MCP_SHIM";
/// WSL's list of variables shared between Windows and Linux.
pub const WSLENV: &str = "WSLENV";

/// The WSLENV flags for one of our variables: `/p` translates a Windows
/// path to its WSL form (and back). The pipe name and the token are opaque
/// strings that must arrive byte for byte, so they get no flag.
pub fn forward_flags(name: &str) -> Option<&'static str> {
    match name {
        crate::mcp::SOCKET_ENV | crate::mcp::TOKEN_ENV => Some(""),
        "SPARKDOWN_CONTEXT" | SHIM_ENV => Some("/p"),
        _ => None,
    }
}

/// The variable name of one `WSLENV` entry (`NAME/flags`).
fn entry_name(entry: &str) -> &str {
    entry.split('/').next().unwrap_or("")
}

/// `existing` (the user's own `WSLENV`, kept as is) plus an entry for each
/// of our variables in `names`. Our variables replace any entry of the same
/// name (Windows env names are case-insensitive), so a user entry with a
/// different flag cannot turn the pipe name into a translated "path".
/// Names that are not ours are ignored. Empty entries are dropped.
pub fn merged_wslenv(existing: Option<&str>, names: &[&str]) -> String {
    let ours: Vec<(&str, &str)> = names
        .iter()
        .filter_map(|n| forward_flags(n).map(|f| (*n, f)))
        .collect();
    let mut out: Vec<String> = existing
        .unwrap_or("")
        .split(':')
        .filter(|e| !e.is_empty() && !entry_name(e).is_empty())
        .filter(|e| {
            let n = entry_name(e);
            !ours.iter().any(|(o, _)| o.eq_ignore_ascii_case(n))
        })
        .map(str::to_string)
        .collect();
    for (n, f) in ours {
        let e = format!("{n}{f}");
        if !out.contains(&e) {
            out.push(e);
        }
    }
    out.join(":")
}

/// The extra variables a new terminal gets for WSL: `$SPARKDOWN_MCP_SHIM`
/// (only while the MCP server runs) and the merged `WSLENV`. `set` names
/// the SparkDown variables already set on this terminal. Nothing for a
/// non-Windows or a remote (SSH) terminal: there is no WSL boundary to
/// cross, and a remote shell must never see local pipe names.
pub fn terminal_env(
    windows: bool,
    remote: bool,
    shim: Option<String>,
    set: &[&'static str],
    existing_wslenv: Option<&str>,
) -> Vec<(&'static str, String)> {
    if !windows || remote {
        return Vec::new();
    }
    let mut names: Vec<&str> = set.to_vec();
    let mut out = Vec::new();
    // The shim only helps an agent reach a running server.
    let serving = set.contains(&crate::mcp::SOCKET_ENV);
    if let Some(shim) = shim.filter(|s| serving && !s.is_empty()) {
        out.push((SHIM_ENV, shim));
        names.push(SHIM_ENV);
    }
    if names.iter().any(|n| forward_flags(n).is_some()) {
        out.push((WSLENV, merged_wslenv(existing_wslenv, &names)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::{SOCKET_ENV, TOKEN_ENV};

    const ALL: [&str; 4] = [SOCKET_ENV, TOKEN_ENV, "SPARKDOWN_CONTEXT", SHIM_ENV];

    #[test]
    fn forwards_routing_vars_verbatim_and_paths_translated() {
        assert_eq!(
            merged_wslenv(None, &ALL),
            "SPARKDOWN_MCP:SPARKDOWN_MCP_TOKEN:SPARKDOWN_CONTEXT/p:SPARKDOWN_MCP_SHIM/p"
        );
    }

    #[test]
    fn keeps_the_users_entries_and_their_flags() {
        assert_eq!(
            merged_wslenv(Some("USERPROFILE/p:GOPATH/l:FOO/u"), &[SOCKET_ENV]),
            "USERPROFILE/p:GOPATH/l:FOO/u:SPARKDOWN_MCP"
        );
    }

    #[test]
    fn our_flags_win_over_a_conflicting_user_entry() {
        // A `/p` on the pipe name would mangle `\\.\pipe\…` into a path.
        assert_eq!(
            merged_wslenv(Some("sparkdown_mcp/p:SPARKDOWN_MCP_TOKEN/w:X"), &ALL[..2]),
            "X:SPARKDOWN_MCP:SPARKDOWN_MCP_TOKEN"
        );
    }

    #[test]
    fn idempotent_when_reapplied_to_its_own_output() {
        let once = merged_wslenv(Some("A/p"), &ALL);
        assert_eq!(merged_wslenv(Some(&once), &ALL), once);
    }

    #[test]
    fn drops_empty_entries_and_ignores_names_that_are_not_ours() {
        assert_eq!(
            merged_wslenv(Some("::A::/p:"), &["PATH", "SPARKDOWN_LAUNCH", TOKEN_ENV]),
            "A:SPARKDOWN_MCP_TOKEN"
        );
        assert_eq!(merged_wslenv(Some(""), &[]), "");
    }

    #[test]
    fn holds_names_only_never_values() {
        let token = "s3cr3t-token-value";
        let pipe = r"\\.\pipe\sparkdown-jane-0123abcd-mcp";
        let out = merged_wslenv(Some("A"), &ALL);
        assert!(!out.contains(token) && !out.contains(pipe) && !out.contains('\\'));
    }

    const EXE: &str = r"C:\Users\Jane O'Brien\AppData\Local\SparkDown\sparkdown.exe";

    #[test]
    fn windows_terminal_gets_shim_and_wslenv() {
        let env = terminal_env(
            true,
            false,
            Some(EXE.into()),
            &["SPARKDOWN_CONTEXT", SOCKET_ENV, TOKEN_ENV],
            Some("USERPROFILE/p"),
        );
        assert_eq!(
            env,
            vec![
                (SHIM_ENV, EXE.to_string()),
                (
                    WSLENV,
                    "USERPROFILE/p:SPARKDOWN_CONTEXT/p:SPARKDOWN_MCP:SPARKDOWN_MCP_TOKEN:SPARKDOWN_MCP_SHIM/p"
                        .to_string()
                ),
            ]
        );
    }

    #[test]
    fn no_wsl_env_off_windows_or_in_remote_terminals() {
        let set = [SOCKET_ENV, TOKEN_ENV];
        assert!(terminal_env(false, false, Some(EXE.into()), &set, None).is_empty());
        assert!(terminal_env(true, true, Some(EXE.into()), &set, None).is_empty());
    }

    #[test]
    fn no_shim_when_the_server_is_not_running() {
        let env = terminal_env(true, false, Some(EXE.into()), &["SPARKDOWN_CONTEXT"], None);
        assert_eq!(env, vec![(WSLENV, "SPARKDOWN_CONTEXT/p".to_string())]);
        // Nothing of ours set: the user's WSLENV is left alone (not re-set).
        assert!(terminal_env(true, false, Some(EXE.into()), &[], Some("A")).is_empty());
    }

    #[test]
    fn launch_line_and_opencode_config_are_not_forwarded() {
        // SPARKDOWN_LAUNCH runs once in PowerShell; it must not re-run in WSL.
        assert_eq!(forward_flags("SPARKDOWN_LAUNCH"), None);
        assert_eq!(forward_flags("OPENCODE_CONFIG_CONTENT"), None);
    }
}
