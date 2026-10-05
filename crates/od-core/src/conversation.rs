//! Builders for the `/api/conversation` response (shape of `ConversationResponse`), mirroring
//! `conversation()` in `bridge/src/server.ts`. Lookup of the session file and the Korean
//! reason strings stay with the caller.

use crate::model::{ConversationResponse, ScreenSupport, SubagentInfo};
use crate::screen::screen_support;
use crate::transcript::TranscriptResult;

/// The `empty(reason)` response: nothing found.
pub fn empty_conversation(reason: &str) -> ConversationResponse {
    ConversationResponse {
        found: false,
        reason: Some(reason.to_string()),
        file_id: None,
        title: None,
        total: 0,
        after: 0,
        messages: Vec::new(),
        subagents: Vec::new(),
        questions: Vec::new(),
        pending: Vec::new(),
        claude_version: None,
        screen_support: ScreenSupport::Unknown,
    }
}

/// A found conversation. `main` is the session transcript; `sub` is the subagent's own
/// transcript when one was requested. `after` is out-of-range tolerant like the TS.
pub fn conversation_response(
    main: &TranscriptResult,
    sub: Option<&TranscriptResult>,
    subagents: Vec<SubagentInfo>,
    after: i64,
    agent_type: &str,
) -> ConversationResponse {
    let t = sub.unwrap_or(main);
    let from = if after >= 0 && after as usize <= t.messages.len() {
        after as usize
    } else {
        0
    };
    ConversationResponse {
        found: true,
        reason: None,
        file_id: Some(t.file_id.clone()),
        title: if sub.is_some() { None } else { t.title.clone() },
        total: t.messages.len() as i64,
        after: from as i64,
        messages: t.messages[from..].to_vec(),
        subagents,
        questions: main.questions.clone(),
        pending: if sub.is_some() {
            Vec::new()
        } else {
            main.pending.clone()
        },
        claude_version: main.claude_version.clone(),
        screen_support: screen_support(agent_type, main.claude_version.as_deref()),
    }
}
