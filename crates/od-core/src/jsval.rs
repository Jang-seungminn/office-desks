//! JavaScript value semantics the TS code relies on, for `serde_json::Value`.

use serde_json::Value;

/// JS truthiness (`Boolean(v)`): `null`, `false`, `0` and `""` are false; arrays and objects
/// (even empty) are true. JSON has no `NaN` or `undefined`; callers map a missing value to false.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
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

#[cfg(test)]
mod tests {
    use super::{string, truthy};
    use serde_json::json;

    #[test]
    fn follows_js_boolean() {
        for v in [
            json!(null),
            json!(false),
            json!(0),
            json!(0.0),
            json!(-0.0),
            json!(""),
        ] {
            assert!(!truthy(&v), "{v}");
        }
        for v in [
            json!(true),
            json!(1),
            json!(-1.5),
            json!("0"),
            json!(" "),
            json!([]),
            json!({}),
        ] {
            assert!(truthy(&v), "{v}");
        }
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
}
