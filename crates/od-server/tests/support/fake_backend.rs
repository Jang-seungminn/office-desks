//! A minimal `OfficeBackend` whose methods succeed with empty values (Task 3 grows it).

use async_trait::async_trait;
use od_core::backend::{
    BackendCapabilities, BackendError, BackendMessages, BoardUpdate, ConversationHit, HireResult,
    HireSpec, KeyInput, OfficeBackend,
};
use od_core::model::{OfficeAgent, OfficeDesk, OfficeSnapshot, UsageSnapshot};
use serde_json::Value;

pub struct FakeBackend {
    pub capabilities: BackendCapabilities,
    pub messages: BackendMessages,
}

impl Default for FakeBackend {
    fn default() -> Self {
        FakeBackend {
            capabilities: BackendCapabilities {
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
            },
            messages: BackendMessages {
                no_session: "no session".into(),
                hire_disabled: "hire disabled".into(),
            },
        }
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
        Ok(OfficeSnapshot {
            desks: Vec::new(),
            updated_at: 0,
            error: None,
        })
    }
    async fn read_screen(&self, _handle: &str) -> Result<Vec<String>, BackendError> {
        Ok(Vec::new())
    }
    async fn send_prompt(&self, _handle: &str, _text: &str) -> Result<(), BackendError> {
        Ok(())
    }
    async fn retry_prompt(&self, _request_id: &str) -> Result<(), BackendError> {
        Ok(())
    }
    fn blocked_handle(&self, _request_id: &str) -> Option<String> {
        None
    }
    async fn send_keys(&self, _handle: &str, _input: KeyInput) -> Result<(), BackendError> {
        Ok(())
    }
    async fn focus(&self, _handle: &str) -> Result<(), BackendError> {
        Ok(())
    }
    async fn hire(&self, _spec: HireSpec) -> Result<HireResult, BackendError> {
        Ok(HireResult::default())
    }
    async fn set_board(&self, _desk_id: &str, _update: BoardUpdate) -> Result<(), BackendError> {
        Ok(())
    }
    async fn find_session(
        &self,
        _desk: &OfficeDesk,
        _agent: &OfficeAgent,
    ) -> Result<Option<String>, BackendError> {
        Ok(None)
    }
    fn cached_session(&self, _agent_id: &str) -> Option<String> {
        None
    }
    async fn search_conversations(
        &self,
        _query: &str,
    ) -> Result<Vec<ConversationHit>, BackendError> {
        Ok(Vec::new())
    }
    async fn usage(&self) -> Result<Option<UsageSnapshot>, BackendError> {
        Ok(None)
    }
    async fn add_repo(&self, _repo_path: &str) -> Result<(), BackendError> {
        Ok(())
    }
    async fn stop_agent(&self, _agent_id: &str) -> Result<(), BackendError> {
        Ok(())
    }
    async fn remove_worktree(&self, _desk_id: &str) -> Result<(), BackendError> {
        Ok(())
    }
    fn hook(&self, _agent_id: &str, _token: &str, _payload: &Value) -> bool {
        false
    }
    async fn dispose(&self) {}
}
