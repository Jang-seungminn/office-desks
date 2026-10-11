//! Parse agent session transcripts (Claude Code and Codex JSONL) into a flat chat log.
//! Port of `bridge/src/transcript.ts`. Only conversation turns and one-line tool summaries
//! are kept: thinking, meta entries, tool output and harness wrappers are dropped.
//!
//! Files are append-only, so after the first read only the new bytes are parsed and the whole
//! history is kept. The cache is keyed by path exactly like the TS (`Map<filePath, state>`):
//! TS has no inode/dev check, a reset happens only when `size < offset` (truncation or a
//! shorter replacement). That is portable as is (no platform file identity needed) and is
//! what this port does; a rotated file that is at least as large as the old offset is not
//! detected, in TS and here alike.

use crate::jsstr;
use crate::jsval;
use crate::model::{
    AskedQuestion, ConversationMessage, MessageRole, PendingMessage, QuestionOption, QuestionState,
    QuestionStatus, SubagentStatus,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

const TOOL_SUMMARY: usize = 140;
/// Parsed transcripts kept in memory (they hold base64 images); least recently read is dropped.
const MAX_FILES: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptImage {
    pub media_type: String,
    /// base64, stored exactly as written in the transcript.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentCall {
    pub tool_use_id: String,
    pub description: String,
    pub agent_type: String,
    pub status: SubagentStatus,
}

/// Insertion-ordered map where re-inserting a key replaces in place (JS `Map.set`).
#[derive(Debug, Clone)]
pub struct Ordered<T> {
    items: Vec<T>,
    index: HashMap<String, usize>,
}

impl<T> Default for Ordered<T> {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            index: HashMap::new(),
        }
    }
}

impl<T> Ordered<T> {
    fn insert(&mut self, key: String, v: T) {
        match self.index.get(&key) {
            Some(&i) => self.items[i] = v,
            None => {
                self.index.insert(key, self.items.len());
                self.items.push(v);
            }
        }
    }
    pub fn get(&self, key: &str) -> Option<&T> {
        self.index.get(key).map(|&i| &self.items[i])
    }
    fn get_mut(&mut self, key: &str) -> Option<&mut T> {
        let i = *self.index.get(key)?;
        Some(&mut self.items[i])
    }
    pub fn values(&self) -> &[T] {
        &self.items
    }
}

#[derive(Debug, Clone)]
pub struct ParseState {
    pub title: Option<String>,
    /// `Arc` so a poll hands out the history without deep-copying it (copy-on-write on append).
    pub messages: Arc<Vec<ConversationMessage>>,
    pub images: Arc<Vec<TranscriptImage>>,
    /// Subagent transcripts are all `isSidechain`; the main one skips sidechain records.
    pub sidechain: bool,
    pub calls: Ordered<SubagentCall>,
    pub asks: Ordered<QuestionState>,
    /// Claude Code's queue of messages typed while it works.
    pub queue: Vec<PendingMessage>,
    pub claude_version: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    queued: HashSet<String>,
}

impl ParseState {
    fn push_msg(&mut self, m: ConversationMessage) {
        Arc::make_mut(&mut self.messages).push(m);
    }
    fn images_mut(&mut self) -> &mut Vec<TranscriptImage> {
        Arc::make_mut(&mut self.images)
    }
    fn new(sidechain: bool) -> Self {
        Self {
            title: None,
            messages: Arc::default(),
            images: Arc::default(),
            sidechain,
            calls: Ordered::default(),
            asks: Ordered::default(),
            queue: Vec::new(),
            claude_version: None,
            model: None,
            effort: None,
            queued: HashSet::new(),
        }
    }
}

/// `JSON.parse` accepts lone surrogate escapes (`"\ud83d"`) that serde_json rejects, and Node
/// writes them. On failure retry with each lone surrogate escape replaced by U+FFFD.
fn parse_json(text: &str) -> Option<Value> {
    match serde_json::from_str::<Value>(text) {
        Ok(v) => Some(v),
        Err(_) if text.to_ascii_lowercase().contains("\\ud") => {
            serde_json::from_str(&sanitize_surrogates(text)).ok()
        }
        Err(_) => None,
    }
}

fn hex4(b: &[u8]) -> Option<u32> {
    if b.len() < 4 || !b[..4].iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    u32::from_str_radix(std::str::from_utf8(&b[..4]).ok()?, 16).ok()
}

fn sanitize_surrogates(text: &str) -> String {
    let b = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'\\' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        // An escape: `\\x` is consumed as a unit so `\\\\ud83d` stays literal text.
        if b.get(i + 1) == Some(&b'u') {
            if let Some(c) = hex4(&b[i + 2..]) {
                let pair_next = b.get(i + 6) == Some(&b'\\')
                    && b.get(i + 7) == Some(&b'u')
                    && hex4(&b[(i + 8).min(b.len())..])
                        .is_some_and(|n| (0xDC00..=0xDFFF).contains(&n));
                if (0xD800..=0xDBFF).contains(&c) && pair_next {
                    out.extend_from_slice(&b[i..i + 12]);
                    i += 12;
                } else if (0xD800..=0xDFFF).contains(&c) {
                    out.extend_from_slice("\u{FFFD}".as_bytes());
                    i += 6;
                } else {
                    out.extend_from_slice(&b[i..i + 6]);
                    i += 6;
                }
                continue;
            }
        }
        out.push(b'\\');
        if let Some(n) = b.get(i + 1) {
            out.push(*n);
        }
        i += 2;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

// ---- JS value semantics -------------------------------------------------------------------

fn nn(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

fn truthy(v: Option<&Value>) -> bool {
    v.is_some_and(jsval::truthy)
}

/// JS `String(v)` for a defined value.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(a) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(v)` including `undefined`.
fn js_string_opt(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js_string)
}

/// `String(v ?? '')`
fn str_or_empty(v: Option<&Value>) -> String {
    nn(v).map(js_string).unwrap_or_default()
}

fn as_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// `a?.b?.c` style lookups: missing, null and non-objects all give None.
fn at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for k in path {
        cur = cur.get(*k)?;
    }
    Some(cur)
}

fn one_line(s: &str) -> String {
    jsstr::one_line(s, TOOL_SUMMARY)
}

/// Harness-injected user text that is not something the human typed.
fn is_wrapper(text: &str) -> bool {
    let t = jsstr::trim_start(text);
    [
        "<command-",
        "<local-command",
        "<system-reminder>",
        "<environment_context>",
        "<user_instructions>",
        "<permissions instructions>",
        "[Image: original",
        "<task-notification>",
    ]
    .iter()
    .any(|p| t.starts_with(p))
}

fn tool_summary(name: &str, input: Option<&Value>) -> String {
    let parsed: Value;
    let args: Option<&Value> = match input {
        Some(Value::String(s)) => match parse_json(s) {
            Some(v) => {
                parsed = v;
                Some(&parsed)
            }
            None => return one_line(&format!("{name}: {s}")),
        },
        Some(v @ Value::Object(_)) | Some(v @ Value::Array(_)) => Some(v),
        _ => None,
    };
    const KEYS: [&str; 10] = [
        "command",
        "cmd",
        "file_path",
        "path",
        "pattern",
        "query",
        "url",
        "description",
        "skill",
        "prompt",
    ];
    // `a ?? b ?? ... ?? prompt`: the first non-nullish value, else whatever `prompt` is.
    let main: Option<&Value> = args.and_then(|a| {
        KEYS.iter()
            .find_map(|k| nn(a.get(*k)))
            .or_else(|| a.get("prompt"))
    });
    match main {
        Some(Value::Array(a)) => one_line(&format!(
            "{name}: {}",
            a.iter()
                .map(|x| if x.is_null() {
                    String::new()
                } else {
                    js_string(x)
                })
                .collect::<Vec<_>>()
                .join(" ")
        )),
        Some(v) => one_line(&format!("{name}: {}", js_string(v))),
        None => one_line(name),
    }
}

// ---- Claude Code ---------------------------------------------------------------------------

fn msg(role: MessageRole, text: String, ts: Option<String>) -> ConversationMessage {
    ConversationMessage {
        role,
        text,
        ts,
        images: None,
        queued: None,
        tool_use_id: None,
    }
}

/// Text + base64 images from a Claude user content array.
fn user_content(blocks: &[Value], st: &mut ParseState) -> (String, Vec<i64>) {
    let mut parts: Vec<&str> = Vec::new();
    let mut images = Vec::new();
    for b in blocks {
        let ty = as_str(b.get("type"));
        if ty == Some("text") {
            if let Some(t) = as_str(b.get("text")) {
                if !is_wrapper(t) {
                    parts.push(t);
                }
            }
        }
        if ty == Some("image") && as_str(at(b, &["source", "type"])) == Some("base64") {
            if let Some(data) = as_str(at(b, &["source", "data"])) {
                st.images_mut().push(TranscriptImage {
                    media_type: match nn(at(b, &["source", "media_type"])) {
                        Some(v) => js_string(v),
                        None => "image/png".into(),
                    },
                    data: data.to_string(),
                });
                images.push(st.images.len() as i64 - 1);
            }
        }
    }
    (jsstr::trim(&parts.join("\n\n")).to_string(), images)
}

fn asked_questions(input: Option<&Value>) -> Vec<AskedQuestion> {
    let qs = input
        .and_then(|i| i.get("questions"))
        .and_then(Value::as_array);
    qs.map(|qs| {
        qs.iter()
            .map(|q| AskedQuestion {
                header: str_or_empty(q.get("header")),
                question: str_or_empty(q.get("question")),
                multi_select: truthy(q.get("multiSelect")),
                options: q
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|os| {
                        os.iter()
                            .map(|o| QuestionOption {
                                label: str_or_empty(o.get("label")),
                                description: str_or_empty(o.get("description")),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
            .collect()
    })
    .unwrap_or_default()
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let len = text[start..].find('<')?;
    let inner = &text[start..start + len];
    // `[^<]+` must be followed directly by the closing tag and be non-empty.
    (text[start + len..].starts_with(close) && !inner.is_empty()).then_some(inner)
}

/// `<task-notification>…<tool-use-id>X</tool-use-id>…<status>completed</status>` finishes call X.
fn apply_task_notification(text: &str, st: &mut ParseState) {
    let id = first_tag(text, "tool-use-id");
    let status = first_tag(text, "status");
    let (Some(id), Some(status)) = (id, status) else {
        return;
    };
    let Some(call) = st.calls.get_mut(jsstr::trim(id)) else {
        return;
    };
    let s = status.to_ascii_lowercase();
    if ["complete", "success", "done"]
        .iter()
        .any(|k| s.contains(k))
    {
        call.status = SubagentStatus::Done;
    } else if ["fail", "kill", "error", "cancel"]
        .iter()
        .any(|k| s.contains(k))
    {
        call.status = SubagentStatus::Failed;
    }
}

/// First match of `<tag>([^<]+)</tag>` (regex semantics: later occurrences are tried if an
/// earlier opening tag does not fit the pattern).
fn first_tag<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut from = 0;
    while let Some(p) = text[from..].find(&open) {
        let at = from + p;
        if let Some(inner) = between(&text[at..], &open, &close) {
            return Some(inner);
        }
        from = at + 1;
    }
    None
}

fn apply_queue_operation(r: &Value, st: &mut ParseState) {
    let text = as_str(r.get("content")).unwrap_or("");
    let ts = as_str(r.get("timestamp")).map(str::to_string);
    match as_str(r.get("operation")) {
        Some("enqueue") => {
            if !text.is_empty() && !text.contains("<task-notification>") {
                st.queue.push(PendingMessage {
                    text: text.to_string(),
                    ts,
                });
            }
        }
        Some("remove") | Some("dequeue") => {
            // dequeue (message picked up while idle) carries no content: it takes the oldest entry.
            let i = if text.is_empty() {
                Some(0)
            } else {
                st.queue.iter().position(|q| q.text == text)
            };
            if let Some(i) = i.filter(|i| *i < st.queue.len()) {
                st.queue.remove(i);
            }
        }
        Some("popAll") | Some("clear") => {
            // popAll moves queued messages back into the input box; they're no longer queued.
            if let Some(i) = st.queue.iter().position(|q| q.text == text) {
                st.queue.remove(i);
            } else if text.is_empty() {
                st.queue.clear();
            }
        }
        _ => {}
    }
}

fn blocks_of(content: Option<&Value>) -> Vec<Value> {
    match content {
        Some(Value::String(s)) => vec![json!({ "type": "text", "text": s })],
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    }
}

fn add_claude(r: &Value, st: &mut ParseState) {
    let ty = as_str(r.get("type"));
    if ty == Some("queue-operation") {
        return apply_queue_operation(r, st);
    }
    if ty == Some("ai-title") {
        if let Some(t) = as_str(r.get("aiTitle")) {
            st.title = Some(t.to_string());
        }
    }
    if ty == Some("summary") {
        if let Some(s) = as_str(r.get("summary")) {
            if st.title.is_none() {
                st.title = Some(s.to_string());
            }
        }
    }
    // Messages typed while the agent was busy are stored as queued_command attachments.
    let q = if ty == Some("attachment") {
        r.get("attachment")
    } else {
        None
    };
    let is_queued_cmd = q.is_some_and(|q| as_str(q.get("type")) == Some("queued_command"));
    if let Some(q) = q.filter(|_| is_queued_cmd) {
        let prompt = q.get("prompt");
        if let Some(p) = as_str(prompt).filter(|p| p.contains("<task-notification>")) {
            apply_task_notification(p, st);
            return;
        }
        if as_str(at(q, &["origin", "kind"])) == Some("human") || truthy(q.get("humanTurn")) {
            let id = ["source_uuid", "delivery_id"]
                .iter()
                .find_map(|k| nn(q.get(*k)))
                .or_else(|| nn(r.get("uuid")))
                .map(js_string)
                .unwrap_or_default();
            if !id.is_empty() && st.queued.contains(&id) {
                return;
            }
            if !id.is_empty() {
                st.queued.insert(id);
            }
            let blocks = match prompt {
                Some(Value::String(s)) => vec![json!({ "type": "text", "text": s })],
                Some(Value::Array(a)) => a.clone(),
                _ => Vec::new(),
            };
            let (text, images) = user_content(&blocks, st);
            let ts = as_str(r.get("timestamp")).map(str::to_string);
            if !text.is_empty() || !images.is_empty() {
                let mut m = msg(MessageRole::User, text, ts);
                m.queued = Some(true);
                if !images.is_empty() {
                    m.images = Some(images);
                }
                st.push_msg(m);
            }
            return;
        }
    }
    if (ty != Some("user") && ty != Some("assistant"))
        || truthy(r.get("isMeta"))
        || (truthy(r.get("isSidechain")) && !st.sidechain)
    {
        return;
    }
    if let Some(v) = as_str(r.get("version")) {
        st.claude_version = Some(v.to_string());
    }
    if ty == Some("assistant") {
        if let Some(m) = as_str(at(r, &["message", "model"])) {
            if !m.starts_with('<') {
                st.model = Some(m.to_string());
            }
        }
        if let Some(e) = ["effort", "perTurnEffort"]
            .iter()
            .find_map(|k| nn(r.get(*k)))
            .and_then(Value::as_str)
        {
            st.effort = Some(e.to_string());
        }
    }
    let ts = as_str(r.get("timestamp")).map(str::to_string);
    let blocks = blocks_of(at(r, &["message", "content"]));

    if ty == Some("user") {
        for b in &blocks {
            let bty = as_str(b.get("type"));
            if bty == Some("tool_result") {
                let id = js_string_opt(b.get("tool_use_id"));
                if let Some(ask) = st.asks.get_mut(&id) {
                    let answers = at(r, &["toolUseResult", "answers"]);
                    let entries: Option<Vec<(String, String)>> = match answers {
                        Some(Value::Object(o)) => {
                            Some(o.iter().map(|(k, v)| (k.clone(), js_string(v))).collect())
                        }
                        Some(Value::Array(a)) => Some(
                            a.iter()
                                .enumerate()
                                .map(|(i, v)| (i.to_string(), js_string(v)))
                                .collect(),
                        ),
                        _ => None,
                    };
                    match entries {
                        Some(e) if !truthy(b.get("is_error")) => {
                            ask.status = QuestionStatus::Answered;
                            ask.answers = e.into_iter().collect();
                        }
                        _ => ask.status = QuestionStatus::Cancelled,
                    }
                }
            }
            if bty == Some("text") {
                if let Some(t) = as_str(b.get("text")).filter(|t| t.contains("<task-notification>"))
                {
                    apply_task_notification(t, st);
                }
            }
            if bty != Some("tool_result") {
                continue;
            }
            let id = js_string_opt(b.get("tool_use_id"));
            let Some(call) = st.calls.get_mut(&id) else {
                continue;
            };
            let out = match b.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(c) => serde_json::to_string(c).unwrap_or_default(),
                None => "\"\"".into(),
            };
            // Background launches answer immediately; the real end comes as a notification.
            if !out.to_ascii_lowercase().contains("async agent launched") {
                call.status = if truthy(b.get("is_error")) {
                    SubagentStatus::Failed
                } else {
                    SubagentStatus::Done
                };
            }
        }
        if blocks
            .iter()
            .any(|b| as_str(b.get("type")) == Some("tool_result"))
        {
            return;
        }
        let (text, images) = user_content(&blocks, st);
        if !text.is_empty() || !images.is_empty() {
            let mut m = msg(MessageRole::User, text, ts);
            if !images.is_empty() {
                m.images = Some(images);
            }
            st.push_msg(m);
        }
        return;
    }

    for b in &blocks {
        let bty = as_str(b.get("type"));
        let name = as_str(b.get("name"));
        let id = as_str(b.get("id"));
        if bty == Some("text") && as_str(b.get("text")).is_some_and(|t| !jsstr::trim(t).is_empty())
        {
            let text = as_str(b.get("text")).unwrap_or_default().to_string();
            st.push_msg(msg(MessageRole::Assistant, text, ts.clone()));
        } else if bty == Some("tool_use")
            && name == Some("SubagentHandback")
            && as_str(at(b, &["input", "message"])).is_some()
        {
            // A subagent's final report is a tool call, not a text block.
            let text = as_str(at(b, &["input", "message"])).unwrap_or_default();
            st.push_msg(msg(MessageRole::Assistant, text.to_string(), ts.clone()));
        } else if bty == Some("tool_use") && name == Some("AskUserQuestion") && id.is_some() {
            let id = id.unwrap_or_default().to_string();
            let questions = asked_questions(b.get("input"));
            let text = questions
                .iter()
                .map(|q| q.question.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            st.asks.insert(
                id.clone(),
                QuestionState {
                    tool_use_id: id.clone(),
                    questions,
                    status: QuestionStatus::Pending,
                    answers: Default::default(),
                },
            );
            let mut m = msg(MessageRole::Question, text, ts.clone());
            m.tool_use_id = Some(id);
            st.push_msg(m);
        } else if bty == Some("tool_use")
            && matches!(name, Some("Agent") | Some("Task"))
            && id.is_some()
        {
            let id = id.unwrap_or_default().to_string();
            let desc_src = ["description", "prompt"]
                .iter()
                .find_map(|k| nn(at(b, &["input", k])))
                .map(js_string)
                .unwrap_or_else(|| "subagent".into());
            let description = jsstr::one_line(&desc_src, 120);
            st.calls.insert(
                id.clone(),
                SubagentCall {
                    tool_use_id: id.clone(),
                    description: description.clone(),
                    agent_type: nn(at(b, &["input", "subagent_type"]))
                        .map(js_string)
                        .unwrap_or_else(|| "general-purpose".into()),
                    status: SubagentStatus::Running,
                },
            );
            let mut m = msg(MessageRole::Subagent, description, ts.clone());
            m.tool_use_id = Some(id);
            st.push_msg(m);
        } else if bty == Some("tool_use") && name.is_some() {
            st.push_msg(msg(
                MessageRole::Tool,
                tool_summary(name.unwrap_or_default(), b.get("input")),
                ts.clone(),
            ));
        }
    }
}

// ---- Codex ---------------------------------------------------------------------------------

fn add_codex(r: &Value, st: &mut ParseState) {
    let empty = json!({});
    let p = nn(r.get("payload")).unwrap_or(&empty);
    let ty = as_str(r.get("type"));
    let pty = as_str(p.get("type"));
    let ts = as_str(r.get("timestamp")).map(str::to_string);
    if ty == Some("turn_context") {
        if let Some(m) = as_str(p.get("model")) {
            st.model = Some(m.to_string());
        }
        if let Some(e) = as_str(p.get("effort")) {
            st.effort = Some(e.to_string());
        }
        return;
    }
    // event_msg/user_message is the clean human text; response_item user messages carry injected context.
    if ty == Some("event_msg") && pty == Some("user_message") && as_str(p.get("message")).is_some()
    {
        let m = as_str(p.get("message")).unwrap_or_default();
        if !jsstr::trim(m).is_empty() && !is_wrapper(m) {
            st.push_msg(msg(MessageRole::User, m.to_string(), ts));
        }
    } else if ty == Some("response_item")
        && pty == Some("message")
        && as_str(p.get("role")) == Some("assistant")
    {
        let text = p
            .get("content")
            .and_then(Value::as_array)
            .map(|cs| {
                cs.iter()
                    .filter(|c| as_str(c.get("type")) == Some("output_text"))
                    .filter_map(|c| as_str(c.get("text")))
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
            .unwrap_or_default();
        let text = jsstr::trim(&text);
        if !text.is_empty() {
            st.push_msg(msg(MessageRole::Assistant, text.to_string(), ts));
        }
    } else if ty == Some("response_item")
        && matches!(pty, Some("function_call") | Some("custom_tool_call"))
    {
        let name = nn(p.get("name"))
            .map(js_string)
            .unwrap_or_else(|| "tool".into());
        let input = nn(p.get("arguments")).or_else(|| p.get("input"));
        st.push_msg(msg(MessageRole::Tool, tool_summary(&name, input), ts));
    } else if ty == Some("response_item") && pty == Some("web_search_call") {
        let q = str_or_empty(at(p, &["action", "query"]));
        st.push_msg(msg(
            MessageRole::Tool,
            one_line(&format!("web_search: {q}")),
            ts,
        ));
    }
}

fn add_lines(text: &str, st: &mut ParseState) {
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if jsstr::trim(line).is_empty() {
            continue;
        }
        let Some(r) = parse_json(line) else {
            continue;
        };
        // Codex records wrap everything in `payload`; Claude Code records don't.
        if let Some(o) = r.as_object() {
            if o.contains_key("payload") {
                add_codex(&r, st);
            } else {
                add_claude(&r, st);
            }
        }
    }
}

/// Parse a whole transcript text (main conversation: sidechain records are skipped).
pub fn parse_transcript(text: &str) -> ParseState {
    parse_transcript_with(text, false)
}

pub fn parse_transcript_with(text: &str, sidechain: bool) -> ParseState {
    let mut st = ParseState::new(sidechain);
    add_lines(text, &mut st);
    st
}

// ---- incremental reader --------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptResult {
    /// Identifies this file + read generation; changes if the file is replaced or truncated.
    pub file_id: String,
    pub title: Option<String>,
    pub messages: Arc<Vec<ConversationMessage>>,
    pub images: Arc<Vec<TranscriptImage>>,
    pub calls: Vec<SubagentCall>,
    pub questions: Vec<QuestionState>,
    pub pending: Vec<PendingMessage>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub claude_version: Option<String>,
}

#[derive(Default)]
struct FileState {
    st: Option<ParseState>,
    offset: u64,
    carry: Vec<u8>,
    /// 0 until the first read.
    generation: u64,
}

struct CacheEntry {
    /// Last-use stamp for LRU eviction.
    used: u64,
    state: Arc<Mutex<FileState>>,
}

#[derive(Default)]
struct Cache {
    clock: u64,
    files: HashMap<String, CacheEntry>,
}

/// Outer lock: only get/insert/evict. Each file has its own lock, held across stat, read and
/// parse, so concurrent readers of one file never see (or write) stale offsets, and readers
/// of different files do not block each other.
static FILES: Mutex<Option<Cache>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, Default)]
pub struct ReadOptions {
    pub sidechain: bool,
}

fn entry_for(key: &str) -> Arc<Mutex<FileState>> {
    let mut g = crate::util::lock(&FILES);
    let cache = g.get_or_insert_with(Cache::default);
    cache.clock += 1;
    let stamp = cache.clock;
    let arc = {
        let e = cache
            .files
            .entry(key.to_string())
            .or_insert_with(|| CacheEntry {
                used: stamp,
                state: Arc::default(),
            });
        e.used = stamp;
        Arc::clone(&e.state)
    };
    while cache.files.len() > MAX_FILES {
        let oldest = cache
            .files
            .iter()
            .min_by_key(|(_, e)| e.used)
            .map(|(k, _)| k.clone());
        match oldest {
            Some(k) => cache.files.remove(&k),
            None => break,
        };
    }
    arc
}

/// Read a transcript incrementally: the first call parses the whole file, later calls only
/// new bytes. Thread-safe: callers serialize per path; different files proceed in parallel.
pub fn read_transcript(file_path: &Path, opts: ReadOptions) -> std::io::Result<TranscriptResult> {
    let key = file_path.to_string_lossy().into_owned();
    let arc = entry_for(&key);
    let mut fs = crate::util::lock(&arc);
    let size = std::fs::metadata(file_path)?.len();
    if fs.st.is_none() || size < fs.offset {
        let generation = fs.generation + 1;
        *fs = FileState {
            st: Some(ParseState::new(opts.sidechain)),
            offset: 0,
            carry: Vec::new(),
            generation,
        };
    }
    if size > fs.offset {
        let mut f = std::fs::File::open(file_path)?;
        f.seek(SeekFrom::Start(fs.offset))?;
        let mut chunk = Vec::new();
        f.take(size - fs.offset).read_to_end(&mut chunk)?;
        fs.offset += chunk.len() as u64;
        // Only parse complete lines; keep a half-written last line (and split UTF-8).
        let mut buf = std::mem::take(&mut fs.carry);
        buf.extend_from_slice(&chunk);
        match buf.iter().rposition(|b| *b == b'\n') {
            Some(nl) => {
                fs.carry = buf[nl + 1..].to_vec();
                let text = String::from_utf8_lossy(&buf[..nl]);
                add_lines(&text, fs.st.as_mut().expect("set above"));
            }
            None => fs.carry = buf,
        }
    }
    let st = fs.st.as_ref().expect("set above");
    Ok(TranscriptResult {
        file_id: file_id(&key, fs.generation),
        title: st.title.clone(),
        messages: Arc::clone(&st.messages),
        images: Arc::clone(&st.images),
        calls: st.calls.values().to_vec(),
        questions: st.asks.values().to_vec(),
        pending: st.queue.clone(),
        model: st.model.clone(),
        effort: st.effort.clone(),
        claude_version: st.claude_version.clone(),
    })
}

fn file_id(path: &str, generation: u64) -> String {
    let mut h = sha1_smol::Sha1::new();
    h.update(format!("{path}#{generation}").as_bytes());
    h.digest().to_string()[..12].to_string()
}

/// Forget cached parse state (tests).
pub fn reset_transcript_cache() {
    *crate::util::lock(&FILES) = None;
}
