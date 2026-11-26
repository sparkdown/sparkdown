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
//! Local folders only: a remote session gets an error. Files that are not
//! UTF-8 text are listed in the preview as skipped and never written.
//! Line endings and everything outside the replaced ranges stay byte for
//! byte as they were.

use super::{preview_around, read_text_bytes, walk_files, Matcher};
use crate::commands::AppError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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

/// Every non-empty hit in `text`, line by line. Offsets are bytes of `text`;
/// a line's `\n` or `\r\n` ending is never part of a hit.
fn hits_in(text: &str, matcher: &Matcher, room: usize) -> Vec<ReplaceHit> {
    let mut hits = Vec::new();
    let mut offset = 0usize;
    for (i, raw) in text.split_inclusive('\n').enumerate() {
        let line = raw.strip_suffix('\n').unwrap_or(raw);
        let line = line.strip_suffix('\r').unwrap_or(line);
        for (a, b) in matcher.find_all(line) {
            if a == b {
                continue;
            }
            if hits.len() >= room {
                return hits;
            }
            let (preview, match_start, match_end, column) = preview_around(line, a, b);
            hits.push(ReplaceHit {
                start: offset + a,
                end: offset + b,
                line: i as u32 + 1,
                column,
                preview,
                match_start,
                match_end,
            });
        }
        offset += raw.len();
    }
    hits
}

/// List every hit under `root` (canonical). See the module docs.
pub(crate) fn preview_local(
    root: &Path,
    include_hidden: bool,
    matcher: &Matcher,
) -> ReplacePreview {
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut total = 0usize;
    let mut truncated = walk_files(root, include_hidden, |path| {
        let Some(bytes) = read_text_bytes(path) else {
            return true;
        };
        let path_str = path.to_string_lossy().into_owned();
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
    ReplacePreview {
        files,
        skipped,
        truncated,
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
    replacement: &str,
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
    let known: HashSet<(usize, usize)> = hits_in(text, matcher, usize::MAX)
        .into_iter()
        .map(|h| (h.start, h.end))
        .collect();
    let mut ranges = edit.ranges.clone();
    ranges.sort_unstable();
    ranges.dedup();
    if ranges.is_empty() || ranges.iter().any(|r| !known.contains(r)) {
        return Err(failed("the selected matches are not in the file".into()));
    }
    let mut out = String::with_capacity(text.len());
    let mut at = 0usize;
    for &(a, b) in &ranges {
        out.push_str(&text[at..a]);
        out.push_str(replacement);
        at = b;
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
    for edit in edits {
        let outcome = |status, count, message: Option<String>| FileOutcome {
            path: edit.path.clone(),
            status,
            count,
            message,
        };
        match edit_one(root, include_hidden, matcher, replacement, edit) {
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
/// preview. Local folders only.
#[tauri::command]
pub async fn replace_preview(
    webview_window: tauri::WebviewWindow,
    root: String,
    query: String,
    case_sensitive: Option<bool>,
    include_hidden: Option<bool>,
    use_regex: Option<bool>,
) -> Result<ReplacePreview, AppError> {
    let matcher = matcher_for(
        &query,
        use_regex.unwrap_or(false),
        case_sensitive.unwrap_or(false),
    )?;
    let include_hidden = include_hidden.unwrap_or(false);
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        let root = local_root(&root)?;
        Ok(preview_local(&root, include_hidden, &matcher))
    })
    .await
    .map_err(|e| AppError::Other(format!("replace task failed: {e}")))?
}

/// Replace the previewed hits in `edits` with `replacement` (taken as plain
/// text, also in regex mode). The query and options must be the preview's.
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

    #[test]
    fn regex_replacement_is_plain_text() {
        let root = temp_dir("regex");
        let file = root.join("a.md");
        fs::write(&file, "v1 v22 x\n").unwrap();
        let m = compile_matcher(r"v\d+", true, true).unwrap();
        let p = preview_local(&root, false, &m);
        let (_, _) = apply_local(&root, false, &m, "$1", &[all_of(&p.files[0])]);
        assert_eq!(read(&file), "$1 $1 x\n");
        let _ = fs::remove_dir_all(&root);
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
