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

#[cfg(test)]
mod tests {
    use super::truthy;
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
}
