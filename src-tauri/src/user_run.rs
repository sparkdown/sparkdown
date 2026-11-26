//! User-level run config: custom palette commands and on-save hooks.
//!
//! The file lives in the app config directory (`user-run.json`) and is never
//! read from the opened folder. Commands and hooks run as a program plus
//! arguments (no shell).

use crate::commands::AppError;
use crate::windows::FolderId;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewWindow};

/// File name inside the app config directory.
pub const FILE_NAME: &str = "user-run.json";
/// Default run budget when an entry does not set `timeout_ms`.
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MIN_TIMEOUT_MS: u64 = 100;
const MAX_TIMEOUT_MS: u64 = 300_000;
const MAX_OUTPUT_BYTES: usize = 1_048_576;
const WAIT_SLICE: Duration = Duration::from_millis(20);

/// On-disk (and API) document stored at [`path`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserRunFile {
    #[serde(default)]
    pub commands: Vec<UserCommand>,
    #[serde(default)]
    pub save_hooks: Vec<SaveHook>,
}

/// One palette command: a display name and the program + arguments to run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserCommand {
    pub name: String,
    pub argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// One on-save hook. Off until `enabled` is true (a missing flag is off).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SaveHook {
    pub name: String,
    pub argv: Vec<String>,
    /// If empty, the hook matches every file inside the local folder.
    /// Always written (also when empty): the frontend reads it as a list.
    #[serde(default)]
    pub globs: Vec<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// What the frontend shows after a load or save: accepted entries plus notes
/// about anything that was skipped.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserRunView {
    pub commands: Vec<UserCommand>,
    pub save_hooks: Vec<SaveHook>,
    pub problems: Vec<String>,
    /// The file as a whole could not be read; Settings shows this and does
    /// not write the file until it is fixed by hand.
    pub file_error: Option<String>,
    pub path: String,
}

/// Result of running one program.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunOutcome {
    pub name: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub output: String,
    /// Set when the process could not be started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Absolute path of the user-level run file (the file may not exist yet).
pub fn path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Config(e.to_string()))?;
    Ok(dir.join(FILE_NAME))
}

/// Result of reading a user-run document: accepted entries, a note for
/// every entry that was skipped, and what a Settings save must keep.
#[derive(Debug, Default)]
pub struct Parsed {
    pub file: UserRunFile,
    /// One line per skipped entry (or ignored field), with the reason.
    pub problems: Vec<String>,
    /// Set when the document as a whole could not be read (not JSON, not an
    /// object, or a list that is not an array). Settings does not write the
    /// file while this is set, so a hand edit is never replaced.
    pub file_error: Option<String>,
    /// Skipped entries exactly as written, kept when Settings saves.
    skipped_commands: Vec<serde_json::Value>,
    skipped_hooks: Vec<serde_json::Value>,
    /// Top-level fields other than `commands` / `save_hooks`, kept on save.
    other_fields: serde_json::Map<String, serde_json::Value>,
}

impl Parsed {
    fn file_level(&mut self, msg: String) {
        self.problems.push(msg.clone());
        if self.file_error.is_none() {
            self.file_error = Some(msg);
        }
    }
}

const COMMAND_FIELDS: &[&str] = &["name", "argv", "command", "timeout_ms"];
const HOOK_FIELDS: &[&str] = &["name", "argv", "command", "globs", "enabled", "timeout_ms"];

/// Load `path`, skipping bad entries instead of failing the whole file.
/// A missing or empty file is an empty list with no problems.
pub fn load_from(path: &Path) -> Parsed {
    match std::fs::read_to_string(path) {
        Ok(text) => parse_user_run(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Parsed::default(),
        Err(e) => {
            let mut out = Parsed::default();
            out.file_level(format!("Could not read {}: {e}", path.display()));
            out
        }
    }
}

/// Parse a user-run document from `text`. Never fails: every problem is a
/// line in [`Parsed::problems`].
pub fn parse_user_run(text: &str) -> Parsed {
    if text.trim().is_empty() {
        return Parsed::default();
    }
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) => parse_document(value),
        Err(e) => {
            let mut out = Parsed::default();
            out.file_level(format!("user-run.json is not valid JSON: {e}"));
            out
        }
    }
}

fn parse_document(value: serde_json::Value) -> Parsed {
    let mut out = Parsed::default();
    let serde_json::Value::Object(mut obj) = value else {
        out.file_level("user-run.json must be a JSON object.".to_string());
        return out;
    };
    let commands = obj.remove("commands");
    let hooks = obj.remove("save_hooks");
    for key in obj.keys() {
        out.problems.push(format!(
            "Unknown top-level field \"{key}\" in user-run.json was ignored."
        ));
    }
    out.other_fields = obj;
    if let Some(items) = entry_list(commands, "commands", &mut out) {
        let (ok, skipped) = parse_entries(
            &items,
            parse_command,
            |c| &c.name,
            "Command",
            &mut out.problems,
        );
        out.file.commands = ok;
        out.skipped_commands = skipped;
    }
    if let Some(items) = entry_list(hooks, "save_hooks", &mut out) {
        let (ok, skipped) = parse_entries(
            &items,
            parse_hook,
            |h| &h.name,
            "On-save hook",
            &mut out.problems,
        );
        out.file.save_hooks = ok;
        out.skipped_hooks = skipped;
    }
    out
}

/// The entries of one top-level list. Missing or null is an empty list;
/// any other non-array value is a file-level problem.
fn entry_list(
    value: Option<serde_json::Value>,
    key: &str,
    out: &mut Parsed,
) -> Option<Vec<serde_json::Value>> {
    match value {
        None | Some(serde_json::Value::Null) => Some(Vec::new()),
        Some(serde_json::Value::Array(items)) => Some(items),
        Some(_) => {
            out.file_level(format!(
                "\"{key}\" in user-run.json must be an array; it was ignored."
            ));
            None
        }
    }
}

fn parse_entries<T>(
    items: &[serde_json::Value],
    parse: fn(&serde_json::Value, usize) -> Result<T, String>,
    name_of: fn(&T) -> &String,
    kind: &str,
    problems: &mut Vec<String>,
) -> (Vec<T>, Vec<serde_json::Value>) {
    let mut ok = Vec::new();
    let mut skipped = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (i, item) in items.iter().enumerate() {
        match parse(item, i) {
            Ok(entry) => {
                if seen.insert(name_of(&entry).clone()) {
                    ok.push(entry);
                } else {
                    problems.push(format!(
                        "{kind} \"{}\" is duplicated; the later entry was skipped.",
                        name_of(&entry)
                    ));
                    skipped.push(item.clone());
                }
            }
            Err(msg) => {
                problems.push(msg);
                skipped.push(item.clone());
            }
        }
    }
    (ok, skipped)
}

type JsonObject = serde_json::Map<String, serde_json::Value>;

/// The object of entry `index`, its display label, and its checked name.
fn entry_head<'a>(
    item: &'a serde_json::Value,
    index: usize,
    kind: &str,
    allowed: &[&str],
) -> Result<(&'a JsonObject, String), String> {
    let obj = item
        .as_object()
        .ok_or_else(|| format!("{kind} {} is not an object; it was skipped.", index + 1))?;
    let label = match obj
        .get("name")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
    {
        Some(n) if !n.is_empty() => format!("{kind} \"{n}\""),
        _ => format!("{kind} {}", index + 1),
    };
    if let Some(key) = obj.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(format!(
            "{label} has an unknown field \"{key}\"; it was skipped."
        ));
    }
    let name = match obj.get("name") {
        None | Some(serde_json::Value::Null) => {
            return Err(format!("{label} has no name; it was skipped."));
        }
        Some(serde_json::Value::String(s)) if s.trim().is_empty() => {
            return Err(format!("{label} has an empty name; it was skipped."));
        }
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(_) => {
            return Err(format!(
                "{label} has a name that is not text; it was skipped."
            ));
        }
    };
    Ok((obj, name))
}

fn parse_command(item: &serde_json::Value, index: usize) -> Result<UserCommand, String> {
    let (obj, name) = entry_head(item, index, "Command", COMMAND_FIELDS)?;
    let label = format!("Command \"{name}\"");
    Ok(UserCommand {
        argv: required_argv(obj, &label)?,
        timeout_ms: timeout_field(obj, &label)?,
        name,
    })
}

fn parse_hook(item: &serde_json::Value, index: usize) -> Result<SaveHook, String> {
    let (obj, name) = entry_head(item, index, "On-save hook", HOOK_FIELDS)?;
    let label = format!("On-save hook \"{name}\"");
    let argv = required_argv(obj, &label)?;
    let globs = match obj.get("globs") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(arr)) => {
            let globs: Vec<String> = arr
                .iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if globs.len() != arr.len() {
                return Err(format!(
                    "{label} has a file pattern that is empty or not text; it was skipped."
                ));
            }
            globs
        }
        Some(_) => {
            return Err(format!(
                "{label} has a globs value that is not a list of patterns; it was skipped."
            ));
        }
    };
    let enabled = match obj.get("enabled") {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Bool(b)) => *b,
        Some(_) => {
            return Err(format!(
                "{label} has an enabled value that is not true or false; it was skipped."
            ));
        }
    };
    Ok(SaveHook {
        timeout_ms: timeout_field(obj, &label)?,
        name,
        argv,
        globs,
        enabled,
    })
}

fn required_argv(obj: &JsonObject, label: &str) -> Result<Vec<String>, String> {
    match obj.get("argv") {
        Some(serde_json::Value::Array(arr)) => {
            let argv: Vec<String> = arr
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect();
            if argv.len() != arr.len() {
                return Err(format!(
                    "{label} has an argv entry that is not text; it was skipped."
                ));
            }
            if argv.is_empty() || argv[0].trim().is_empty() {
                return Err(format!("{label} has an empty argv; it was skipped."));
            }
            Ok(argv)
        }
        Some(serde_json::Value::Null) | None => match obj.get("command") {
            Some(serde_json::Value::String(line)) => split_command_line(line).map_err(|e| {
                format!("{label} has a command that could not be split ({e}); it was skipped.")
            }),
            Some(serde_json::Value::Null) | None => Err(format!(
                "{label} needs an argv list or a command string; it was skipped."
            )),
            Some(_) => Err(format!(
                "{label} has a command that is not text; it was skipped."
            )),
        },
        Some(_) => Err(format!(
            "{label} has an argv that is not a list of strings; it was skipped."
        )),
    }
}

fn timeout_field(obj: &JsonObject, label: &str) -> Result<Option<u64>, String> {
    match obj.get("timeout_ms") {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => match v.as_u64() {
            Some(ms) if ms > 0 => Ok(Some(clamp_timeout(ms))),
            _ => Err(format!(
                "{label} has a timeout_ms that is not a positive whole number; it was skipped."
            )),
        },
    }
}

fn clamp_timeout(ms: u64) -> u64 {
    ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

/// Write the entries Settings edited to `path` (owner-only, like other
/// SparkDown config files). Entries from `file` are checked the same way a
/// hand edit is read; any that would be skipped are not written and come
/// back as "Not saved" lines. Entries the file already had that are skipped
/// (and unknown top-level fields) are kept as written, so Settings never
/// deletes a hand edit. Refuses to write over a file it cannot read.
pub fn save_merged(path: &Path, file: &UserRunFile) -> Result<Vec<String>, AppError> {
    let current = load_from(path);
    if let Some(err) = &current.file_error {
        return Err(AppError::Config(format!(
            "{err} Fix user-run.json in the editor first; Settings did not change it."
        )));
    }
    let payload = serde_json::to_value(file).map_err(|e| AppError::Config(e.to_string()))?;
    let checked = parse_document(payload);
    let not_saved = checked
        .problems
        .iter()
        .map(|p| format!("Not saved: {p}"))
        .collect();
    let to_values = |v: Vec<serde_json::Value>, keep: &[serde_json::Value]| {
        let mut all = v;
        all.extend(keep.iter().cloned());
        serde_json::Value::Array(all)
    };
    let commands = checked
        .file
        .commands
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::Config(e.to_string()))?;
    let hooks = checked
        .file
        .save_hooks
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::Config(e.to_string()))?;
    let mut doc = serde_json::Map::new();
    doc.insert(
        "commands".into(),
        to_values(commands, &current.skipped_commands),
    );
    doc.insert(
        "save_hooks".into(),
        to_values(hooks, &current.skipped_hooks),
    );
    doc.extend(current.other_fields);
    save_to(path, &serde_json::Value::Object(doc))?;
    Ok(not_saved)
}

fn save_to(path: &Path, doc: &serde_json::Value) -> Result<(), AppError> {
    let json = serde_json::to_string_pretty(doc).map_err(|e| AppError::Config(e.to_string()))?;
    crate::fsio::write_private(path, format!("{json}\n").as_bytes()).map_err(AppError::from)
}

/// Split a typed command line into argv. Whitespace separates arguments;
/// single quotes are literal; in double quotes, `\\` and `\"` are escapes
/// and any other backslash is kept (so Windows paths stay intact). There is
/// no shell expansion.
pub fn split_command_line(input: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut chars = input.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;
    let mut started = false;
    while let Some(c) = chars.next() {
        if in_single {
            if c == '\'' {
                in_single = false;
            } else {
                cur.push(c);
            }
            continue;
        }
        if in_double {
            if c == '"' {
                in_double = false;
            } else if c == '\\' {
                match chars.next() {
                    Some(q @ '"') | Some(q @ '\\') => cur.push(q),
                    Some(other) => {
                        cur.push('\\');
                        cur.push(other);
                    }
                    None => cur.push('\\'),
                }
            } else {
                cur.push(c);
            }
            continue;
        }
        match c {
            '\'' => {
                started = true;
                in_single = true;
            }
            '"' => {
                started = true;
                in_double = true;
            }
            c if c.is_whitespace() => {
                if started {
                    args.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            _ => {
                started = true;
                cur.push(c);
            }
        }
    }
    if in_single || in_double {
        return Err("unclosed quote".into());
    }
    if started {
        args.push(cur);
    }
    if args.is_empty() {
        return Err("empty command".into());
    }
    Ok(args)
}

/// Quote `argv` for display (not for a shell).
#[cfg(test)]
pub fn join_command_line(argv: &[String]) -> String {
    argv.iter()
        .map(|a| quote_arg(a))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
fn quote_arg(a: &str) -> String {
    if a.is_empty() {
        return "\"\"".to_string();
    }
    let needs = a
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '"' | '\\' | '\''));
    if !needs {
        return a.to_string();
    }
    let mut s = String::from("\"");
    for c in a.chars() {
        if c == '"' || c == '\\' {
            s.push('\\');
        }
        s.push(c);
    }
    s.push('"');
    s
}

/// True when `relative` (from the folder root, `/`-separated) matches any
/// glob in `globs`. An empty list matches every path.
pub fn path_matches_globs(relative: &str, globs: &[String]) -> bool {
    if globs.is_empty() {
        return true;
    }
    let rel = normalize_rel(relative);
    globs.iter().any(|g| glob_matches(g, &rel))
}

fn normalize_rel(relative: &str) -> String {
    relative
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string()
}

fn glob_matches(pattern: &str, path: &str) -> bool {
    let pat = pattern.replace('\\', "/");
    for p in expand_braces(&pat) {
        if glob_one(&p, path) {
            return true;
        }
        // A pattern with no slash (e.g. `*.md`) also matches in subfolders.
        if !p.contains('/') && !p.contains("**") {
            if let Some(base) = path.rsplit('/').next() {
                if glob_one(&p, base) {
                    return true;
                }
            }
        }
    }
    false
}

fn expand_braces(pat: &str) -> Vec<String> {
    if let Some(start) = pat.find('{') {
        if let Some(rel_end) = pat[start + 1..].find('}') {
            let end = start + 1 + rel_end;
            let prefix = &pat[..start];
            let suffix = &pat[end + 1..];
            let inner = &pat[start + 1..end];
            if !inner.is_empty() && !inner.contains('{') {
                let mut out = Vec::new();
                for alt in inner.split(',') {
                    out.extend(expand_braces(&format!("{prefix}{alt}{suffix}")));
                }
                return out;
            }
        }
    }
    vec![pat.to_string()]
}

fn glob_one(pat: &str, path: &str) -> bool {
    let Ok(re) = regex_lite::Regex::new(&glob_to_regex(pat)) else {
        return false;
    };
    re.is_match(path)
}

fn glob_to_regex(pat: &str) -> String {
    let mut out = String::from("^");
    let chars: Vec<char> = pat.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '*' && i + 1 < chars.len() && chars[i + 1] == '*' {
            i += 2;
            if i < chars.len() && chars[i] == '/' {
                i += 1;
                out.push_str("(?:.*/)?");
            } else {
                out.push_str(".*");
            }
            continue;
        }
        match chars[i] {
            '*' => out.push_str("[^/]*"),
            '?' => out.push_str("[^/]"),
            c => {
                if ".+()[]{}^$|\\".contains(c) {
                    out.push('\\');
                }
                out.push(c);
            }
        }
        i += 1;
    }
    out.push('$');
    out
}

/// Relative path of `saved` inside a local `folder`, `/`-separated.
pub fn relative_in_folder(folder: &FolderId, saved: &str) -> Option<String> {
    let FolderId::Local { path: root } = folder else {
        return None;
    };
    if !folder.contains_local(saved) {
        return None;
    }
    let norm = |s: &str| {
        let s = s
            .strip_prefix(r"\\?\")
            .filter(|r| !r.starts_with("UNC\\"))
            .unwrap_or(s);
        s.replace('\\', "/").trim_end_matches('/').to_string()
    };
    let (root, path) = (norm(root), norm(saved));
    if path == root {
        return None;
    }
    let prefix = format!("{root}/");
    path.strip_prefix(&prefix).map(str::to_string)
}

/// Hooks that should run for a successful save of `saved_path`.
pub fn hooks_for_save<'a>(
    file: &'a UserRunFile,
    folder: &FolderId,
    saved_path: &str,
) -> Vec<&'a SaveHook> {
    let Some(rel) = relative_in_folder(folder, saved_path) else {
        return Vec::new();
    };
    file.save_hooks
        .iter()
        .filter(|h| h.enabled && !h.argv.is_empty() && path_matches_globs(&rel, &h.globs))
        .collect()
}

/// Run `argv` in `cwd` for up to `timeout`. Stdin is discarded. The first
/// element is the program; the rest are arguments. No shell is started.
pub fn run_argv(
    name: &str,
    argv: &[String],
    cwd: &Path,
    timeout: Duration,
    extra_args: &[String],
) -> RunOutcome {
    let mut full: Vec<String> = argv.to_vec();
    full.extend(extra_args.iter().cloned());
    let cwd_s = cwd.display().to_string();
    if full.is_empty() || full[0].trim().is_empty() {
        return RunOutcome {
            name: name.to_string(),
            argv: full,
            cwd: cwd_s,
            exit_code: None,
            timed_out: false,
            output: String::new(),
            error: Some("The command is empty.".to_string()),
        };
    }
    if !cwd.is_absolute() || !cwd.is_dir() {
        return RunOutcome {
            name: name.to_string(),
            argv: full,
            cwd: cwd_s.clone(),
            exit_code: None,
            timed_out: false,
            output: String::new(),
            error: Some(format!("The folder {cwd_s} is not available.")),
        };
    }
    let mut cmd = crate::proc::command(&full[0]);
    cmd.args(&full[1..])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return RunOutcome {
                name: name.to_string(),
                argv: full.clone(),
                cwd: cwd_s,
                exit_code: None,
                timed_out: false,
                output: String::new(),
                error: Some(format!("Could not start {}: {e}", full[0])),
            };
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_h = std::thread::spawn(move || read_capped(stdout));
    let err_h = std::thread::spawn(move || read_capped(stderr));
    let (timed_out, status) = wait_with_timeout(&mut child, timeout);
    if timed_out {
        kill_tree(&mut child);
        let _ = child.wait();
    }
    let stdout = out_h.join().unwrap_or_default();
    let stderr = err_h.join().unwrap_or_default();
    let mut output = String::new();
    if !stdout.is_empty() {
        output.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&stderr);
    }
    let exit_code = status.and_then(|s| s.code());
    RunOutcome {
        name: name.to_string(),
        argv: full,
        cwd: cwd_s,
        exit_code,
        timed_out,
        output,
        error: if timed_out {
            Some(format!("Timed out after {} ms.", timeout.as_millis()))
        } else {
            None
        },
    }
}

fn read_capped(stream: Option<impl std::io::Read>) -> String {
    let Some(mut stream) = stream else {
        return String::new();
    };
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                let room = MAX_OUTPUT_BYTES.saturating_sub(buf.len());
                if room == 0 {
                    // Drain the rest so the child is not blocked on a full pipe.
                    let mut sink = [0u8; 8192];
                    while let Ok(k) = stream.read(&mut sink) {
                        if k == 0 {
                            break;
                        }
                    }
                    break;
                }
                buf.extend_from_slice(&tmp[..n.min(room)]);
            }
            Err(_) => break,
        }
    }
    let truncated = buf.len() >= MAX_OUTPUT_BYTES;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if truncated {
        text.push_str("\n… output truncated …\n");
    }
    text
}

fn wait_with_timeout(
    child: &mut std::process::Child,
    timeout: Duration,
) -> (bool, Option<std::process::ExitStatus>) {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return (false, Some(status)),
            Ok(None) => {
                if Instant::now() >= deadline {
                    return (true, None);
                }
                std::thread::sleep(WAIT_SLICE);
            }
            Err(_) => return (false, None),
        }
    }
}

fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        // Best effort: the child was started in its own group.
        // SAFETY: this child was started with process_group(0), so -pid is
        // its own group. Ending the group also ends children it started.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
}

fn local_folder_of(label: &str) -> Result<PathBuf, AppError> {
    let reg = crate::windows::registry();
    match reg.get(label).and_then(|w| w.folder.clone()) {
        Some(FolderId::Local { path }) => Ok(PathBuf::from(path)),
        Some(FolderId::Remote { .. }) => Err(AppError::Other(
            "Custom commands and on-save hooks run in a local folder only.".into(),
        )),
        None => Err(AppError::Other(
            "Open a local folder to run a custom command.".into(),
        )),
    }
}

fn view_from(path: PathBuf, parsed: Parsed) -> UserRunView {
    UserRunView {
        commands: parsed.file.commands,
        save_hooks: parsed.file.save_hooks,
        problems: parsed.problems,
        file_error: parsed.file_error,
        path: path.display().to_string(),
    }
}

/// Absolute path of the user-level run file.
#[tauri::command]
pub fn user_run_path(app: AppHandle) -> Result<String, AppError> {
    Ok(path(&app)?.display().to_string())
}

/// Load the user-level run file. A missing file is an empty list, not an error.
#[tauri::command]
pub fn load_user_run(app: AppHandle) -> Result<UserRunView, AppError> {
    let path = path(&app)?;
    let parsed = load_from(&path);
    Ok(view_from(path, parsed))
}

/// Replace the user-level run file with `file` and return the reloaded view.
#[tauri::command]
pub fn save_user_run(app: AppHandle, file: UserRunFile) -> Result<UserRunView, AppError> {
    let path = path(&app)?;
    let not_saved = save_merged(&path, &file)?;
    let mut parsed = load_from(&path);
    parsed.problems.extend(not_saved);
    Ok(view_from(path, parsed))
}

/// Run the named custom command with the window's local folder as cwd.
#[tauri::command]
pub async fn run_user_command(
    app: AppHandle,
    webview_window: WebviewWindow,
    name: String,
) -> Result<RunOutcome, AppError> {
    let path = path(&app)?;
    let label = webview_window.label().to_string();
    crate::windows::spawn_scoped(label.clone(), move || {
        let folder = local_folder_of(&label)?;
        let file = load_from(&path).file;
        let cmd = file
            .commands
            .iter()
            .find(|c| c.name == name)
            .ok_or_else(|| AppError::Other(format!("No custom command named \"{name}\".")))?;
        let timeout = Duration::from_millis(cmd.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
        Ok(run_argv(&cmd.name, &cmd.argv, &folder, timeout, &[]))
    })
    .await
    .map_err(|e| AppError::Other(format!("run task failed: {e}")))?
}

/// Run every enabled, matching on-save hook for `saved_path`. Always returns
/// a list (empty when none apply); hook failure is in each outcome, not an
/// Err, so a caller can ignore it without failing the save.
#[tauri::command]
pub async fn run_save_hooks(
    app: AppHandle,
    webview_window: WebviewWindow,
    saved_path: String,
) -> Result<Vec<RunOutcome>, AppError> {
    let path = path(&app)?;
    let label = webview_window.label().to_string();
    crate::windows::spawn_scoped(label.clone(), move || {
        let folder = match crate::windows::registry()
            .get(&label)
            .and_then(|w| w.folder.clone())
        {
            Some(f) => f,
            None => return Ok(Vec::new()),
        };
        let file = load_from(&path).file;
        let hooks: Vec<SaveHook> = hooks_for_save(&file, &folder, &saved_path)
            .into_iter()
            .cloned()
            .collect();
        let FolderId::Local { path: cwd } = &folder else {
            return Ok(Vec::new());
        };
        let cwd = PathBuf::from(cwd);
        let extra = vec![saved_path];
        let mut out = Vec::new();
        for hook in hooks {
            let timeout = Duration::from_millis(hook.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
            out.push(run_argv(&hook.name, &hook.argv, &cwd, timeout, &extra));
        }
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(format!("hook task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn problems_of(json: &str) -> (UserRunFile, Vec<String>) {
        let p = parse_user_run(json);
        (p.file, p.problems)
    }

    #[test]
    fn split_command_line_handles_quotes_and_windows_paths() {
        assert_eq!(
            split_command_line("prettier --write .").unwrap(),
            ["prettier", "--write", "."]
        );
        assert_eq!(
            split_command_line(r#"pretty "hello world" 'a b'"#).unwrap(),
            ["pretty", "hello world", "a b"]
        );
        assert_eq!(
            split_command_line(r#""C:\Program Files\app.exe" --flag"#).unwrap(),
            [r"C:\Program Files\app.exe", "--flag"]
        );
        assert_eq!(
            split_command_line(r#"say "say \"hi\"""#).unwrap(),
            ["say", r#"say "hi""#]
        );
        // No shell: a semicolon is just another argument.
        assert_eq!(
            split_command_line("echo hello; echo other").unwrap(),
            ["echo", "hello;", "echo", "other"]
        );
        assert!(split_command_line("").is_err());
        assert!(split_command_line("   ").is_err());
        assert!(split_command_line("\"open").is_err());
        assert_eq!(
            split_command_line("  prettier   --write  ").unwrap(),
            ["prettier", "--write"]
        );
    }

    #[test]
    fn join_command_line_round_trips_common_args() {
        let argv = vec![
            "prettier".into(),
            "--write".into(),
            "hello world".into(),
            r"C:\Program Files\app.exe".into(),
        ];
        let line = join_command_line(&argv);
        assert_eq!(split_command_line(&line).unwrap(), argv);
    }

    #[test]
    fn parse_accepts_argv_or_command_and_skips_bad_entries() {
        let (file, problems) = problems_of(
            r#"{
              "commands": [
                {"name": "Format", "argv": ["prettier", "--write", "."]},
                {"name": "Hello", "command": "echo hello"},
                {"name": "", "argv": ["x"]},
                {"argv": ["x"]},
                {"name": "Bad", "argv": []},
                {"name": "Format", "argv": ["dup"]},
                "not an object",
                {"name": "Quoted", "command": "echo \"a b\""}
              ]
            }"#,
        );
        assert_eq!(file.commands.len(), 3);
        assert_eq!(file.commands[0].name, "Format");
        assert_eq!(file.commands[0].argv, ["prettier", "--write", "."]);
        assert_eq!(file.commands[1].argv, ["echo", "hello"]);
        assert_eq!(file.commands[2].argv, ["echo", "a b"]);
        assert!(problems.iter().any(|p| p.contains("no name")));
        assert!(problems.iter().any(|p| p.contains("empty argv")));
        assert!(problems.iter().any(|p| p.contains("duplicated")));
        assert!(problems.iter().any(|p| p.contains("not an object")));
        assert!(file.save_hooks.is_empty());
    }

    #[test]
    fn parse_reports_invalid_json_and_wrong_shapes_without_panicking() {
        let (file, problems) = problems_of("{ not json");
        assert!(file.commands.is_empty());
        assert!(problems.iter().any(|p| p.contains("not valid JSON")));

        let (file, problems) = problems_of("[]");
        assert!(file.commands.is_empty());
        assert!(problems.iter().any(|p| p.contains("JSON object")));

        let (file, problems) = problems_of(r#"{"commands": {"name": "x"}}"#);
        assert!(file.commands.is_empty());
        assert!(problems.iter().any(|p| p.contains("must be an array")));
    }

    #[test]
    fn missing_file_is_empty_and_a_folder_file_is_never_consulted() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join(FILE_NAME);
        let Parsed { file, problems, .. } = load_from(&user);
        assert!(file.commands.is_empty());
        assert!(problems.is_empty());

        // A file sitting in an opened folder must not be read as user config.
        let opened = dir.path().join("opened-folder");
        fs::create_dir(&opened).unwrap();
        fs::write(
            opened.join(FILE_NAME),
            r#"{"commands":[{"name":"FromFolder","argv":["echo"]}]}"#,
        )
        .unwrap();
        let Parsed { file, problems, .. } = load_from(&user);
        assert!(file.commands.is_empty());
        assert!(problems.is_empty());
        assert!(!file.commands.iter().any(|c| c.name == "FromFolder"));
    }

    #[test]
    fn load_from_reads_only_the_given_path() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join(FILE_NAME);
        fs::write(
            &user,
            r#"{"commands":[{"name":"Hi","argv":["echo","hi"]}],"save_hooks":[{"name":"Fmt","argv":["prettier","--write"],"enabled":true,"globs":["*.md"]}]}"#,
        )
        .unwrap();
        let Parsed { file, problems, .. } = load_from(&user);
        assert!(problems.is_empty());
        assert_eq!(file.commands[0].name, "Hi");
        assert_eq!(file.save_hooks[0].name, "Fmt");
        assert!(file.save_hooks[0].enabled);
        assert_eq!(file.save_hooks[0].globs, ["*.md"]);
    }

    #[test]
    fn hooks_default_to_off_and_empty_globs_match_every_file() {
        let (file, problems) = problems_of(r#"{"save_hooks":[{"name":"All","command":"echo"}]}"#);
        assert!(problems.is_empty());
        assert!(!file.save_hooks[0].enabled);
        assert!(file.save_hooks[0].globs.is_empty());
        assert!(path_matches_globs("src/a.ts", &file.save_hooks[0].globs));
    }

    #[test]
    fn globs_match_basename_braces_and_double_star() {
        assert!(path_matches_globs("readme.md", &["*.md".into()]));
        assert!(path_matches_globs("docs/readme.md", &["*.md".into()]));
        assert!(!path_matches_globs("readme.txt", &["*.md".into()]));
        assert!(path_matches_globs("src/app.ts", &["**/*.{ts,js}".into()]));
        assert!(path_matches_globs("src/app.js", &["**/*.{ts,js}".into()]));
        assert!(!path_matches_globs("src/app.rs", &["**/*.{ts,js}".into()]));
        assert!(path_matches_globs("a/b/c.txt", &["**/c.txt".into()]));
        assert!(path_matches_globs("c.txt", &["**/c.txt".into()]));
        assert!(!path_matches_globs("a/b/d.txt", &["**/c.txt".into()]));
        assert!(path_matches_globs("src/x.rs", &["src/*".into()]));
        assert!(!path_matches_globs("src/nested/x.rs", &["src/*".into()]));
        assert!(path_matches_globs("src/nested/x.rs", &["src/**".into()]));
        assert!(path_matches_globs(
            "one-char/a.md",
            &["one-char/?.md".into()]
        ));
        assert!(!path_matches_globs(
            "one-char/ab.md",
            &["one-char/?.md".into()]
        ));
    }

    #[test]
    fn hooks_for_save_requires_enabled_local_folder_and_glob() {
        let folder = FolderId::Local {
            path: "/proj".into(),
        };
        let remote = FolderId::Remote {
            user: "u".into(),
            hostname: "h".into(),
            port: 22,
            path: "/proj".into(),
        };
        let file = UserRunFile {
            commands: vec![],
            save_hooks: vec![
                SaveHook {
                    name: "Fmt".into(),
                    argv: vec!["prettier".into(), "--write".into()],
                    globs: vec!["*.md".into()],
                    enabled: true,
                    timeout_ms: None,
                },
                SaveHook {
                    name: "Off".into(),
                    argv: vec!["prettier".into(), "--write".into()],
                    globs: vec!["*.md".into()],
                    enabled: false,
                    timeout_ms: None,
                },
                SaveHook {
                    name: "JsOnly".into(),
                    argv: vec!["eslint".into()],
                    globs: vec!["*.js".into()],
                    enabled: true,
                    timeout_ms: None,
                },
            ],
        };
        let names = |hooks: Vec<&SaveHook>| -> Vec<String> {
            hooks.into_iter().map(|h| h.name.clone()).collect()
        };
        assert_eq!(
            names(hooks_for_save(&file, &folder, "/proj/README.md")),
            ["Fmt"]
        );
        assert_eq!(
            names(hooks_for_save(&file, &folder, "/proj/app.js")),
            ["JsOnly"]
        );
        assert!(hooks_for_save(&file, &folder, "/elsewhere/README.md").is_empty());
        assert!(hooks_for_save(&file, &remote, "/proj/README.md").is_empty());
        assert_eq!(
            relative_in_folder(&folder, "/proj/docs/a.md").as_deref(),
            Some("docs/a.md")
        );
    }

    #[test]
    fn save_merged_round_trips_and_is_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let file = UserRunFile {
            commands: vec![UserCommand {
                name: "Hi".into(),
                argv: vec!["echo".into(), "hi".into()],
                timeout_ms: Some(5_000),
            }],
            save_hooks: vec![SaveHook {
                name: "Fmt".into(),
                argv: vec!["prettier".into(), "--write".into()],
                globs: vec!["*.md".into()],
                enabled: true,
                timeout_ms: None,
            }],
        };
        assert!(save_merged(&path, &file).unwrap().is_empty());
        #[cfg(unix)]
        {
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let loaded = load_from(&path);
        assert!(loaded.problems.is_empty());
        assert_eq!(loaded.file, file);
    }

    fn hook(name: &str, globs: &[&str]) -> SaveHook {
        SaveHook {
            name: name.into(),
            argv: vec!["echo".into()],
            globs: globs.iter().map(|g| g.to_string()).collect(),
            enabled: false,
            timeout_ms: None,
        }
    }

    #[test]
    fn a_hook_with_no_globs_is_sent_and_saved_with_an_empty_list() {
        // The frontend reads `globs` as a list; it must be present even
        // when empty, in the view and in the file Settings writes.
        let json = serde_json::to_value(hook("New hook", &[])).unwrap();
        assert_eq!(json["globs"], serde_json::json!([]));

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let file = UserRunFile {
            commands: vec![],
            save_hooks: vec![hook("New hook", &[])],
        };
        assert!(save_merged(&path, &file).unwrap().is_empty());
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["save_hooks"][0]["globs"], serde_json::json!([]));
        let loaded = load_from(&path);
        assert!(loaded.problems.is_empty(), "{:?}", loaded.problems);
        assert_eq!(loaded.file.save_hooks, file.save_hooks);
        let view = serde_json::to_value(view_from(path, loaded)).unwrap();
        assert_eq!(view["save_hooks"][0]["globs"], serde_json::json!([]));
        assert_eq!(view["file_error"], serde_json::Value::Null);
    }

    #[test]
    fn each_bad_entry_is_skipped_with_a_reason_and_the_rest_load() {
        let cases: &[(&str, &str, &str)] = &[
            ("commands", r#"{"argv":["a"]}"#, "has no name"),
            ("commands", r#"{"name":"","argv":["a"]}"#, "empty name"),
            ("commands", r#"{"name":"  ","argv":["a"]}"#, "empty name"),
            (
                "commands",
                r#"{"name":5,"argv":["a"]}"#,
                "name that is not text",
            ),
            ("commands", r#"{"name":"Ok","argv":["b"]}"#, "duplicated"),
            ("commands", r#"{"name":"X","argv":[]}"#, "empty argv"),
            ("commands", r#"{"name":"X","argv":[""]}"#, "empty argv"),
            (
                "commands",
                r#"{"name":"X","argv":"echo hi"}"#,
                "argv that is not a list",
            ),
            (
                "commands",
                r#"{"name":"X","argv":["a",1]}"#,
                "argv entry that is not text",
            ),
            ("commands", r#"{"name":"X"}"#, "needs an argv list"),
            (
                "commands",
                r#"{"name":"X","command":7}"#,
                "command that is not text",
            ),
            (
                "commands",
                r#"{"name":"X","command":"\"open"}"#,
                "could not be split",
            ),
            (
                "commands",
                r#"{"name":"X","argv":["a"],"colour":"red"}"#,
                "unknown field \"colour\"",
            ),
            (
                "commands",
                r#"{"name":"X","argv":["a"],"cwd":"sub"}"#,
                "unknown field \"cwd\"",
            ),
            (
                "commands",
                r#"{"name":"X","argv":["a"],"timeout_ms":"5"}"#,
                "timeout_ms",
            ),
            (
                "commands",
                r#"{"name":"X","argv":["a"],"timeout_ms":-1}"#,
                "timeout_ms",
            ),
            (
                "commands",
                r#"{"name":"X","argv":["a"],"timeout_ms":0}"#,
                "timeout_ms",
            ),
            ("commands", r#""just text""#, "not an object"),
            (
                "save_hooks",
                r#"{"name":"H","argv":["a"],"globs":"*.md"}"#,
                "not a list of patterns",
            ),
            (
                "save_hooks",
                r#"{"name":"H","argv":["a"],"globs":["*.md",""]}"#,
                "empty or not text",
            ),
            (
                "save_hooks",
                r#"{"name":"H","argv":["a"],"globs":[3]}"#,
                "empty or not text",
            ),
            (
                "save_hooks",
                r#"{"name":"H","argv":["a"],"enabled":"yes"}"#,
                "not true or false",
            ),
            (
                "save_hooks",
                r#"{"name":"H","argv":["a"],"glob":["*.md"]}"#,
                "unknown field \"glob\"",
            ),
            ("save_hooks", r#"{"argv":["a"]}"#, "has no name"),
            ("save_hooks", r#"{"name":"Ok","argv":["b"]}"#, "duplicated"),
        ];
        for (list, entry, reason) in cases {
            let json = format!(r#"{{"{list}":[{{"name":"Ok","argv":["echo"]}},{entry}]}}"#);
            let parsed = parse_user_run(&json);
            assert_eq!(parsed.problems.len(), 1, "{entry}: {:?}", parsed.problems);
            assert!(
                parsed.problems[0].contains(reason) && parsed.problems[0].contains("skipped"),
                "{entry}: {:?}",
                parsed.problems
            );
            assert!(parsed.file_error.is_none(), "{entry}");
            let names: Vec<&str> = if *list == "commands" {
                parsed
                    .file
                    .commands
                    .iter()
                    .map(|c| c.name.as_str())
                    .collect()
            } else {
                parsed
                    .file
                    .save_hooks
                    .iter()
                    .map(|h| h.name.as_str())
                    .collect()
            };
            assert_eq!(names, ["Ok"], "{entry}");
        }
    }

    #[test]
    fn hook_globs_missing_null_or_empty_load_as_an_empty_list() {
        for globs in ["", r#","globs":null"#, r#","globs":[]"#] {
            let parsed = parse_user_run(&format!(
                r#"{{"save_hooks":[{{"name":"H","argv":["echo"]{globs}}}]}}"#
            ));
            assert!(parsed.problems.is_empty(), "{globs}: {:?}", parsed.problems);
            assert!(parsed.file.save_hooks[0].globs.is_empty());
        }
    }

    #[test]
    fn empty_missing_and_unreadable_files() {
        for text in ["", "  \n"] {
            let parsed = parse_user_run(text);
            assert!(parsed.problems.is_empty());
            assert!(parsed.file_error.is_none());
        }
        for text in [
            "{ not json",
            "[]",
            "null",
            r#"{"commands":{"name":"x"}}"#,
            r#"{"save_hooks":"x"}"#,
        ] {
            let parsed = parse_user_run(text);
            assert!(parsed.file_error.is_some(), "{text}");
            assert_eq!(parsed.problems.len(), 1, "{text}: {:?}", parsed.problems);
        }
        // One list of the wrong shape does not drop the other list.
        let parsed = parse_user_run(r#"{"commands":"x","save_hooks":[{"name":"H","argv":["a"]}]}"#);
        assert_eq!(parsed.file.save_hooks.len(), 1);
        let parsed = parse_user_run(r#"{"commands":[],"extra":1}"#);
        assert!(parsed.file_error.is_none());
        assert!(parsed.problems[0].contains("Unknown top-level field \"extra\""));
    }

    #[test]
    fn settings_save_keeps_hand_edits_and_rejects_bad_payload_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(
            &path,
            r#"{"commands":[{"name":"Hi","argv":["echo"]},{"argv":["no-name"]}],"save_hooks":[{"name":"H","argv":["a"],"globs":"*.md"}],"note":"mine"}"#,
        )
        .unwrap();
        let payload = UserRunFile {
            commands: vec![
                UserCommand {
                    name: "Hi".into(),
                    argv: vec!["echo".into(), "hi".into()],
                    timeout_ms: None,
                },
                UserCommand {
                    name: "Hi".into(),
                    argv: vec!["dup".into()],
                    timeout_ms: None,
                },
                UserCommand {
                    name: "Empty".into(),
                    argv: vec![],
                    timeout_ms: None,
                },
            ],
            save_hooks: vec![hook("New hook", &[])],
        };
        let not_saved = save_merged(&path, &payload).unwrap();
        assert_eq!(not_saved.len(), 2, "{not_saved:?}");
        assert!(not_saved.iter().all(|p| p.starts_with("Not saved: ")));
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            on_disk["commands"][1],
            serde_json::json!({"argv":["no-name"]})
        );
        assert_eq!(on_disk["save_hooks"][1]["globs"], serde_json::json!("*.md"));
        assert_eq!(on_disk["note"], serde_json::json!("mine"));
        let loaded = load_from(&path);
        assert_eq!(loaded.file.commands.len(), 1);
        assert_eq!(loaded.file.commands[0].argv, ["echo", "hi"]);
        assert_eq!(loaded.file.save_hooks, vec![hook("New hook", &[])]);
        // still listed: the no-name command, the bad hook, the extra field
        assert_eq!(loaded.problems.len(), 3, "{:?}", loaded.problems);
    }

    #[test]
    fn settings_save_does_not_write_over_a_file_it_cannot_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let text = "{ \"commands\": [ {\"name\": \"A\", ";
        fs::write(&path, text).unwrap();
        let err = save_merged(&path, &UserRunFile::default()).unwrap_err();
        assert!(err.to_string().contains("not valid JSON"), "{err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        let view = view_from(path.clone(), load_from(&path));
        assert!(view.file_error.is_some());
    }

    #[test]
    fn run_argv_reports_a_relative_or_missing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("gone");
        for cwd in [Path::new("relative/dir"), missing.as_path()] {
            let out = run_argv("X", &["echo".into()], cwd, Duration::from_secs(2), &[]);
            assert_eq!(out.exit_code, None);
            assert!(
                out.error
                    .as_deref()
                    .unwrap_or("")
                    .contains("is not available"),
                "{out:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn run_argv_uses_cwd_passes_args_without_a_shell_and_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("show.sh");
        let mut f = fs::File::create(&script).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "printf 'cwd=%s\\n' \"$(pwd)\"").unwrap();
        writeln!(f, "printf 'args=%s\\n' \"$*\"").unwrap();
        drop(f);
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        let cwd = dir.path().join("work");
        fs::create_dir(&cwd).unwrap();
        let argv = vec![script.to_string_lossy().into_owned()];
        let out = run_argv(
            "Show",
            &argv,
            &cwd,
            Duration::from_secs(5),
            &["hello; echo pwned".into(), "second".into()],
        );
        assert_eq!(out.error, None);
        assert_eq!(out.exit_code, Some(0));
        assert!(!out.timed_out);
        // macOS temp dirs live under /var, a link to /private/var, and `pwd`
        // prints the resolved path: compare both sides canonicalized.
        let printed = out
            .output
            .lines()
            .find_map(|l| l.strip_prefix("cwd="))
            .unwrap_or_else(|| panic!("no cwd line; output was: {}", out.output));
        assert_eq!(
            fs::canonicalize(printed.trim()).unwrap(),
            fs::canonicalize(&cwd).unwrap(),
            "output was: {}",
            out.output
        );
        // The semicolon was an argument, not a shell command: no "pwned" line
        // of its own, and both args are in the "args=" line.
        assert!(out.output.contains("args=hello; echo pwned second"));
        assert!(!out.output.lines().any(|l| l.trim() == "pwned"));

        let sleeper = dir.path().join("sleep.sh");
        let mut f = fs::File::create(&sleeper).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "sleep 30").unwrap();
        drop(f);
        fs::set_permissions(&sleeper, fs::Permissions::from_mode(0o755)).unwrap();
        let out = run_argv(
            "Sleep",
            &[sleeper.to_string_lossy().into_owned()],
            dir.path(),
            Duration::from_millis(200),
            &[],
        );
        assert!(out.timed_out, "output was: {:?}", out);
        assert!(out.error.as_deref().unwrap_or("").contains("Timed out"));

        let out = run_argv(
            "Missing",
            &["/this/program/does/not/exist".into()],
            dir.path(),
            Duration::from_secs(2),
            &[],
        );
        assert!(out.error.is_some());
        assert_eq!(out.exit_code, None);
    }

    #[cfg(unix)]
    #[test]
    fn run_argv_captures_failure_without_failing_the_caller() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fail.sh");
        let mut f = fs::File::create(&script).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "echo oops 1>&2").unwrap();
        writeln!(f, "exit 3").unwrap();
        drop(f);
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let out = run_argv(
            "Fail",
            &[script.to_string_lossy().into_owned()],
            dir.path(),
            Duration::from_secs(5),
            &[],
        );
        assert_eq!(out.exit_code, Some(3));
        assert!(!out.timed_out);
        assert!(out.output.contains("oops"));
        assert_eq!(out.error, None);
    }
}
