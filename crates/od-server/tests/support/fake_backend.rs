//! A scriptable `OfficeBackend` for the api tests.
//!
//! - `capabilities` and `messages` are plain fields: set them before wrapping in an `Arc`.
//! - Everything else is behind a `Mutex` and can change while the server runs.
//! - `errors` scripts a failure per method name (checked first in each method).
//! - `calls` logs every call as `"<method> <args…>"` (space separated, args as given).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use od_core::backend::{
    BackendCapabilities, BackendError, BackendMessages, BoardUpdate, ConversationHit, HireResult,
    HireSpec, KeyInput, OfficeBackend,
};
use od_core::model::{OfficeAgent, OfficeDesk, OfficeSnapshot, UsageSnapshot};
use serde_json::{json, Value};
use tokio::sync::Notify;

pub struct FakeBackend {
    pub capabilities: BackendCapabilities,
    pub messages: BackendMessages,
    /// What `snapshot` returns (or fails with).
    pub snapshot: Mutex<Result<OfficeSnapshot, BackendError>>,
    /// What `read_screen` returns.
    pub screen: Mutex<Vec<String>>,
    pub usage: Mutex<Option<UsageSnapshot>>,
    /// What `search_conversations` returns.
    pub search: Mutex<Vec<ConversationHit>>,
    /// What `find_session` and `cached_session` return.
    pub session: Mutex<Option<String>>,
    /// When set, `read_screen` waits for one `notify_one` on it before answering.
    pub pending_keys: Mutex<Option<Arc<Notify>>>,
    /// A scripted error per method name, e.g. `"send_prompt"`.
    pub errors: Mutex<HashMap<&'static str, BackendError>>,
    /// `blocked_handle`: request id → terminal handle.
    pub blocked: Mutex<HashMap<String, String>>,
    pub calls: Mutex<Vec<String>>,
    /// What `hook` returns.
    pub hook: Mutex<bool>,
    /// The `warning` `hire` answers with.
    pub hire_warning: Mutex<Option<String>>,
    /// Each successful `send_keys` moves the next of these into `screen` (a terminal reacting).
    pub screens_after_keys: Mutex<VecDeque<Vec<String>>>,
    /// A gate per method name (`send_prompt`, `hire`): the method logs its call, waits for one
    /// `notify_one`, then logs `"<method>_done <first arg>"` (the native paste's Enter).
    pub gates: Mutex<HashMap<&'static str, Arc<Notify>>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn no_capabilities() -> BackendCapabilities {
    BackendCapabilities {
        usage: false,
        search: false,
        board: false,
        hire: false,
        changes: false,
        transcripts: false,
        focus: false,
        repos: false,
        stop: false,
        remove: false,
    }
}

pub fn empty_snapshot() -> OfficeSnapshot {
    OfficeSnapshot {
        desks: Vec::new(),
        updated_at: 0,
        error: None,
    }
}

/// A Claude agent with a terminal handle.
pub fn agent(id: &str, handle: Option<&str>) -> OfficeAgent {
    serde_json::from_value(json!({
        "id": id, "terminalHandle": handle, "agentType": "claude", "terminalTitle": null,
        "subagentsRunning": 0, "model": null, "effort": null, "stats": null, "state": "done",
        "rawState": "", "activity": "", "prompt": null, "lastMessage": null, "since": null
    }))
    .expect("agent")
}

/// A main desk at `path` with these agents.
pub fn desk(id: &str, path: &str, agents: Vec<OfficeAgent>) -> OfficeDesk {
    serde_json::from_value(json!({
        "id": id, "repoId": "repo1", "isMain": true, "parentId": null, "name": id,
        "repo": "repo", "branch": "main", "path": path, "status": "", "workspaceStatus": null,
        "comment": "", "preview": "", "isActive": false, "unread": false,
        "lastActivityAt": null, "changes": null, "pr": null, "agents": agents
    }))
    .expect("desk")
}

pub fn office(desks: Vec<OfficeDesk>) -> OfficeSnapshot {
    OfficeSnapshot {
        desks,
        updated_at: 1,
        error: None,
    }
}

impl Default for FakeBackend {
    fn default() -> Self {
        FakeBackend {
            capabilities: no_capabilities(),
            messages: BackendMessages {
                no_session: "no session".into(),
                hire_disabled: "hire disabled".into(),
            },
            snapshot: Mutex::new(Ok(empty_snapshot())),
            screen: Mutex::new(Vec::new()),
            usage: Mutex::new(None),
            search: Mutex::new(Vec::new()),
            session: Mutex::new(None),
            pending_keys: Mutex::new(None),
            errors: Mutex::new(HashMap::new()),
            blocked: Mutex::new(HashMap::new()),
            calls: Mutex::new(Vec::new()),
            hook: Mutex::new(false),
            hire_warning: Mutex::new(None),
            screens_after_keys: Mutex::new(VecDeque::new()),
            gates: Mutex::new(HashMap::new()),
        }
    }
}

impl FakeBackend {
    /// Log the call, then fail if an error is scripted for this method.
    fn call(&self, method: &'static str, args: &[&str]) -> Result<(), BackendError> {
        let mut line = method.to_string();
        for a in args {
            line.push(' ');
            line.push_str(a);
        }
        lock(&self.calls).push(line);
        match lock(&self.errors).get(method) {
            Some(e) => Err(e.clone()),
            None => Ok(()),
        }
    }

    /// The logged calls of one method.
    pub fn calls_of(&self, method: &str) -> Vec<String> {
        lock(&self.calls)
            .iter()
            .filter(|c| c.split(' ').next() == Some(method))
            .cloned()
            .collect()
    }

    /// Wait on the gate of `method`, if one is set, then log `"<method>_done <arg>"`.
    async fn gate(&self, method: &'static str, arg: &str) {
        let gate = lock(&self.gates).get(method).cloned();
        if let Some(g) = gate {
            g.notified().await;
            lock(&self.calls).push(format!("{method}_done {arg}"));
        }
    }

    pub fn set_snapshot(&self, s: Result<OfficeSnapshot, BackendError>) {
        *lock(&self.snapshot) = s;
    }

    pub fn set_usage(&self, u: Option<UsageSnapshot>) {
        *lock(&self.usage) = u;
    }

    pub fn set_session(&self, file: Option<String>) {
        *lock(&self.session) = file;
    }
}

#[async_trait]
impl OfficeBackend for FakeBackend {
    fn name(&self) -> &str {
        "fake"
    }
    fn capabilities(&self) -> &BackendCapabilities {
        &self.capabilities
    }
    fn messages(&self) -> &BackendMessages {
        &self.messages
    }
    async fn snapshot(&self) -> Result<OfficeSnapshot, BackendError> {
        self.call("snapshot", &[])?;
        lock(&self.snapshot).clone()
    }
    async fn read_screen(&self, handle: &str) -> Result<Vec<String>, BackendError> {
        self.call("read_screen", &[handle])?;
        let pending = lock(&self.pending_keys).clone();
        if let Some(n) = pending {
            n.notified().await;
        }
        Ok(lock(&self.screen).clone())
    }
    async fn send_prompt(&self, handle: &str, text: &str) -> Result<(), BackendError> {
        self.call("send_prompt", &[handle, text])?;
        self.gate("send_prompt", handle).await;
        Ok(())
    }
    async fn retry_prompt(&self, request_id: &str) -> Result<(), BackendError> {
        self.call("retry_prompt", &[request_id])
    }
    fn blocked_handle(&self, request_id: &str) -> Option<String> {
        lock(&self.calls).push(format!("blocked_handle {request_id}"));
        lock(&self.blocked).get(request_id).cloned()
    }
    async fn send_keys(&self, handle: &str, input: KeyInput) -> Result<(), BackendError> {
        let input = match &input {
            KeyInput::Enter => "<enter>".to_string(),
            KeyInput::Bytes(b) => format!("{b:?}"),
        };
        self.call("send_keys", &[handle, &input])?;
        if let Some(next) = lock(&self.screens_after_keys).pop_front() {
            *lock(&self.screen) = next;
        }
        Ok(())
    }
    async fn focus(&self, handle: &str) -> Result<(), BackendError> {
        self.call("focus", &[handle])
    }
    async fn hire(&self, spec: HireSpec) -> Result<HireResult, BackendError> {
        let spec = serde_json::to_string(&spec).expect("spec");
        self.call("hire", &[&spec])?;
        self.gate("hire", "").await;
        Ok(HireResult {
            warning: lock(&self.hire_warning).clone(),
        })
    }
    async fn set_board(&self, desk_id: &str, update: BoardUpdate) -> Result<(), BackendError> {
        let update = serde_json::to_string(&update).expect("update");
        self.call("set_board", &[desk_id, &update])
    }
    async fn find_session(
        &self,
        _desk: &OfficeDesk,
        agent: &OfficeAgent,
    ) -> Result<Option<String>, BackendError> {
        self.call("find_session", &[&agent.id])?;
        Ok(lock(&self.session).clone())
    }
    fn cached_session(&self, agent_id: &str) -> Option<String> {
        lock(&self.calls).push(format!("cached_session {agent_id}"));
        lock(&self.session).clone()
    }
    async fn search_conversations(
        &self,
        query: &str,
    ) -> Result<Vec<ConversationHit>, BackendError> {
        self.call("search_conversations", &[query])?;
        Ok(lock(&self.search).clone())
    }
    async fn usage(&self) -> Result<Option<UsageSnapshot>, BackendError> {
        self.call("usage", &[])?;
        Ok(lock(&self.usage).clone())
    }
    async fn add_repo(&self, repo_path: &str) -> Result<(), BackendError> {
        self.call("add_repo", &[repo_path])
    }
    async fn stop_agent(&self, agent_id: &str) -> Result<(), BackendError> {
        self.call("stop_agent", &[agent_id])
    }
    async fn remove_worktree(&self, desk_id: &str) -> Result<(), BackendError> {
        self.call("remove_worktree", &[desk_id])
    }
    fn hook(&self, agent_id: &str, token: &str, payload: &Value) -> bool {
        lock(&self.calls).push(format!("hook {agent_id} {token} {payload}"));
        *lock(&self.hook)
    }
    async fn dispose(&self) {
        lock(&self.calls).push("dispose".to_string());
    }
}
