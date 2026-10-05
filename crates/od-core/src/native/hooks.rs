//! Claude Code reports what it is doing through hooks. We pass them in with `--settings` so the
//! user's own settings stay untouched, relay each event to the bridge, and fold the events into
//! the same raw states Orca reports. Port of `bridge/src/native/hooks.ts`.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::jsstr::slice_utf16;

pub const HOOK_EVENTS: [&str; 6] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Notification",
    "Stop",
];

fn is_tool_event(ev: &str) -> bool {
    ev == "PreToolUse" || ev == "PostToolUse"
}

/// The relay argv for a hook command: our own binary and its `hook-relay` subcommand.
pub fn relay_command(exe: &Path) -> Vec<String> {
    vec![exe.to_string_lossy().into_owned(), "hook-relay".to_string()]
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HookCommand {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HookGroup {
    /// Omitted (not null) for non-tool events, like TS.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    pub hooks: Vec<HookCommand>,
}

/// Event name to groups, serialized in `HOOK_EVENTS` order (like the TS object).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HookMap(pub Vec<(String, Vec<HookGroup>)>);

impl HookMap {
    pub fn get(&self, event: &str) -> Option<&Vec<HookGroup>> {
        self.0.iter().find(|(k, _)| k == event).map(|(_, v)| v)
    }
}

impl Serialize for HookMap {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HookSettings {
    pub hooks: HookMap,
}

/// Quote one argv element for a POSIX shell (Git Bash on Windows). Like the TS: backslashes
/// become forward slashes and the element is wrapped in double quotes. Unlike the TS, characters
/// that stay special inside double quotes (`"`, `$`, backtick) are backslash-escaped.
fn quote(p: &str) -> String {
    let mut out = String::with_capacity(p.len() + 2);
    out.push('"');
    for c in p.chars() {
        match c {
            '\\' => out.push('/'),
            '"' | '$' | '`' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The `--settings` JSON for Claude: every event runs `relay_command` (joined, each element quoted).
pub fn hook_settings(relay_command: &[String]) -> HookSettings {
    let command = relay_command
        .iter()
        .map(|a| quote(a))
        .collect::<Vec<_>>()
        .join(" ");
    let hooks = HOOK_EVENTS
        .iter()
        .map(|ev| {
            let group = HookGroup {
                matcher: is_tool_event(ev).then(|| "*".to_string()),
                hooks: vec![HookCommand {
                    kind: "command",
                    command: command.clone(),
                }],
            };
            (ev.to_string(), vec![group])
        })
        .collect();
    HookSettings {
        hooks: HookMap(hooks),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookState {
    pub raw_state: String,
    pub tool_name: Option<String>,
    pub tool_input: Option<String>,
    pub prompt: Option<String>,
    pub last_message: Option<String>,
    /// Epoch ms, like TS `Date.now()`.
    pub since: i64,
    /// SessionStart arrived: the agent is past any startup dialog and ready for a prompt.
    pub started: bool,
    pub session_id: Option<String>,
    pub transcript_path: Option<String>,
}

pub fn initial_hook_state(now: i64) -> HookState {
    HookState {
        raw_state: "unknown".into(),
        tool_name: None,
        tool_input: None,
        prompt: None,
        last_message: None,
        since: now,
        started: false,
        session_id: None,
        transcript_path: None,
    }
}

/// A non-empty string field, else None.
fn str_field(p: &Value, k: &str) -> Option<String> {
    match p.get(k) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// The one field of a tool call worth showing ("npm test", "src/a.ts", ...).
fn tool_summary(input: Option<&Value>) -> Option<String> {
    let o = input?;
    if !o.is_object() {
        return None;
    }
    for k in [
        "command",
        "file_path",
        "path",
        "pattern",
        "url",
        "query",
        "description",
        "prompt",
    ] {
        if let Some(v) = str_field(o, k) {
            return Some(slice_utf16(&v, 200).to_string());
        }
    }
    None
}

fn is_permission(p: &Value) -> bool {
    if let Some(t) = str_field(p, "notification_type") {
        return t == "permission_prompt";
    }
    static RE: OnceLock<Regex> = OnceLock::new();
    // ASCII-only case folding, like a JS /i regex without the u flag for these letters.
    let re = RE.get_or_init(|| Regex::new(r"(?i-u)permission|approve|needs your").unwrap());
    re.is_match(&str_field(p, "message").unwrap_or_default())
}

/// Fold one hook payload into the state. `now` is epoch ms.
pub fn apply_hook(s: &HookState, p: &Value, now: i64) -> HookState {
    let ev = str_field(p, "hook_event_name");
    let mut base = s.clone();
    base.session_id = str_field(p, "session_id").or_else(|| s.session_id.clone());
    base.transcript_path = str_field(p, "transcript_path").or_else(|| s.transcript_path.clone());
    let to = |raw: &str, f: &dyn Fn(&mut HookState)| -> HookState {
        let mut n = base.clone();
        f(&mut n);
        n.raw_state = raw.to_string();
        n.since = if raw == s.raw_state { s.since } else { now };
        n
    };
    match ev.as_deref() {
        Some("SessionStart") => to("done", &|n| n.started = true),
        Some("UserPromptSubmit") => to("working", &|n| {
            n.prompt = str_field(p, "prompt").or_else(|| s.prompt.clone());
            n.tool_name = None;
            n.tool_input = None;
        }),
        Some("PreToolUse") => to("working", &|n| {
            n.tool_name = str_field(p, "tool_name");
            n.tool_input = tool_summary(p.get("tool_input"));
        }),
        Some("PostToolUse") => to("working", &|n| {
            n.tool_name = None;
            n.tool_input = None;
        }),
        Some("Notification") => {
            if is_permission(p) {
                to("waiting", &|_| {})
            } else {
                to("done", &|_| {})
            }
        }
        Some("Stop") => to("done", &|n| {
            n.last_message =
                str_field(p, "last_assistant_message").or_else(|| s.last_message.clone());
            n.tool_name = None;
            n.tool_input = None;
        }),
        _ => s.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_run_the_relay_for_every_event_matching_all_tools() {
        let s = hook_settings(&[
            r"C:\Program Files\od\office-desks.exe".to_string(),
            "hook-relay".to_string(),
        ]);
        let cmd = r#""C:/Program Files/od/office-desks.exe" "hook-relay""#;
        let keys: Vec<&str> = s.hooks.0.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, HOOK_EVENTS);
        let expect_tool =
            json!([{ "matcher": "*", "hooks": [{ "type": "command", "command": cmd }] }]);
        let expect_plain = json!([{ "hooks": [{ "type": "command", "command": cmd }] }]);
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["hooks"]["PreToolUse"], expect_tool);
        assert_eq!(v["hooks"]["PostToolUse"], expect_tool);
        assert_eq!(v["hooks"]["Stop"], expect_plain);
        assert!(v["hooks"]["Stop"][0].get("matcher").is_none());
    }

    #[test]
    fn settings_json_keeps_event_order_and_shell_quotes() {
        let s = hook_settings(&["/a b/od".into(), "hook-relay".into(), r#"x"$y`z"#.into()]);
        let j = serde_json::to_string(&s).unwrap();
        let order: Vec<usize> = HOOK_EVENTS.iter().map(|e| j.find(e).unwrap()).collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]));
        let v: Value = serde_json::from_str(&j).unwrap();
        assert_eq!(
            v["hooks"]["Stop"][0]["hooks"][0]["command"],
            r#""/a b/od" "hook-relay" "x\"\$y\`z""#
        );
    }

    #[test]
    fn relay_command_is_exe_then_subcommand() {
        assert_eq!(
            relay_command(Path::new("/x/office-desks")),
            vec!["/x/office-desks".to_string(), "hook-relay".to_string()]
        );
    }

    #[test]
    fn follows_a_turn() {
        let t0 = initial_hook_state(1000);
        let mut s = apply_hook(
            &t0,
            &json!({"hook_event_name":"SessionStart","session_id":"sid","transcript_path":"/p/sid.jsonl","source":"startup"}),
            2000,
        );
        assert_eq!(
            (s.raw_state.as_str(), s.started, s.since),
            ("done", true, 2000)
        );
        assert_eq!(s.session_id.as_deref(), Some("sid"));
        assert_eq!(s.transcript_path.as_deref(), Some("/p/sid.jsonl"));
        s = apply_hook(
            &s,
            &json!({"hook_event_name":"UserPromptSubmit","prompt":"fix the bug"}),
            3000,
        );
        assert_eq!((s.raw_state.as_str(), s.since), ("working", 3000));
        assert_eq!(s.prompt.as_deref(), Some("fix the bug"));
        assert_eq!(s.tool_name, None);
        s = apply_hook(
            &s,
            &json!({"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test","description":"run tests"}}),
            4000,
        );
        assert_eq!((s.raw_state.as_str(), s.since), ("working", 3000));
        assert_eq!(s.tool_name.as_deref(), Some("Bash"));
        assert_eq!(s.tool_input.as_deref(), Some("npm test"));
        s = apply_hook(
            &s,
            &json!({"hook_event_name":"PostToolUse","tool_name":"Bash"}),
            5000,
        );
        assert_eq!(s.raw_state, "working");
        assert_eq!(s.tool_name, None);
        s = apply_hook(
            &s,
            &json!({"hook_event_name":"Stop","last_assistant_message":"All green."}),
            6000,
        );
        assert_eq!((s.raw_state.as_str(), s.since), ("done", 6000));
        assert_eq!(s.last_message.as_deref(), Some("All green."));
        assert_eq!(s.session_id.as_deref(), Some("sid"));
    }

    #[test]
    fn permission_notification_waits_idle_reminder_is_done() {
        let t0 = initial_hook_state(1000);
        let working = apply_hook(
            &t0,
            &json!({"hook_event_name":"UserPromptSubmit","prompt":"x"}),
            2000,
        );
        let raw = |p: Value| apply_hook(&working, &p, 3000).raw_state;
        assert_eq!(
            raw(
                json!({"hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"})
            ),
            "waiting"
        );
        assert_eq!(
            raw(
                json!({"hook_event_name":"Notification","message":"Claude needs your permission to use Edit"})
            ),
            "waiting"
        );
        assert_eq!(
            raw(json!({"hook_event_name":"Notification","message":"PLEASE APPROVE"})),
            "waiting"
        );
        assert_eq!(
            raw(
                json!({"hook_event_name":"Notification","notification_type":"idle_prompt","message":"Claude is waiting for your input"})
            ),
            "done"
        );
        assert_eq!(
            raw(
                json!({"hook_event_name":"Notification","message":"Claude is waiting for your input"})
            ),
            "done"
        );
        assert_eq!(raw(json!({"hook_event_name":"Notification"})), "done");
    }

    #[test]
    fn ignores_unknown_events_and_malformed_fields() {
        let t0 = initial_hook_state(1000);
        assert_eq!(
            apply_hook(&t0, &json!({"hook_event_name":"SubagentStop"}), 2000),
            t0
        );
        assert_eq!(apply_hook(&t0, &json!(null), 2000), t0);
        let s = apply_hook(
            &t0,
            &json!({"hook_event_name":"PreToolUse","tool_name":42,"tool_input":"x"}),
            2000,
        );
        assert_eq!((s.tool_name, s.tool_input), (None, None));
    }

    #[test]
    fn unknown_event_keeps_state_even_with_session_fields() {
        let t0 = initial_hook_state(1000);
        let s = apply_hook(
            &t0,
            &json!({"hook_event_name":"Other","session_id":"zzz"}),
            2000,
        );
        assert_eq!(s, t0);
    }

    #[test]
    fn tool_summary_picks_first_field_and_truncates_in_utf16() {
        let t0 = initial_hook_state(1);
        let long = "a".repeat(300);
        let s = apply_hook(
            &t0,
            &json!({"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"command":"","file_path":long,"path":"p"}}),
            2,
        );
        assert_eq!(s.tool_input.unwrap().len(), 200);
        let s = apply_hook(
            &t0,
            &json!({"hook_event_name":"PreToolUse","tool_name":"Grep","tool_input":{"pattern":"x.*"}}),
            2,
        );
        assert_eq!(s.tool_input.as_deref(), Some("x.*"));
        // 150 emoji = 300 UTF-16 units; the cut at 200 units keeps 100 emoji.
        let emoji = "😀".repeat(150);
        let s = apply_hook(
            &t0,
            &json!({"hook_event_name":"PreToolUse","tool_input":{"query":emoji}}),
            2,
        );
        assert_eq!(s.tool_input.unwrap().chars().count(), 100);
    }

    #[test]
    fn empty_strings_do_not_overwrite_and_since_holds_on_same_state() {
        let s0 = apply_hook(
            &initial_hook_state(1),
            &json!({"hook_event_name":"UserPromptSubmit","prompt":"keep","session_id":"s1"}),
            5,
        );
        let s1 = apply_hook(
            &s0,
            &json!({"hook_event_name":"UserPromptSubmit","prompt":"","session_id":""}),
            9,
        );
        assert_eq!(s1.prompt.as_deref(), Some("keep"));
        assert_eq!(s1.session_id.as_deref(), Some("s1"));
        assert_eq!(s1.since, 5);
    }

    #[test]
    fn state_serializes_camel_case_with_nulls() {
        let v = serde_json::to_value(initial_hook_state(7)).unwrap();
        assert_eq!(
            v,
            json!({"rawState":"unknown","toolName":null,"toolInput":null,"prompt":null,"lastMessage":null,"since":7,"started":false,"sessionId":null,"transcriptPath":null})
        );
    }
}
