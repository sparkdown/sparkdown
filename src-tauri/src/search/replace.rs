//! Replace in files: preview every hit, then rewrite only the hits the user
//! kept.
//!
//! 1. [`replace_preview`] walks the folder like the search does and lists
//!    every hit per file (byte range, line, preview text) plus a SHA-256
//!    fingerprint of each file's bytes.
//! 2. [`replace_apply`] gets back the kept hits per file with the
//!    fingerprint. A file whose bytes changed since the preview is skipped
//!    and reported; every other file is rewritten with
//!    [`crate::fsio::write_atomic`], one file at a time.
//! 3. The old bytes of every rewritten file are kept for the window, so
//!    [`replace_undo`] can put back the whole batch. A file that changed
//!    again after the replace is left as it is and reported.
//!
//! In regex mode the replacement can use the query's capture groups (see
//! [`Template`]); a literal query's replacement is plain text.
//!
//! Local folders only: a remote session gets an error. Files that are not
//! UTF-8 text, and files open in a tab with unsaved changes, are listed in
//! the preview as skipped and never written.
//! Line endings and everything outside the replaced ranges stay byte for
//! byte as they were.

use super::{preview_around, read_text_bytes, walk_files, Matcher};
use crate::commands::AppError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Most hits one preview lists. Apply only ever writes listed hits, so a
/// capped preview is still exact for what it shows.
pub const MAX_REPLACE_HITS: usize = 2000;
/// Longest replacement text we accept.
const MAX_REPLACEMENT_CHARS: usize = 1000;
/// Old file contents kept for undo, per batch. Files past this budget are
/// skipped (and reported), so every batch stays undoable.
const MAX_UNDO_BYTES: usize = 128 * 1024 * 1024;
const REMOTE_MESSAGE: &str = "Replace is not available for remote folders";
/// Why a file open with unsaved changes is left out (the frontend shows the
/// same words for a tab that gets unsaved changes after the preview).
pub const UNSAVED_REASON: &str = "open with unsaved changes";

/// One piece of a replacement.
#[derive(Debug, Clone, PartialEq)]
enum Piece {
    Text(String),
    /// A capture group by the user's number (0 = the whole hit).
    Group(usize),
}

/// A parsed replacement. In regex mode `$1` (any number of digits) and
/// `${1}` insert a capture group, `${name}` a named one, `$0` the whole hit,
/// and `$$` a single `$`; any other `$` is kept as written. A group that took
/// no part in the hit inserts nothing. Literal queries use the text as is.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Template(Vec<Piece>);

impl Template {
    /// The replacement for `matcher`'s hits, or why it refers to a group the
    /// query doesn't have.
    pub(crate) fn for_matcher(replacement: &str, matcher: &Matcher) -> Result<Self, String> {
        if !matches!(matcher, Matcher::Regex { .. }) {
            return Ok(Template(vec![Piece::Text(replacement.to_owned())]));
        }
        let (count, names) = matcher.user_groups();
        Self::parse(replacement, count, &names)
    }

    fn parse(s: &str, count: usize, names: &[(String, usize)]) -> Result<Self, String> {
        let mut pieces = Vec::new();
        let mut text = String::new();
        let mut rest = s;
        while let Some(i) = rest.find('$') {
            text.push_str(&rest[..i]);
            let after = &rest[i + 1..];
            let (group, used) = if let Some(tail) = after.strip_prefix('$') {
                text.push('$');
                rest = tail;
                continue;
            } else if let Some(body) = after.strip_prefix('{') {
                match body.find('}') {
                    Some(end) if end > 0 => (Some(&body[..end]), end + 2),
                    _ => (None, 0),
                }
            } else {
                let digits = after.bytes().take_while(u8::is_ascii_digit).count();
                ((digits > 0).then(|| &after[..digits]), digits)
            };
            let Some(group) = group else {
                text.push('$');
                rest = after;
                continue;
            };
            let index = if group.bytes().all(|b| b.is_ascii_digit()) {
                match group.parse::<usize>() {
                    Ok(n) if n <= count => n,
                    _ => return Err(no_group(&format!("${group}"), count)),
                }
            } else {
                names
                    .iter()
                    .find(|(n, _)| n == group)
                    .map(|(_, i)| *i)
                    .ok_or_else(|| no_group(&format!("${{{group}}}"), count))?
            };
            if !text.is_empty() {
                pieces.push(Piece::Text(std::mem::take(&mut text)));
            }
            pieces.push(Piece::Group(index));
            rest = &after[used..];
        }
        text.push_str(rest);
        if !text.is_empty() {
            pieces.push(Piece::Text(text));
        }
        Ok(Template(pieces))
    }

    /// The text for one hit; `groups` as given by `Matcher::find_all_groups`.
    fn expand(&self, line: &str, groups: &[Option<(usize, usize)>]) -> String {
        let mut out = String::new();
        for p in &self.0 {
            match p {
                Piece::Text(t) => out.push_str(t),
                Piece::Group(i) => {
                    if let Some(Some((a, b))) = groups.get(*i) {
                        out.push_str(&line[*a..*b]);
                    }
                }
            }
        }
        out
    }
}

fn no_group(reference: &str, count: usize) -> String {
    let has = match count {
        0 => "no capture groups".to_owned(),
        1 => "1 capture group".to_owned(),
        n => format!("{n} capture groups"),
    };
    format!("The replacement uses {reference}, but the search pattern has {has} (use $$ for a literal $)")
}

/// One hit in a file.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReplaceHit {
    /// Byte range of the hit in the file.
    pub start: usize,
    pub end: usize,
    /// 1-based line and column (in chars).
    pub line: u32,
    pub column: u32,
    /// The line around the hit, and the hit's char range inside it.
    pub preview: String,
    pub match_start: u32,
    pub match_end: u32,
    /// Regex mode: the text of each capture group, by the user's numbering
    /// (0 = the hit; None = the group took no part). Empty for a literal
    /// query. The preview expands the replacement from these.
    pub groups: Vec<Option<String>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReplaceFile {
    pub path: String,
    /// SHA-256 (hex) of the file's bytes at preview time.
    pub fingerprint: String,
    pub hits: Vec<ReplaceHit>,
}

/// A file with hits that replace leaves alone, and why.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SkippedFile {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReplacePreview {
    pub files: Vec<ReplaceFile>,
    pub skipped: Vec<SkippedFile>,
    /// The walk stopped at a limit: there may be more hits than listed.
    pub truncated: bool,
    /// Regex mode: how many capture groups the query has, and the number of
    /// each named one, for the replacement's `$1` / `${name}`.
    pub group_count: usize,
    pub group_names: Vec<(String, usize)>,
}

/// The text of a tab open with unsaved changes.
#[derive(Debug, Clone, Deserialize)]
pub struct UnsavedBuffer {
    pub path: String,
    pub text: String,
}

/// The hits to replace in one file, as listed by the preview.
#[derive(Debug, Clone, Deserialize)]
pub struct FileEdit {
    pub path: String,
    pub fingerprint: String,
    /// Byte ranges `[start, end]` taken from the preview's hits.
    pub ranges: Vec<(usize, usize)>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    /// Rewritten (apply) or put back (undo).
    Done,
    /// The file changed on disk since the preview (or since the replace,
    /// for undo); left as it is.
    Changed,
    /// Not written: an error, or a request that does not match the preview.
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileOutcome {
    pub path: String,
    pub status: FileStatus,
    /// Hits replaced in this file (0 unless Done; undo reports the count it
    /// put back).
    pub count: usize,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ApplyResult {
    /// Pass to [`replace_undo`]; None when nothing was written.
    pub batch_id: Option<u64>,
    pub files: Vec<FileOutcome>,
}

/// Old contents of the files one apply rewrote.
struct UndoBatch {
    id: u64,
    files: Vec<UndoFile>,
}

struct UndoFile {
    path: PathBuf,
    original: Vec<u8>,
    /// Fingerprint of what the replace wrote.
    written: String,
    count: usize,
}

static NEXT_BATCH: AtomicU64 = AtomicU64::new(1);

/// The last batch per window, keyed by window label.
fn undo_store() -> &'static Mutex<HashMap<String, UndoBatch>> {
    static STORE: std::sync::OnceLock<Mutex<HashMap<String, UndoBatch>>> =
        std::sync::OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn fingerprint(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Every non-empty hit in `text`, line by line, each with the line it is on
/// and its capture group ranges (see `Matcher::find_all_groups`). Offsets
/// are bytes of `text`; a line's `\n` or `\r\n` ending is never part of a
/// hit, and group ranges are bytes of the line.
fn each_hit<'t>(
    text: &'t str,
    matcher: &Matcher,
    mut f: impl FnMut(u32, usize, &'t str, &[Option<(usize, usize)>]) -> bool,
) {
    let mut offset = 0usize;
    for (i, raw) in text.split_inclusive('\n').enumerate() {
        let line = raw.strip_suffix('\n').unwrap_or(raw);
        let line = line.strip_suffix('\r').unwrap_or(line);
        for groups in matcher.find_all_groups(line) {
            let Some(Some((a, b))) = groups.first().copied() else {
                continue;
            };
            if a == b {
                continue;
            }
            if !f(i as u32 + 1, offset, line, &groups) {
                return;
            }
        }
        offset += raw.len();
    }
}

/// Every non-empty hit in `text`, at most `room`.
fn hits_in(text: &str, matcher: &Matcher, room: usize) -> Vec<ReplaceHit> {
    let with_groups = matches!(matcher, Matcher::Regex { .. });
    let mut hits = Vec::new();
    each_hit(text, matcher, |line_no, offset, line, groups| {
        if hits.len() >= room {
            return false;
        }
        let (a, b) = groups[0].unwrap_or_default();
        let (preview, match_start, match_end, column) = preview_around(line, a, b);
        hits.push(ReplaceHit {
            start: offset + a,
            end: offset + b,
            line: line_no,
            column,
            preview,
            match_start,
            match_end,
            groups: if with_groups {
                groups
                    .iter()
                    .map(|g| g.map(|(x, y)| line[x..y].to_owned()))
                    .collect()
            } else {
                Vec::new()
            },
        });
        true
    });
    hits
}

/// The replacement text of every hit in `text`, by byte range.
fn replacements_in(
    text: &str,
    matcher: &Matcher,
    template: &Template,
) -> HashMap<(usize, usize), String> {
    let mut out = HashMap::new();
    each_hit(text, matcher, |_, offset, line, groups| {
        let (a, b) = groups[0].unwrap_or_default();
        out.insert((offset + a, offset + b), template.expand(line, groups));
        true
    });
    out
}

/// Canonical path → text of the tabs open with unsaved changes.
fn unsaved_map(unsaved: &[UnsavedBuffer]) -> HashMap<PathBuf, &str> {
    unsaved
        .iter()
        .map(|u| {
            let p = Path::new(&u.path);
            (
                p.canonicalize().unwrap_or_else(|_| p.to_path_buf()),
                u.text.as_str(),
            )
        })
        .collect()
}

/// List every hit under `root` (canonical), with no tab open with unsaved
/// changes.
#[cfg(test)]
pub(crate) fn preview_local(
    root: &Path,
    include_hidden: bool,
    matcher: &Matcher,
) -> ReplacePreview {
    preview_local_with(root, include_hidden, matcher, &[])
}

/// List every hit under `root` (canonical). See the module docs. A file in
/// `unsaved` is listed as skipped when its text on disk or in the tab has a
/// hit, so a file left out for its unsaved changes is always shown.
pub(crate) fn preview_local_with(
    root: &Path,
    include_hidden: bool,
    matcher: &Matcher,
    unsaved: &[UnsavedBuffer],
) -> ReplacePreview {
    let unsaved = unsaved_map(unsaved);
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut total = 0usize;
    let mut truncated = walk_files(root, include_hidden, |path| {
        let path_str = path.to_string_lossy().into_owned();
        if let Some(buffer) = unsaved.get(path) {
            let on_disk = read_text_bytes(path)
                .map(|b| !hits_in(&String::from_utf8_lossy(&b), matcher, 1).is_empty())
                .unwrap_or(false);
            if on_disk || !hits_in(buffer, matcher, 1).is_empty() {
                skipped.push(SkippedFile {
                    path: path_str,
                    reason: UNSAVED_REASON.into(),
                });
            }
            return true;
        }
        let Some(bytes) = read_text_bytes(path) else {
            return true;
        };
        let Ok(text) = std::str::from_utf8(&bytes) else {
            let lossy = String::from_utf8_lossy(&bytes);
            if !hits_in(&lossy, matcher, 1).is_empty() {
                skipped.push(SkippedFile {
                    path: path_str,
                    reason: "not UTF-8 text".into(),
                });
            }
            return true;
        };
        let hits = hits_in(text, matcher, MAX_REPLACE_HITS + 1 - total);
        if hits.is_empty() {
            return true;
        }
        total += hits.len();
        files.push(ReplaceFile {
            path: path_str,
            fingerprint: fingerprint(&bytes),
            hits,
        });
        total <= MAX_REPLACE_HITS
    });
    if total > MAX_REPLACE_HITS {
        truncated = true;
        if let Some(last) = files.last_mut() {
            last.hits.pop();
            if last.hits.is_empty() {
                files.pop();
            }
        }
    }
    let (group_count, group_names) = matcher.user_groups();
    ReplacePreview {
        files,
        skipped,
        truncated,
        group_count,
        group_names,
    }
}

/// `path` as a file the preview could have listed: absolute, inside `root`,
/// no `..`, no symlink on the way, no ignored or (unless `include_hidden`)
/// hidden component.
fn check_edit_path(root: &Path, path: &str, include_hidden: bool) -> Result<PathBuf, String> {
    let path = Path::new(path);
    let rel = path
        .strip_prefix(root)
        .map_err(|_| "not inside the open folder".to_string())?;
    for c in rel.components() {
        let Component::Normal(name) = c else {
            return Err("not inside the open folder".into());
        };
        let name = name.to_string_lossy();
        if crate::watcher::ignored_dir_name(&name) || (!include_hidden && name.starts_with('.')) {
            return Err("not a searched file".into());
        }
    }
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("cannot open the file: {e}"))?;
    if canonical != path {
        return Err("the path goes through a link".into());
    }
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a regular file".into());
    }
    Ok(canonical)
}

/// One file ready to write: its old and new bytes.
struct PlannedWrite {
    path: PathBuf,
    original: Vec<u8>,
    new: Vec<u8>,
}

/// The new bytes for one edit, or why the edit can't be done.
fn edit_one(
    root: &Path,
    include_hidden: bool,
    matcher: &Matcher,
    template: &Template,
    edit: &FileEdit,
) -> Result<PlannedWrite, (FileStatus, String)> {
    let failed = |m: String| (FileStatus::Failed, m);
    let path = check_edit_path(root, &edit.path, include_hidden).map_err(failed)?;
    let Some(bytes) = read_text_bytes(&path) else {
        return Err(failed("not a readable text file".into()));
    };
    if fingerprint(&bytes) != edit.fingerprint {
        return Err((
            FileStatus::Changed,
            "changed on disk since the preview".into(),
        ));
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| failed("not UTF-8 text".into()))?;
    // Only ranges the preview listed: the same hits, recomputed now.
    let known = replacements_in(text, matcher, template);
    let mut ranges = edit.ranges.clone();
    ranges.sort_unstable();
    ranges.dedup();
    if ranges.is_empty() || ranges.iter().any(|r| !known.contains_key(r)) {
        return Err(failed("the selected matches are not in the file".into()));
    }
    let mut out = String::with_capacity(text.len());
    let mut at = 0usize;
    for r in &ranges {
        out.push_str(&text[at..r.0]);
        out.push_str(&known[r]);
        at = r.1;
    }
    out.push_str(&text[at..]);
    Ok(PlannedWrite {
        path,
        original: bytes,
        new: out.into_bytes(),
    })
}

/// Apply `edits` under `root` (canonical). Returns the outcome per file and
/// the undo batch (None when nothing was written).
fn apply_local(
    root: &Path,
    include_hidden: bool,
    matcher: &Matcher,
    replacement: &str,
    edits: &[FileEdit],
) -> (Vec<FileOutcome>, Option<UndoBatch>) {
    let mut outcomes = Vec::new();
    let mut undo = Vec::new();
    let mut kept = 0usize;
    let template = match Template::for_matcher(replacement, matcher) {
        Ok(t) => t,
        Err(m) => {
            let failed = |e: &FileEdit| FileOutcome {
                path: e.path.clone(),
                status: FileStatus::Failed,
                count: 0,
                message: Some(m.clone()),
            };
            return (edits.iter().map(failed).collect(), None);
        }
    };
    for edit in edits {
        let outcome = |status, count, message: Option<String>| FileOutcome {
            path: edit.path.clone(),
            status,
            count,
            message,
        };
        match edit_one(root, include_hidden, matcher, &template, edit) {
            Err((status, m)) => outcomes.push(outcome(status, 0, Some(m))),
            Ok(PlannedWrite {
                path,
                original,
                new,
            }) => {
                if kept + original.len() > MAX_UNDO_BYTES {
                    outcomes.push(outcome(
                        FileStatus::Failed,
                        0,
                        Some("batch too large to undo; replace the rest in a second run".into()),
                    ));
                    continue;
                }
                match crate::fsio::write_atomic(&path, &new) {
                    Ok(()) => {
                        let count = edit.ranges.len();
                        kept += original.len();
                        undo.push(UndoFile {
                            path,
                            original,
                            written: fingerprint(&new),
                            count,
                        });
                        outcomes.push(outcome(FileStatus::Done, count, None));
                    }
                    Err(e) => outcomes.push(outcome(FileStatus::Failed, 0, Some(e.to_string()))),
                }
            }
        }
    }
    let batch = (!undo.is_empty()).then(|| UndoBatch {
        id: NEXT_BATCH.fetch_add(1, Ordering::Relaxed),
        files: undo,
    });
    (outcomes, batch)
}

/// Put back every file of `batch` that still holds what the replace wrote.
fn undo_local(batch: UndoBatch) -> Vec<FileOutcome> {
    batch
        .files
        .into_iter()
        .map(|f| {
            let path = f.path.to_string_lossy().into_owned();
            let current = fs::read(&f.path).ok().map(|b| fingerprint(&b));
            if current.as_deref() != Some(f.written.as_str()) {
                return FileOutcome {
                    path,
                    status: FileStatus::Changed,
                    count: 0,
                    message: Some("changed on disk since the replace".into()),
                };
            }
            match crate::fsio::write_atomic(&f.path, &f.original) {
                Ok(()) => FileOutcome {
                    path,
                    status: FileStatus::Done,
                    count: f.count,
                    message: None,
                },
                Err(e) => FileOutcome {
                    path,
                    status: FileStatus::Failed,
                    count: 0,
                    message: Some(e.to_string()),
                },
            }
        })
        .collect()
}

fn local_root(root: &str) -> Result<PathBuf, AppError> {
    if crate::remote::is_active() {
        return Err(AppError::Other(REMOTE_MESSAGE.into()));
    }
    let root = crate::commands::validate_path(root)?;
    if !root.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "Path is not a directory: {}",
            root.display()
        )));
    }
    Ok(root)
}

fn matcher_for(query: &str, use_regex: bool, case_sensitive: bool) -> Result<Matcher, AppError> {
    super::validate_query(query, use_regex)?;
    super::compile_matcher(query, use_regex, case_sensitive)
}

/// List every hit of `query` under `root`, per file, for the replace
/// preview. Local folders only. `unsaved`: the tabs open with unsaved
/// changes, listed as skipped when they have a hit.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn replace_preview(
    webview_window: tauri::WebviewWindow,
    root: String,
    query: String,
    case_sensitive: Option<bool>,
    include_hidden: Option<bool>,
    use_regex: Option<bool>,
    unsaved: Option<Vec<UnsavedBuffer>>,
) -> Result<ReplacePreview, AppError> {
    let matcher = matcher_for(
        &query,
        use_regex.unwrap_or(false),
        case_sensitive.unwrap_or(false),
    )?;
    let include_hidden = include_hidden.unwrap_or(false);
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        let root = local_root(&root)?;
        Ok(preview_local_with(
            &root,
            include_hidden,
            &matcher,
            &unsaved.unwrap_or_default(),
        ))
    })
    .await
    .map_err(|e| AppError::Other(format!("replace task failed: {e}")))?
}

/// Replace the previewed hits in `edits` with `replacement` (a [`Template`]:
/// capture groups in regex mode, plain text otherwise). The query and options
/// must be the preview's.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn replace_apply(
    webview_window: tauri::WebviewWindow,
    root: String,
    query: String,
    replacement: String,
    edits: Vec<FileEdit>,
    case_sensitive: Option<bool>,
    include_hidden: Option<bool>,
    use_regex: Option<bool>,
) -> Result<ApplyResult, AppError> {
    let matcher = matcher_for(
        &query,
        use_regex.unwrap_or(false),
        case_sensitive.unwrap_or(false),
    )?;
    if replacement.chars().count() > MAX_REPLACEMENT_CHARS {
        return Err(AppError::Other("Replacement text is too long".into()));
    }
    Template::for_matcher(&replacement, &matcher).map_err(AppError::Other)?;
    let include_hidden = include_hidden.unwrap_or(false);
    let label = webview_window.label().to_string();
    crate::windows::spawn_scoped(label.clone(), move || {
        let root = local_root(&root)?;
        let (files, batch) = apply_local(&root, include_hidden, &matcher, &replacement, &edits);
        let batch_id = batch.as_ref().map(|b| b.id);
        if let Some(batch) = batch {
            undo_store()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(label, batch);
        }
        Ok(ApplyResult { batch_id, files })
    })
    .await
    .map_err(|e| AppError::Other(format!("replace task failed: {e}")))?
}

/// Undo the last replace of this window (`batch_id` from its result).
#[tauri::command]
pub async fn replace_undo(
    webview_window: tauri::WebviewWindow,
    batch_id: u64,
) -> Result<Vec<FileOutcome>, AppError> {
    if crate::remote::is_active() {
        return Err(AppError::Other(REMOTE_MESSAGE.into()));
    }
    let label = webview_window.label().to_string();
    crate::windows::spawn_scoped(label.clone(), move || {
        let batch = {
            let mut store = undo_store().lock().unwrap_or_else(|e| e.into_inner());
            match store.get(&label) {
                Some(b) if b.id == batch_id => store.remove(&label),
                _ => None,
            }
        };
        let batch = batch.ok_or_else(|| AppError::Other("Nothing to undo".into()))?;
        Ok(undo_local(batch))
    })
    .await
    .map_err(|e| AppError::Other(format!("replace task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::compile_matcher;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sparkdown-replace-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn literal(q: &str) -> Matcher {
        compile_matcher(q, false, true).unwrap()
    }

    /// An edit for every hit the preview listed in `file`.
    fn all_of(file: &ReplaceFile) -> FileEdit {
        FileEdit {
            path: file.path.clone(),
            fingerprint: file.fingerprint.clone(),
            ranges: file.hits.iter().map(|h| (h.start, h.end)).collect(),
        }
    }

    fn read(p: &Path) -> String {
        fs::read_to_string(p).unwrap()
    }

    #[test]
    fn preview_lists_every_hit_on_a_line() {
        let root = temp_dir("every-hit");
        fs::write(root.join("a.md"), "cat cat\nno\n  a cat\n").unwrap();
        let p = preview_local(&root, false, &literal("cat"));
        assert_eq!(p.files.len(), 1);
        let hits = &p.files[0].hits;
        let at: Vec<(u32, u32, usize)> = hits.iter().map(|h| (h.line, h.column, h.start)).collect();
        assert_eq!(at, vec![(1, 1, 0), (1, 5, 4), (3, 5, 15)]);
        assert_eq!(hits[2].preview, "a cat");
        assert_eq!((hits[2].match_start, hits[2].match_end), (2, 5));
        assert!(!p.truncated);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_writes_only_the_kept_hits_and_keeps_crlf() {
        let root = temp_dir("kept-crlf");
        let file = root.join("a.md");
        fs::write(&file, "one cat\r\ntwo cat\r\nthree cat").unwrap();
        let p = preview_local(&root, false, &literal("cat"));
        let mut edit = all_of(&p.files[0]);
        edit.ranges.remove(1); // leave line 2 alone
        let (out, batch) = apply_local(&root, false, &literal("cat"), "dog", &[edit]);
        assert_eq!(out[0].status, FileStatus::Done);
        assert_eq!(out[0].count, 2);
        assert!(batch.is_some());
        assert_eq!(read(&file), "one dog\r\ntwo cat\r\nthree dog");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_handles_multibyte_text_and_case_folding() {
        let root = temp_dir("multibyte");
        let file = root.join("a.md");
        fs::write(&file, "São Paulo e SÃO paulo — são\n").unwrap();
        let m = compile_matcher("são", false, false).unwrap();
        let p = preview_local(&root, false, &m);
        assert_eq!(p.files[0].hits.len(), 3);
        let (out, _) = apply_local(&root, false, &m, "Rio", &[all_of(&p.files[0])]);
        assert_eq!(out[0].status, FileStatus::Done);
        assert_eq!(read(&file), "Rio Paulo e Rio paulo — Rio\n");
        let _ = fs::remove_dir_all(&root);
    }

    fn regex(q: &str) -> Matcher {
        compile_matcher(q, true, true).unwrap()
    }

    /// Apply `replacement` to every hit of regex `q` in a file holding `text`.
    fn regex_replace(name: &str, text: &str, q: &str, replacement: &str) -> String {
        let root = temp_dir(name);
        let file = root.join("a.md");
        fs::write(&file, text).unwrap();
        let m = regex(q);
        let p = preview_local(&root, false, &m);
        let (out, _) = apply_local(&root, false, &m, replacement, &[all_of(&p.files[0])]);
        assert_eq!(out[0].status, FileStatus::Done, "{out:?}");
        let got = read(&file);
        let _ = fs::remove_dir_all(&root);
        got
    }

    #[test]
    fn regex_replacement_inserts_numbered_and_named_groups() {
        assert_eq!(
            regex_replace(
                "groups",
                "ann@ex, bob@ey\n",
                r"(\w+)@(?P<host>\w+)",
                "${host}:$1 [$0]"
            ),
            "ex:ann [ann@ex], ey:bob [bob@ey]\n"
        );
        // ${1} ends the number where the text goes on with digits.
        assert_eq!(
            regex_replace("braces", "v1 v2\n", r"v(\d)", "${1}0"),
            "10 20\n"
        );
    }

    #[test]
    fn regex_replacement_dollar_dollar_is_one_dollar_and_a_lone_dollar_stays() {
        assert_eq!(
            regex_replace("dollar", "cost 5\n", r"(\d+)", "$$$1 $ $x ${"),
            "cost $5 $ $x ${\n"
        );
    }

    #[test]
    fn regex_replacement_group_numbers_ignore_the_boundary_rewrite() {
        // A leading \b before a word character is rewritten into a group of
        // its own (pattern.rs); $1 must still be the user's first group.
        assert_eq!(
            regex_replace("bounded", "são são\n", r"\bs(ã)o\b", "<$1>"),
            "<ã> <ã>\n"
        );
    }

    #[test]
    fn regex_replacement_group_without_a_match_inserts_nothing() {
        assert_eq!(
            regex_replace("optional", "ab b\n", r"(a)?b", "[$1]"),
            "[a] []\n"
        );
    }

    #[test]
    fn regex_replacement_with_a_missing_group_writes_nothing() {
        let root = temp_dir("missing-group");
        let file = root.join("a.md");
        fs::write(&file, "v1 v22 x\n").unwrap();
        let m = regex(r"v(\d+)");
        let p = preview_local(&root, false, &m);
        for bad in ["$2", "${2}", "${name}"] {
            let (out, batch) = apply_local(&root, false, &m, bad, &[all_of(&p.files[0])]);
            assert_eq!(out[0].status, FileStatus::Failed);
            assert!(
                out[0]
                    .message
                    .as_deref()
                    .unwrap()
                    .contains("1 capture group"),
                "{out:?}"
            );
            assert!(batch.is_none());
        }
        assert_eq!(read(&file), "v1 v22 x\n");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn literal_replacement_keeps_dollar_signs() {
        let root = temp_dir("literal-dollar");
        let file = root.join("a.md");
        fs::write(&file, "cat (cat)\n").unwrap();
        let p = preview_local(&root, false, &literal("cat"));
        let (_, _) = apply_local(
            &root,
            false,
            &literal("cat"),
            "$1 $$ ${x}",
            &[all_of(&p.files[0])],
        );
        assert_eq!(read(&file), "$1 $$ ${x} ($1 $$ ${x})\n");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn preview_lists_capture_group_texts_and_names() {
        let root = temp_dir("preview-groups");
        fs::write(root.join("a.md"), "ann@ex\n").unwrap();
        let p = preview_local(&root, false, &regex(r"(\w+)@(?P<host>\w+)(x)?"));
        assert_eq!(p.group_count, 3);
        assert_eq!(p.group_names, vec![("host".to_owned(), 2)]);
        let g = &p.files[0].hits[0].groups;
        assert_eq!(
            g,
            &vec![
                Some("ann@ex".to_owned()),
                Some("ann".to_owned()),
                Some("ex".to_owned()),
                None
            ]
        );
        // Literal queries send no groups.
        let p = preview_local(&root, false, &literal("ann"));
        assert!(p.files[0].hits[0].groups.is_empty());
        assert_eq!(p.group_count, 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn files_open_with_unsaved_changes_are_listed_as_skipped() {
        let root = temp_dir("unsaved");
        fs::write(root.join("disk.md"), "cat\n").unwrap();
        fs::write(root.join("tab-only.md"), "dog\n").unwrap();
        fs::write(root.join("no-hit.md"), "dog\n").unwrap();
        fs::write(root.join("clean.md"), "cat\n").unwrap();
        let buf = |name: &str, text: &str| UnsavedBuffer {
            path: root.join(name).to_string_lossy().into_owned(),
            text: text.into(),
        };
        let unsaved = [
            buf("disk.md", "bird\n"),
            buf("tab-only.md", "dog cat\n"),
            buf("no-hit.md", "dog dog\n"),
        ];
        let p = preview_local_with(&root, false, &literal("cat"), &unsaved);
        let listed: Vec<&str> = p.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].ends_with("clean.md"));
        let mut skipped: Vec<(String, &str)> = p
            .skipped
            .iter()
            .map(|s| {
                (
                    Path::new(&s.path)
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    s.reason.as_str(),
                )
            })
            .collect();
        skipped.sort();
        assert_eq!(
            skipped,
            vec![
                ("disk.md".to_owned(), UNSAVED_REASON),
                ("tab-only.md".to_owned(), UNSAVED_REASON)
            ]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn template_parsing() {
        let names = vec![("host".to_owned(), 2)];
        let t = |s: &str| Template::parse(s, 2, &names);
        assert_eq!(
            t("a$1b").unwrap().0,
            vec![
                Piece::Text("a".into()),
                Piece::Group(1),
                Piece::Text("b".into())
            ]
        );
        assert_eq!(
            t("${host}$0").unwrap().0,
            vec![Piece::Group(2), Piece::Group(0)]
        );
        assert_eq!(t("$$1").unwrap().0, vec![Piece::Text("$1".into())]);
        assert_eq!(t("${}$").unwrap().0, vec![Piece::Text("${}$".into())]);
        assert!(t("$3").unwrap_err().contains("$3"));
        assert!(t("${other}").unwrap_err().contains("${other}"));
        assert!(t("$99999999999999999999999").is_err());
    }

    #[test]
    fn a_file_changed_since_the_preview_is_skipped() {
        let root = temp_dir("changed");
        let a = root.join("a.md");
        let b = root.join("b.md");
        fs::write(&a, "cat\n").unwrap();
        fs::write(&b, "cat\n").unwrap();
        let p = preview_local(&root, false, &literal("cat"));
        // Another writer edits a.md after the preview, same length.
        fs::write(&a, "cat\nhat\n").unwrap();
        let edits: Vec<FileEdit> = p.files.iter().map(all_of).collect();
        let (out, _) = apply_local(&root, false, &literal("cat"), "dog", &edits);
        assert_eq!(out[0].status, FileStatus::Changed);
        assert_eq!(out[1].status, FileStatus::Done);
        assert_eq!(read(&a), "cat\nhat\n");
        assert_eq!(read(&b), "dog\n");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ranges_that_are_not_hits_are_refused() {
        let root = temp_dir("ranges");
        let file = root.join("a.md");
        fs::write(&file, "cat and more\n").unwrap();
        let p = preview_local(&root, false, &literal("cat"));
        let mut edit = all_of(&p.files[0]);
        edit.ranges = vec![(4, 7)];
        let (out, batch) = apply_local(&root, false, &literal("cat"), "dog", &[edit]);
        assert_eq!(out[0].status, FileStatus::Failed);
        assert!(batch.is_none());
        assert_eq!(read(&file), "cat and more\n");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn paths_outside_the_folder_or_through_links_are_refused() {
        let root = temp_dir("paths");
        let outside = temp_dir("paths-outside");
        fs::write(outside.join("x.md"), "cat\n").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/x.md"), "cat\n").unwrap();
        let fp = fingerprint(b"cat\n");
        let mut edits = vec![
            FileEdit {
                path: outside.join("x.md").to_string_lossy().into(),
                fingerprint: fp.clone(),
                ranges: vec![(0, 3)],
            },
            FileEdit {
                path: root.join("sub/../../x.md").to_string_lossy().into(),
                fingerprint: fp.clone(),
                ranges: vec![(0, 3)],
            },
            FileEdit {
                path: root.join(".git/x.md").to_string_lossy().into(),
                fingerprint: fp.clone(),
                ranges: vec![(0, 3)],
            },
        ];
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
            edits.push(FileEdit {
                path: root.join("link/x.md").to_string_lossy().into(),
                fingerprint: fp.clone(),
                ranges: vec![(0, 3)],
            });
        }
        let (out, batch) = apply_local(&root, false, &literal("cat"), "dog", &edits);
        assert!(
            out.iter().all(|o| o.status == FileStatus::Failed),
            "{out:?}"
        );
        assert!(batch.is_none());
        assert_eq!(read(&outside.join("x.md")), "cat\n");
        assert_eq!(read(&root.join(".git/x.md")), "cat\n");
        // The preview does not list them either.
        assert!(preview_local(&root, false, &literal("cat"))
            .files
            .is_empty());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn binary_and_non_utf8_files_are_never_written() {
        let root = temp_dir("encoding");
        fs::write(root.join("bin.dat"), b"cat\0cat").unwrap();
        fs::write(root.join("latin1.txt"), b"caf\xe9 cat\n").unwrap();
        fs::write(root.join("ok.md"), "cat\n").unwrap();
        let p = preview_local(&root, false, &literal("cat"));
        let listed: Vec<&str> = p
            .files
            .iter()
            .map(|f| f.path.rsplit('/').next().unwrap())
            .collect();
        assert_eq!(listed, vec!["ok.md"]);
        assert_eq!(p.skipped.len(), 1);
        assert!(p.skipped[0].path.ends_with("latin1.txt"));
        assert_eq!(p.skipped[0].reason, "not UTF-8 text");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn undo_puts_back_the_batch_but_not_files_changed_again() {
        let root = temp_dir("undo");
        let a = root.join("a.md");
        let b = root.join("b.md");
        fs::write(&a, "cat\r\n").unwrap();
        fs::write(&b, "a cat\n").unwrap();
        let p = preview_local(&root, false, &literal("cat"));
        let edits: Vec<FileEdit> = p.files.iter().map(all_of).collect();
        let (_, batch) = apply_local(&root, false, &literal("cat"), "dog", &edits);
        assert_eq!(read(&a), "dog\r\n");
        fs::write(&b, "a dog, edited\n").unwrap();
        let out = undo_local(batch.unwrap());
        assert_eq!(out[0].status, FileStatus::Done);
        assert_eq!(out[0].count, 1);
        assert_eq!(out[1].status, FileStatus::Changed);
        assert_eq!(read(&a), "cat\r\n");
        assert_eq!(read(&b), "a dog, edited\n");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_large_batch_is_capped_and_applies_exactly_what_was_listed() {
        let root = temp_dir("large");
        for i in 0..30 {
            fs::write(root.join(format!("f{i:02}.md")), "cat\n".repeat(100)).unwrap();
        }
        let p = preview_local(&root, false, &literal("cat"));
        assert!(p.truncated);
        let listed: usize = p.files.iter().map(|f| f.hits.len()).sum();
        assert_eq!(listed, MAX_REPLACE_HITS);
        let edits: Vec<FileEdit> = p.files.iter().map(all_of).collect();
        let (out, batch) = apply_local(&root, false, &literal("cat"), "dog", &edits);
        assert!(out.iter().all(|o| o.status == FileStatus::Done));
        let written: usize = out.iter().map(|o| o.count).sum();
        assert_eq!(written, MAX_REPLACE_HITS);
        assert_eq!(read(&root.join("f00.md")), "dog\n".repeat(100));
        assert_eq!(read(&root.join("f29.md")), "cat\n".repeat(100));
        // Undo restores every file.
        let back = undo_local(batch.unwrap());
        assert!(back.iter().all(|o| o.status == FileStatus::Done));
        assert_eq!(read(&root.join("f00.md")), "cat\n".repeat(100));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn concurrent_writers_during_apply_leave_whole_files() {
        let root = temp_dir("concurrent");
        for i in 0..40 {
            fs::write(root.join(format!("f{i:02}.md")), "cat\n").unwrap();
        }
        let p = preview_local(&root, false, &literal("cat"));
        let edits: Vec<FileEdit> = p.files.iter().map(all_of).collect();
        // Another writer rewrites every odd file while the apply runs.
        let writer_root = root.clone();
        let writer = std::thread::spawn(move || {
            for i in (1..40).step_by(2) {
                crate::fsio::write_atomic(&writer_root.join(format!("f{i:02}.md")), b"agent\n")
                    .unwrap();
            }
        });
        let (out, _) = apply_local(&root, false, &literal("cat"), "dog", &edits);
        writer.join().unwrap();
        for (i, o) in out.iter().enumerate() {
            let text = read(&root.join(format!("f{i:02}.md")));
            match o.status {
                FileStatus::Done if i % 2 == 0 => assert_eq!(text, "dog\n"),
                // An odd file written by us before the other writer got there
                // ends with the other writer's text; never a mix.
                FileStatus::Done => assert!(text == "agent\n" || text == "dog\n"),
                FileStatus::Changed => assert_eq!(text, "agent\n"),
                FileStatus::Failed => panic!("{o:?}"),
            }
        }
        let _ = fs::remove_dir_all(&root);
    }
}
