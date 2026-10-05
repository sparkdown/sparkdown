//! "meat" heuristics for the MCP review tools — a Rust port of
//! `frontend/src/meat.ts`. KEEP THE TWO IN SYNC: the Changes view and the
//! agent-facing `sparkdown_list_changes` / `sparkdown_read_diff` tools must
//! agree on what is noise. Both layers are pure and unit-tested:
//!
//!   1. `classify_file(path)` — is a changed file review-worthy ("meat") or
//!      noise (lockfile, generated, build output, …)? Path-only.
//!   2. `abridge_diff(text)`  — fold a unified diff to its substantive hunks,
//!      replacing runs of import-only / whitespace-only hunks with one marker.
//!
//! No regex crate (binary size): the patterns from meat.ts are hand-matched.

/// Why a changed file was judged noise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoiseReason {
    Lockfile,
    Generated,
    Minified,
    Sourcemap,
    Dependency,
    BuildOutput,
    Snapshot,
    OsCruft,
}

impl NoiseReason {
    /// Stable machine label, identical to meat.ts's `NoiseReason` strings.
    pub fn as_str(self) -> &'static str {
        match self {
            NoiseReason::Lockfile => "lockfile",
            NoiseReason::Generated => "generated",
            NoiseReason::Minified => "minified",
            NoiseReason::Sourcemap => "sourcemap",
            NoiseReason::Dependency => "dependency",
            NoiseReason::BuildOutput => "build-output",
            NoiseReason::Snapshot => "snapshot",
            NoiseReason::OsCruft => "os-cruft",
        }
    }
}

const NOISE_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    ".next",
    ".nuxt",
    ".svelte-kit",
    "coverage",
    ".turbo",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
];

const OS_CRUFT: &[&str] = &[".ds_store", "thumbs.db", "desktop.ini", ".directory"];

const LOCKFILES: &[&str] = &[
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "composer.lock",
    "cargo.lock",
    "poetry.lock",
    "pipfile.lock",
    "gemfile.lock",
    "go.sum",
];

/// Lowercased path segments, tolerating a leading "./" and backslashes.
fn segments(path: &str) -> Vec<String> {
    let norm = path.replace('\\', "/");
    let norm = norm.strip_prefix("./").unwrap_or(&norm);
    norm.split('/')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase())
        .collect()
}

/// Classify a changed file by its repo-relative path. `None` = meat.
pub fn classify_file(path: &str) -> Option<NoiseReason> {
    let segs = segments(path);
    let name = segs
        .last()
        .cloned()
        .unwrap_or_else(|| path.to_ascii_lowercase());

    if let Some(dir) = segs
        .iter()
        .take(segs.len().saturating_sub(1))
        .find(|s| NOISE_DIRS.contains(&s.as_str()))
    {
        return Some(if dir == "node_modules" || dir == "vendor" {
            NoiseReason::Dependency
        } else {
            NoiseReason::BuildOutput
        });
    }
    if OS_CRUFT.contains(&name.as_str()) {
        return Some(NoiseReason::OsCruft);
    }
    if LOCKFILES.contains(&name.as_str()) {
        return Some(NoiseReason::Lockfile);
    }
    if name.ends_with(".map") {
        return Some(NoiseReason::Sourcemap);
    }
    if name.ends_with(".min.js") || name.ends_with(".min.css") {
        return Some(NoiseReason::Minified);
    }
    if name.ends_with(".snap") {
        return Some(NoiseReason::Snapshot);
    }
    if name.ends_with(".d.ts") || has_generated_marker(&name) {
        return Some(NoiseReason::Generated);
    }
    None
}

/// `*.generated.<ext>` / `*.gen.<ext>` with an alphanumeric extension
/// (meat.ts: `/\.(generated|gen)\.[a-z0-9]+$/`).
fn has_generated_marker(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if ext.is_empty() || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    stem.ends_with(".generated") || stem.ends_with(".gen")
}

// --- Diff abridging ("reading diff") ----------------------------------------

/// A parsed diff hunk: its `@@` header (empty for a preamble) plus body lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HunkKind {
    Substantive,
    Import,
    Whitespace,
}

fn is_word(c: char) -> bool {
    // ASCII-only, matching JS `\w` (meat.ts uses no `u` flag). Keeping both
    // sides ASCII avoids Unicode drift between the Rust and TS classifiers.
    c.is_ascii_alphanumeric() || c == '_'
}

/// After `prefix` at the start of `s`, is the next char a non-word (or end)?
/// i.e. `prefix\b`.
fn starts_with_word(s: &str, prefix: &str) -> bool {
    s.strip_prefix(prefix)
        .map(|rest| !rest.starts_with(is_word))
        .unwrap_or(false)
}

/// `^\s*(import\b|export\s+(\*|\{)|from\s+['"]|const\s+\w+\s*=\s*require\()`
/// `| ^\s*(use\s+[\w:]+;|#include\b)`
fn is_import_line(body: &str) -> bool {
    let s = body.trim_start();
    if starts_with_word(s, "import") || starts_with_word(s, "#include") {
        return true;
    }
    if let Some(rest) = s.strip_prefix("export") {
        let r = rest.trim_start();
        if r.len() < rest.len() && (r.starts_with('*') || r.starts_with('{')) {
            return true;
        }
    }
    if let Some(rest) = s.strip_prefix("from") {
        let r = rest.trim_start();
        if r.len() < rest.len() && (r.starts_with('\'') || r.starts_with('"')) {
            return true;
        }
    }
    if let Some(rest) = s.strip_prefix("const") {
        let r = rest.trim_start();
        if r.len() < rest.len() {
            let ident_len = r.chars().take_while(|c| is_word(*c)).count();
            if ident_len > 0 {
                let after = r[ident_len..].trim_start();
                if let Some(a) = after.strip_prefix('=') {
                    if a.trim_start().starts_with("require(") {
                        return true;
                    }
                }
            }
        }
    }
    if let Some(rest) = s.strip_prefix("use") {
        let r = rest.trim_start();
        if r.len() < rest.len() {
            // meat.ts's `use\s+[\w:]+;` has no end anchor, so trailing text
            // after the `;` (e.g. `use std::io; // note`) still counts. Match
            // that: require `[\w:]+;`, ignore anything after the semicolon.
            if let Some(semi) = r.find(';') {
                let path = &r[..semi];
                if !path.is_empty() && path.chars().all(|c| is_word(c) || c == ':') {
                    return true;
                }
            }
        }
    }
    false
}

/// Opens a multi-line import span: `^\s*(import\b|export\s+(type\s+)?\{)`.
fn opens_import_span(body: &str) -> bool {
    let s = body.trim_start();
    if starts_with_word(s, "import") {
        return true;
    }
    if let Some(rest) = s.strip_prefix("export") {
        let mut r = rest.trim_start();
        if r.len() == rest.len() {
            return false;
        }
        if let Some(t) = r.strip_prefix("type") {
            let t2 = t.trim_start();
            if t2.len() < t.len() {
                r = t2;
            }
        }
        return r.starts_with('{');
    }
    false
}

/// Indices of lines inside a multi-line import statement (brace-balanced).
fn import_span_lines(hunk: &Hunk) -> Vec<bool> {
    let mut spans = vec![false; hunk.lines.len()];
    let mut depth: i64 = 0;
    for (i, line) in hunk.lines.iter().enumerate() {
        let body = line.get(1..).unwrap_or("");
        let balance = body.matches('{').count() as i64 - body.matches('}').count() as i64;
        if depth == 0 {
            if opens_import_span(body) && balance > 0 {
                depth = balance;
                spans[i] = true;
            }
        } else {
            spans[i] = true;
            depth = (depth + balance).max(0);
        }
    }
    spans
}

/// Classify a hunk by its changed (+/-) lines only; see meat.ts.
pub fn classify_hunk(hunk: &Hunk) -> HunkKind {
    let changed: Vec<usize> = hunk
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.starts_with('+') || l.starts_with('-'))
        .map(|(i, _)| i)
        .collect();
    if changed.is_empty() {
        return HunkKind::Whitespace;
    }
    // Strip the leading +/-/space marker, then a trailing CR so `\r\n` diffs
    // classify the same as `\n` diffs (and match meat.ts, which does the same).
    let body = |i: usize| {
        let b = hunk.lines[i].get(1..).unwrap_or("");
        b.strip_suffix('\r').unwrap_or(b)
    };
    if changed.iter().all(|&i| body(i).trim().is_empty()) {
        return HunkKind::Whitespace;
    }
    // Whitespace-only: the hunk's old side (context + removed) and new side
    // (context + added) are the same text once all whitespace is dropped
    // (like `git diff -w`, plus re-wrapping). Comparing whole sides keeps
    // order: any move, even relative to context, is a real change. Keep in
    // sync with meat.ts.
    let side = |drop: char| -> String {
        hunk.lines
            .iter()
            .filter(|l| !l.starts_with(drop) && !l.starts_with('\\'))
            .flat_map(|l| {
                l.get(1..)
                    .unwrap_or("")
                    .chars()
                    .filter(|c| !c.is_whitespace())
            })
            .collect()
    };
    if side('+') == side('-') {
        return HunkKind::Whitespace;
    }
    let spans = import_span_lines(hunk);
    if changed.iter().all(|&i| is_import_line(body(i)) || spans[i]) {
        return HunkKind::Import;
    }
    HunkKind::Substantive
}

/// Split diff lines into hunks keyed by `@@` headers; lines before the first
/// header form a headerless preamble hunk so nothing is dropped.
pub fn parse_hunks(lines: &[&str]) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = Vec::new();
    for line in lines {
        if line.starts_with("@@") {
            hunks.push(Hunk {
                header: line.to_string(),
                lines: Vec::new(),
            });
        } else if let Some(cur) = hunks.last_mut() {
            cur.lines.push(line.to_string());
        } else {
            hunks.push(Hunk {
                header: String::new(),
                lines: vec![line.to_string()],
            });
        }
    }
    hunks
}

/// The "reading diff": the file preamble, substantive hunks verbatim, and one
/// marker line standing in for each run of omitted noise hunks. Returns the
/// text plus how many hunks were omitted.
pub fn abridge_diff(diff: &str) -> (String, usize) {
    let lines: Vec<&str> = diff.lines().collect();
    let mut out = String::new();
    let mut omitted = 0usize;
    let mut run: Option<(HunkKind, usize)> = None;
    let flush = |run: &mut Option<(HunkKind, usize)>, out: &mut String| {
        if let Some((kind, n)) = run.take() {
            let what = match kind {
                HunkKind::Import => "import-only",
                _ => "whitespace-only",
            };
            out.push_str(&format!(
                "@@ … @@ [{n} hunk{} omitted: {what} changes; use mode \"full\" to see them]\n",
                if n == 1 { "" } else { "s" }
            ));
        }
    };
    for hunk in parse_hunks(&lines) {
        if hunk.header.is_empty() {
            // Preamble (diff --git / index / --- / +++): always kept.
            for l in &hunk.lines {
                out.push_str(l);
                out.push('\n');
            }
            continue;
        }
        match classify_hunk(&hunk) {
            HunkKind::Substantive => {
                flush(&mut run, &mut out);
                out.push_str(&hunk.header);
                out.push('\n');
                for l in &hunk.lines {
                    out.push_str(l);
                    out.push('\n');
                }
            }
            kind => {
                omitted += 1;
                match &mut run {
                    Some((_, n)) => *n += 1,
                    None => run = Some((kind, 1)),
                }
            }
        }
    }
    flush(&mut run, &mut out);
    (out, omitted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hunk(lines: &[&str]) -> Hunk {
        Hunk {
            header: "@@ -1,3 +1,3 @@".into(),
            lines: lines.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn ordinary_source_files_are_meat() {
        assert_eq!(classify_file("src/app.ts"), None);
        assert_eq!(classify_file("./frontend/src/meat.ts"), None);
        assert_eq!(classify_file("README.md"), None);
        // A noise word elsewhere in a segment is not a noise dir.
        assert_eq!(classify_file("src/distribution/logic.ts"), None);
        assert_eq!(classify_file("src/building/frame.ts"), None);
    }

    #[test]
    fn lockfiles_dirs_and_cruft_are_noise_with_reasons() {
        use NoiseReason::*;
        for f in [
            "package-lock.json",
            "yarn.lock",
            "Cargo.lock",
            "Pipfile.lock",
            "go.sum",
        ] {
            assert_eq!(classify_file(f), Some(Lockfile), "{f}");
        }
        assert_eq!(
            classify_file("node_modules/left-pad/index.js"),
            Some(Dependency)
        );
        assert_eq!(classify_file("vendor/foo/bar.go"), Some(Dependency));
        assert_eq!(classify_file("dist/bundle.js"), Some(BuildOutput));
        assert_eq!(classify_file("frontend/dist/app.js"), Some(BuildOutput));
        assert_eq!(classify_file("target/debug/thing"), Some(BuildOutput));
        assert_eq!(classify_file("coverage/lcov.info"), Some(BuildOutput));
        assert_eq!(
            classify_file("node_modules\\pkg\\index.js"),
            Some(Dependency)
        );
        assert_eq!(classify_file(".DS_Store"), Some(OsCruft));
        assert_eq!(classify_file("src/.DS_Store"), Some(OsCruft));
        assert_eq!(classify_file("folder/desktop.ini"), Some(OsCruft));
    }

    #[test]
    fn maps_minified_snapshots_and_generated_are_noise() {
        use NoiseReason::*;
        assert_eq!(classify_file("src/app.js.map"), Some(Sourcemap));
        assert_eq!(classify_file("lib/vendor.min.js"), Some(Minified));
        assert_eq!(classify_file("styles/site.min.css"), Some(Minified));
        assert_eq!(classify_file("__tests__/x.test.ts.snap"), Some(Snapshot));
        assert_eq!(classify_file("src/schema.generated.ts"), Some(Generated));
        assert_eq!(classify_file("src/proto.gen.js"), Some(Generated));
        assert_eq!(classify_file("types/index.d.ts"), Some(Generated));
        assert_eq!(
            classify_file("src/general.ts"),
            None,
            "'.gen' must be a full segment"
        );
    }

    #[test]
    fn hunk_classification_matches_the_frontend() {
        use HunkKind::*;
        assert_eq!(
            classify_hunk(&hunk(&[" ctx", "-const x = 1", "+const x = 2"])),
            Substantive
        );
        assert_eq!(
            classify_hunk(&hunk(&["-  foo()", "+    foo()"])),
            Whitespace
        );
        // A reorder is never "formatting" (statement order can matter).
        assert_eq!(classify_hunk(&hunk(&["-a", "-b", "+b", "+a"])), Substantive);
        assert_eq!(
            classify_hunk(&hunk(&["-f(a, b);", "+f( a, b );"])),
            Whitespace
        );
        assert_eq!(classify_hunk(&hunk(&["+", "+", " ctx"])), Whitespace);
        assert_eq!(classify_hunk(&hunk(&["-", "-"])), Whitespace);
        assert_eq!(classify_hunk(&hunk(&[" ctx"])), Whitespace, "no +/- lines");
        assert_eq!(
            classify_hunk(&hunk(&["+import { a } from './a';", "-import b from 'b';"])),
            Import
        );
        assert_eq!(
            classify_hunk(&hunk(&["+use std::io;", "+use std::fmt;"])),
            Import
        );
        assert_eq!(classify_hunk(&hunk(&["+#include <stdio.h>"])), Import);
        assert_eq!(
            classify_hunk(&hunk(&[
                "+const fs = require('fs');",
                "+export * from './x';"
            ])),
            Import
        );
        // Multi-line import statement.
        assert_eq!(
            classify_hunk(&hunk(&["+import {", "+  a,", "+  b,", "+} from './x';"])),
            Import
        );
        // A brace-less import must not swallow the code after it.
        assert_eq!(
            classify_hunk(&hunk(&["+import os", "+do_real_thing()"])),
            Substantive
        );
        // Mixed imports and code is substantive.
        assert_eq!(
            classify_hunk(&hunk(&["+import x from 'x';", "+x.run();"])),
            Substantive
        );
        // `important` is not `import\b`; `useState;` is not `use path;`.
        assert_eq!(classify_hunk(&hunk(&["+important();"])), Substantive);
        assert_eq!(classify_hunk(&hunk(&["+useState;"])), Substantive);
    }

    #[test]
    fn abridge_keeps_preamble_and_substantive_hunks_and_marks_omissions() {
        let diff = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n\
@@ -1,2 +1,2 @@\n-import a from 'a';\n+import b from 'b';\n\
@@ -10,2 +10,2 @@\n-  f()\n+    f()\n\
@@ -20,1 +20,1 @@\n-return 1\n+return 2\n";
        let (out, omitted) = abridge_diff(diff);
        assert_eq!(omitted, 2);
        assert!(out.starts_with("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n"));
        assert!(
            out.contains("[2 hunks omitted: import-only changes"),
            "{out}"
        );
        assert!(
            !out.contains("import b from"),
            "noise hunk body must be gone"
        );
        assert!(
            out.contains("@@ -20,1 +20,1 @@\n-return 1\n+return 2\n"),
            "{out}"
        );
        // Order: marker precedes the substantive hunk it replaced.
        assert!(out.find("omitted").unwrap() < out.find("-return 1").unwrap());
    }

    #[test]
    fn abridge_passes_a_fully_substantive_diff_through_unchanged() {
        let diff = "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n";
        let (out, omitted) = abridge_diff(diff);
        assert_eq!(omitted, 0);
        assert_eq!(out, diff);
    }

    // Shared cross-language fixture: the SAME cases run here and in
    // frontend/src/__tests__/meat.test.ts, so the Rust and TS ports can't drift
    // (case-insensitive dir match, import end-anchor, ASCII word chars, `\r`).
    #[test]
    fn shared_fixture_matches_the_frontend() {
        #[derive(serde::Deserialize)]
        struct FileCase {
            path: String,
            verdict: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct HunkCase {
            kind: String,
            lines: Vec<String>,
        }
        #[derive(serde::Deserialize)]
        struct Cases {
            files: Vec<FileCase>,
            hunks: Vec<HunkCase>,
        }

        const FIXTURE: &str = include_str!("../tests-fixtures/meat-cases.json");
        let cases: Cases = serde_json::from_str(FIXTURE).expect("valid fixture json");

        for c in &cases.files {
            let got = classify_file(&c.path).map(|r| r.as_str());
            assert_eq!(got, c.verdict.as_deref(), "file verdict for {}", c.path);
        }
        for c in &cases.hunks {
            let h = Hunk {
                header: "@@ -1 +1 @@".to_string(),
                lines: c.lines.clone(),
            };
            let got = match classify_hunk(&h) {
                HunkKind::Substantive => "substantive",
                HunkKind::Import => "import",
                HunkKind::Whitespace => "whitespace",
            };
            assert_eq!(got, c.kind, "hunk kind for {:?}", c.lines);
        }
    }
}
