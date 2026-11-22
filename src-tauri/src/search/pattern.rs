//! Make `regex-lite` match the way grep does on Unicode text.
//!
//! `regex-lite` keeps the binary about 1.1 MB smaller than `regex`, but it
//! folds case for ASCII only and its `\w`, `\d` and `\s` are ASCII only. The
//! sidebar search has to find `SÃO` with `são`, as `grep -i` does in a UTF-8
//! locale. [`translate`] therefore rewrites the user's pattern before it is
//! compiled:
//!
//! * a literal that has other-case forms becomes a class of all of them
//!   (`ã` -> `[Ããã]`), and the same members are added to bracket classes and
//!   range ends, so `[^ã]` and `[à-ü]` fold too;
//! * `\w`, `\d`, `\s` and their negations (outside brackets) get the
//!   non-ASCII ranges back.
//!
//! The text being searched is never changed, so match offsets stay byte
//! offsets of the original line.
//!
//! The folding is the `regex` crate's (Unicode simple case folding). GNU grep
//! differs from it only for a few letters outside Latin and Greek text that
//! Portuguese does not use: grep also matches dotless `ı` with `I`, while
//! it does not fold the Kelvin, Angstrom and Ohm signs, `ß`/`ẞ`, or a few
//! Greek/Cyrillic variant letters.
//!
//! * `\b` at the very start or end of the pattern, next to a word character,
//!   becomes a Unicode-aware boundary (see [`Translated::bounded`]).
//!
//! Not translated (the `regex` crate handled these, `regex-lite` does not):
//! `\p{..}` classes are rejected with a clear message
//! ([`UNICODE_CLASS_MESSAGE`]); `\B` and a `\b` in the middle of a pattern
//! (or next to anything but a plain word character) stay ASCII-only; `\W`,
//! `\D`, `\S` inside brackets stay ASCII-only. Patterns with the `x` flag
//! are passed through unchanged (ASCII-only case folding).

use super::case_tables::FOLD;
use super::perl_tables;
use std::collections::BTreeSet;

/// What the user sees for a `\p{..}` / `\P{..}` class, which `regex-lite`
/// cannot do. The frontend shows it as is.
pub(super) const UNICODE_CLASS_MESSAGE: &str = "Unicode classes like \\p{..} aren't supported";

/// Name of the capture group that holds the real match of a bounded pattern.
pub(super) const MATCH_GROUP: &str = "sd_m";

/// A pattern ready for `regex-lite`.
pub(super) struct Translated {
    pub pattern: String,
    /// The pattern starts and/or ends with a consuming boundary: the match
    /// proper is the [`MATCH_GROUP`] capture, not the whole match. A leading
    /// `\b` before a word character becomes `(?:^|[^word])`, a trailing `\b`
    /// after one becomes `(?:[^word]|$)`; both eat one character that is not
    /// part of the hit. Search again from the *end of the hit*, not from the
    /// end of the whole match, or the eaten separator hides the next hit
    /// (`\bsão\b` on `são são`).
    pub bounded: bool,
}

/// True when `pattern` holds `\p` or `\P` (a Unicode class), escaped
/// backslashes (`\\p`) excluded.
pub(super) fn uses_unicode_class(pattern: &str) -> bool {
    let mut it = pattern.chars();
    while let Some(c) = it.next() {
        if c == '\\' && matches!(it.next(), Some('p' | 'P')) {
            return true;
        }
    }
    false
}

/// Rewrite `pattern` for `regex-lite`. `case_insensitive` must be the value
/// given to the builder; inline `(?i)` / `(?-i)` flags are tracked here.
pub(super) fn translate(pattern: &str, case_insensitive: bool) -> Translated {
    let chars: Vec<char> = pattern.chars().collect();
    let (lead, trail) = boundary_ends(&chars);
    let body_start = if lead { 2 } else { 0 };
    let body_end = chars.len() - if trail { 2 } else { 0 };
    let mut t = Translator {
        chars: chars[body_start..body_end].to_vec(),
        pos: 0,
        out: String::with_capacity(pattern.len() * 2),
        icase: case_insensitive,
        stack: Vec::new(),
    };
    if !t.run() {
        return Translated {
            pattern: pattern.to_owned(),
            bounded: false,
        };
    }
    if !lead && !trail {
        return Translated {
            pattern: t.out,
            bounded: false,
        };
    }
    let non_word = non_word_class();
    let mut out = String::with_capacity(t.out.len() + 2 * non_word.len() + 32);
    if lead {
        out.push_str(&format!("(?:^|{non_word})"));
    }
    out.push_str(&format!("(?P<{MATCH_GROUP}>{})", t.out));
    if trail {
        out.push_str(&format!("(?:{non_word}|$)"));
    }
    Translated {
        pattern: out,
        bounded: true,
    }
}

/// One character that is not a word character, ASCII or not.
fn non_word_class() -> String {
    let mut s = String::from("[^\\w");
    push_ranges(&mut s, perl_tables::WORD);
    s.push(']');
    s
}

/// `\w`: ASCII letters, digits, `_`, and the non-ASCII word characters.
fn is_word_char(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_alphanumeric() || c == '_';
    }
    let c = c as u32;
    perl_tables::WORD
        .binary_search_by(|&(lo, hi)| {
            if hi < c {
                std::cmp::Ordering::Less
            } else if lo > c {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

#[derive(PartialEq)]
enum Tok {
    /// A literal character (also `\xHH`, `\u....`).
    Lit(char),
    /// `\w`.
    WordClass,
    /// `\b`.
    Boundary,
    /// `?`, `*`, `+`, `{..}` and a lazy `?` after them; the text is kept.
    Quant(String),
    /// A bracket class, group, `.`, `^`, `$` or any other escape.
    Other,
}

/// Does a leading / trailing `\b` of the pattern qualify for the consuming
/// rewrite? It needs: no top-level `|` (the `\b` would apply to one branch
/// only), and the neighbouring atom must certainly be a word character that
/// cannot be skipped (a literal word char or `\w`, with at most a `+`).
fn boundary_ends(chars: &[char]) -> (bool, bool) {
    let Some(toks) = top_level_tokens(chars) else {
        return (false, false);
    };
    let word_atom = |t: &Tok| match t {
        Tok::Lit(c) => is_word_char(*c),
        Tok::WordClass => true,
        _ => false,
    };
    let plus = |t: Option<&Tok>| matches!(t, Some(Tok::Quant(q)) if q == "+" || q == "+?");
    let lead = toks.len() >= 2
        && toks[0] == Tok::Boundary
        && word_atom(&toks[1])
        && match toks.get(2) {
            Some(Tok::Quant(_)) => plus(toks.get(2)),
            _ => true,
        };
    let n = toks.len();
    let trail = n >= 2
        && toks[n - 1] == Tok::Boundary
        && (word_atom(&toks[n - 2])
            || (plus(toks.get(n - 2)) && n >= 3 && word_atom(&toks[n - 3])));
    (lead, trail)
}

/// Split the pattern into top-level tokens. None when it holds a top-level
/// `|` or does not parse (unbalanced brackets or parentheses).
fn top_level_tokens(chars: &[char]) -> Option<Vec<Tok>> {
    let mut t = Translator {
        chars: chars.to_vec(),
        pos: 0,
        out: String::new(),
        icase: false,
        stack: Vec::new(),
    };
    let mut toks = Vec::new();
    while let Some(c) = t.peek() {
        match c {
            '\\' => toks.push(match t.escape() {
                Esc::Char(ch, _) => Tok::Lit(ch),
                Esc::Class('w') => Tok::WordClass,
                Esc::Class(_) => Tok::Other,
                Esc::Other(raw) if raw == "\\b" => Tok::Boundary,
                Esc::Other(_) => Tok::Other,
            }),
            '[' => {
                t.pos = skip_bracket(chars, t.pos)?;
                toks.push(Tok::Other);
            }
            '(' => {
                t.pos = skip_group(chars, t.pos)?;
                toks.push(Tok::Other);
            }
            ')' => return None,
            '|' => return None,
            '?' | '*' | '+' => {
                let mut q = c.to_string();
                t.pos += 1;
                if t.peek() == Some('?') {
                    q.push('?');
                    t.pos += 1;
                }
                toks.push(Tok::Quant(q));
            }
            '{' => {
                let close = chars[t.pos..].iter().position(|&x| x == '}');
                match close {
                    Some(n) => {
                        let mut q: String = chars[t.pos..=t.pos + n].iter().collect();
                        t.pos += n + 1;
                        if t.peek() == Some('?') {
                            q.push('?');
                            t.pos += 1;
                        }
                        toks.push(Tok::Quant(q));
                    }
                    None => {
                        t.pos += 1;
                        toks.push(Tok::Lit('{'));
                    }
                }
            }
            '.' | '^' | '$' => {
                t.pos += 1;
                toks.push(Tok::Other);
            }
            _ => {
                t.pos += 1;
                toks.push(Tok::Lit(c));
            }
        }
    }
    Some(toks)
}

/// Index just past the bracket class that starts at `i`.
fn skip_bracket(chars: &[char], i: usize) -> Option<usize> {
    let mut j = i + 1;
    if chars.get(j) == Some(&'^') {
        j += 1;
    }
    if chars.get(j) == Some(&']') {
        j += 1;
    }
    while let Some(&c) = chars.get(j) {
        match c {
            ']' => return Some(j + 1),
            '\\' => j += 2,
            '[' if chars.get(j + 1) == Some(&':') => {
                let rest: String = chars[j..].iter().collect();
                j += rest.find(":]").map_or(1, |e| rest[..e + 2].chars().count());
            }
            _ => j += 1,
        }
    }
    None
}

/// Index just past the group that starts at `i`.
fn skip_group(chars: &[char], i: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut j = i;
    while let Some(&c) = chars.get(j) {
        match c {
            '\\' => j += 2,
            '[' => j = skip_bracket(chars, j)?,
            '(' => {
                depth += 1;
                j += 1;
            }
            ')' => {
                depth -= 1;
                j += 1;
                if depth == 0 {
                    return Some(j);
                }
            }
            _ => j += 1,
        }
    }
    None
}

/// Every character that folds together with `c` (simple case folding),
/// `c` included. Just `[c]` when it has no other case forms.
fn orbit(c: char) -> Vec<char> {
    let Ok(i) = FOLD.binary_search_by_key(&(c as u32), |&(k, _)| k) else {
        return vec![c];
    };
    orbit_of_rep(FOLD[i].1)
}

/// The characters a case-insensitive literal `c` stands for: its case forms
/// (ASCII ones included).
pub(super) fn fold_class(c: char) -> Vec<char> {
    let mut v = orbit(c);
    if c.is_ascii_alphabetic() {
        v.push(c.to_ascii_lowercase());
        v.push(c.to_ascii_uppercase());
        v.sort_unstable();
        v.dedup();
    }
    v
}

fn orbit_of_rep(rep: u32) -> Vec<char> {
    FOLD.iter()
        .filter(|&&(_, r)| r == rep)
        .filter_map(|&(k, _)| char::from_u32(k))
        .collect()
}

/// A bracket-class item or an escape.
enum Esc {
    /// One character, written as `\xHH`, `\u....` etc. or as itself.
    Char(char, String),
    /// `\w \W \d \D \s \S`.
    Class(char),
    /// Anything else, copied through as written.
    Other(String),
}

struct Translator {
    chars: Vec<char>,
    pos: usize,
    out: String,
    icase: bool,
    /// Case flag to restore at each `)`.
    stack: Vec<bool>,
}

impl Translator {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek_at(&self, n: usize) -> Option<char> {
        self.chars.get(self.pos + n).copied()
    }

    /// False when the pattern must be used as written.
    fn run(&mut self) -> bool {
        while let Some(c) = self.peek() {
            match c {
                '\\' => match self.escape() {
                    Esc::Char(ch, raw) => self.literal(ch, &raw),
                    Esc::Class(k) => self.class_escape(k),
                    Esc::Other(raw) => self.out.push_str(&raw),
                },
                '[' => self.bracket(),
                '(' => {
                    if !self.group() {
                        return false;
                    }
                }
                ')' => {
                    self.pos += 1;
                    if let Some(prev) = self.stack.pop() {
                        self.icase = prev;
                    }
                    self.out.push(')');
                }
                _ => {
                    self.pos += 1;
                    self.literal(c, &c.to_string());
                }
            }
        }
        true
    }

    /// A literal outside brackets: a class of its case forms when it has any.
    fn literal(&mut self, c: char, raw: &str) {
        if self.icase {
            let members = orbit(c);
            if members.len() > 1 {
                self.out.push('[');
                self.out.extend(members);
                self.out.push(']');
                return;
            }
        }
        self.out.push_str(raw);
    }

    /// Read the escape at `pos` (which holds the backslash).
    fn escape(&mut self) -> Esc {
        let start = self.pos;
        self.pos += 1;
        let Some(n) = self.peek() else {
            return Esc::Other("\\".into());
        };
        self.pos += 1;
        let hex_len = match n {
            'w' | 'W' | 'd' | 'D' | 's' | 'S' => return Esc::Class(n),
            'x' if self.peek() == Some('{') => 0,
            'x' => 2,
            'u' => 4,
            'U' => 8,
            _ => return Esc::Other(format!("\\{n}")),
        };
        let digits: String = if hex_len == 0 {
            self.pos += 1;
            let mut s = String::new();
            while let Some(h) = self.peek() {
                self.pos += 1;
                if h == '}' {
                    break;
                }
                s.push(h);
            }
            s
        } else {
            let s: String = self
                .chars
                .iter()
                .skip(self.pos)
                .take(hex_len)
                .copied()
                .collect();
            self.pos += s.chars().count();
            s
        };
        let raw: String = self.chars[start..self.pos].iter().collect();
        match u32::from_str_radix(&digits, 16)
            .ok()
            .and_then(char::from_u32)
        {
            Some(c) if digits.chars().all(|d| d.is_ascii_hexdigit()) => Esc::Char(c, raw),
            _ => Esc::Other(raw),
        }
    }

    /// `\w \d \s` (or the negations) outside brackets.
    fn class_escape(&mut self, k: char) {
        let ranges = match k.to_ascii_lowercase() {
            'w' => perl_tables::WORD,
            'd' => perl_tables::DIGIT,
            _ => perl_tables::SPACE,
        };
        self.out.push('[');
        if k.is_ascii_uppercase() {
            self.out.push('^');
        }
        self.out.push('\\');
        self.out.push(k.to_ascii_lowercase());
        push_ranges(&mut self.out, ranges);
        self.out.push(']');
    }

    /// A bracket class, from `[` to the matching `]`.
    fn bracket(&mut self) {
        self.pos += 1;
        self.out.push('[');
        if self.peek() == Some('^') {
            self.pos += 1;
            self.out.push('^');
        }
        if self.peek() == Some(']') {
            self.pos += 1;
            self.out.push(']');
        }
        let mut extra_chars: BTreeSet<char> = BTreeSet::new();
        let mut extra_ranges = String::new();
        let mut closed = false;
        while let Some(c) = self.peek() {
            if c == ']' {
                self.pos += 1;
                closed = true;
                break;
            }
            if c == '[' && self.peek_at(1) == Some(':') {
                // `[:alpha:]` and friends: copy through `:]`.
                let rest: String = self.chars[self.pos..].iter().collect();
                if let Some(end) = rest.find(":]") {
                    let take = rest[..end + 2].chars().count();
                    self.out
                        .extend(self.chars[self.pos..self.pos + take].iter());
                    self.pos += take;
                    continue;
                }
            }
            let (lo, raw_lo) = match self.atom() {
                Esc::Char(ch, raw) => (ch, raw),
                Esc::Class(k) => {
                    self.out.push('\\');
                    self.out.push(k);
                    // Only the positive classes can take extra ranges.
                    if k.is_ascii_lowercase() {
                        let ranges = match k {
                            'w' => perl_tables::WORD,
                            'd' => perl_tables::DIGIT,
                            _ => perl_tables::SPACE,
                        };
                        push_ranges(&mut extra_ranges, ranges);
                    }
                    continue;
                }
                Esc::Other(raw) => {
                    self.out.push_str(&raw);
                    continue;
                }
            };
            // A range `lo-hi` (a `-` just before `]` is a literal dash).
            if self.peek() == Some('-') && !matches!(self.peek_at(1), None | Some(']')) {
                let save = self.pos;
                self.pos += 1;
                match self.atom() {
                    Esc::Char(hi, raw_hi) => {
                        self.out.push_str(&raw_lo);
                        self.out.push('-');
                        self.out.push_str(&raw_hi);
                        if self.icase {
                            fold_extras(lo, hi, &mut extra_chars);
                        }
                        continue;
                    }
                    _ => self.pos = save,
                }
            }
            // A lone dash is written `\-`, so the members added at the end can
            // never turn it into a range.
            if raw_lo == "-" {
                self.out.push_str("\\-");
            } else {
                self.out.push_str(&raw_lo);
            }
            if self.icase {
                fold_extras(lo, lo, &mut extra_chars);
            }
        }
        // An unterminated class stays as written, so regex-lite reports it.
        if closed {
            self.out.extend(extra_chars);
            self.out.push_str(&extra_ranges);
            self.out.push(']');
        }
    }

    /// One bracket-class atom: a character or an escape.
    fn atom(&mut self) -> Esc {
        match self.peek() {
            Some('\\') => self.escape(),
            Some(c) => {
                self.pos += 1;
                Esc::Char(c, c.to_string())
            }
            None => Esc::Other(String::new()),
        }
    }

    /// `(`: a group, a named group or an inline flag group. False on the
    /// `x` flag.
    fn group(&mut self) -> bool {
        self.pos += 1;
        if self.peek() != Some('?') {
            self.stack.push(self.icase);
            self.out.push('(');
            return true;
        }
        self.pos += 1;
        // Named group: `(?P<name>` or `(?<name>`; the name stays as written.
        let named = match (self.peek(), self.peek_at(1)) {
            (Some('P'), Some('<')) => true,
            (Some('<'), Some(c)) => c != '=' && c != '!',
            _ => false,
        };
        if named {
            self.stack.push(self.icase);
            self.out.push_str("(?");
            while let Some(c) = self.peek() {
                self.pos += 1;
                self.out.push(c);
                if c == '>' {
                    break;
                }
            }
            return true;
        }
        let mut flags = String::new();
        let mut negated = false;
        let mut icase = self.icase;
        while let Some(c) = self.peek() {
            match c {
                '-' => negated = true,
                'i' => icase = !negated,
                'x' if !negated => return false,
                'm' | 's' | 'x' | 'u' | 'U' | 'R' => {}
                _ => break,
            }
            flags.push(c);
            self.pos += 1;
        }
        match self.peek() {
            Some(')') => {
                // `(?i)` changes the rest of the current group.
                self.pos += 1;
                self.icase = icase;
                self.out.push_str(&format!("(?{flags})"));
            }
            Some(':') => {
                self.pos += 1;
                self.stack.push(self.icase);
                self.icase = icase;
                self.out.push_str(&format!("(?{flags}:"));
            }
            _ => {
                // `(?=`, `(?!`, ...: not supported by regex-lite; it will say so.
                self.stack.push(self.icase);
                self.out.push_str(&format!("(?{flags}"));
            }
        }
        true
    }
}

/// Add to `extras` every fold partner of a character in `lo..=hi` that lies
/// outside that range.
fn fold_extras(lo: char, hi: char, extras: &mut BTreeSet<char>) {
    let (lo, hi) = (lo as u32, hi as u32);
    let reps: BTreeSet<u32> = FOLD
        .iter()
        .filter(|&&(k, _)| (lo..=hi).contains(&k))
        .map(|&(_, r)| r)
        .collect();
    for rep in reps {
        for m in orbit_of_rep(rep) {
            if !(lo..=hi).contains(&(m as u32)) {
                extras.insert(m);
            }
        }
    }
}

fn push_ranges(out: &mut String, ranges: &[(u32, u32)]) {
    for &(a, b) in ranges {
        let (Some(a), Some(b)) = (char::from_u32(a), char::from_u32(b)) else {
            continue;
        };
        out.push(a);
        if b != a {
            out.push('-');
            out.push(b);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `regex` (full Unicode) is what `grep -i` agrees with, so it is the
    /// reference. `Some((start, end))` byte offsets of the first match.
    fn reference(pattern: &str, haystack: &str, case_sensitive: bool) -> Option<(usize, usize)> {
        regex::RegexBuilder::new(pattern)
            .case_insensitive(!case_sensitive)
            .build()
            .unwrap()
            .find(haystack)
            .map(|m| (m.start(), m.end()))
    }

    fn lite(pattern: &str, haystack: &str, case_sensitive: bool) -> Option<(usize, usize)> {
        super::super::compile_regex(pattern, case_sensitive)
            .unwrap_or_else(|e| panic!("{pattern:?}: {e}"))
            .find(haystack)
    }

    /// Characters whose case mapping differs from themselves, plus the ASCII
    /// letters: every character that could belong to a folding orbit.
    fn cased_chars() -> Vec<char> {
        (0..=0x10FFFFu32)
            .filter_map(char::from_u32)
            .filter(|&c| {
                c.is_ascii_alphabetic()
                    || FOLD.iter().any(|&(k, _)| k == c as u32)
                    || c.to_lowercase().ne(std::iter::once(c))
                    || c.to_uppercase().ne(std::iter::once(c))
            })
            .collect()
    }

    #[test]
    fn orbits_equal_the_regex_crate_for_every_cased_char() {
        let pool = cased_chars();
        // One haystack of every candidate, NUL-separated: a one-character
        // pattern matches whole characters only.
        let haystack: String = pool.iter().flat_map(|&c| [c, '\0']).collect();
        let mut seen = BTreeSet::new();
        for &c in &pool {
            if seen.contains(&c) {
                continue;
            }
            let re = regex::RegexBuilder::new(&regex::escape(&c.to_string()))
                .case_insensitive(true)
                .build()
                .unwrap();
            let truth: BTreeSet<char> = re
                .find_iter(&haystack)
                .map(|m| m.as_str().chars().next().unwrap())
                .collect();
            let ours: BTreeSet<char> = orbit(c).into_iter().collect();
            if truth.iter().all(char::is_ascii) {
                // `a`/`A`: regex-lite folds ASCII itself, the table has no entry.
                assert_eq!(ours, BTreeSet::from([c]));
                seen.extend(truth);
                continue;
            }
            assert_eq!(ours, truth, "orbit of U+{:04X}", c as u32);
            // Orbits are symmetric: the same set for every member.
            for &m in &ours {
                assert_eq!(orbit(m).into_iter().collect::<BTreeSet<_>>(), ours);
            }
            seen.extend(truth);
        }
        // The orbits that matter for Portuguese, spelled out.
        assert_eq!(orbit('ã'), vec!['Ã', 'ã']);
        assert_eq!(orbit('ç'), vec!['Ç', 'ç']);
        // No accent folding, and the Turkish dotted/dotless i stay apart.
        assert!(!orbit('a').contains(&'ã'));
        assert_eq!(orbit('ı'), vec!['ı']);
        assert_eq!(orbit('İ'), vec!['İ']);
        // The non-trivial ones.
        assert_eq!(orbit('ß'), vec!['ß', 'ẞ']);
        assert!(orbit('k').contains(&'\u{212A}'));
        assert!(orbit('s').contains(&'ſ'));
        assert_eq!(orbit('Σ'), vec!['Σ', 'ς', 'σ']);
    }

    #[test]
    fn perl_classes_equal_the_regex_crate_for_every_assigned_code_point() {
        // Every assigned plane (0-3 and the tags block of plane 14); the rest of
        // the space is unassigned or private use, where no class has members.
        let all: Vec<char> = (0..0x40000u32)
            .chain(0xE0000..0xE1000)
            .filter_map(char::from_u32)
            .collect();
        for (pattern, sep) in [
            (r"\w", '\0'),
            (r"\d", '\0'),
            (r"\s", '\0'),
            (r"\W", 'a'),
            (r"\D", '0'),
            (r"\S", ' '),
            (r"[\w]", '\0'),
            (r"[\d]", '\0'),
            (r"[\s]", '\0'),
            (r"[^\w]", 'a'),
        ] {
            let haystack: String = all.iter().flat_map(|&c| [c, sep]).collect();
            let want: Vec<usize> = regex::Regex::new(pattern)
                .unwrap()
                .find_iter(&haystack)
                .map(|m| m.start())
                .collect();
            let got: Vec<usize> = regex_lite::Regex::new(&translate(pattern, false).pattern)
                .unwrap()
                .find_iter(&haystack)
                .map(|m| m.start())
                .collect();
            assert_eq!(got.len(), want.len(), "{pattern}: number of matches");
            assert_eq!(got, want, "{pattern}");
        }
    }

    /// The same pattern on the same text finds the same span with `regex`
    /// and with translated `regex-lite`, for both case modes.
    #[test]
    fn translated_patterns_find_what_the_regex_crate_finds() {
        let patterns = [
            "são",
            "ção",
            "ACAO",
            "acao",
            "ação",
            "AÇÃO",
            "straße",
            "ß",
            "ẞ",
            "[ãá]+",
            "[^ã]+",
            "[^ãÃ]+",
            "[à-ü]+",
            "[a-z]+",
            "[A-Z]+",
            "[^a-z]+",
            "[\\w-]+",
            "[\\d.]+",
            "[[:alpha:]]+",
            "(?i)são",
            "(?-i)são",
            "(?i:são)o",
            "a(?-i:ã)",
            "(?-i:a)ã",
            "(?i)a(?-i)ã",
            "(são|ção)+",
            "s(ã|a)o",
            "ã{2}",
            "ã+|é",
            "ã*s",
            "\\w+",
            "\\W+",
            "\\d+",
            "\\D+",
            "\\s+",
            "\\S+",
            "k",
            "K",
            "\u{212A}",
            "s",
            "ſ",
            "Σ",
            "ς",
            "σ+",
            "ǆ",
            "ǅ",
            "µ",
            "Å",
            "\\u00e3",
            "\\u00C3",
            "\\x{e3}",
            "\\xe3",
            "[\\u00e3]",
            "\\U000000e7",
            "(?P<key>k)s",
            "(?P<source>s)",
            "(?<n>s)",
            ".",
            "a.o",
            r"\bção",
            r"\bsão\b",
            r"são\b",
            r"\bsão",
            r"\bAÇÃO\b",
            r"\bs+ão\b",
            r"\b\w+o\b",
            r"\bk",
            "^são$",
            "são$",
            "^S",
            "[\\]ã]",
            "[]ã]",
            "[ã-]",
            "ã-é",
        ];
        let haystacks = [
            "SÃO São são sÃo",
            "AÇÃO ação Ação",
            "acao ACAO",
            "STRASSE Straße STRAßE straẞe ẞ ß",
            "K k \u{212A} ſ s S",
            "ΣΑΣ σας ς σ Σ",
            "ǅ ǆ Ǆ",
            "İstanbul ıI iİ",
            "x١٢٣ 4 5\u{a0}y\u{2003}z",
            "Ãã éÉ üÜ àÀ õÕ",
            "µ Μ μ Å å \u{212B}",
            "ã-é ]ã[ -",
            "foo_bar ação_2 naïve",
            "",
        ];
        for pattern in patterns {
            for hay in haystacks {
                for case_sensitive in [false, true] {
                    assert_eq!(
                        lite(pattern, hay, case_sensitive),
                        reference(pattern, hay, case_sensitive),
                        "pattern {pattern:?} on {hay:?}, case_sensitive={case_sensitive}"
                    );
                }
            }
        }
    }

    #[test]
    fn x_flag_patterns_pass_through_unchanged() {
        assert_eq!(translate("(?x) são ", true).pattern, "(?x) são ");
        assert_eq!(translate("são", false).pattern, "são");
    }

    #[test]
    fn unfinished_patterns_do_not_panic() {
        for p in [
            "[", "[a", "[a-", "[\\", "\\", "(", "(?", "(?i", "\\x", "\\x{", "\\u00", "[[:", "(?P<",
            "\\b", "\\bx\\b(", "\\b[", "\\b(x", "x{", "\\bx{2",
        ] {
            let _ = translate(p, true);
            let _ = translate(p, false);
        }
    }

    #[test]
    fn unicode_classes_are_detected_unless_the_backslash_is_escaped() {
        for p in [
            r"\p{L}",
            r"\P{Lu}",
            r"\pL",
            r"[\p{L}-]",
            r"a\p{Greek}+",
            r"\\\p{L}",
        ] {
            assert!(uses_unicode_class(p), "{p}");
        }
        for p in [r"\\p{L}", r"p{L}", r"\w+", r"são", r"[\\p]", ""] {
            assert!(!uses_unicode_class(p), "{p}");
        }
        assert_eq!(
            UNICODE_CLASS_MESSAGE,
            r"Unicode classes like \p{..} aren't supported"
        );
    }

    /// The consuming boundary is used only where it keeps `\b` exact.
    #[test]
    fn the_boundary_rewrite_applies_only_where_it_is_exact() {
        for p in [
            r"\bção",
            r"são\b",
            r"\bsão\b",
            r"\bs+ão",
            r"\b\wx",
            r"ão+\b",
            r"\bx",
            r"x\b",
            r"\b\w\b",
            r"\bção\d",
            r"\bsão+?\b",
        ] {
            assert!(translate(p, true).bounded, "{p} should be rewritten");
        }
        for p in [
            r"\b(são|ção)",
            r"(são|ção)\b",
            r"\bs?ão",
            r"\bs*ão",
            r"\bs{0,1}ão",
            r"são?\b",
            r"são\w*\b",
            r"\b-x",
            r"x-\b",
            r"são|\bção",
            r"\bsão|ção",
            r"[\b]",
            r"\Bsão",
            r"são\B",
            r"a\bb",
            r"são\\b",
            r"\b",
            r"\b\b",
            r"\b.ão",
            r"\b[sç]ão",
            r"\bsão(",
            r"(?i)\bsão",
            r"são",
            r"\W+",
        ] {
            assert!(!translate(p, true).bounded, "{p} must stay as it is");
        }
        // The rewrite itself: a separator in front, the hit in a named group.
        let t = translate(r"\bção", false);
        assert!(t.pattern.starts_with("(?:^|[^\\w"));
        assert!(t.pattern.contains("(?P<sd_m>ção)"));
        assert!(!t.pattern.contains("\\b"));
        // Only the end that qualifies is rewritten; the other `\b` stays.
        let t = translate(r"\bs?ão\b", false);
        assert!(t.bounded);
        assert!(t.pattern.starts_with("(?P<sd_m>\\bs?ão)"));
        assert!(t.pattern.ends_with("|$)"));
    }

    /// Every hit of a rewritten `\b` pattern equals the `regex` crate's,
    /// restarting at the end of each hit (not of the eaten separator).
    #[test]
    fn rewritten_boundaries_find_every_hit_the_regex_crate_finds() {
        let patterns = [
            r"\bsão\b",
            r"\bção",
            r"são\b",
            r"\bsão",
            r"\bs+ão\b",
            r"\bção+\b",
            r"\b\w+o\b",
            r"\b\w\b",
            r"\bAÇÃO\b",
            r"\bé\b",
            r"\bk\b",
            r"\b[0-9]x",
        ];
        let haystacks = [
            "são são",
            "são  são   são",
            "são,são;são",
            "são",
            "ação",
            "a ção",
            "ção ção",
            "SÃO São sãos são_ _são são1 1são",
            "ásão são ósão",
            "é é e é",
            "ê é é.",
            "K k K",
            "a1x 1x x",
            "",
        ];
        for pattern in patterns {
            for hay in haystacks {
                for case_sensitive in [false, true] {
                    let want: Vec<(usize, usize)> = regex::RegexBuilder::new(pattern)
                        .case_insensitive(!case_sensitive)
                        .build()
                        .unwrap()
                        .find_iter(hay)
                        .map(|m| (m.start(), m.end()))
                        .collect();
                    let got = super::super::compile_regex(pattern, case_sensitive)
                        .unwrap()
                        .find_all(hay);
                    assert_eq!(
                        got, want,
                        "pattern {pattern:?} on {hay:?}, case_sensitive={case_sensitive}"
                    );
                }
            }
        }
    }
}
