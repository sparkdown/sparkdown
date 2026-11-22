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
//! Not translated (the `regex` crate handled these, `regex-lite` does not):
//! `\p{..}` classes are rejected, `\b` and `\B` stay ASCII-only, and `\W`,
//! `\D`, `\S` inside brackets stay ASCII-only. Patterns with the `x` flag are
//! passed through unchanged (ASCII-only case folding).

use super::case_tables::FOLD;
use super::perl_tables;
use std::collections::BTreeSet;

/// Rewrite `pattern` for `regex-lite`. `case_insensitive` must be the value
/// given to the builder; inline `(?i)` / `(?-i)` flags are tracked here.
pub(super) fn translate(pattern: &str, case_insensitive: bool) -> String {
    let mut t = Translator {
        chars: pattern.chars().collect(),
        pos: 0,
        out: String::with_capacity(pattern.len() * 2),
        icase: case_insensitive,
        stack: Vec::new(),
    };
    if t.run() {
        t.out
    } else {
        pattern.to_owned()
    }
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
        let translated = translate(pattern, !case_sensitive);
        regex_lite::RegexBuilder::new(&translated)
            .case_insensitive(!case_sensitive)
            .build()
            .unwrap_or_else(|e| panic!("{pattern:?} -> {translated:?}: {e}"))
            .find(haystack)
            .map(|m| (m.start(), m.end()))
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
            let got: Vec<usize> = regex_lite::Regex::new(&translate(pattern, false))
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
        assert_eq!(translate("(?x) são ", true), "(?x) são ");
        assert_eq!(translate("são", false), "são");
    }

    #[test]
    fn unfinished_patterns_do_not_panic() {
        for p in [
            "[", "[a", "[a-", "[\\", "\\", "(", "(?", "(?i", "\\x", "\\x{", "\\u00", "[[:", "(?P<",
        ] {
            let _ = translate(p, true);
            let _ = translate(p, false);
        }
    }
}
