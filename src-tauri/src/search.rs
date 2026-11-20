//! Search in files: the sidebar's workspace text search.
//!
//! Literal or regex substring search over the open folder. Local folders are
//! walked here in Rust; remote folders run one POSIX `find` + `grep` over the
//! existing ssh helpers. Both return the same shape, so the frontend does not
//! care where the folder lives.
//!
//! The walk skips what the file watcher skips (VCS, dependency and build
//! directories — see `watcher::IGNORED_DIR_NAMES`), hidden entries unless the
//! caller asks for them, symlinks (no loops, no escapes from the root),
//! binaries and large files. The result list is capped; `truncated` tells the
//! UI that there is more.

use crate::commands::AppError;
use regex::Regex;
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
fn validate_query(query: &str, _use_regex: bool) -> Result<(), AppError> {
    if query.is_empty() {
        return Err(AppError::Other("Empty search query".into()));
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(AppError::Other("Search query is too long".into()));
    }
    // Single-line rule applies to both modes: local search is per-line, and
    // remote `grep -e` treats a newline as alternation.
    if query.contains('\n') || query.contains('\r') || query.contains('\0') {
        return Err(AppError::Other("Search query must be a single line".into()));
    }
    Ok(())
}

/// Compile a regex pattern with safety limits. Returns an error for invalid patterns.
/// Only supports POSIX ERE syntax that works in both Rust regex and `grep -E`.
fn compile_regex(pattern: &str, case_sensitive: bool) -> Result<Regex, AppError> {
    let mut builder = regex::RegexBuilder::new(pattern);
    builder.case_insensitive(!case_sensitive);
    // The default 10 MiB size_limit is already set; no need to override.
    builder
        .build()
        .map_err(|e| AppError::Other(format!("Invalid regex pattern: {}", e)))
}

/// Build a [`SearchMatch`] for `line` if it contains `query`. Case-insensitive
/// search lowercases both sides (literal) or uses case-insensitive regex;
/// columns are counted in chars of the line. For regex, finds the first match.
pub(crate) fn match_line(
    path: &str,
    line_no: u32,
    line: &str,
    query: &str,
    case_sensitive: bool,
    regex: Option<&Regex>,
) -> Option<SearchMatch> {
    let line_chars: Vec<char> = line.chars().collect();
    let (start, end) = if let Some(re) = regex {
        // Regex mode: find first match in the line
        let m = re.find(line)?;
        let start = line[..m.start()].chars().count();
        let end = line[..m.end()].chars().count();
        (start, end)
    } else {
        // Literal mode: case-insensitive substring search
        let (hay, needle) = if case_sensitive {
            (line.to_string(), query.to_string())
        } else {
            (line.to_lowercase(), query.to_lowercase())
        };
        let byte_at = hay.find(&needle)?;
        // Char offsets in the (possibly lowercased) line. Lowercasing keeps the
        // char count for everything but a few exotic letters; clamp to be safe.
        let start = hay[..byte_at].chars().count().min(line_chars.len());
        let len = needle.chars().count();
        let end = (start + len).min(line_chars.len());
        (start, end)
    };

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
    regex: Option<&Regex>,
    room: usize,
    out: &mut Vec<SearchMatch>,
) {
    for (i, line) in text.lines().enumerate() {
        if out.len() >= room {
            return;
        }
        if let Some(m) = match_line(path, i as u32 + 1, line, query, case_sensitive, regex) {
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
    regex: Option<&Regex>,
) -> Result<SearchResults, AppError> {
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
                regex,
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
    Ok(SearchResults { matches, truncated })
}

/// The remote search script: POSIX `find` prunes the same directories as the
/// local walk, then `grep -In --null -F` (literal) or `grep -In --null -E`
/// (regex) runs in batches. `/dev/null` as an extra file makes grep always
/// print the file name. `head` caps the output (one extra line tells us it
/// was truncated). `--null` (GNU and BSD grep) ends the file name with a NUL,
/// so a newline in a folder name cannot start a new record.
pub(crate) fn remote_search_script(
    root: &str,
    query: &str,
    case_sensitive: bool,
    include_hidden: bool,
    use_regex: bool,
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
    let grep_mode = if use_regex { "-E" } else { "-F" };
    // 2048 blocks of 512 bytes = MAX_FILE_BYTES (POSIX `-size` units).
    format!(
        "find -H {r} -mindepth 1 \\( {prune} \\) -prune -o -type f -size -{blocks} \
         -exec grep -In{case} --null {grep_mode} -e {q} -- /dev/null {{}} + 2>/dev/null | head -n {limit}",
        prune = prune.join(" -o "),
        blocks = MAX_FILE_BYTES / 512 + 1,
        limit = MAX_RESULTS + 1,
    )
}

/// Parse `path\0line:text` records from [`remote_search_script`]. The script
/// uses `grep --null`, which separates the file name from `line:text` with
/// a NUL byte; records end with a newline. The path is read up to the NUL
/// first, so a newline inside a file name stays in that path, and paths
/// with control characters are dropped. Every kept path must start with
/// the workspace root.
pub(crate) fn parse_remote_output(
    raw: &str,
    root: &str,
    query: &str,
    case_sensitive: bool,
    regex: Option<&Regex>,
) -> Result<SearchResults, AppError> {
    let mut matches = Vec::new();
    let prefix = format!("{}/", root.trim_end_matches('/'));
    // Each record is `path NUL line:text \n`: find the NUL, then the
    // newline after it.
    let bytes = raw.as_bytes();
    let mut path_start = 0usize;
    let mut records = 0usize;
    let mut truncated = false;
    while path_start < bytes.len() {
        // End of the path = next NUL. No NUL => trailing garbage; stop.
        let Some(nul_rel) = bytes[path_start..].iter().position(|&b| b == 0) else {
            break;
        };
        let nul = path_start + nul_rel;
        // End of the record = next newline after the NUL (or end of input).
        let nl = bytes[nul + 1..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|r| nul + 1 + r)
            .unwrap_or(bytes.len());
        let path = &raw[path_start..nul];
        let tail = &raw[nul + 1..nl];
        // Advance past the newline for the next iteration.
        path_start = (nl + 1).min(bytes.len());
        records += 1;
        if records > MAX_RESULTS {
            truncated = true;
            break;
        }
        if !path.starts_with(&prefix) {
            continue;
        }
        if path_has_forbidden_char(path) {
            continue;
        }
        let Some((line_no, text)) = split_line_text(tail) else {
            continue;
        };
        if let Some(m) = match_line(path, line_no, text, query, case_sensitive, regex) {
            matches.push(m);
        }
    }
    Ok(SearchResults { matches, truncated })
}

/// True when a path holds an ASCII control character (including newlines
/// and NULs). Such results are left out of the list.
fn path_has_forbidden_char(path: &str) -> bool {
    path.bytes().any(|b| b < 0x20 || b == 0x7f)
}

/// Split the `line:text` tail of a `grep --null` record into (line, text).
fn split_line_text(rest: &str) -> Option<(u32, &str)> {
    let bytes = rest.as_bytes();
    let mut j = 0;
    while j < bytes.len() && bytes[j].is_ascii_digit() {
        j += 1;
    }
    if j == 0 || j >= bytes.len() || bytes[j] != b':' {
        return None;
    }
    let n: u32 = rest[..j].parse().ok()?;
    Some((n, &rest[j + 1..]))
}

/// Search the open folder for `query` (literal or regex). Case-insensitive
/// unless `case_sensitive`. Runs off the main thread; a remote session searches
/// on the host.
#[tauri::command]
pub async fn search_in_files(
    webview_window: tauri::WebviewWindow,
    root: String,
    query: String,
    case_sensitive: Option<bool>,
    include_hidden: Option<bool>,
    use_regex: Option<bool>,
) -> Result<SearchResults, AppError> {
    let use_regex = use_regex.unwrap_or(false);
    validate_query(&query, use_regex)?;
    let case_sensitive = case_sensitive.unwrap_or(false);
    let include_hidden = include_hidden.unwrap_or(false);
    // Compile the regex before branching, so an invalid pattern never runs grep.
    // Both local and remote use the same compiled regex for consistency.
    let regex = if use_regex {
        Some(compile_regex(&query, case_sensitive)?)
    } else {
        None
    };
    crate::windows::spawn_scoped(webview_window.label().to_string(), move || {
        if crate::remote::is_active() {
            let raw = crate::remote::search_in_files(
                &root,
                &remote_search_script(&root, &query, case_sensitive, include_hidden, use_regex),
            )
            .map_err(AppError::Other)?;
            return parse_remote_output(&raw, &root, &query, case_sensitive, regex.as_ref());
        }
        let safe_root = crate::commands::validate_path(&root)?;
        if !safe_root.is_dir() {
            return Err(AppError::InvalidPath(format!(
                "Path is not a directory: {}",
                safe_root.display()
            )));
        }
        search_local(
            &safe_root,
            &query,
            case_sensitive,
            include_hidden,
            regex.as_ref(),
        )
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
        let m = match_line("/r/a.md", 3, "  Hello World, world", "WORLD", false, None).unwrap();
        assert_eq!(m.line, 3);
        assert_eq!(m.column, 9);
        assert_eq!(m.preview, "Hello World, world");
        assert_eq!(m.match_start, 6);
        assert_eq!(m.match_end, 11);
        assert!(match_line("/r/a.md", 1, "Hello", "hello", true, None).is_none());
        assert!(match_line("/r/a.md", 1, "Hello", "Hello", true, None).is_some());
    }

    #[test]
    fn match_line_supports_regex() {
        let re = compile_regex(r"w\w+d", false).unwrap();
        let m = match_line(
            "/r/a.md",
            1,
            "Hello World and word",
            "w\\w+d",
            false,
            Some(&re),
        )
        .unwrap();
        assert_eq!(m.column, 7);
        assert_eq!(m.preview, "Hello World and word");
        assert!(m.preview[m.match_start as usize..m.match_end as usize]
            .to_lowercase()
            .contains("world"));
    }

    #[test]
    fn match_line_shortens_long_lines_around_the_match() {
        let line = format!("{}needle{}", "x".repeat(300), "y".repeat(300));
        let m = match_line("/r/a", 1, &line, "needle", true, None).unwrap();
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
        let m = match_line("/r/a", 1, "héllo wörld", "wör", false, None).unwrap();
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

        let res = search_local(&root, "find me", false, false, None).unwrap();
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
        let res = search_local(&root, "find me", false, true, None).unwrap();
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
        let res = search_local(&root, "find me", false, false, None).unwrap();
        assert!(res.matches.is_empty());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn local_search_caps_results() {
        let root = temp_dir("cap");
        let text = "hit\n".repeat(MAX_RESULTS + 50);
        fs::write(root.join("many.md"), text).unwrap();
        let res = search_local(&root, "hit", true, false, None).unwrap();
        assert_eq!(res.matches.len(), MAX_RESULTS);
        assert!(res.truncated);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn local_search_supports_regex() {
        let root = temp_dir("regex");
        fs::write(root.join("test.md"), "hello world\nfoo123bar\ntest").unwrap();
        // Use ERE syntax ([0-9]+) instead of Rust-specific \d+
        let re = compile_regex(r"foo[0-9]+bar", true).unwrap();
        let res = search_local(&root, r"foo[0-9]+bar", true, false, Some(&re)).unwrap();
        assert_eq!(res.matches.len(), 1);
        assert_eq!(res.matches[0].line, 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn query_validation() {
        assert!(validate_query("", false).is_err());
        assert!(validate_query("a\nb", false).is_err());
        assert!(validate_query(&"x".repeat(MAX_QUERY_CHARS + 1), false).is_err());
        assert!(validate_query("ok", false).is_ok());
        // Newlines rejected in both modes now (single-line rule)
        assert!(validate_query("a\nb", true).is_err());
    }

    #[test]
    fn compile_regex_rejects_invalid_patterns() {
        assert!(compile_regex(r"[unclosed", true).is_err());
        assert!(compile_regex(r"(?P<)", false).is_err());
        assert!(compile_regex(r"valid\d+pattern", true).is_ok());
    }

    #[test]
    fn remote_script_quotes_query_and_root() {
        let s = remote_search_script("/home/u/it's", "a'b; rm -rf /", false, false, false);
        assert!(s.contains("find -H '/home/u/it'\\''s' -mindepth 1"));
        assert!(s.contains("-e 'a'\\''b; rm -rf /' -- /dev/null {} +"));
        assert!(s.contains("grep -In -i --null -F"));
        assert!(s.contains("-name 'node_modules'"));
        assert!(s.contains("-name '.*'"));
        assert!(s.contains(&format!("head -n {}", MAX_RESULTS + 1)));
        let s = remote_search_script("/r", "q", true, true, false);
        assert!(s.contains("grep -In --null -F"));
        assert!(!s.contains("-name '.*'"));

        // Regex mode uses grep -E instead of -F
        let s = remote_search_script("/r", r"test\d+", false, false, true);
        assert!(s.contains("grep -In -i --null -E"));
        assert!(!s.contains(" -F"));
    }

    #[test]
    fn parse_remote_output_handles_colons_and_truncation() {
        // `grep --null` separates the file name and line:text with a NUL.
        let raw =
            "/r/a.md\x0012:  Find me here\n/r/we:ird:name.md\x003:find ME\n/r/x.md\x00notanumber\n";
        let res = parse_remote_output(raw, "/r", "find me", false, None).unwrap();
        assert_eq!(res.matches.len(), 2);
        assert_eq!(res.matches[0].path, "/r/a.md");
        assert_eq!(res.matches[0].line, 12);
        assert_eq!(res.matches[0].column, 3);
        // Colons in the file name are kept: the NUL ends the path.
        assert_eq!(res.matches[1].path, "/r/we:ird:name.md");
        assert_eq!(res.matches[1].line, 3);
        assert!(!res.truncated);

        let many: String = (0..MAX_RESULTS + 1)
            .map(|i| format!("/r/a.md\x00{}:hit\n", i + 1))
            .collect();
        let res = parse_remote_output(&many, "/r", "hit", true, None).unwrap();
        assert_eq!(res.matches.len(), MAX_RESULTS);
        assert!(res.truncated);
    }

    #[test]
    fn parse_remote_output_keeps_a_newline_inside_the_path() {
        // A folder name ending in a newline: the second line is part of the
        // same path, which is dropped, not a separate hit.
        let raw = "/r/dir\n/r/notes.md/f.md\x001:FAKE note\n";
        let res = parse_remote_output(raw, "/r", "FAKE", true, None).unwrap();
        assert!(res.matches.is_empty());

        // After a normal match: that one is kept, the other is dropped.
        let raw = "/r/a.md\x001:FAKE here\n/r/dir\n/r/notes.md/f.md\x002:FAKE note\n";
        let res = parse_remote_output(raw, "/r", "FAKE", true, None).unwrap();
        assert_eq!(res.matches.len(), 1);
        assert_eq!(res.matches[0].path, "/r/a.md");
        assert_eq!(res.matches[0].line, 1);
    }

    #[test]
    fn parse_remote_output_rejects_control_chars_in_path() {
        // A path with a bell character is dropped.
        let raw = "/r/a\x07.md\x001:hit here\n";
        let res = parse_remote_output(raw, "/r", "hit", true, None).unwrap();
        assert!(res.matches.is_empty());
    }

    /// The real script on this machine's find and grep: a folder whose name
    /// holds a newline yields no extra hit, and normal files still match.
    #[cfg(unix)]
    #[test]
    fn remote_search_script_runs_with_a_newline_in_a_folder_name() {
        let root = std::env::temp_dir().join(format!("sd-rsearch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("dir\nnotes.md")).unwrap();
        std::fs::write(root.join("dir\nnotes.md").join("f.md"), "hit one\n").unwrap();
        std::fs::write(root.join("a.md"), "hit two\n").unwrap();
        let root_s = root.to_str().unwrap();
        let out = crate::proc::command("/bin/sh")
            .arg("-c")
            .arg(remote_search_script(root_s, "hit", true, false, false))
            .output()
            .unwrap();
        let raw = String::from_utf8_lossy(&out.stdout);
        let res = parse_remote_output(&raw, root_s, "hit", true, None).unwrap();
        let paths: Vec<&str> = res.matches.iter().map(|m| m.path.as_str()).collect();
        assert_eq!(paths, vec![format!("{root_s}/a.md").as_str()]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
