//! Golden round-trips: each file under tests/golden is produced by the real TS code
//! (`npm run golden`). Deserializing and re-serializing must reproduce it exactly.

use od_core::model::{OfficeSnapshot, ServerMessage};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::path::PathBuf;

fn golden(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).expect("golden is valid JSON")
}

/// JS prints 42.0 as `42`; serde prints an f64 as `42.0`. Compare numbers by value so that
/// only real shape differences fail. serde_json::Value objects compare key-order-insensitively.
fn normalize(v: Value) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 9e15 => Value::from(f as i64),
            _ => Value::Number(n),
        },
        Value::Array(a) => Value::Array(a.into_iter().map(normalize).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, normalize(v))).collect()),
        other => other,
    }
}

fn roundtrip<T: DeserializeOwned + Serialize>(name: &str) {
    let expected = golden(name);
    let typed: T = serde_json::from_value(expected.clone())
        .unwrap_or_else(|e| panic!("{name}: deserialize failed: {e}"));
    let actual = serde_json::to_value(&typed).expect("serialize");
    assert_eq!(
        normalize(actual),
        normalize(expected),
        "{name} round-trip differs"
    );
}

#[test]
fn snapshots_roundtrip() {
    roundtrip::<OfficeSnapshot>("snapshot");
    roundtrip::<OfficeSnapshot>("snapshot-populated");
    roundtrip::<OfficeSnapshot>("snapshot-error");
}

#[test]
fn server_messages_roundtrip() {
    for name in [
        "msg-backend",
        "msg-snapshot",
        "msg-usage",
        "msg-org",
        "msg-awards",
        "msg-awards-empty",
    ] {
        roundtrip::<ServerMessage>(name);
    }
}

#[test]
fn unknown_message_type_is_rejected() {
    let v = serde_json::json!({ "type": "nope" });
    assert!(serde_json::from_value::<ServerMessage>(v).is_err());
}
