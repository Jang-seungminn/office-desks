//! Golden round-trips: each file under tests/golden is produced by the real TS code
//! (`npm run golden`). Deserializing and re-serializing must reproduce it exactly.

use od_core::model::{OfficeSnapshot, ServerMessage};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
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

#[test]
fn orca_sourced_timestamps_accept_json_floats() {
    use od_core::model::{OfficeAgent, OfficeDesk, UsageWindow};
    let agent = |since: Value| {
        json!({
            "id": "a", "terminalHandle": null, "agentType": "claude", "terminalTitle": null,
            "subagentsRunning": 0, "model": null, "effort": null, "stats": null, "state": "done",
            "rawState": "done", "activity": "", "prompt": null, "lastMessage": null, "since": since
        })
    };
    let a: OfficeAgent = serde_json::from_value(agent(json!(1790997660310.7))).unwrap();
    assert_eq!(a.since, Some(1_790_997_660_310));
    let a: OfficeAgent = serde_json::from_value(agent(json!(1790997660310_i64))).unwrap();
    assert_eq!(a.since, Some(1_790_997_660_310));
    let a: OfficeAgent = serde_json::from_value(agent(Value::Null)).unwrap();
    assert_eq!(a.since, None);
    let mut missing = agent(Value::Null);
    missing.as_object_mut().unwrap().remove("since");
    assert_eq!(
        serde_json::from_value::<OfficeAgent>(missing)
            .unwrap()
            .since,
        None
    );
    // Serialization stays an integer.
    let a: OfficeAgent = serde_json::from_value(agent(json!(5.0))).unwrap();
    assert_eq!(serde_json::to_value(&a).unwrap()["since"], json!(5));

    let mut desk = golden("snapshot")["desks"][0].clone();
    desk["lastActivityAt"] = json!(1700000000123.9);
    let d: OfficeDesk = serde_json::from_value(desk).unwrap();
    assert_eq!(d.last_activity_at, Some(1_700_000_000_123));

    let w: UsageWindow = serde_json::from_value(json!({
        "key": "session", "label": "5h", "usedPercent": 1.5,
        "resetsAt": 1700003600000.5, "resetDescription": null
    }))
    .unwrap();
    assert_eq!(w.resets_at, Some(1_700_003_600_000));
    assert!(serde_json::from_value::<OfficeAgent>(agent(json!("soon"))).is_err());
}

// ---- transcripts, stats, conversation responses (task 8) ----

mod transcript_goldens {
    use super::{golden, normalize};
    use chrono::{DateTime, Utc};
    use od_core::conversation::{conversation_response, empty_conversation};
    use od_core::model::{ConversationResponse, SubagentInfo};
    use od_core::stats::agent_stats;
    use od_core::subagents::subagent_infos;
    use od_core::transcript::{read_transcript, reset_transcript_cache, ReadOptions};
    use serde_json::Value;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../bridge/test/fixtures")
            .join(name)
    }

    /// fileId hashes the absolute path, so goldens pin it to a placeholder.
    fn pinned(mut v: Value) -> Value {
        if v["fileId"].is_string() {
            v["fileId"] = Value::from("<fileId>");
        }
        v
    }

    // One test reads and resets the process-wide transcript cache, so the sidechain variant
    // of the same file is read fresh.
    #[test]
    fn transcripts_stats_and_conversations_match_ts() {
        let mut all = HashMap::new();
        for (name, sidechain) in [
            ("claude-session", false),
            ("codex-session", false),
            ("claude-rich", false),
            ("claude-rich", true),
        ] {
            reset_transcript_cache();
            let t = read_transcript(
                &fixture_path(&format!("{name}.jsonl")),
                ReadOptions { sidechain },
            )
            .unwrap();
            let key = if sidechain {
                format!("{name}-sidechain")
            } else {
                name.to_string()
            };
            let actual = pinned(serde_json::to_value(&t).unwrap());
            assert_eq!(
                normalize(actual),
                normalize(golden(&format!("transcript-{key}"))),
                "{key}"
            );
            all.insert(key, t);
        }
        reset_transcript_cache();

        for case in golden("stats").as_array().unwrap() {
            let t = &all[case["transcript"].as_str().unwrap()];
            let now: DateTime<Utc> = case["now"].as_str().unwrap().parse().unwrap();
            let s = agent_stats(&t.messages, &t.calls, &now);
            assert_eq!(
                normalize(serde_json::to_value(&s).unwrap()),
                normalize(case["expected"].clone()),
                "stats {} @ {}",
                case["transcript"],
                case["now"]
            );
        }

        let ids: HashMap<String, String> = [("s1".to_string(), "abc123".to_string())]
            .into_iter()
            .collect();
        let infos = |name: &str| -> Vec<SubagentInfo> { subagent_infos(&all[name].calls, &ids) };
        for case in golden("conversation").as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let resp: ConversationResponse = match case["kind"].as_str().unwrap() {
                "empty" => empty_conversation(case["reason"].as_str().unwrap()),
                "empty-subagents" => ConversationResponse {
                    subagents: infos("claude-rich"),
                    ..empty_conversation(case["reason"].as_str().unwrap())
                },
                _ => {
                    let main = &all[case["main"].as_str().unwrap()];
                    let sub = case["sub"].as_str().map(|s| &all[s]);
                    conversation_response(
                        main,
                        sub,
                        subagent_infos(&main.calls, &ids),
                        case["after"].as_i64().unwrap(),
                        case["agentType"].as_str().unwrap(),
                    )
                }
            };
            assert_eq!(
                normalize(pinned(serde_json::to_value(&resp).unwrap())),
                normalize(case["expected"].clone()),
                "conversation: {name}"
            );
            // And the golden itself round-trips through the model type.
            let typed: ConversationResponse =
                serde_json::from_value(case["expected"].clone()).unwrap();
            assert_eq!(
                normalize(serde_json::to_value(&typed).unwrap()),
                normalize(case["expected"].clone()),
                "conversation roundtrip: {name}"
            );
        }
    }
}
