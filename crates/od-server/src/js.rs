//! JavaScript and Node semantics the server's request handling relies on.
//!
//! The whitespace, length, truthiness, `String()` and Node `path` helpers come from od-core and
//! are only re-exported here. This module writes `Number()` and `decodeURIComponent` /
//! `encodeURIComponent`.

pub use od_core::jsstr::{collapse_ws as collapse_spaces, is_js_space, trim, utf16_len};
pub use od_core::jsval::{number_to_string, string, truthy};
pub use od_core::nodepath::{
    node_basename, node_is_absolute, posix_basename, win32_basename, win32_is_absolute,
};

/// JS `Number(string)` (StringToNumber).
pub fn number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return radix_number(digits, radix);
        }
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !is_decimal_literal(body) {
        return f64::NAN;
    }
    // The grammar is checked, so Rust's (correctly rounded) parser sees only valid literals.
    body.parse::<f64>().map_or(f64::NAN, |v| sign * v)
}

/// `0x` / `0o` / `0b` digits; no sign, at least one digit.
fn radix_number(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut v = 0.0f64;
    for c in digits.chars() {
        match c.to_digit(radix) {
            Some(d) => v = v * f64::from(radix) + f64::from(d),
            None => return f64::NAN,
        }
    }
    v
}

/// StrUnsignedDecimalLiteral: `digits [. digits?] [exp]` or `. digits [exp]`.
fn is_decimal_literal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - start
    };
    let mut mantissa = digits(&mut i);
    if i < b.len() && b[i] == b'.' {
        i += 1;
        mantissa += digits(&mut i);
    }
    if mantissa == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

/// `Number(param)` for a query value: a missing one is `Number(null)`, 0.
pub fn number_of_param(v: Option<&str>) -> f64 {
    v.map_or(0.0, number)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// JS `decodeURIComponent`: None where JS throws `URIError` (a malformed `%` escape, or escapes
/// that do not decode to valid UTF-8).
pub fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hi = hex_val(*b.get(i + 1)?)?;
            let lo = hex_val(*b.get(i + 2)?)?;
            out.push(hi << 4 | lo);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    // Raw characters are whole UTF-8 sequences, so the result is valid exactly when every
    // escaped sequence is.
    String::from_utf8(out).ok()
}

/// JS `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` as UTF-8 `%XX`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_follows_js() {
        assert_eq!(number(""), 0.0);
        assert_eq!(number(" \t\u{3000}"), 0.0);
        assert_eq!(number(" 2 "), 2.0);
        assert_eq!(number("0x10"), 16.0);
        assert_eq!(number("0o17"), 15.0);
        assert_eq!(number("0B101"), 5.0);
        assert_eq!(number("1e0"), 1.0);
        assert!(number("abc").is_nan());
        let neg_zero = number("-0");
        assert_eq!(neg_zero, 0.0);
        assert!(neg_zero.is_sign_negative());
        assert!(number("1_000").is_nan());
        assert_eq!(number("Infinity"), f64::INFINITY);
        assert_eq!(number("+Infinity"), f64::INFINITY);
        assert_eq!(number("-Infinity"), f64::NEG_INFINITY);
        for nan in [
            "inf", "nan", "NaN", "infinity", "INFINITY", "-0x10", "0x", "0x1g", ".", "e5", "1e",
            "1e+", "--1", "1 2", "0b2",
        ] {
            assert!(number(nan).is_nan(), "{nan:?}");
        }
        assert_eq!(number("1."), 1.0);
        assert_eq!(number(".5"), 0.5);
        assert_eq!(number("+.5"), 0.5);
        assert_eq!(number("-1.5e-1"), -0.15);
        assert_eq!(number("007"), 7.0);
    }

    #[test]
    fn number_of_param_treats_missing_as_null() {
        assert_eq!(number_of_param(None), 0.0);
        assert_eq!(number_of_param(Some("3")), 3.0);
        assert!(number_of_param(Some("x")).is_nan());
    }

    #[test]
    fn reexported_helpers_smoke() {
        assert_eq!(collapse_spaces("a\u{3000}\u{FEFF} b"), "a b");
        assert_eq!(utf16_len("😀"), 2);
        assert!(is_js_space('\u{FEFF}'));
        assert_eq!(trim("\u{A0}x "), "x");
        assert!(truthy(&json!([])));
        assert!(!truthy(&json!("")));
    }

    #[test]
    fn decode_uri_component_is_strict() {
        assert_eq!(decode_uri_component("a%20b%2Fc").as_deref(), Some("a b/c"));
        assert_eq!(decode_uri_component("%ED%95%9C").as_deref(), Some("한"));
        assert_eq!(decode_uri_component("+").as_deref(), Some("+"));
        assert_eq!(decode_uri_component("%E0%A4%A"), None);
        assert_eq!(decode_uri_component("%C3%28"), None);
        assert_eq!(decode_uri_component("%"), None);
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("%ED%A0%80"), None);
    }

    #[test]
    fn encode_uri_component_matches_js() {
        assert_eq!(encode_uri_component("ab:c/d e"), "ab%3Ac%2Fd%20e");
        assert_eq!(encode_uri_component("A-z_0.9!~*'()"), "A-z_0.9!~*'()");
        assert_eq!(encode_uri_component("한"), "%ED%95%9C");
        assert_eq!(encode_uri_component("?&=#+"), "%3F%26%3D%23%2B");
    }
}
