//! What the core needs from whatever runs the agents (port of bridge/src/backend/*).
//!
//! The server and the poller only ever talk to [`OfficeBackend`]; which implementation runs
//! (native, Orca, demo) is picked at runtime, so the trait is object-safe and used as
//! `Arc<dyn OfficeBackend>`.

pub mod native_backend;
mod types;

use async_trait::async_trait;
use serde_json::Value;

pub use native_backend::{NativeBackend, NativeDeps, PtyLike};
pub use types::*;

use crate::model::{OfficeAgent, OfficeDesk, OfficeSnapshot, UsageSnapshot};

/// Port of the TS `OfficeBackend` interface. Every method of the TS interface is required there,
/// so every method is required here too. `hook`, `cached_session` and `blocked_handle` are sync,
/// as in TS (they never wait on I/O for long).
#[async_trait]
pub trait OfficeBackend: Send + Sync {
    fn name(&self) -> &str;
    fn capabilities(&self) -> &BackendCapabilities;
    /// User-facing text that depends on the backend.
    fn messages(&self) -> &BackendMessages;
    /// Desks and agents as the backend knows them, before git/transcript enrichment.
    async fn snapshot(&self) -> Result<OfficeSnapshot, BackendError>;
    /// The rendered screen, one string per row.
    async fn read_screen(&self, handle: &str) -> Result<Vec<String>, BackendError>;
    /// Type a prompt and submit it. Fails with code `agent_busy` when the agent can't take it now.
    async fn send_prompt(&self, handle: &str, text: &str) -> Result<(), BackendError>;
    /// Re-send a prompt refused as `agent_busy`. Fails with `agent_busy` again if still busy.
    async fn retry_prompt(&self, request_id: &str) -> Result<(), BackendError>;
    /// Terminal of a refused prompt that can still be retried, or None.
    fn blocked_handle(&self, request_id: &str) -> Option<String>;
    async fn send_keys(&self, handle: &str, input: KeyInput) -> Result<(), BackendError>;
    /// Bring a terminal to the front of the host app.
    async fn focus(&self, handle: &str) -> Result<(), BackendError>;
    async fn hire(&self, spec: HireSpec) -> Result<HireResult, BackendError>;
    /// An empty comment clears it.
    async fn set_board(&self, desk_id: &str, update: BoardUpdate) -> Result<(), BackendError>;
    /// Transcript file of the agent's current session, or None. May search.
    async fn find_session(
        &self,
        desk: &OfficeDesk,
        agent: &OfficeAgent,
    ) -> Result<Option<String>, BackendError>;
    /// Last known transcript file for an agent, without searching.
    fn cached_session(&self, agent_id: &str) -> Option<String>;
    async fn search_conversations(&self, query: &str)
        -> Result<Vec<ConversationHit>, BackendError>;
    async fn usage(&self) -> Result<Option<UsageSnapshot>, BackendError>;
    /// Register a local git repo as a project, for `capabilities.repos`.
    async fn add_repo(&self, repo_path: &str) -> Result<(), BackendError>;
    /// Stop a running agent.
    async fn stop_agent(&self, agent_id: &str) -> Result<(), BackendError>;
    /// Remove a worktree; refuses the main checkout, running agents and uncommitted changes.
    /// Keeps the branch.
    async fn remove_worktree(&self, desk_id: &str) -> Result<(), BackendError>;
    /// An agent hook event from a backend-spawned agent; false if unknown or unauthorized.
    fn hook(&self, agent_id: &str, token: &str, payload: &Value) -> bool;
    /// Stop everything the backend started; called once on shutdown.
    async fn dispose(&self);
    /// The native backend behind this one, for the terminal app (TS: `instanceof NativeBackend`).
    fn as_native(&self) -> Option<&NativeBackend> {
        None
    }
}
