//! Ports of bridge/test/transcript.test.ts and subagents.test.ts, plus reader edge cases.

use od_core::model::{MessageRole, SubagentStatus};
use od_core::stats::agent_stats;
use od_core::subagents::{subagent_file, subagent_ids, subagent_infos};
use od_core::transcript::{parse_transcript, read_transcript, ReadOptions};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

fn fixture(name: &str) -> String {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../bridge/test/fixtures")
        .join(name);
    std::fs::read_to_string(p).unwrap()
}

fn role_text(st: &od_core::transcript::ParseState) -> Vec<(MessageRole, String)> {
    st.messages
        .iter()
        .map(|m| (m.role, m.text.clone()))
        .collect()
}

fn tmp_file() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("s.jsonl");
    (dir, f)
}

fn line(text: &str, role: &str) -> String {
    let content = if role == "user" {
        json!(text)
    } else {
        json!([{ "type": "text", "text": text }])
    };
    format!(
        "{}\n",
        json!({ "type": role, "message": { "role": role, "content": content } })
    )
}

fn append(path: &Path, bytes: &[u8]) {
    let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    f.write_all(bytes).unwrap();
}

fn read(path: &Path) -> od_core::transcript::TranscriptResult {
    read_transcript(path, ReadOptions::default()).unwrap()
}

#[test]
fn claude_keeps_the_chat_and_drops_noise() {
    let st = parse_transcript(&fixture("claude-session.jsonl"));
    assert_eq!(st.title.as_deref(), Some("Office desks project"));
    use MessageRole::*;
    let exp = |r, t: &str| (r, t.to_string());
    assert_eq!(
        role_text(&st),
        vec![
            exp(User, "Build an **office** view"),
            exp(Assistant, "Sure.\n\n```ts\nconst a = 1;\n```"),
            exp(Tool, "Bash: npm test --run"),
            exp(User, "next: add pixel assets"),
            exp(User, "also check usage"),
        ]
    );
    assert_eq!(st.messages.last().unwrap().queued, Some(true));
    assert_eq!(
        st.messages[0].ts.as_deref(),
        Some("2026-10-03T03:00:00.000Z")
    );
    assert_eq!(st.messages[0].images, Some(vec![0]));
    assert_eq!(st.images.len(), 1);
    assert_eq!(st.images[0].media_type, "image/png");
    assert_eq!(st.images[0].data, "xx");
}

#[test]
fn codex_uses_user_message_events_assistant_output_and_tool_summaries() {
    let st = parse_transcript(&fixture("codex-session.jsonl"));
    use MessageRole::*;
    let exp = |r, t: &str| (r, t.to_string());
    assert_eq!(
        role_text(&st),
        vec![
            exp(User, "Make a terminal usage monitor"),
            exp(Assistant, "Checking the repo first."),
            exp(Tool, "exec_command: pwd && rg --files"),
            exp(Tool, "web_search: claude code otel"),
            exp(
                Tool,
                "apply_patch: *** Begin Patch *** Add File: docs/plan.md +# Plan"
            ),
        ]
    );
}

#[test]
fn tolerates_crlf() {
    let (_d, f) = tmp_file();
    std::fs::write(&f, fixture("claude-session.jsonl").replace('\n', "\r\n")).unwrap();
    assert_eq!(read(&f).messages.len(), 5);
}

#[test]
fn keeps_whole_history_and_parses_only_appended_lines() {
    let (_d, f) = tmp_file();
    let mut s = line("the very first request", "user");
    for i in 0..1500 {
        s += &line(&format!("reply {i}"), "assistant");
    }
    std::fs::write(&f, s).unwrap();
    let a = read(&f);
    assert_eq!(a.messages.len(), 1501);
    assert_eq!(a.messages[0].text, "the very first request");

    append(&f, line("one more", "user").as_bytes());
    let b = read(&f);
    assert_eq!(b.messages.len(), 1502);
    assert_eq!(b.messages.last().unwrap().text, "one more");
    assert_eq!(b.file_id, a.file_id);
}

#[test]
fn waits_for_half_written_line_including_split_utf8() {
    let (_d, f) = tmp_file();
    let bytes = line("안녕하세요 반가워요", "user").into_bytes();
    std::fs::write(&f, &bytes[..20]).unwrap(); // cuts inside a multibyte character
    assert_eq!(read(&f).messages.len(), 0);
    append(&f, &bytes[20..]);
    let texts: Vec<_> = read(&f).messages.into_iter().map(|m| m.text).collect();
    assert_eq!(texts, ["안녕하세요 반가워요"]);
}

#[test]
fn partial_last_line_is_not_consumed_until_its_newline_arrives() {
    let (_d, f) = tmp_file();
    let whole = line("complete", "user");
    let partial = line("later", "user");
    let no_nl = partial.trim_end_matches('\n');
    std::fs::write(&f, format!("{whole}{no_nl}")).unwrap();
    assert_eq!(read(&f).messages.len(), 1); // full JSON but no newline yet
    append(&f, b"\n");
    assert_eq!(read(&f).messages.len(), 2);
}

#[test]
fn starts_over_with_new_file_id_when_truncated_or_replaced() {
    let (_d, f) = tmp_file();
    std::fs::write(
        &f,
        line("old session, long text here", "user") + &line("more", "user"),
    )
    .unwrap();
    let a = read(&f);
    std::fs::write(&f, line("new", "user")).unwrap();
    let b = read(&f);
    let texts: Vec<_> = b.messages.iter().map(|m| m.text.as_str()).collect();
    assert_eq!(texts, ["new"]);
    assert_ne!(b.file_id, a.file_id);
}

#[test]
fn skips_invalid_json_lines() {
    let (_d, f) = tmp_file();
    std::fs::write(
        &f,
        format!(
            "not json\n{{broken\n{}\n   \n[1,2]\n42\n{}",
            line("ok", "user").trim_end(),
            line("tail", "user")
        ),
    )
    .unwrap();
    let texts: Vec<_> = read(&f).messages.into_iter().map(|m| m.text).collect();
    assert_eq!(texts, ["ok", "tail"]);
}

#[test]
fn file_id_is_a_12_char_sha1_of_path_and_generation() {
    let (_d, f) = tmp_file();
    std::fs::write(&f, line("x", "user")).unwrap();
    let a = read(&f);
    let mut h = sha1_smol::Sha1::new();
    h.update(format!("{}#1", f.to_string_lossy()).as_bytes());
    assert_eq!(a.file_id, &h.digest().to_string()[..12]);
}

#[test]
fn missing_file_is_an_error() {
    let (_d, f) = tmp_file();
    assert!(read_transcript(&f, ReadOptions::default()).is_err());
}

#[test]
fn concurrent_reads_of_one_growing_file_stay_consistent() {
    let (_d, f) = tmp_file();
    std::fs::write(&f, line("first", "user")).unwrap();
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let f = f.clone();
            std::thread::spawn(move || {
                for _ in 0..50 {
                    let n = read(&f).messages.len();
                    assert!(n >= 1);
                }
            })
        })
        .collect();
    for i in 0..50 {
        append(&f, line(&format!("m{i}"), "assistant").as_bytes());
    }
    for h in handles {
        h.join().unwrap();
    }
    assert_eq!(read(&f).messages.len(), 51);
}

#[test]
fn model_and_effort_take_the_latest_turn() {
    let claude = parse_transcript(
        &[
            json!({"type":"assistant","effort":"high","message":{"role":"assistant","model":"claude-opus-5-5","content":[]}}),
            json!({"type":"assistant","perTurnEffort":"xhigh","message":{"role":"assistant","model":"<synthetic>","content":[]}}),
        ]
        .map(|v| v.to_string())
        .join("\n"),
    );
    assert_eq!(claude.model.as_deref(), Some("claude-opus-5-5"));
    assert_eq!(claude.effort.as_deref(), Some("xhigh"));
    let codex = parse_transcript(
        &json!({"type":"turn_context","payload":{"model":"gpt-5.4","effort":"medium"}}).to_string(),
    );
    assert_eq!(codex.model.as_deref(), Some("gpt-5.4"));
    assert_eq!(codex.effort.as_deref(), Some("medium"));
}

fn q(operation: &str, content: Option<&str>, reason: Option<&str>) -> String {
    json!({"type":"queue-operation","operation":operation,"content":content,"reason":reason,"timestamp":"t"})
        .to_string()
}

#[test]
fn tracks_what_is_still_waiting_in_the_queue() {
    let st = parse_transcript(
        &[
            q("enqueue", Some("first"), None),
            q("enqueue", Some("second"), None),
            q(
                "enqueue",
                Some("<task-notification>x</task-notification>"),
                None,
            ),
            q("remove", Some("first"), Some("absorbed_mid_turn")),
            q("enqueue", Some("third"), None),
            q("popAll", Some("third"), None),
        ]
        .join("\n"),
    );
    let texts: Vec<_> = st.queue.iter().map(|x| x.text.as_str()).collect();
    assert_eq!(texts, ["second"]);
}

#[test]
fn empty_dequeue_takes_the_oldest_queued_message() {
    let st = parse_transcript(
        &[
            q("enqueue", Some("ok keep going"), None),
            q("dequeue", Some(""), None),
        ]
        .join("\n"),
    );
    assert!(st.queue.is_empty());
    // A dequeue with no content field at all behaves the same.
    let st = parse_transcript(
        &[
            q("enqueue", Some("a"), None),
            json!({"type":"queue-operation","operation":"dequeue"}).to_string(),
        ]
        .join("\n"),
    );
    assert!(st.queue.is_empty());
}

// ---- subagents ----

fn agent_call(id: &str, description: &str) -> String {
    json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":id,"name":"Agent","input":{"description":description,"subagent_type":"Explore","prompt":"p"}}]}}).to_string()
}
fn tool_result(id: &str, text: &str) -> String {
    json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":[{"type":"text","text":text}]}]}}).to_string()
}
fn notification(id: &str, status: &str) -> String {
    json!({"type":"attachment","attachment":{"type":"queued_command","prompt":format!("<task-notification>\n<task-id>x</task-id>\n<tool-use-id>{id}</tool-use-id>\n<status>{status}</status>\n</task-notification>"),"origin":{"kind":"task-notification"}}}).to_string()
}

#[test]
fn agent_calls_become_subagent_messages_and_follow_status() {
    let st = parse_transcript(
        &[
            agent_call("bg", "Security review"),
            tool_result("bg", "Async agent launched successfully."),
            agent_call("fg", "Find files"),
            tool_result("fg", "Found 3 files"),
            agent_call("dead", "Flaky one"),
            tool_result("dead", "Async agent launched successfully."),
            notification("dead", "failed"),
        ]
        .join("\n"),
    );
    let subs: Vec<_> = st
        .messages
        .iter()
        .filter(|m| m.role == MessageRole::Subagent)
        .map(|m| m.text.as_str())
        .collect();
    assert_eq!(subs, ["Security review", "Find files", "Flaky one"]);
    let calls: Vec<_> = st
        .calls
        .values()
        .iter()
        .map(|c| (c.tool_use_id.as_str(), c.status))
        .collect();
    assert_eq!(
        calls,
        [
            ("bg", SubagentStatus::Running),
            ("fg", SubagentStatus::Done),
            ("dead", SubagentStatus::Failed)
        ]
    );
    let later = parse_transcript(
        &[
            agent_call("bg", "Security review"),
            notification("bg", "completed"),
        ]
        .join("\n"),
    );
    assert_eq!(later.calls.get("bg").unwrap().status, SubagentStatus::Done);
    // the notification itself is not shown as a chat message
    assert_eq!(later.messages.len(), 1);
}

#[test]
fn maps_tool_calls_to_subagent_transcripts_and_reads_sidechain_records() {
    let root = tempfile::tempdir().unwrap();
    let main = root.path().join("sess.jsonl");
    std::fs::write(&main, agent_call("t1", "Review") + "\n").unwrap();
    let dir = root.path().join("sess").join("subagents");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("agent-abc123.meta.json"),
        json!({"toolUseId":"t1","agentType":"Explore"}).to_string(),
    )
    .unwrap();
    // junk the scan must ignore
    std::fs::write(dir.join("agent-bad.meta.json"), "{half").unwrap();
    std::fs::write(dir.join("agent-x y.meta.json"), "{\"toolUseId\":\"z\"}").unwrap();
    let lines = [
        json!({"type":"user","isSidechain":true,"message":{"role":"user","content":"Review the bridge"}}),
        json!({"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"Found 2 issues"}]}}),
        json!({"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"tool_use","id":"h","name":"SubagentHandback","input":{"message":"## Report"}}]}}),
    ]
    .map(|v| v.to_string())
    .join("\n")
        + "\n";
    std::fs::write(dir.join("agent-abc123.jsonl"), lines).unwrap();

    let t = read(&main);
    let ids = subagent_ids(&main);
    assert_eq!(ids.len(), 1);
    let infos = subagent_infos(&t.calls, &ids);
    let v = serde_json::to_value(&infos).unwrap();
    assert_eq!(
        v,
        json!([{"toolUseId":"t1","agentId":"abc123","description":"Review","agentType":"Explore","status":"running"}])
    );
    let sub = read_transcript(
        &subagent_file(&main, "abc123").unwrap(),
        ReadOptions { sidechain: true },
    )
    .unwrap();
    let got: Vec<_> = sub
        .messages
        .iter()
        .map(|m| (m.role, m.text.as_str()))
        .collect();
    assert_eq!(
        got,
        [
            (MessageRole::User, "Review the bridge"),
            (MessageRole::Assistant, "Found 2 issues"),
            (MessageRole::Assistant, "## Report"),
        ]
    );
    assert_eq!(subagent_file(&main, "../../etc"), None);
    assert_eq!(subagent_file(&main, ""), None);
    assert_eq!(subagent_file(&main, &"a".repeat(65)), None);
    assert!(subagent_file(&main, &"a".repeat(64)).is_some());
    assert_eq!(subagent_file(&main, "ok\n"), None);
}

#[test]
fn sidechain_records_are_skipped_in_the_main_transcript() {
    let l = json!({"type":"user","isSidechain":true,"message":{"role":"user","content":"x"}});
    assert!(parse_transcript(&l.to_string()).messages.is_empty());
}

// ---- stats ----

#[test]
fn stats_counts_today_in_the_zone_of_now() {
    use chrono::{FixedOffset, TimeZone, Utc};
    let st = parse_transcript(&fixture("claude-session.jsonl"));
    let calls: Vec<_> = st.calls.values().to_vec();
    // fixture messages are 2026-10-03T03:00Z; in UTC+9 that is already 12:00 on the 3rd,
    // in UTC-5 it is the evening of the 2nd.
    let utc = Utc.with_ymd_and_hms(2026, 10, 3, 12, 0, 0).unwrap();
    let s = agent_stats(&st.messages, &calls, &utc);
    assert_eq!((s.instructions, s.instructions_today), (3, 3));
    assert_eq!((s.tool_calls, s.tool_calls_today), (1, 1));
    assert_eq!(s.hired_at.as_deref(), Some("2026-10-03T03:00:00.000Z"));
    let west = FixedOffset::west_opt(5 * 3600).unwrap();
    let now = west.with_ymd_and_hms(2026, 10, 3, 12, 0, 0).unwrap();
    let s = agent_stats(&st.messages, &calls, &now);
    assert_eq!((s.instructions_today, s.tool_calls_today), (0, 0));
    assert_eq!(s.instructions, 3);
}

#[test]
fn stats_ignore_bad_timestamps() {
    use chrono::{TimeZone, Utc};
    let mk = |ts: Option<&str>| od_core::model::ConversationMessage {
        role: MessageRole::User,
        text: "x".into(),
        ts: ts.map(str::to_string),
        images: None,
        queued: None,
        tool_use_id: None,
    };
    let msgs = [
        mk(None),
        mk(Some("garbage")),
        mk(Some("2026-10-03T01:00:00Z")),
    ];
    let now = Utc.with_ymd_and_hms(2026, 10, 3, 12, 0, 0).unwrap();
    let s = agent_stats(&msgs, &[], &now);
    assert_eq!((s.instructions, s.instructions_today), (3, 1));
    assert_eq!(s.hired_at.as_deref(), Some("garbage"));
    let _: Value = serde_json::to_value(&s).unwrap();
}
