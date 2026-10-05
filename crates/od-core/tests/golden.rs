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

// ---- Task 10: org, awards, uploads, commands, answer ----

mod task10 {
    use super::{golden, normalize};
    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    use od_core::answer::{
        answer_questions, current_question, is_review_screen, validate_choices, AnswerIO,
    };
    use od_core::awards::{best_today, local_date, AwardBook};
    use od_core::backend::BackendError;
    use od_core::commands::{front_matter, list_commands};
    use od_core::model::{
        AnswerRequest, AskedQuestion, AwardBoard, ErrorResponse, ImageUpload, OfficeDesk,
        OkResponse, SendRequest, SlashCommand, TerminalKey,
    };
    use od_core::org::sanitize_org;
    use od_core::uploads::{
        compose_prompt, decode_base64_lenient, save_images, upload_path, UploadError, IMAGE_TYPES,
        MAX_IMAGES, MAX_IMAGE_BYTES,
    };
    use serde_json::{json, Value};
    use std::path::Path;

    fn arr(v: &Value) -> &Vec<Value> {
        v.as_array().expect("array")
    }

    fn pin_ids(mut v: Value, input: &Value) -> Value {
        let given: Vec<&str> = input
            .get("departments")
            .and_then(Value::as_array)
            .map(|l| l.iter().filter_map(|d| d.get("id")?.as_str()).collect())
            .unwrap_or_default();
        if let Some(list) = v.get_mut("departments").and_then(Value::as_array_mut) {
            for d in list {
                let id = d["id"].as_str().unwrap().to_string();
                let generated = id.len() >= 3
                    && id.len() <= 10
                    && id.starts_with("d-")
                    && id[2..]
                        .bytes()
                        .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase());
                if generated && !given.contains(&id.as_str()) {
                    d["id"] = json!("<generated>");
                }
            }
        }
        v
    }

    #[test]
    fn org_sanitize_matches_ts() {
        for case in arr(&golden("org-sanitize")) {
            let input = &case["input"];
            let got = match sanitize_org(input) {
                Ok(chart) => serde_json::to_value(chart).unwrap(),
                Err(error) => json!({ "error": error }),
            };
            assert_eq!(
                normalize(pin_ids(got, input)),
                normalize(case["expected"].clone()),
                "org: {}",
                case["name"]
            );
        }
    }

    fn desks(v: &Value) -> Vec<OfficeDesk> {
        serde_json::from_value(v.clone()).expect("desks deserialize")
    }

    #[test]
    fn award_scoring_matches_ts() {
        for case in arr(&golden("awards-score")) {
            let got = best_today(&desks(&case["desks"]), case["date"].as_str().unwrap());
            assert_eq!(
                normalize(serde_json::to_value(got).unwrap()),
                normalize(case["expected"].clone()),
                "score: {}",
                case["name"]
            );
        }
    }

    fn utc(iso: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn award_book_script_matches_ts() {
        let t = tempfile::tempdir().unwrap();
        let mut book = AwardBook::new(t.path().join("awards.json"));
        book.load();
        for step in arr(&golden("awards-book")["steps"]) {
            let changed = book.update(&desks(&step["desks"]), &utc(step["now"].as_str().unwrap()));
            assert_eq!(
                changed, step["expected"]["changed"],
                "changed at {}",
                step["now"]
            );
            assert_eq!(
                normalize(serde_json::to_value(book.current()).unwrap()),
                normalize(step["expected"]["board"].clone()),
                "board at {}",
                step["now"]
            );
        }
        // And the saved file loads back to the same board.
        book.save().unwrap();
        let mut again = AwardBook::new(book.file());
        again.load();
        assert_eq!(again.current(), book.current());
    }

    #[test]
    fn award_hall_cap_and_file_format_match_ts() {
        let g = golden("awards-cap");
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("cap.json");
        std::fs::write(&file, g["initial"].to_string()).unwrap();
        let mut book = AwardBook::new(&file);
        book.load();
        // The 95-entry hall is cut to 90 on load, like the TS slice.
        assert_eq!(book.current().hall.len(), 90);
        let changed = book.update(&[], &utc(g["now"].as_str().unwrap()));
        assert_eq!(changed, g["changed"]);
        assert_eq!(
            normalize(serde_json::to_value(book.current()).unwrap()),
            normalize(g["board"].clone())
        );
        let board: AwardBoard = serde_json::from_value(g["board"].clone()).unwrap();
        assert_eq!(&board, book.current());
    }

    #[test]
    fn local_date_matches_ts_in_utc() {
        for case in arr(&golden("awards-local-date")) {
            assert_eq!(
                local_date(&utc(case["iso"].as_str().unwrap())),
                case["expected"].as_str().unwrap(),
                "{}",
                case["iso"]
            );
        }
    }

    #[test]
    fn answer_wire_shapes_roundtrip() {
        let g = golden("wire-answer");
        let req: AnswerRequest = serde_json::from_value(g["request"].clone()).unwrap();
        assert_eq!(req.choices, vec![vec![1], vec![0, 2]]);
        assert_eq!(
            normalize(serde_json::to_value(&req).unwrap()),
            normalize(g["request"].clone())
        );
        let ok: OkResponse = serde_json::from_value(g["ok"].clone()).unwrap();
        assert_eq!(serde_json::to_value(&ok).unwrap(), g["ok"]);
        let hire: OkResponse = serde_json::from_value(g["hireOk"].clone()).unwrap();
        assert_eq!(serde_json::to_value(&hire).unwrap(), g["hireOk"]);
        for e in arr(&g["errors"]) {
            let typed: ErrorResponse = serde_json::from_value(e.clone()).unwrap();
            assert_eq!(&serde_json::to_value(&typed).unwrap(), e);
        }
        // The busy error the server builds from BackendError::busy has exactly that shape.
        let busy = BackendError::busy("req-1");
        let body = ErrorResponse {
            error: "에이전트가 지금 새 메시지를 받을 수 없는 상태예요 (질문·권한 확인 중이거나 화면 전환 중). 잠시 후 다시 보내기를 눌러 주세요".into(),
            code: busy.code.clone(),
            request_id: busy.request_id.clone(),
        };
        assert_eq!(serde_json::to_value(&body).unwrap(), g["errors"][4]);
        roundtrip_value::<SlashCommand>(
            &json!({ "name": "a", "description": "", "source": "plugin" }),
        );
    }

    fn roundtrip_value<T: serde::de::DeserializeOwned + serde::Serialize>(v: &Value) {
        let typed: T = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(&serde_json::to_value(&typed).unwrap(), v);
    }

    #[test]
    fn upload_wire_shapes_and_helpers_match_ts() {
        let g = golden("wire-upload");
        for s in arr(&g["sends"]) {
            roundtrip_value::<SendRequest>(s);
        }
        // The omitted/present distinction survives: `images` and `force` are only written when set.
        let bare: SendRequest = serde_json::from_value(g["sends"][0].clone()).unwrap();
        assert!(bare.images.is_none() && bare.force.is_none());
        let with: SendRequest = serde_json::from_value(g["sends"][1].clone()).unwrap();
        assert_eq!(with.images.as_ref().map(Vec::len), Some(1));
        let _: Option<&ImageUpload> = with.images.as_ref().and_then(|i| i.first());

        let types: serde_json::Map<String, Value> = IMAGE_TYPES
            .iter()
            .map(|(t, e)| ((*t).into(), json!(e)))
            .collect();
        assert_eq!(Value::Object(types), g["imageTypes"]);
        assert_eq!(
            g["limits"],
            json!({ "maxImages": MAX_IMAGES, "maxImageBytes": MAX_IMAGE_BYTES })
        );

        for c in arr(&g["uploadPath"]) {
            let name = c["name"].as_str().unwrap();
            let got = upload_path(name, Path::new("/up")).map(|_| json!(name));
            assert_eq!(
                got.unwrap_or(Value::Null),
                c["expected"],
                "uploadPath {name:?}"
            );
        }
        for c in arr(&g["compose"]) {
            let paths: Vec<String> = arr(&c["paths"])
                .iter()
                .map(|p| p.as_str().unwrap().into())
                .collect();
            assert_eq!(
                compose_prompt(c["text"].as_str().unwrap(), &paths),
                c["expected"].as_str().unwrap(),
                "compose {}",
                c["text"]
            );
        }
        for c in arr(&g["base64"]) {
            let hex: String = decode_base64_lenient(c["data"].as_str().unwrap())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            assert_eq!(
                hex,
                c["expectedHex"].as_str().unwrap(),
                "base64 {}",
                c["data"]
            );
        }

        // The messages the folder and image checks raise are the TS ones, byte for byte.
        let t = tempfile::tempdir().unwrap();
        let png = || ImageUpload {
            media_type: "image/png".into(),
            data: "iVBORw==".into(),
        };
        let msg = |r: Result<Vec<String>, UploadError>| match r {
            Err(UploadError::Rejected(m)) => json!({ "error": m }),
            other => panic!("expected a rejection: {other:?}"),
        };
        let errors = arr(&g["errors"]);
        assert_eq!(msg(save_images(&vec![png(); 7], t.path())), errors[0]);
        let svg = ImageUpload {
            media_type: "image/svg+xml".into(),
            data: "iVBORw==".into(),
        };
        assert_eq!(msg(save_images(&[svg], t.path())), errors[1]);
        let empty = ImageUpload {
            media_type: "image/png".into(),
            data: String::new(),
        };
        assert_eq!(msg(save_images(&[empty], t.path())), errors[2]);
        #[cfg(unix)]
        {
            let elsewhere = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(elsewhere.path(), t.path().join("uploads")).unwrap();
            assert_eq!(
                msg(save_images(&[png()], &t.path().join("uploads"))),
                errors[3]
            );
        }
    }

    fn write(file: impl AsRef<Path>, text: &str) {
        let file = file.as_ref();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }

    #[test]
    fn list_commands_matches_ts_over_a_fixture_home() {
        let g = golden("commands-list");
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        for (rel, text) in g["files"].as_object().unwrap() {
            let (root, rest) = rel.split_once('/').unwrap();
            let base = if root == "home" {
                home.path()
            } else {
                proj.path()
            };
            write(base.join(rest), text.as_str().unwrap());
        }
        // The plugin paths in the golden are "<HOME>/...": expand to this machine's temp dir.
        let home_str = home.path().to_string_lossy().replace('\\', "/");
        write(
            home.path().join(".claude/plugins/installed_plugins.json"),
            &g["installedPlugins"]
                .to_string()
                .replace("<HOME>", &home_str),
        );
        write(
            home.path().join(".claude/settings.json"),
            &g["settings"].to_string(),
        );

        for case in arr(&g["cases"]) {
            let project = if case["project"] == "proj" {
                proj.path().to_path_buf()
            } else {
                proj.path().join("nowhere")
            };
            let got = list_commands(case["agentType"].as_str().unwrap(), &project, home.path());
            assert_eq!(
                serde_json::to_value(&got).unwrap(),
                case["expected"],
                "listCommands {} in {}",
                case["agentType"],
                case["project"]
            );
            let typed: Vec<SlashCommand> =
                serde_json::from_value(case["expected"].clone()).unwrap();
            assert_eq!(typed, got);
        }
        let empty = tempfile::tempdir().unwrap();
        for agent in ["claude", "codex"] {
            let got = list_commands(agent, &empty.path().join("p"), empty.path());
            assert_eq!(
                serde_json::to_value(&got).unwrap(),
                g["emptyHome"][agent],
                "{agent}"
            );
        }
        for case in arr(&g["frontMatter"]) {
            let fm = front_matter(case["text"].as_str().unwrap());
            // JSON.stringify omits undefined, so absent keys are absent in the golden.
            let mut got = serde_json::Map::new();
            if let Some(n) = fm.name {
                got.insert("name".into(), json!(n));
            }
            if let Some(d) = fm.description {
                got.insert("description".into(), json!(d));
            }
            assert_eq!(
                Value::Object(got),
                case["expected"],
                "frontMatter {}",
                case["text"]
            );
        }
    }

    fn lines(v: &Value) -> Vec<String> {
        arr(v)
            .iter()
            .map(|l| l.as_str().unwrap().to_string())
            .collect()
    }

    /// Plays the scripted terminal of the TS golden: `Date.now` ticks 1000 per call.
    struct Scripted {
        screens: std::collections::HashMap<String, Vec<String>>,
        screen: Vec<String>,
        pressed: Vec<Value>,
        slept: Vec<u64>,
        case: String,
        t: std::sync::atomic::AtomicI64,
    }

    #[async_trait]
    impl AnswerIO for Scripted {
        async fn read_screen(&mut self) -> Result<Vec<String>, BackendError> {
            Ok(self.screen.clone())
        }
        async fn press(&mut self, key: TerminalKey) -> Result<(), BackendError> {
            self.pressed.push(json!(key.name()));
            let is = |n: &str| self.screen == self.screens[n];
            let digit = key.name().as_bytes()[0].is_ascii_digit() && key.name().len() == 1;
            let next = match self.case.as_str() {
                "full walk" if is("q1") && digit => Some("q2"),
                "full walk" if is("q2") && key == TerminalKey::Right => Some("review"),
                "full walk" if is("review") && key == TerminalKey::N1 => Some("done"),
                "single question submits at once" => Some("done"),
                _ => None,
            };
            if let Some(n) = next {
                self.screen = self.screens[n].clone();
            }
            Ok(())
        }
        async fn sleep(&mut self, ms: u64) {
            self.slept.push(ms);
        }
        fn now_ms(&self) -> i64 {
            self.t.fetch_add(1000, std::sync::atomic::Ordering::SeqCst) + 1000
        }
    }

    #[tokio::test]
    async fn answer_dialog_helpers_and_driver_match_ts() {
        let g = golden("answer-driver");
        let screens: std::collections::HashMap<String, Vec<String>> = arr(&g["screens"])
            .iter()
            .map(|s| (s["name"].as_str().unwrap().to_string(), lines(&s["lines"])))
            .collect();
        for s in arr(&g["screens"]) {
            let l = lines(&s["lines"]);
            assert_eq!(
                current_question(&l).map_or(Value::Null, Value::from),
                s["currentQuestion"],
                "currentQuestion {}",
                s["name"]
            );
            assert_eq!(
                is_review_screen(&l),
                s["isReview"],
                "isReview {}",
                s["name"]
            );
        }
        for v in arr(&g["validate"]) {
            let qs: Vec<AskedQuestion> = serde_json::from_value(v["questions"].clone()).unwrap();
            assert_eq!(
                validate_choices(&qs, &v["choices"]).map_or(Value::Null, Value::from),
                v["expected"],
                "validate {}",
                v["name"]
            );
        }
        for run in arr(&g["runs"]) {
            let qs: Vec<AskedQuestion> = serde_json::from_value(run["questions"].clone()).unwrap();
            let choices: Vec<Vec<i64>> = serde_json::from_value(run["choices"].clone()).unwrap();
            let mut io = Scripted {
                screens: screens.clone(),
                screen: screens[run["first"].as_str().unwrap()].clone(),
                pressed: vec![],
                slept: vec![],
                case: run["name"].as_str().unwrap().to_string(),
                t: 0.into(),
            };
            let error = answer_questions(&mut io, &qs, &choices)
                .await
                .err()
                .map(|e| e.message);
            let want = &run["result"];
            assert_eq!(
                Value::Array(io.pressed.clone()),
                want["pressed"],
                "pressed: {}",
                run["name"]
            );
            assert_eq!(json!(io.slept), want["slept"], "slept: {}", run["name"]);
            assert_eq!(
                error.map_or(Value::Null, Value::from),
                want["error"],
                "error: {}",
                run["name"]
            );
        }
    }
}
