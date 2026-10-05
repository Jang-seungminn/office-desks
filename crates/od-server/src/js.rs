//! JavaScript and Node semantics the server's request handling relies on.
//!
//! The whitespace, length and truthiness helpers come from od-core and are only re-exported
//! here. This module writes `Number()`, `String()`, `decodeURIComponent` /
//! `encodeURIComponent` and Node's `path.basename` / `path.isAbsolute`.

use serde_json::Value;

pub use od_core::jsstr::{collapse_ws as collapse_spaces, is_js_space, trim, utf16_len};
pub use od_core::jsval::truthy;
pub use od_core::native::env::win32_is_absolute;

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

/// JS `String(value)` for a JSON value.
pub fn string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                x => string(x),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JS `Number::toString(x)` (radix 10).
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x < 0.0 {
        return format!("-{}", number_to_string(-x));
    }
    if x.is_infinite() {
        return "Infinity".into();
    }
    // `{:e}` gives the shortest round-trip digits: "d[.ddd]e<exp>".
    let sci = format!("{x:e}");
    let (mantissa, exp) = sci.split_once('e').expect("LowerExp has an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().expect("LowerExp exponent") + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        let mant = if k == 1 {
            digits
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!("{mant}e{sign}{}", e.abs())
    }
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

/// Node `path.posix.basename(p)`.
pub fn posix_basename(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    if t.is_empty() {
        return "";
    }
    t.rsplit('/').next().unwrap_or(t)
}

/// Node `path.win32.basename(p)`: `\` and `/` separate, and a drive prefix (`C:`) is dropped.
pub fn win32_basename(p: &str) -> &str {
    let b = p.as_bytes();
    let p = if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        &p[2..]
    } else {
        p
    };
    let sep = |c: char| c == '/' || c == '\\';
    let t = p.trim_end_matches(sep);
    if t.is_empty() {
        return "";
    }
    t.rsplit(sep).next().unwrap_or(t)
}

/// Node `path.basename(p)` for the OS the server runs on.
pub fn node_basename(p: &str) -> &str {
    if cfg!(windows) {
        win32_basename(p)
    } else {
        posix_basename(p)
    }
}

/// Node `path.isAbsolute(p)` for the OS the server runs on.
pub fn node_is_absolute(p: &str) -> bool {
    if cfg!(windows) {
        win32_is_absolute(p)
    } else {
        p.starts_with('/')
    }
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
    fn string_follows_js() {
        assert_eq!(string(&json!(null)), "null");
        assert_eq!(string(&json!(true)), "true");
        assert_eq!(string(&json!(false)), "false");
        assert_eq!(string(&json!(1.0)), "1");
        assert_eq!(string(&json!(-0.0)), "0");
        assert_eq!(string(&json!(1.5)), "1.5");
        assert_eq!(string(&json!("x y")), "x y");
        assert_eq!(string(&json!([1, [2, 3], null])), "1,2,3,");
        assert_eq!(string(&json!({})), "[object Object]");
        assert_eq!(string(&json!(1e21)), "1e+21");
        assert_eq!(string(&json!(1.5e21)), "1.5e+21");
        assert_eq!(string(&json!(1e20)), "100000000000000000000");
        assert_eq!(string(&json!(0.000001)), "0.000001");
        assert_eq!(string(&json!(1e-7)), "1e-7");
        assert_eq!(string(&json!(1.25e-7)), "1.25e-7");
        assert_eq!(string(&json!(123.456)), "123.456");
        assert_eq!(string(&json!(-42)), "-42");
        assert_eq!(string(&json!(0.1)), "0.1");
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

    #[test]
    fn basenames_follow_node() {
        assert_eq!(posix_basename("/a/b.png"), "b.png");
        assert_eq!(posix_basename("/a/b/"), "b");
        assert_eq!(posix_basename("/"), "");
        assert_eq!(posix_basename(""), "");
        assert_eq!(posix_basename("a\\b"), "a\\b");
        assert_eq!(win32_basename("C:\\x\\y.png"), "y.png");
        assert_eq!(win32_basename("C:\\x\\y\\\\"), "y");
        assert_eq!(win32_basename("C:y.png"), "y.png");
        assert_eq!(win32_basename("C:"), "");
        assert_eq!(win32_basename("a/b\\c"), "c");
        assert_eq!(win32_basename("\\"), "");
    }

    #[cfg(unix)]
    #[test]
    fn node_is_absolute_on_unix() {
        assert!(node_is_absolute("/x"));
        assert!(!node_is_absolute("x/y"));
        assert!(!node_is_absolute("C:\\x"));
        assert!(!node_is_absolute("\\x"));
        assert_eq!(node_basename("/a/b"), "b");
    }

    #[cfg(windows)]
    #[test]
    fn node_is_absolute_on_windows() {
        assert!(node_is_absolute("C:\\x"));
        assert!(node_is_absolute("c:/x"));
        assert!(node_is_absolute("\\x"));
        assert!(node_is_absolute("/x"));
        assert!(!node_is_absolute("C:x"));
        assert!(!node_is_absolute("C:"));
        assert!(!node_is_absolute("x\\y"));
        assert_eq!(node_basename("C:\\a\\b"), "b");
    }
}
