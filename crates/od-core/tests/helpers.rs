//! Port of bridge/test/{stateMapper,screen,screens,hire}.test.ts plus golden comparisons for the
//! pure helpers (state mapper, screen, keys, hire). Goldens come from `npm run golden`.

use od_core::backend::{BackendCapabilities, BackendError, HireResult, HireSpec, KeyInput};
use od_core::hire::{validate_hire, KNOWN_AGENTS};
use od_core::keys::{char_bytes, key_bytes, KEY_BYTES};
use od_core::model::{
    ComposerState, HireRequest, OfficeDesk, OfficeSnapshot, ScreenSupport, TerminalKey,
};
use od_core::screen::{composer_state, screen_support, TESTED_CLAUDE_VERSIONS};
use od_core::state_mapper::{
    clean_title, map_agent_state, native_desk_name, orca_desk_name, to_snapshot, OrcaTerminalRow,
    OrcaWorktreeRow,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

fn crate_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn read_json(path: PathBuf) -> Value {
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).expect("valid JSON")
}

fn golden(name: &str) -> Value {
    read_json(crate_path(&format!("tests/golden/{name}.json")))
}

fn fixture(name: &str) -> Value {
    read_json(crate_path(&format!("../../bridge/test/fixtures/{name}")))
}

/// JS prints 42.0 as `42`; serde prints an f64 as `42.0`. Compare numbers by value.
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

fn rows<T: for<'de> Deserialize<'de>>(v: &Value) -> Vec<T> {
    serde_json::from_value(v.clone()).expect("rows deserialize")
}

fn fixture_snapshot(now: i64) -> OfficeSnapshot {
    let ps = fixture("worktree-ps.json");
    let terms = fixture("terminal-list.json");
    let w: Vec<OrcaWorktreeRow> = rows(&ps["worktrees"]);
    let t: Vec<OrcaTerminalRow> = rows(&terms["terminals"]);
    to_snapshot(&w, &t, now, None)
}

fn snap_of(w: Value) -> OfficeSnapshot {
    to_snapshot(&rows(&w), &[], 0, None)
}

// ---------- stateMapper.test.ts ----------

#[test]
fn map_agent_state_table() {
    let cases: [(Option<&str>, Option<&str>, &str); 9] = [
        (Some("waiting"), Some("ExitPlanMode"), "waiting"),
        (Some("done"), None, "done"),
        (Some("working"), Some("Edit"), "typing"),
        (Some("working"), None, "typing"),
        (Some("working"), Some("Read"), "reading"),
        (Some("working"), Some("WebSearch"), "reading"),
        (Some("working"), Some("Bash"), "running"),
        (Some("something-new"), None, "away"),
        (None, None, "away"),
    ];
    for (raw, tool, want) in cases {
        let got = serde_json::to_value(map_agent_state(raw, tool)).unwrap();
        assert_eq!(got, json!(want), "{raw:?} + {tool:?}");
    }
    assert_eq!(
        serde_json::to_value(map_agent_state(Some("permission"), None)).unwrap(),
        json!("waiting")
    );
    assert_eq!(
        serde_json::to_value(map_agent_state(Some("idle"), None)).unwrap(),
        json!("done")
    );
    // An empty tool name is falsy in JS.
    assert_eq!(
        serde_json::to_value(map_agent_state(Some("working"), Some(""))).unwrap(),
        json!("typing")
    );
}

#[test]
fn snapshot_drops_archived_and_keeps_stable_order() {
    let snap = fixture_snapshot(123);
    let ids: Vec<_> = snap.desks.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "repoA::/Users/me/proj/office_desks",
            "repoB::C:\\Users\\me\\secretary",
            "repoD::/Users/me/empty"
        ]
    );
    assert_eq!(snap.updated_at, 123);
    assert_eq!(snap.error, None);
}

#[test]
fn snapshot_joins_agents_to_terminal_handles() {
    let snap = fixture_snapshot(123);
    assert_eq!(
        snap.desks[0].agents[0].terminal_handle.as_deref(),
        Some("term_1")
    );
    let handles: Vec<_> = snap.desks[1]
        .agents
        .iter()
        .map(|a| a.terminal_handle.as_deref())
        .collect();
    assert_eq!(handles, [Some("term_2"), Some("term_3"), None, None]);
}

#[test]
fn snapshot_builds_readable_activity_lines() {
    let snap = fixture_snapshot(123);
    let b = &snap.desks[1];
    assert_eq!(snap.desks[0].agents[0].activity, "확인 필요: ExitPlanMode");
    assert_eq!(b.agents[0].activity, "Bash: npm test --watch=false");
    assert_eq!(b.agents[2].activity, "생각 중…");
    assert_eq!(b.agents[3].activity, "완료 · 다음 지시 대기");
    assert_eq!(b.agents[3].last_message.as_deref(), Some("All green."));
}

#[test]
fn snapshot_names_desks_by_repo_when_display_name_is_empty_or_branch() {
    let snap = fixture_snapshot(123);
    let b = &snap.desks[1];
    assert_eq!(b.name, "secretary");
    let vault = snap_of(
        json!([{ "worktreeId": "r::/x", "repo": "vault", "displayName": "main", "branch": "refs/heads/main" }]),
    );
    assert_eq!(vault.desks[0].name, "vault");
    assert_eq!(b.branch, "knowledge-graph");
    assert_eq!(b.path, "C:\\Users\\me\\secretary");
}

#[test]
fn clean_title_drops_spinner_glyphs() {
    assert_eq!(
        clean_title(Some("✳ command context logging")).as_deref(),
        Some("command context logging")
    );
    assert_eq!(
        clean_title(Some("◑ Orca 터미널 대시보드 프로젝트")).as_deref(),
        Some("Orca 터미널 대시보드 프로젝트")
    );
    assert_eq!(clean_title(Some("⠂ ")), None);
    assert_eq!(clean_title(None), None);
    let snap = fixture_snapshot(123);
    assert_eq!(
        snap.desks[0].agents[0].terminal_title.as_deref(),
        Some("Fix login")
    );
}

#[test]
fn snapshot_passes_unread_through() {
    assert!(snap_of(json!([{ "worktreeId": "r::/a", "unread": true }])).desks[0].unread);
    assert!(!fixture_snapshot(123).desks[0].unread);
}

#[test]
fn snapshot_keeps_empty_desks_and_tolerates_missing_fields() {
    assert!(fixture_snapshot(123).desks[2].agents.is_empty());
    let snap = snap_of(json!([{ "worktreeId": "x::y", "agents": [{}] }]));
    assert_eq!(snap.desks[0].agents[0].id, "x::y#0");
    assert_eq!(snap.desks[0].repo_id, "x");
}

#[test]
fn rows_degrade_on_wrong_types_instead_of_failing() {
    let snap = snap_of(json!([{
        "worktreeId": "x::y", "branch": 5, "isActive": "yes", "lastActivityAt": "soon",
        "agents": [{ "state": 1, "stateStartedAt": "then", "toolName": ["Bash"] }]
    }]));
    assert_eq!(snap.desks[0].branch, "");
    assert_eq!(snap.desks[0].last_activity_at, None);
    assert_eq!(snap.desks[0].agents[0].raw_state, "unknown");
    assert_eq!(snap.desks[0].agents[0].since, None);
}

#[test]
fn orca_timestamps_may_be_floats() {
    let snap = snap_of(json!([{
        "worktreeId": "x::y", "lastActivityAt": 1700000000123.9,
        "agents": [{ "stateStartedAt": 1790997660310.7 }]
    }]));
    assert_eq!(snap.desks[0].last_activity_at, Some(1_700_000_000_123));
    assert_eq!(snap.desks[0].agents[0].since, Some(1_790_997_660_310));
}

#[test]
fn orca_desk_name_prefers_display_name_then_repo_then_branch() {
    let w = |v: Value| serde_json::from_value::<OrcaWorktreeRow>(v).unwrap();
    assert_eq!(
        orca_desk_name(&w(
            json!({ "displayName": "Mine", "branch": "refs/heads/x" })
        )),
        "Mine"
    );
    assert_eq!(
        orca_desk_name(&w(
            json!({ "displayName": "x", "branch": "refs/heads/x", "repo": "r" })
        )),
        "r"
    );
    assert_eq!(orca_desk_name(&w(json!({ "branch": "refs/heads/x" }))), "x");
    assert_eq!(orca_desk_name(&w(json!({}))), "worktree");
}

#[test]
fn custom_desk_name_function_is_used() {
    let w: Vec<OrcaWorktreeRow> = rows(&json!([{ "worktreeId": "r::/p/q", "path": "/p/q" }]));
    let f = |w: &OrcaWorktreeRow| format!("<{}>", w.path.clone().unwrap_or_default());
    let snap = to_snapshot(&w, &[], 0, Some(&f));
    assert_eq!(snap.desks[0].name, "</p/q>");
    assert_eq!(native_desk_name(&w[0]), "q");
}

// ---------- screen.test.ts ----------

fn rule() -> String {
    "─".repeat(60)
}

fn s(lines: &[&str]) -> Vec<String> {
    lines.iter().map(|l| l.to_string()).collect()
}

#[test]
fn composer_sees_the_input_box_framed_by_rules() {
    let r = rule();
    let composer = s(&[
        "⏺ Done.",
        "",
        &format!("{r} command context logging ─"),
        "❯ ",
        &r,
        "  ⏵⏵ auto mode on · 1 shell",
    ]);
    assert_eq!(composer_state(&composer, "claude"), ComposerState::Ready);
    let draft = s(&["x", &r, "❯ first line", "  second line", &r, "footer"]);
    assert_eq!(composer_state(&draft, "claude"), ComposerState::Ready);
}

#[test]
fn composer_flags_dialogs_that_replace_the_input_box() {
    let usage = s(&[
        "Settings  Status  Config  Usage",
        "",
        "Current session  ███░░ 12% used",
        "Esc to cancel",
    ]);
    assert_eq!(composer_state(&usage, "claude"), ComposerState::Menu);
    let permission = s(&[
        "Bash command",
        "  rm -rf build",
        "Do you want to proceed?",
        "❯ 1. Yes",
        "  2. No",
        "",
        "Esc to cancel",
    ]);
    assert_eq!(composer_state(&permission, "claude"), ComposerState::Menu);
}

#[test]
fn composer_does_not_guess_for_other_agents_or_blank_screens() {
    assert_eq!(
        composer_state(&s(&["anything"]), "codex"),
        ComposerState::Unknown
    );
    assert_eq!(
        composer_state(&s(&["", ""]), "claude"),
        ComposerState::Unknown
    );
    assert_eq!(
        composer_state::<String>(&[], "claude"),
        ComposerState::Unknown
    );
}

#[test]
fn char_bytes_accepts_one_printable_character_only() {
    assert_eq!(char_bytes("a"), Some('a'));
    assert_eq!(char_bytes("한"), Some('한'));
    assert_eq!(char_bytes(" "), Some(' '));
    assert_eq!(char_bytes("\x1b"), None);
    assert_eq!(char_bytes("ab"), None);
    assert_eq!(char_bytes("\n"), None);
    assert_eq!(char_bytes(""), None);
}

#[test]
fn queue_keys_use_csi_u_ctrl_enter_and_ctrl_u() {
    assert_eq!(key_bytes("ctrl-enter"), Some("\x1b[13;5u"));
    assert_eq!(key_bytes("ctrl-u"), Some("\x15"));
    assert_eq!(key_bytes("constructor"), None);
    assert_eq!(KEY_BYTES.len(), 24);
    assert_eq!(TerminalKey::ShiftTab.bytes(), "\x1b[Z");
}

#[test]
fn screen_support_marks_untested_versions() {
    assert_eq!(TESTED_CLAUDE_VERSIONS, ["2.1"]);
    assert_eq!(
        screen_support("claude", Some("2.1.288")),
        ScreenSupport::Tested
    );
    assert_eq!(
        screen_support("claude", Some("2.2.0")),
        ScreenSupport::Untested
    );
    assert_eq!(screen_support("claude", None), ScreenSupport::Unknown);
    assert_eq!(
        screen_support("codex", Some("0.118.0")),
        ScreenSupport::Unknown
    );
}

// ---------- screens.test.ts: captured Claude Code 2.1 screens ----------

#[test]
fn captured_claude_2_1_screens() {
    let expected = [
        ("composer-queued.txt", ComposerState::Ready),
        ("composer-working.txt", ComposerState::Ready),
        ("question-single-with-pane.txt", ComposerState::Menu),
        ("question-multi-first.txt", ComposerState::Menu),
        ("question-multi-review.txt", ComposerState::Menu),
        ("trust-dialog.txt", ComposerState::Menu),
    ];
    let dir = crate_path("../../bridge/test/fixtures/screens/claude-2.1");
    let mut seen = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("txt") {
            continue;
        }
        let name = path.file_name().unwrap().to_str().unwrap().to_string();
        let want = expected
            .iter()
            .find(|(n, _)| *n == name)
            .unwrap_or_else(|| panic!("add an expectation for {name}"))
            .1;
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(composer_state(&lines, "claude"), want, "{name}");
        seen += 1;
    }
    assert_eq!(seen, expected.len());
}

// ---------- hire.test.ts ----------

fn desks() -> Vec<OfficeDesk> {
    serde_json::from_value(golden("hire")["desks"].clone()).unwrap()
}

fn req(v: Value) -> HireRequest {
    serde_json::from_value(v).unwrap()
}

#[test]
fn hire_accepts_new_worktree_and_trims_prompt() {
    let got = validate_hire(
        &req(
            json!({ "repoId": "r1", "name": "fix-login", "agent": "claude", "prompt": " --help me ", "baseBranch": "origin/main" }),
        ),
        &desks(),
    );
    assert_eq!(
        got,
        Ok(HireSpec::Worktree {
            repo_id: "r1".into(),
            name: "fix-login".into(),
            agent: "claude".into(),
            base_branch: Some("origin/main".into()),
            prompt: Some("--help me".into()),
        })
    );
}

#[test]
fn hire_accepts_another_agent_in_an_existing_worktree() {
    let got = validate_hire(
        &req(json!({ "deskId": "r1::/p/feat", "agent": "codex", "prompt": "go" })),
        &desks(),
    );
    assert_eq!(
        got,
        Ok(HireSpec::Agent {
            desk_id: "r1::/p/feat".into(),
            agent: "codex".into(),
            prompt: Some("go".into()),
        })
    );
    let no_prompt = validate_hire(
        &req(json!({ "deskId": "r1::/p/feat", "agent": "codex" })),
        &desks(),
    );
    assert!(matches!(
        no_prompt,
        Ok(HireSpec::Agent { prompt: None, .. })
    ));
}

#[test]
fn hire_rejects_unknown_repos_worktrees_agents_and_unsafe_names() {
    let bad = [
        json!({ "repoId": "nope", "name": "x", "agent": "claude" }),
        json!({ "repoId": "r1", "name": "--fresh", "agent": "claude" }),
        json!({ "repoId": "r1", "name": "a b", "agent": "claude" }),
        json!({ "repoId": "r1", "name": "feat", "agent": "claude" }),
        json!({ "repoId": "r1", "name": "ok", "agent": "bash -c x" }),
        json!({ "repoId": "r1", "name": "ok", "agent": "claude", "baseBranch": "-x" }),
        json!({ "deskId": "r1::/elsewhere", "agent": "claude" }),
    ];
    for b in bad {
        assert!(validate_hire(&req(b.clone()), &desks()).is_err(), "{b}");
    }
    assert_eq!(KNOWN_AGENTS.len(), 8);
}

// ---------- backend/types.ts ----------

#[test]
fn backend_error_has_code_and_message() {
    let e = BackendError::new("boom");
    assert_eq!(e.code, "backend_error");
    assert_eq!(e.to_string(), "boom");
    let e = BackendError::with_code("agent can not take a prompt right now", "agent_busy");
    assert_eq!(e.code, "agent_busy");
    assert_eq!(e.message, "agent can not take a prompt right now");
}

#[test]
fn hire_result_omits_absent_warning() {
    assert_eq!(
        serde_json::to_value(HireResult::default()).unwrap(),
        json!({})
    );
    let r = HireResult {
        warning: Some("w".into()),
    };
    assert_eq!(serde_json::to_value(r).unwrap(), json!({ "warning": "w" }));
    let spec = serde_json::to_value(HireSpec::Agent {
        desk_id: "d".into(),
        agent: "claude".into(),
        prompt: None,
    })
    .unwrap();
    assert_eq!(
        spec,
        json!({ "kind": "agent", "deskId": "d", "agent": "claude", "prompt": null })
    );
    assert_eq!(KeyInput::Enter, KeyInput::Enter);
    assert_ne!(KeyInput::Bytes("x".into()), KeyInput::Enter);
    let _: Option<BackendCapabilities> = None;
}

// ---------- goldens from the real TS ----------

#[test]
fn golden_to_snapshot() {
    for case in golden("mapper-snapshots").as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let w: Vec<OrcaWorktreeRow> = rows(&case["worktrees"]);
        let t: Vec<OrcaTerminalRow> = rows(&case["terminals"]);
        let now = case["now"].as_i64().unwrap();
        let native = case["deskName"].as_str() == Some("native");
        let snap = if native {
            to_snapshot(&w, &t, now, Some(&native_desk_name))
        } else {
            to_snapshot(&w, &t, now, None)
        };
        assert_eq!(
            normalize(serde_json::to_value(&snap).unwrap()),
            normalize(case["expected"].clone()),
            "{name}"
        );
    }
}

#[test]
fn golden_clean_title() {
    for case in golden("mapper-clean-title").as_array().unwrap() {
        let got = clean_title(case["input"].as_str());
        assert_eq!(
            got.as_deref(),
            case["expected"].as_str(),
            "{}",
            case["input"]
        );
    }
}

#[test]
fn golden_composer_state() {
    let cases = golden("screen-composer");
    assert!(cases.as_array().unwrap().len() >= 6 + 8);
    for case in cases.as_array().unwrap() {
        let lines: Vec<String> = serde_json::from_value(case["lines"].clone()).unwrap();
        let got = composer_state(&lines, case["agentType"].as_str().unwrap());
        assert_eq!(
            serde_json::to_value(got).unwrap(),
            case["expected"],
            "{}",
            case["name"]
        );
    }
}

#[test]
fn golden_screen_support() {
    for case in golden("screen-support").as_array().unwrap() {
        let got = screen_support(
            case["agentType"].as_str().unwrap(),
            case["version"].as_str(),
        );
        assert_eq!(
            serde_json::to_value(got).unwrap(),
            case["expected"],
            "{} {}",
            case["agentType"],
            case["version"]
        );
    }
}

#[test]
fn golden_keys() {
    let g = golden("keys");
    let keys = g["keys"].as_object().unwrap();
    assert_eq!(keys.len(), TerminalKey::ALL.len());
    for (name, bytes) in keys {
        assert_eq!(key_bytes(name), bytes.as_str(), "{name}");
        let key: TerminalKey = serde_json::from_value(json!(name)).unwrap();
        assert_eq!(Some(key.bytes()), bytes.as_str(), "{name}");
    }
    for case in g["rejected"].as_array().unwrap() {
        assert_eq!(
            key_bytes(case["key"].as_str().unwrap()),
            None,
            "{}",
            case["key"]
        );
    }
    for case in g["chars"].as_array().unwrap() {
        let got = char_bytes(case["ch"].as_str().unwrap()).map(String::from);
        assert_eq!(got.as_deref(), case["expected"].as_str(), "{}", case["ch"]);
    }
}

#[test]
fn golden_validate_hire() {
    let g = golden("hire");
    let desks: Vec<OfficeDesk> = serde_json::from_value(g["desks"].clone()).unwrap();
    for case in g["cases"].as_array().unwrap() {
        let body: HireRequest = serde_json::from_value(case["body"].clone()).unwrap();
        let got = match validate_hire(&body, &desks) {
            Ok(spec) => json!({ "spec": spec }),
            Err(error) => json!({ "error": error }),
        };
        assert_eq!(got, case["expected"], "{}", case["name"]);
    }
}
