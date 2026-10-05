//! JavaScript string semantics the TS code relies on (`\s`, `trim`, `.length`).

/// JS `\s` / `trim` whitespace: Unicode White_Space except U+0085, plus U+FEFF.
pub(crate) fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

pub(crate) fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_space)
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

/// The TS `oneLine(s, max)` of transcript.ts and stateMapper.ts: whitespace collapsed and
/// trimmed, then cut to `max` UTF-16 units with `…` as the last one.
pub(crate) fn one_line(s: &str, max: usize) -> String {
    let flat = collapse_ws(s);
    if utf16_len(&flat) > max {
        format!("{}…", slice_utf16(&flat, max.saturating_sub(1)))
    } else {
        flat
    }
}

#[cfg(test)]
mod tests {
    use super::slice_utf16;

    #[test]
    fn slice_utf16_drops_whole_char_when_cut_splits_surrogate_pair() {
        // U+1F600 is two UTF-16 units; cutting after the first unit drops it entirely.
        assert_eq!(slice_utf16("a😀b", 2), "a");
        assert_eq!(slice_utf16("a😀b", 3), "a😀");
        assert_eq!(slice_utf16("😀", 1), "");
        assert_eq!(slice_utf16("ab", 5), "ab");
    }
}
