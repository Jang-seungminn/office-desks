//! JavaScript string semantics the TS code relies on (`\s`, `trim`, `.length`).

/// JS `\s` / `trim` whitespace: Unicode White_Space except U+0085, plus U+FEFF.
pub(crate) fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

pub(crate) fn trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_space)
}

/// JS `String.length` (UTF-16 code units).
pub(crate) fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.replace(/\s+/g, ' ').trim()`
pub(crate) fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if is_js_space(c) {
            in_ws = true;
        } else {
            if in_ws {
                out.push(' ');
                in_ws = false;
            }
            out.push(c);
        }
    }
    if in_ws {
        out.push(' ');
    }
    trim(&out).to_string()
}

/// `s.slice(0, units)` on UTF-16 code units. A cut inside a surrogate pair drops the whole
/// character instead of leaving a lone surrogate (which a Rust string cannot hold).
pub(crate) fn slice_utf16(s: &str, units: usize) -> &str {
    let mut used = 0;
    for (i, c) in s.char_indices() {
        let w = c.len_utf16();
        if used + w > units {
            return &s[..i];
        }
        used += w;
    }
    s
}
