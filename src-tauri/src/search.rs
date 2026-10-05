//! Search in files: the sidebar's workspace text search.
//!
//! A plain, literal (not regex) substring search over the open folder. Local
//! folders are walked here in Rust; remote folders run one POSIX `find` +
//! `grep` over the existing ssh helpers. Both return the same shape, so the
//! frontend does not care where the folder lives.
//!
//! The walk skips what the file watcher skips (VCS, dependency and build
//! directories — see `watcher::IGNORED_DIR_NAMES`), hidden entries unless the
//! caller asks for them, symlinks (no loops, no escapes from the root),
//! binaries and large files. The result list is capped; `truncated` tells the
//! UI that there is more.

use crate::commands::AppError;
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Stop after this many matching lines (the UI says "more results …").
pub const MAX_RESULTS: usize = 500;
/// Skip files larger than this. Search is for text the user wrote, not logs
/// or data dumps.
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Stop the walk after this many files, so a huge folder can't pin a core.
const MAX_FILES_SCANNED: usize = 20_000;
/// A file with a NUL byte in its first 8 KiB is binary (git's heuristic).
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
/// Longest query we accept.
const MAX_QUERY_CHARS: usize = 1000;
/// Preview text around the match, in chars.
const PREVIEW_BEFORE: usize = 40;
const PREVIEW_MAX: usize = 200;

/// One matching line.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SearchMatch {
    /// Absolute path of the file.
    pub path: String,
    /// 1-based line number.
    pub line: u32,
    /// 1-based column (in chars) of the first match on the line.
    pub column: u32,
    /// The line, trimmed and shortened around the match.
    pub preview: String,
    /// Char range of the match inside `preview` (start inclusive, end exclusive).
    pub match_start: u32,
    pub match_end: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SearchResults {
    pub matches: Vec<SearchMatch>,
    /// True if the search stopped at a limit before it saw every file.
    pub truncated: bool,
}

/// Reject queries that can't match a single line or are unreasonably long.
fn validate_query(query: &str) -> Result<(), AppError> {
    if query.is_empty() {
        return Err(AppError::Other("Empty search query".into()));
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(AppError::Other("Search query is too long".into()));
    }
    if query.contains('\n') || query.contains('\r') || query.contains('\0') {
        return Err(AppError::Other("Search query must be a single line".into()));
    }
    Ok(())
}

/// Build a [`SearchMatch`] for `line` if it contains `query`. Case-insensitive
/// search lowercases both sides; columns are counted in chars of the line.
pub(crate) fn match_line(
    path: &str,
    line_no: u32,
    line: &str,
    query: &str,
    case_sensitive: bool,
) -> Option<SearchMatch> {
    let (hay, needle) = if case_sensitive {
        (line.to_string(), query.to_string())
    } else {
        (line.to_lowercase(), query.to_lowercase())
    };
    let byte_at = hay.find(&needle)?;
    // Char offsets in the (possibly lowercased) line. Lowercasing keeps the
    // char count for everything but a few exotic letters; clamp to be safe.
    let line_chars: Vec<char> = line.chars().collect();
    let start = hay[..byte_at].chars().count().min(line_chars.len());
    let len = needle.chars().count();
    let end = (start + len).min(line_chars.len());

    // Trim leading whitespace, then keep a window around the match.
    let lead = line_chars.iter().take_while(|c| c.is_whitespace()).count();
    let lead = lead.min(start);
    let mut from = lead;
    let mut prefix = "";
    if start - from > PREVIEW_BEFORE {
        from = start - PREVIEW_BEFORE;
        prefix = "…";
    }
    let to = (from + PREVIEW_MAX).max(end).min(line_chars.len());
    let body: String = line_chars[from..to].iter().collect();
    let body = body.trim_end();
    let offset = prefix.chars().count();
    let preview = format!("{prefix}{body}");
    let match_start = (start - from + offset) as u32;
    let match_end = ((end - from + offset) as u32).min(preview.chars().count() as u32);
    Some(SearchMatch {
        path: path.to_string(),
        line: line_no,
        column: start as u32 + 1,
        preview,
        match_start,
        match_end,
    })
}

/// Search one file's text, appending at most `room` matches.
fn search_text(
    path: &str,
    text: &str,
    query: &str,
    case_sensitive: bool,
    room: usize,
    out: &mut Vec<SearchMatch>,
) {
    for (i, line) in text.lines().enumerate() {
        if out.len() >= room {
            return;
        }
        if let Some(m) = match_line(path, i as u32 + 1, line, query, case_sensitive) {
            out.push(m);
        }
    }
}

/// Read a file for searching: None for binaries, large files and read errors.
fn read_searchable(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let mut file = fs::File::open(path).ok()?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.by_ref()
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return None;
    }
    let sniff = &bytes[..bytes.len().min(BINARY_SNIFF_BYTES)];
    if sniff.contains(&0) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Walk `root` (already canonical) depth-first in name order and search every
/// text file. Does not follow symlinks and never enters ignored directories.
pub(crate) fn search_local(
    root: &Path,
    query: &str,
    case_sensitive: bool,
    include_hidden: bool,
) -> SearchResults {
    let mut matches = Vec::new();
    let mut truncated = false;
    let mut scanned = 0usize;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    'walk: while let Some(dir) = stack.pop() {
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<(String, PathBuf, fs::FileType)> = read
            .flatten()
            .filter_map(|e| {
                let ft = e.file_type().ok()?;
                Some((e.file_name().to_string_lossy().into_owned(), e.path(), ft))
            })
            .collect();
        entries.sort_by_key(|(name, _, _)| name.to_lowercase());
        let mut subdirs = Vec::new();
        for (name, path, ft) in entries {
            if ft.is_symlink() {
                continue;
            }
            if !include_hidden && name.starts_with('.') {
                continue;
            }
            if ft.is_dir() {
                if !crate::watcher::ignored_dir_name(&name) {
                    subdirs.push(path);
                }
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            scanned += 1;
            if scanned > MAX_FILES_SCANNED {
                truncated = true;
                break 'walk;
            }
            let Some(text) = read_searchable(&path) else {
                continue;
            };
            search_text(
                &path.to_string_lossy(),
                &text,
                query,
                case_sensitive,
                MAX_RESULTS + 1,
                &mut matches,
            );
            if matches.len() > MAX_RESULTS {
                truncated = true;
                break 'walk;
            }
        }
        // Reverse so the stack pops subdirectories in name order: files of a
        // folder come first, then its subfolders a→z (like the tree).
        stack.extend(subdirs.into_iter().rev());
    }
    matches.truncate(MAX_RESULTS);
    SearchResults { matches, truncated }
}

/// The remote search script: POSIX `find` prunes the same directories as the
/// local walk, then `grep -In -F` (literal, skip binaries, line numbers) runs
/// in batches. `/dev/null` as an extra file makes grep always print the file
/// name. `head` caps the output (one extra line tells us it was truncated).
pub(crate) fn remote_search_script(
    root: &str,
    query: &str,
    case_sensitive: bool,
    include_hidden: bool,
) -> String {
    let q = crate::remote::quote(query);
    let r = crate::remote::quote(root);
    let mut prune: Vec<String> = crate::watcher::IGNORED_DIR_NAMES
        .iter()
        .map(|n| format!("-name {}", crate::remote::quote(n)))
        .collect();
    if !include_hidden {
        prune.push("-name '.*'".to_string());
    }
    let case = if case_sensitive { "" } else { " -i" };
    // 2048 blocks of 512 bytes = MAX_FILE_BYTES (POSIX `-size` units).
    format!(
        "find -H {r} -mindepth 1 \\( {prune} \\) -prune -o -type f -size -{blocks} \
         -exec grep -In{case} -F -e {q} -- /dev/null {{}} + 2>/dev/null | head -n {limit}",
        prune = prune.join(" -o "),
        blocks = MAX_FILE_BYTES / 512 + 1,
        limit = MAX_RESULTS + 1,
    )
}

/// Parse `path:line:text` lines from [`remote_search_script`]. Paths start
/// with `root/`, so the line number is the first `:<digits>:` after it — a
/// colon inside a file name before that point still parses.
pub(crate) fn parse_remote_output(
    raw: &str,
    root: &str,
    query: &str,
    case_sensitive: bool,
) -> SearchResults {
    let mut matches = Vec::new();
    let mut lines = 0usize;
    let prefix = format!("{}/", root.trim_end_matches('/'));
    for raw_line in raw.lines() {
        lines += 1;
        if lines > MAX_RESULTS {
            break;
        }
        if !raw_line.starts_with(&prefix) {
            continue;
        }
        let Some((path, line_no, text)) = split_grep_line(raw_line, prefix.len()) else {
            continue;
        };
        if let Some(m) = match_line(path, line_no, text, query, case_sensitive) {
            matches.push(m);
        }
    }
    SearchResults {
        matches,
        truncated: lines > MAX_RESULTS,
    }
}

fn split_grep_line(line: &str, skip: usize) -> Option<(&str, u32, &str)> {
    let bytes = line.as_bytes();
    let mut i = skip;
    while i < bytes.len() {
        if bytes[i] == b':' {
            let digits_start = i + 1;
            let mut j = digits_start;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > digits_start && j < bytes.len() && bytes[j] == b':' {
                let n: u32 = line[digits_start..j].parse().ok()?;
                return Some((&line[..i], n, &line[j + 1..]));
            }
        }
        i += 1;
    }
    None
}

/// Search the open folder for `query` (literal text). Case-insensitive unless
/// `case_sensitive`. Runs off the main thread; a remote session searches on
/// the host.
#[tauri::command]
pub async fn search_in_files(
    root: String,
    query: String,
    case_sensitive: Option<bool>,
    include_hidden: Option<bool>,
) -> Result<SearchResults, AppError> {
    validate_query(&query)?;
    let case_sensitive = case_sensitive.unwrap_or(false);
    let include_hidden = include_hidden.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        if crate::remote::is_active() {
            let raw = crate::remote::search_in_files(
                &root,
                &remote_search_script(&root, &query, case_sensitive, include_hidden),
            )
            .map_err(AppError::Other)?;
            return Ok(parse_remote_output(&raw, &root, &query, case_sensitive));
        }
        let safe_root = crate::commands::validate_path(&root)?;
        if !safe_root.is_dir() {
            return Err(AppError::InvalidPath(format!(
                "Path is not a directory: {}",
                safe_root.display()
            )));
        }
        Ok(search_local(
            &safe_root,
            &query,
            case_sensitive,
            include_hidden,
        ))
    })
    .await
    .map_err(|e| AppError::Other(format!("search task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sparkdown-search-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn match_line_finds_first_hit_case_insensitive() {
        let m = match_line("/r/a.md", 3, "  Hello World, world", "WORLD", false).unwrap();
        assert_eq!(m.line, 3);
        assert_eq!(m.column, 9);
        assert_eq!(m.preview, "Hello World, world");
        assert_eq!(m.match_start, 6);
        assert_eq!(m.match_end, 11);
        assert!(match_line("/r/a.md", 1, "Hello", "hello", true).is_none());
        assert!(match_line("/r/a.md", 1, "Hello", "Hello", true).is_some());
    }

    #[test]
    fn match_line_shortens_long_lines_around_the_match() {
        let line = format!("{}needle{}", "x".repeat(300), "y".repeat(300));
        let m = match_line("/r/a", 1, &line, "needle", true).unwrap();
        assert!(m.preview.starts_with('…'));
        let chars: Vec<char> = m.preview.chars().collect();
        let hit: String = chars[m.match_start as usize..m.match_end as usize]
            .iter()
            .collect();
        assert_eq!(hit, "needle");
        assert!(chars.len() <= PREVIEW_MAX + 1);
        assert_eq!(m.column, 301);
    }

    #[test]
    fn match_line_counts_columns_in_chars() {
        let m = match_line("/r/a", 1, "héllo wörld", "wör", false).unwrap();
        assert_eq!(m.column, 7);
        assert_eq!(m.match_start, 6);
        assert_eq!(m.match_end, 9);
    }

    #[test]
    fn local_search_skips_ignored_hidden_binary_and_large_files() {
        let root = temp_dir("skips");
        fs::write(root.join("a.md"), "one\nfind me here\nthree\n").unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/b.md"), "Find Me too").unwrap();
        for ignored in ["node_modules", "target", ".git", "dist"] {
            fs::create_dir_all(root.join(ignored)).unwrap();
            fs::write(root.join(ignored).join("x.md"), "find me").unwrap();
        }
        fs::write(root.join(".hidden.md"), "find me").unwrap();
        fs::write(root.join("bin.dat"), b"find me\0\x01\x02").unwrap();
        let big = format!("find me\n{}", "z".repeat(MAX_FILE_BYTES as usize + 10));
        fs::write(root.join("big.txt"), big).unwrap();

        let res = search_local(&root, "find me", false, false);
        let hits: Vec<(String, u32)> = res
            .matches
            .iter()
            .map(|m| {
                (
                    Path::new(&m.path)
                        .strip_prefix(&root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    m.line,
                )
            })
            .collect();
        assert_eq!(
            hits,
            vec![("a.md".to_string(), 2), ("docs/b.md".to_string(), 1)]
        );
        assert!(!res.truncated);

        // Hidden files are searched when asked for (ignored dirs never are).
        let res = search_local(&root, "find me", false, true);
        let names: Vec<String> = res
            .matches
            .iter()
            .map(|m| {
                Path::new(&m.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert!(names.contains(&".hidden.md".to_string()));
        assert!(!res.matches.iter().any(|m| m.path.contains(".git")));
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn local_search_does_not_follow_symlinks() {
        let root = temp_dir("symlink");
        let outside = temp_dir("symlink-outside");
        fs::write(outside.join("secret.md"), "find me").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.md"), root.join("s.md")).unwrap();
        let res = search_local(&root, "find me", false, false);
        assert!(res.matches.is_empty());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn local_search_caps_results() {
        let root = temp_dir("cap");
        let text = "hit\n".repeat(MAX_RESULTS + 50);
        fs::write(root.join("many.md"), text).unwrap();
        let res = search_local(&root, "hit", true, false);
        assert_eq!(res.matches.len(), MAX_RESULTS);
        assert!(res.truncated);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn query_validation() {
        assert!(validate_query("").is_err());
        assert!(validate_query("a\nb").is_err());
        assert!(validate_query(&"x".repeat(MAX_QUERY_CHARS + 1)).is_err());
        assert!(validate_query("ok").is_ok());
    }

    #[test]
    fn remote_script_quotes_query_and_root() {
        let s = remote_search_script("/home/u/it's", "a'b; rm -rf /", false, false);
        assert!(s.contains("find -H '/home/u/it'\\''s' -mindepth 1"));
        assert!(s.contains("-e 'a'\\''b; rm -rf /' -- /dev/null {} +"));
        assert!(s.contains("grep -In -i -F"));
        assert!(s.contains("-name 'node_modules'"));
        assert!(s.contains("-name '.*'"));
        assert!(s.contains(&format!("head -n {}", MAX_RESULTS + 1)));
        let s = remote_search_script("/r", "q", true, true);
        assert!(s.contains("grep -In -F"));
        assert!(!s.contains("-name '.*'"));
    }

    #[test]
    fn parse_remote_output_handles_colons_and_truncation() {
        let raw = "/r/a.md:12:  Find me here\n/r/we:ird:3:name.md:4:find ME\n/r/x.md:notanumber\n";
        let res = parse_remote_output(raw, "/r", "find me", false);
        assert_eq!(res.matches.len(), 2);
        assert_eq!(res.matches[0].path, "/r/a.md");
        assert_eq!(res.matches[0].line, 12);
        assert_eq!(res.matches[0].column, 3);
        // First `:<digits>:` after the root: the name really is `we:ird`.
        assert_eq!(res.matches[1].path, "/r/we:ird");
        assert_eq!(res.matches[1].line, 3);
        assert!(!res.truncated);

        let many: String = (0..MAX_RESULTS + 1)
            .map(|i| format!("/r/a.md:{}:hit\n", i + 1))
            .collect();
        let res = parse_remote_output(&many, "/r", "hit", true);
        assert_eq!(res.matches.len(), MAX_RESULTS);
        assert!(res.truncated);
    }
}
