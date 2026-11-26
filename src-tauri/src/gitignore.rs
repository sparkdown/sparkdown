//! `.gitignore` rules for the Quick open file index and the watcher.
//!
//! A small matcher for git's ignore format: `#` comments, `!` re-includes,
//! a trailing `/` for directories only, a `/` at the start or in the middle
//! to anchor a pattern to its file's folder, `*` `?` `[a-z]` inside one path
//! segment, and `**` for any number of folders. The deepest `.gitignore`
//! wins, and within one file the last matching line wins, as in git.
//!
//! Rules come from every `.gitignore` between the repository top and the
//! opened folder, `.git/info/exclude`, and the opened folder's own tree.
//! Name matching follows the platform's usual git setting: case-insensitive
//! on macOS and Windows, case-sensitive elsewhere.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const FOLD_CASE: bool = cfg!(any(target_os = "macos", windows));

/// The ignore file read in every folder.
pub const IGNORE_FILE: &str = ".gitignore";

#[derive(Debug)]
struct Pattern {
    /// A pattern without a `/` matches the last path segment only.
    basename: Option<Vec<char>>,
    /// Glob segments; `**` stands for any number of folders.
    segments: Vec<Vec<char>>,
    negated: bool,
    dir_only: bool,
}

fn trim_trailing_spaces(line: &str) -> &str {
    let b = line.as_bytes();
    let mut end = b.len();
    while end > 0 && b[end - 1] == b' ' {
        if end >= 2 && b[end - 2] == b'\\' {
            break;
        }
        end -= 1;
    }
    &line[..end]
}

impl Pattern {
    fn parse(line: &str) -> Option<Pattern> {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let mut s = trim_trailing_spaces(line);
        let negated = match s.strip_prefix('!') {
            Some(rest) => {
                s = rest;
                true
            }
            None => false,
        };
        if s.starts_with("\\!") || s.starts_with("\\#") {
            s = &s[1..];
        }
        let (s, dir_only) = match s.strip_suffix('/') {
            Some(rest) => (rest, true),
            None => (s, false),
        };
        let anchored = s.contains('/');
        let s = s.strip_prefix('/').unwrap_or(s);
        let mut segments: Vec<Vec<char>> = s
            .split('/')
            .filter(|seg| !seg.is_empty())
            .map(|seg| seg.chars().collect())
            .collect();
        if segments.is_empty() {
            return None;
        }
        if !anchored && segments.len() == 1 {
            // The common case (`*.log`, `out/`): only the name can match.
            return Some(Pattern {
                basename: segments.pop(),
                segments,
                negated,
                dir_only,
            });
        }
        if !anchored {
            segments.insert(0, vec!['*', '*']);
        }
        Some(Pattern {
            basename: None,
            segments,
            negated,
            dir_only,
        })
    }

    fn matches(&self, rel: &[Vec<char>], is_dir: bool) -> bool {
        if self.dir_only && !is_dir {
            return false;
        }
        match &self.basename {
            Some(name) => rel.last().is_some_and(|last| glob(name, last)),
            None => match_segments(&self.segments, rel),
        }
    }
}

fn is_double_star(seg: &[char]) -> bool {
    seg == ['*', '*']
}

fn match_segments(pat: &[Vec<char>], path: &[Vec<char>]) -> bool {
    let Some((first, rest)) = pat.split_first() else {
        return path.is_empty();
    };
    if is_double_star(first) {
        if rest.is_empty() {
            // A trailing `/**` matches what is inside, not the folder itself.
            return !path.is_empty();
        }
        return (0..=path.len()).any(|i| match_segments(rest, &path[i..]));
    }
    match path.split_first() {
        Some((seg, path_rest)) => glob(first, seg) && match_segments(rest, path_rest),
        None => false,
    }
}

fn same_char(a: char, b: char) -> bool {
    a == b || (FOLD_CASE && a.to_lowercase().eq(b.to_lowercase()))
}

/// `[...]` at `p[start]`: `Some((matched, index after ']'))`, or `None` when
/// the bracket is not closed (then it is a literal `[`).
fn class(p: &[char], start: usize, c: char) -> Option<(bool, usize)> {
    let mut i = start + 1;
    let negate = matches!(p.get(i), Some('!') | Some('^'));
    if negate {
        i += 1;
    }
    let mut matched = false;
    let mut first = true;
    while i < p.len() {
        if p[i] == ']' && !first {
            return Some((matched != negate, i + 1));
        }
        first = false;
        let mut lo = p[i];
        if lo == '\\' && i + 1 < p.len() {
            i += 1;
            lo = p[i];
        }
        if i + 2 < p.len() && p[i + 1] == '-' && p[i + 2] != ']' {
            let hi = p[i + 2];
            let in_range = |x: char| lo <= x && x <= hi;
            if in_range(c) || (FOLD_CASE && c.to_lowercase().chain(c.to_uppercase()).any(in_range))
            {
                matched = true;
            }
            i += 3;
        } else {
            if same_char(lo, c) {
                matched = true;
            }
            i += 1;
        }
    }
    None
}

/// Glob match within one path segment (`*` and `?` never cross a `/`).
fn glob(p: &[char], s: &[char]) -> bool {
    let (mut pi, mut si) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while si < s.len() {
        let step = match p.get(pi) {
            Some('*') => {
                star = Some((pi, si));
                pi += 1;
                continue;
            }
            Some('?') => Some(pi + 1),
            Some('[') => match class(p, pi, s[si]) {
                Some((true, next)) => Some(next),
                Some((false, _)) => None,
                None => (s[si] == '[').then_some(pi + 1),
            },
            Some('\\') if pi + 1 < p.len() => (p[pi + 1] == s[si]).then_some(pi + 2),
            Some(&c) => same_char(c, s[si]).then_some(pi + 1),
            None => None,
        };
        match (step, star) {
            (Some(next), _) => {
                pi = next;
                si += 1;
            }
            (None, Some((sp, ss))) => {
                pi = sp + 1;
                si = ss + 1;
                star = Some((sp, ss + 1));
            }
            (None, None) => return false,
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

/// The patterns of one ignore file, relative to `base` (its folder).
#[derive(Debug)]
pub struct IgnoreFile {
    base: PathBuf,
    patterns: Vec<Pattern>,
}

impl IgnoreFile {
    fn parse(base: &Path, text: &str) -> Option<Arc<IgnoreFile>> {
        let patterns: Vec<Pattern> = text.lines().filter_map(Pattern::parse).collect();
        (!patterns.is_empty()).then(|| {
            Arc::new(IgnoreFile {
                base: base.to_path_buf(),
                patterns,
            })
        })
    }

    fn load(base: &Path, file: &Path) -> Option<Arc<IgnoreFile>> {
        let text = fs::read_to_string(file).ok()?;
        Self::parse(base, &text)
    }

    /// `Some(true)` ignored, `Some(false)` re-included, `None` no line matched.
    fn decide(&self, path: &Path, is_dir: bool) -> Option<bool> {
        let rel = path.strip_prefix(&self.base).ok()?;
        let name: Vec<char> = rel.file_name()?.to_string_lossy().chars().collect();
        let name_only = [name];
        let mut all: Option<Vec<Vec<char>>> = None;
        for p in self.patterns.iter().rev() {
            if p.dir_only && !is_dir {
                continue;
            }
            let segs: &[Vec<char>] = if p.basename.is_some() {
                &name_only
            } else {
                all.get_or_insert_with(|| {
                    rel.components()
                        .map(|c| c.as_os_str().to_string_lossy().chars().collect())
                        .collect()
                })
            };
            if p.matches(segs, is_dir) {
                return Some(!p.negated);
            }
        }
        None
    }
}

/// The ignore files that apply inside one folder, outermost first.
#[derive(Debug, Clone, Default)]
pub struct Rules(Vec<Arc<IgnoreFile>>);

impl Rules {
    /// Rules for `dir`, a child folder of the folder these rules belong to.
    pub fn child(&self, dir: &Path) -> Rules {
        match IgnoreFile::load(dir, &dir.join(IGNORE_FILE)) {
            Some(file) => {
                let mut files = self.0.clone();
                files.push(file);
                Rules(files)
            }
            None => self.clone(),
        }
    }

    /// Whether `path`, an entry of the folder these rules belong to (or
    /// below it, with no ignored folder on the way), is ignored.
    pub fn is_ignored(&self, path: &Path, is_dir: bool) -> bool {
        self.0
            .iter()
            .rev()
            .find_map(|f| f.decide(path, is_dir))
            .unwrap_or(false)
    }
}

/// The nearest folder at or above `dir` that holds a `.git` entry.
fn repo_top(dir: &Path) -> Option<&Path> {
    dir.ancestors().find(|d| d.join(".git").exists())
}

/// Rules that apply to the entries of `root` (the opened folder): the
/// repository's `.git/info/exclude`, each `.gitignore` from the repository
/// top down to `root`, and `root/.gitignore`.
pub fn root_rules(root: &Path) -> Rules {
    let mut rules = Rules::default();
    if let Some(top) = repo_top(root) {
        if let Some(f) = IgnoreFile::load(top, &top.join(".git/info/exclude")) {
            rules.0.push(f);
        }
        let mut above: Vec<&Path> = root
            .ancestors()
            .skip(1)
            .take_while(|d| d.starts_with(top))
            .collect();
        above.reverse();
        for dir in above {
            rules = rules.child(dir);
        }
    }
    rules.child(root)
}

/// Ignore lookups for any path under one root, for the watcher. Folder rules
/// are cached; call [`Ignorer::clear_cached`] when a `.gitignore` changes.
pub struct Ignorer {
    root: PathBuf,
    cache: Mutex<HashMap<PathBuf, Rules>>,
}

impl Ignorer {
    pub fn new(root: &Path) -> Ignorer {
        Ignorer {
            root: root.to_path_buf(),
            cache: Mutex::default(),
        }
    }

    fn cached(&self, dir: &Path) -> Option<Rules> {
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(dir)
            .cloned()
    }

    /// Rules for the entries of `dir` (the root or a folder under it).
    pub fn rules_for_dir(&self, dir: &Path) -> Rules {
        if let Some(rules) = self.cached(dir) {
            return rules;
        }
        let rules = match dir.parent() {
            Some(parent) if dir != self.root && dir.starts_with(&self.root) => {
                self.rules_for_dir(parent).child(dir)
            }
            _ => root_rules(&self.root),
        };
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(dir.to_path_buf(), rules.clone());
        rules
    }

    /// Whether `path` (under the root) is ignored, or sits in an ignored folder.
    pub fn is_ignored(&self, path: &Path, is_dir: bool) -> bool {
        let Ok(rel) = path.strip_prefix(&self.root) else {
            return false;
        };
        let comps: Vec<_> = rel.components().collect();
        let Some((_, parents)) = comps.split_last() else {
            return false;
        };
        let mut dir = self.root.clone();
        for c in parents {
            let rules = self.rules_for_dir(&dir);
            dir.push(c);
            if rules.is_ignored(&dir, true) {
                return true;
            }
        }
        self.rules_for_dir(&dir).is_ignored(path, is_dir)
    }

    /// Like [`Ignorer::is_ignored`] for a path that may be gone: a missing
    /// path counts as ignored if it would be as a file or as a folder.
    pub fn is_ignored_on_disk(&self, path: &Path) -> bool {
        match fs::symlink_metadata(path) {
            Ok(m) => self.is_ignored(path, m.is_dir()),
            Err(_) => self.is_ignored(path, false) || self.is_ignored(path, true),
        }
    }

    /// Drop cached rules at and below `dir` (its `.gitignore` changed).
    pub fn clear_cached(&self, dir: &Path) {
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|k, _| !k.starts_with(dir));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pat_matches(pattern: &str, path: &str, is_dir: bool) -> bool {
        let p = Pattern::parse(pattern).expect("pattern");
        let segs: Vec<Vec<char>> = path.split('/').map(|s| s.chars().collect()).collect();
        p.matches(&segs, is_dir)
    }

    #[test]
    fn glob_segments() {
        assert!(glob(
            &"*.log".chars().collect::<Vec<_>>(),
            &"a.log".chars().collect::<Vec<_>>()
        ));
        assert!(!glob(
            &"*.log".chars().collect::<Vec<_>>(),
            &"a.txt".chars().collect::<Vec<_>>()
        ));
        let g = |p: &str, s: &str| {
            glob(
                &p.chars().collect::<Vec<_>>(),
                &s.chars().collect::<Vec<_>>(),
            )
        };
        assert!(g("a?c", "abc"));
        assert!(!g("a?c", "ac"));
        assert!(g("[a-c]x", "bx"));
        assert!(!g("[!a-c]x", "bx"));
        assert!(g("[!a-c]x", "dx"));
        assert!(g("\\*x", "*x"));
        assert!(!g("\\*x", "ax"));
        assert!(g("a*b*c", "aXXbYYc"));
        assert!(!g("a*b*c", "aXXbYY"));
        assert!(g("[unclosed", "[unclosed"));
        assert!(g("ção*", "ção.md"));
    }

    #[test]
    fn pattern_kinds() {
        // No slash: any depth.
        assert!(pat_matches("*.log", "a.log", false));
        assert!(pat_matches("*.log", "x/y/a.log", false));
        // Trailing slash: folders only.
        assert!(pat_matches("out/", "x/out", true));
        assert!(!pat_matches("out/", "x/out", false));
        // Leading or middle slash: anchored to the file's folder.
        assert!(pat_matches("/out", "out", true));
        assert!(!pat_matches("/out", "x/out", true));
        assert!(pat_matches("docs/gen", "docs/gen", true));
        assert!(!pat_matches("docs/gen", "x/docs/gen", true));
        // `**` forms.
        assert!(pat_matches("**/gen", "a/b/gen", true));
        assert!(pat_matches("**/gen", "gen", true));
        assert!(pat_matches("a/**/b", "a/b", false));
        assert!(pat_matches("a/**/b", "a/x/y/b", false));
        assert!(pat_matches("a/**", "a/x", false));
        assert!(!pat_matches("a/**", "a", true));
        // Comments, blanks, escapes, trailing spaces.
        assert!(Pattern::parse("# note").is_none());
        assert!(Pattern::parse("   ").is_none() || !pat_matches("   ", "x", false));
        assert!(pat_matches("\\#hash", "#hash", false));
        assert!(pat_matches("\\!bang", "!bang", false));
        assert!(pat_matches("trail   ", "trail", false));
        assert!(Pattern::parse("!keep.log").unwrap().negated);
    }

    fn tree(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sparkdown_gitignore_{name}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn nested_files_and_negation() {
        let root = tree("nested");
        write(&root, ".gitignore", "*.log\nout/\n/top-only.md\n");
        write(&root, "sub/.gitignore", "!keep.log\nlocal.md\n");
        let ign = Ignorer::new(&root);
        assert!(ign.is_ignored(&root.join("a.log"), false));
        assert!(ign.is_ignored(&root.join("sub/deep/b.log"), false));
        assert!(!ign.is_ignored(&root.join("sub/keep.log"), false));
        assert!(ign.is_ignored(&root.join("keep.log"), false));
        assert!(ign.is_ignored(&root.join("sub/local.md"), false));
        assert!(!ign.is_ignored(&root.join("local.md"), false));
        assert!(ign.is_ignored(&root.join("top-only.md"), false));
        assert!(!ign.is_ignored(&root.join("sub/top-only.md"), false));
        // Everything under an ignored folder is ignored.
        assert!(ign.is_ignored(&root.join("out"), true));
        assert!(ign.is_ignored(&root.join("x/out/readme.md"), false));
        assert!(!ign.is_ignored(&root.join("readme.md"), false));
        // A changed file is read again after clear_cached().
        write(&root, ".gitignore", "*.md\n");
        assert!(!ign.is_ignored(&root.join("readme.md"), false));
        ign.clear_cached(&root);
        assert!(ign.is_ignored(&root.join("readme.md"), false));
        assert!(!ign.is_ignored(&root.join("a.log"), false));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn repo_rules_above_the_opened_folder_apply() {
        let top = tree("repo");
        fs::create_dir_all(top.join(".git/info")).unwrap();
        write(&top, ".git/info/exclude", "scratch.md\n");
        write(&top, ".gitignore", "*.tmp\n/docs/gen/\n");
        write(&top, "docs/.gitignore", "drafts/\n");
        let root = top.join("docs");
        fs::create_dir_all(&root).unwrap();
        let ign = Ignorer::new(&root);
        assert!(ign.is_ignored(&root.join("a.tmp"), false));
        assert!(ign.is_ignored(&root.join("gen"), true));
        assert!(ign.is_ignored(&root.join("drafts/x.md"), false));
        assert!(ign.is_ignored(&root.join("scratch.md"), false));
        assert!(!ign.is_ignored(&root.join("guide.md"), false));
        // A missing path matches as a file or a folder.
        assert!(ign.is_ignored_on_disk(&root.join("drafts")));
        let _ = fs::remove_dir_all(&top);
    }
}
