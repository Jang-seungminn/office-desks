//! Port of bridge/src/backend/types.ts (the parts that are data).

use serde::{Deserialize, Serialize};

pub use crate::model::BackendCapabilities;

/// Error with a stable machine-readable code, as thrown by backends in the TS core.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct BackendError {
    pub code: String,
    pub message: String,
}

impl BackendError {
    /// Code `backend_error`, the TS default.
    pub fn new(message: impl Into<String>) -> Self {
        Self::with_code(message, "backend_error")
    }

    pub fn with_code(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
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
