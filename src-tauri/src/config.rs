//! Application configuration persistence.
//!
//! Stores user preferences as JSON in the platform-specific app config directory.
//! The TypeScript mirror types are generated via `ts-rs` when running `cargo test`.

use crate::commands::AppError;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[cfg(test)]
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS), ts(export, export_to = "../../frontend/src/types/"))]
pub struct AppConfig {
    #[serde(default = "default_theme")]
    pub theme: ThemeMode,

    #[serde(default)]
    pub last_open_files: Vec<String>,

    /// Recently opened folder roots (most-recent first), for the welcome
    /// screen's quick-reopen. Capped by the frontend.
    #[serde(default)]
    pub recent_folders: Vec<String>,

    /// Whether the terminal drawer was open, and its height, so the cockpit
    /// layout is restored across sessions.
    #[serde(default)]
    pub terminal_visible: bool,

    #[serde(default = "default_terminal_height")]
    pub terminal_height: u32,

    /// When true, hide the editor/preview card and let the terminal panel
    /// fill the center column (sidebar stays): the Terminals Only layout.
    #[serde(default)]
    pub terminals_only: bool,

    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: u32,

    #[serde(default = "default_true")]
    pub sidebar_visible: bool,

    /// The sidebar view picked in the activity bar: "files", "changes" or
    /// "search". A plain string on disk so an unknown value (a newer or older
    /// build) falls back to Files in the frontend instead of failing the
    /// whole config load.
    #[serde(default = "default_sidebar_view")]
    #[cfg_attr(test, ts(type = "'files' | 'changes' | 'search'"))]
    pub sidebar_view: String,

    /// Legacy mirror of `default_view_mode` (true unless it is Edit), kept
    /// so an older build reading this file still shows the preview.
    #[serde(default = "default_true")]
    pub preview_visible: bool,

    /// View a newly opened tab starts in: the last Edit / Split / Preview the
    /// user picked in the title bar's view control (Diff is never a default).
    /// `None` in configs written before the view control: derive it from
    /// `preview_visible` (false → Edit, else Split).
    #[serde(default)]
    pub default_view_mode: Option<DefaultViewMode>,

    #[serde(default = "default_true")]
    pub word_wrap: bool,

    #[serde(default)]
    pub show_hidden_files: bool,

    #[serde(default = "default_true")]
    pub enable_diagrams: bool,

    /// Back embedded terminals with tmux so they survive app restarts (and
    /// reattach on relaunch). On by default; when off, terminals are plain
    /// login shells that die with the app. Ignored if tmux isn't installed.
    #[serde(default = "default_true")]
    pub use_tmux: bool,

    /// Agent context bridge: mirror what the user is viewing (and the live
    /// text of unsaved buffers) into a per-workspace temp dir that agents in
    /// the embedded terminal read via $SPARKDOWN_CONTEXT. On by default; off
    /// means the bridge never writes to disk.
    #[serde(default = "default_true")]
    pub agent_context_enabled: bool,

    /// Extra command-line arguments appended to each agent's launch command,
    /// keyed by the agent's `bin` (e.g. "claude" → "--model opus"). Configured
    /// in Settings → Agents so the chip can be tuned per agent. Empty by
    /// default; unknown keys are ignored.
    #[serde(default)]
    pub agent_args: std::collections::HashMap<String, String>,

    /// Check GitHub Releases for a new version at startup (at most once per
    /// 24 h). On by default; "Check for Updates..." works either way.
    #[serde(default = "default_true")]
    pub check_updates_automatically: bool,

    /// When the last automatic update check ran, in ms since the Unix epoch
    /// (0 = never). Drives the 24 h throttle in frontend/src/updater.ts.
    #[serde(default)]
    #[cfg_attr(test, ts(type = "number"))]
    pub last_update_check_ms: u64,

    /// Terminal split layout per workspace, keyed by the workspace's tmux
    /// session prefix (`sd-<hash>-`): a binary tree of rows/columns whose
    /// leaves name the tmux session each pane reattaches to. Restored on the
    /// next launch; panes whose session is gone are dropped. A missing or
    /// malformed value is read as empty (older configs had no layout: their
    /// surviving sessions are laid out as one row).
    #[serde(default, deserialize_with = "lenient_layouts")]
    pub terminal_layouts: std::collections::HashMap<String, TerminalLayout>,

    /// Agents (by `bin`) for which the user chose "Don't ask again" in the
    /// MCP install prompt shown at agent launch. Settings → Agents clears it
    /// ("Ask again when launching"). Empty by default.
    #[serde(default)]
    pub mcp_install_prompt_dismissed: Vec<String>,
}

/// One node of a persisted terminal split layout (see
/// `AppConfig::terminal_layouts` and frontend/src/split-layout.ts).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS), ts(export, export_to = "../../frontend/src/types/"))]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TerminalLayout {
    /// A terminal pane attached to this tmux session.
    Pane { session: String },
    /// Two children side by side (`row`) or stacked (`column`); `ratio` is
    /// the share of the first child (0..1).
    Split {
        dir: TerminalSplitDir,
        ratio: f64,
        a: Box<TerminalLayout>,
        b: Box<TerminalLayout>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS), ts(export, export_to = "../../frontend/src/types/"))]
#[serde(rename_all = "lowercase")]
pub enum TerminalSplitDir {
    Row,
    Column,
}

/// Read `terminal_layouts` without ever failing the whole config: a layout
/// entry that does not parse (hand-edited, or from a newer build) is dropped,
/// the others are kept.
fn lenient_layouts<'de, D>(
    de: D,
) -> Result<std::collections::HashMap<String, TerminalLayout>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(de)?;
    let serde_json::Value::Object(map) = value else {
        return Ok(Default::default());
    };
    Ok(map
        .into_iter()
        .filter_map(|(k, v)| serde_json::from_value(v).ok().map(|l| (k, l)))
        .collect())
}

/// Per-document view a new tab opens in (see `AppConfig::default_view_mode`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS), ts(export, export_to = "../../frontend/src/types/"))]
#[serde(rename_all = "lowercase")]
pub enum DefaultViewMode {
    Edit,
    Split,
    Preview,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS), ts(export, export_to = "../../frontend/src/types/"))]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
    System,
}

fn default_theme() -> ThemeMode {
    ThemeMode::System
}
fn default_sidebar_width() -> u32 {
    252
}
fn default_terminal_height() -> u32 {
    200
}
fn default_sidebar_view() -> String {
    "files".to_string()
}
fn default_true() -> bool {
    true
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            theme: ThemeMode::System,
            last_open_files: vec![],
            recent_folders: vec![],
            terminal_visible: false,
            terminal_height: 200,
            terminals_only: false,
            sidebar_width: 252,
            sidebar_visible: true,
            sidebar_view: default_sidebar_view(),
            preview_visible: true,
            default_view_mode: None,
            word_wrap: true,
            show_hidden_files: false,
            enable_diagrams: true,
            use_tmux: true,
            agent_context_enabled: true,
            agent_args: std::collections::HashMap::new(),
            check_updates_automatically: true,
            last_update_check_ms: 0,
            terminal_layouts: std::collections::HashMap::new(),
            mcp_install_prompt_dismissed: vec![],
        }
    }
}

/// Returns the path to the config.json file in the platform-specific app config directory.
pub fn config_path(app_handle: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Config(e.to_string()))?;
    Ok(dir.join("config.json"))
}

/// Load config from disk, returning defaults if the file doesn't exist.
pub fn load(app_handle: &AppHandle) -> Result<AppConfig, AppError> {
    let path = config_path(app_handle)?;
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(AppConfig::default()),
        Err(e) => return Err(e.into()),
    };
    serde_json::from_str(&content).map_err(|e| AppError::Config(e.to_string()))
}

/// Persist config to disk as pretty-printed JSON.
pub fn save(app_handle: &AppHandle, config: &AppConfig) -> Result<(), AppError> {
    let path = config_path(app_handle)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| AppError::Config(e.to_string()))?;
    Ok(fs::write(&path, json)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(s: &str) -> Box<TerminalLayout> {
        Box::new(TerminalLayout::Pane {
            session: s.to_string(),
        })
    }

    #[test]
    fn old_config_without_layouts_loads_with_empty_map() {
        let cfg: AppConfig = serde_json::from_str(r#"{"theme":"dark","terminal_visible":true}"#)
            .expect("old config parses");
        assert!(cfg.terminal_layouts.is_empty());
        assert!(cfg.terminal_visible);
    }

    #[test]
    fn layout_round_trips() {
        let mut cfg = AppConfig::default();
        let layout = TerminalLayout::Split {
            dir: TerminalSplitDir::Row,
            ratio: 0.6,
            a: pane("sd-1-zsh-1"),
            b: Box::new(TerminalLayout::Split {
                dir: TerminalSplitDir::Column,
                ratio: 0.5,
                a: pane("sd-1-zsh-2"),
                b: pane("sd-1-zsh-3-a-claude"),
            }),
        };
        cfg.terminal_layouts
            .insert("sd-1-".to_string(), layout.clone());
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains(r#""type":"split""#));
        assert!(json.contains(r#""dir":"row""#));
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.terminal_layouts.get("sd-1-"), Some(&layout));
    }

    #[test]
    fn malformed_layout_entries_are_dropped_not_fatal() {
        let json = r#"{
            "theme": "light",
            "terminal_layouts": {
                "sd-good-": {"type":"pane","session":"sd-good-zsh-1"},
                "sd-bad-": {"type":"hexagon"},
                "sd-worse-": 42
            }
        }"#;
        let cfg: AppConfig = serde_json::from_str(json).expect("config still parses");
        assert_eq!(cfg.theme, ThemeMode::Light);
        assert_eq!(cfg.terminal_layouts.len(), 1);
        assert!(cfg.terminal_layouts.contains_key("sd-good-"));

        let not_a_map: AppConfig =
            serde_json::from_str(r#"{"terminal_layouts":[1,2]}"#).expect("parses");
        assert!(not_a_map.terminal_layouts.is_empty());
    }

    #[test]
    fn mcp_prompt_dismissals_default_empty_and_round_trip() {
        let old: AppConfig = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert!(old.mcp_install_prompt_dismissed.is_empty());
        let cfg = AppConfig {
            mcp_install_prompt_dismissed: vec!["gemini".into(), "cursor-agent".into()],
            ..AppConfig::default()
        };
        let back: AppConfig = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(
            back.mcp_install_prompt_dismissed,
            ["gemini", "cursor-agent"]
        );
    }

    #[test]
    fn sidebar_view_defaults_to_files_for_an_older_config() {
        let cfg: AppConfig = serde_json::from_str(r#"{"sidebar_visible": false}"#).unwrap();
        assert_eq!(cfg.sidebar_view, "files");
        assert!(!cfg.sidebar_visible);
        assert_eq!(AppConfig::default().sidebar_view, "files");
    }

    #[test]
    fn an_unknown_sidebar_view_does_not_fail_the_load() {
        let cfg: AppConfig = serde_json::from_str(r#"{"sidebar_view": "outline"}"#).unwrap();
        assert_eq!(cfg.sidebar_view, "outline"); // the frontend maps it to Files
        let round: AppConfig =
            serde_json::from_str(&serde_json::to_string(&AppConfig::default()).unwrap()).unwrap();
        assert_eq!(round.sidebar_view, "files");
    }

    #[test]
    fn default_view_mode_round_trips_and_defaults_to_none() {
        // A config written before the view control has no field: None, so
        // the frontend derives the mode from preview_visible.
        let old: AppConfig = serde_json::from_str(r#"{"preview_visible": false}"#).unwrap();
        assert_eq!(old.default_view_mode, None);
        assert!(!old.preview_visible);

        let cfg: AppConfig = serde_json::from_str(r#"{"default_view_mode": "preview"}"#).unwrap();
        assert_eq!(cfg.default_view_mode, Some(DefaultViewMode::Preview));
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains(r#""default_view_mode":"preview""#));

        // Diff is not a default view.
        assert!(serde_json::from_str::<AppConfig>(r#"{"default_view_mode": "diff"}"#).is_err());
    }
}
