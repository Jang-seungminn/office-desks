//! Port of bridge/src/backend/types.ts (the parts that are data).

use serde::{Deserialize, Serialize};

pub use crate::model::BackendCapabilities;

/// The TS `BackendBusyError` message.
pub const BUSY_MESSAGE: &str = "agent can not take a prompt right now";

/// An error from a backend. Merges the three kinds the TS core throws: **busy**
/// ([`BackendError::busy`], TS `BackendBusyError`, code `agent_busy` plus the `request_id` to
/// retry with), **plain** ([`BackendError::plain`], a TS plain `Error` from git, IO or spawns: no
/// code) and **coded** ([`BackendError::new`] / [`BackendError::with_code`], TS `BackendError`).
///
/// The HTTP status depends on the route, not only on the kind; R2 must follow the per-route
/// table in PARITY.md ("Errors to HTTP"), taken from `server.ts`. In short: busy from a prompt
/// send is 409 with the server's own Korean text; `/api/hire` answers every error with 400;
/// `/api/repos` answers a coded error with 400 and `code`; everything else falls to the
/// catch-all: 409 for `terminal_not_writable`, else 502 (with `code` only when there is one).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct BackendError {
    /// None for a plain error.
    pub code: Option<String>,
    pub message: String,
    /// Set for `agent_busy`: the id to retry the refused prompt with.
    pub request_id: Option<String>,
}

impl BackendError {
    /// Code `backend_error`, the TS default.
    pub fn new(message: impl Into<String>) -> Self {
        Self::with_code(message, "backend_error")
    }

    pub fn with_code(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            code: Some(code.into()),
            message: message.into(),
            request_id: None,
        }
    }

    /// A TS plain `Error` (not a `BackendError`): no code.
    pub fn plain(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
            request_id: None,
        }
    }

    /// TS `BackendBusyError`: the agent can't take a prompt now; retry with `request_id`.
    pub fn busy(request_id: impl Into<String>) -> Self {
        Self {
            code: Some("agent_busy".into()),
            message: BUSY_MESSAGE.into(),
            request_id: Some(request_id.into()),
        }
    }

    pub fn is_busy(&self) -> bool {
        self.code.as_deref() == Some("agent_busy")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_carries_the_request_id() {
        let e = BackendError::busy("r1");
        assert!(e.is_busy());
        assert_eq!(e.request_id.as_deref(), Some("r1"));
        assert_eq!(e.code.as_deref(), Some("agent_busy"));
        assert_eq!(e.message, "agent can not take a prompt right now");
    }

    #[test]
    fn plain_has_no_code() {
        let e = BackendError::plain("boom");
        assert_eq!(e.code, None);
        assert_eq!(e.request_id, None);
        assert!(!e.is_busy());
        assert_eq!(e.to_string(), "boom");
        assert!(!BackendError::new("x").is_busy());
    }
}

/// User-facing text that depends on the backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendMessages {
    /// Shown when an agent's conversation can't be found.
    pub no_session: String,
    /// Shown when hiring is not available.
    pub hire_disabled: String,
}

/// A validated request to start work (see `hire::validate_hire`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum HireSpec {
    Agent {
        desk_id: String,
        agent: String,
        prompt: Option<String>,
    },
    Worktree {
        repo_id: String,
        name: String,
        agent: String,
        base_branch: Option<String>,
        prompt: Option<String>,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HireResult {
    /// Set when the agent started but its first prompt could not be delivered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Raw bytes to type, or the terminal's own Enter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyInput {
    Bytes(String),
    Enter,
}

/// One conversation search hit (Orca's `orca session search`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationHit {
    pub agent: String,
    pub title: String,
    pub cwd: String,
    pub updated_at: Option<String>,
    /// Matched text with [[highlights]].
    pub snippet: String,
    pub role: Option<String>,
    pub file_path: Option<String>,
    pub resume_command: Option<String>,
}

/// Board fields to change (`setBoard`); `None` leaves a field as is, an empty comment clears it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}
