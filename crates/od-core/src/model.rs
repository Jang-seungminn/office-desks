//! Office model shared with the web UI (port of bridge/src/model.ts).
//!
//! Wire rules: camelCase fields; `T | null` is `Option<T>` and always serialized (as `null`);
//! TS `field?:` is `Option<T>` that is omitted when `None`.

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;

/// Orca reports some timestamps (ms) as JSON floats; accept them and truncate to whole ms.
/// Serialization is unchanged (an integer).
fn lenient_ms<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Num {
        Int(i64),
        Float(f64),
    }
    Ok(Option::<Num>::deserialize(d)?.map(|n| match n {
        Num::Int(i) => i,
        Num::Float(f) => f as i64,
    }))
}

/// What a character is visibly doing at its desk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CharacterState {
    Typing,
    Reading,
    Running,
    Waiting,
    Done,
    Away,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeAgent {
    /// Orca paneKey (`<tabId>:<leafId>`), stable per terminal pane.
    pub id: String,
    pub terminal_handle: Option<String>,
    pub agent_type: String,
    pub terminal_title: Option<String>,
    pub subagents_running: i64,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub stats: Option<AgentStats>,
    pub state: CharacterState,
    pub raw_state: String,
    pub activity: String,
    pub prompt: Option<String>,
    pub last_message: Option<String>,
    #[serde(default, deserialize_with = "lenient_ms")]
    pub since: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskChanges {
    pub files: i64,
    pub added: i64,
    pub deleted: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskPr {
    pub number: Option<i64>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub state: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeDesk {
    pub id: String,
    pub repo_id: String,
    pub is_main: bool,
    pub parent_id: Option<String>,
    pub name: String,
    pub repo: String,
    pub branch: String,
    pub path: String,
    pub status: String,
    pub workspace_status: Option<String>,
    pub comment: String,
    pub preview: String,
    pub is_active: bool,
    pub unread: bool,
    #[serde(default, deserialize_with = "lenient_ms")]
    pub last_activity_at: Option<i64>,
    pub changes: Option<DeskChanges>,
    pub pr: Option<DeskPr>,
    pub agents: Vec<OfficeAgent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeSnapshot {
    pub desks: Vec<OfficeDesk>,
    pub updated_at: i64,
    pub error: Option<String>,
}

// --- Bridge <-> web protocol ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendCapabilities {
    pub usage: bool,
    pub search: bool,
    pub board: bool,
    pub hire: bool,
    pub changes: bool,
    pub transcripts: bool,
    pub focus: bool,
    pub repos: bool,
    pub stop: bool,
    pub remove: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    pub name: String,
    pub capabilities: BackendCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ServerMessage {
    Backend { backend: BackendInfo },
    Snapshot { snapshot: OfficeSnapshot },
    Usage { usage: UsageSnapshot },
    Org { org: OrgChart },
    Awards { awards: AwardBoard },
}

/// One day's best employee (or today's leader so far).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Award {
    /// Local date, YYYY-MM-DD.
    pub date: String,
    pub agent_id: String,
    pub desk_id: String,
    pub name: String,
    pub repo: String,
    pub repo_id: String,
    pub agent_type: String,
    pub instructions: i64,
    pub tool_calls: i64,
    pub score: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwardBoard {
    pub leader: Option<Award>,
    pub hall: Vec<Award>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStats {
    pub instructions: i64,
    pub instructions_today: i64,
    pub tool_calls: i64,
    pub tool_calls_today: i64,
    pub subagents: i64,
    /// First message of the session (ISO).
    pub hired_at: Option<String>,
}

/// Interior theme of a department.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DepartmentTheme {
    Dev,
    Design,
    Research,
    Ops,
    Etc,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Department {
    pub id: String,
    pub name: String,
    pub theme: DepartmentTheme,
    pub repo_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgChart {
    pub departments: Vec<Department>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub key: String,
    pub label: String,
    pub used_percent: f64,
    #[serde(default, deserialize_with = "lenient_ms")]
    pub resets_at: Option<i64>,
    pub reset_description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProvider {
    pub provider: String,
    pub windows: Vec<UsageWindow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub providers: Vec<UsageProvider>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageUpload {
    pub media_type: String,
    /// Base64 without the data: prefix.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub terminal_handle: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<ImageUpload>>,
    /// Send even if a dialog seems to be open in the agent's terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusRequest {
    pub terminal_handle: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
    Tool,
    Subagent,
    Question,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub role: MessageRole,
    pub text: String,
    pub ts: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentStatus {
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskedQuestion {
    pub header: String,
    pub question: String,
    pub multi_select: bool,
    pub options: Vec<QuestionOption>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionStatus {
    Pending,
    Answered,
    Cancelled,
}

/// An AskUserQuestion call: what was asked, and whether/how it was answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionState {
    pub tool_use_id: String,
    pub questions: Vec<AskedQuestion>,
    pub status: QuestionStatus,
    /// question text to answer text (comma-joined for multi-select), once answered.
    pub answers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerRequest {
    pub agent_id: String,
    pub tool_use_id: String,
    /// Per question, the 0-based indexes of the chosen options.
    pub choices: Vec<Vec<i64>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInfo {
    pub tool_use_id: String,
    pub agent_id: Option<String>,
    pub description: String,
    pub agent_type: String,
    pub status: SubagentStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMessage {
    pub text: String,
    pub ts: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScreenSupport {
    Tested,
    Untested,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationResponse {
    pub found: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub file_id: Option<String>,
    pub title: Option<String>,
    pub total: i64,
    pub after: i64,
    pub messages: Vec<ConversationMessage>,
    pub subagents: Vec<SubagentInfo>,
    pub questions: Vec<QuestionState>,
    pub pending: Vec<PendingMessage>,
    pub claude_version: Option<String>,
    pub screen_support: ScreenSupport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SlashSource {
    Builtin,
    User,
    Project,
    Plugin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    /// Without the leading slash.
    pub name: String,
    pub description: String,
    pub source: SlashSource,
}

/// ready: the input box is on screen; menu: a dialog/prompt has the keyboard; unknown: can't tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComposerState {
    Ready,
    Menu,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalScreen {
    pub found: bool,
    pub lines: Vec<String>,
    pub composer: ComposerState,
}

/// Named keys the panel can press in an agent's terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalKey {
    #[serde(rename = "up")]
    Up,
    #[serde(rename = "down")]
    Down,
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "right")]
    Right,
    #[serde(rename = "enter")]
    Enter,
    #[serde(rename = "esc")]
    Esc,
    #[serde(rename = "tab")]
    Tab,
    #[serde(rename = "shift-tab")]
    ShiftTab,
    #[serde(rename = "space")]
    Space,
    #[serde(rename = "ctrl-c")]
    CtrlC,
    #[serde(rename = "ctrl-u")]
    CtrlU,
    #[serde(rename = "ctrl-enter")]
    CtrlEnter,
    #[serde(rename = "backspace")]
    Backspace,
    #[serde(rename = "1")]
    N1,
    #[serde(rename = "2")]
    N2,
    #[serde(rename = "3")]
    N3,
    #[serde(rename = "4")]
    N4,
    #[serde(rename = "5")]
    N5,
    #[serde(rename = "6")]
    N6,
    #[serde(rename = "7")]
    N7,
    #[serde(rename = "8")]
    N8,
    #[serde(rename = "9")]
    N9,
    #[serde(rename = "y")]
    Y,
    #[serde(rename = "n")]
    N,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum QueueAction {
    #[serde(rename = "send-now")]
    SendNow,
    #[serde(rename = "cancel")]
    Cancel,
}

/// Claude Code's message queue, driven like a person would.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueRequest {
    pub terminal_handle: String,
    pub action: QueueAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyRequest {
    pub terminal_handle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<TerminalKey>,
    /// One printable character (typing into a dialog's search box).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub char: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: ChangeStatus,
    pub added: i64,
    pub deleted: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSummary {
    pub files: Vec<ChangedFile>,
    pub added: i64,
    pub deleted: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffResponse {
    pub file: ChangedFile,
    pub diff: String,
    pub truncated: bool,
}

/// Edit Orca's board status and/or comment for a worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeUpdate {
    pub desk_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_status: Option<String>,
    /// Empty string clears the comment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

fn present_or_absent<'de, D>(d: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(d).map(Some)
}

/// Start new work: a new worktree with an agent, or an agent in an existing worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HireRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    /// `None` = absent; `Some(None)` = explicit JSON `null`. TS checks `deskId !== undefined`,
    /// so null still selects the existing-worktree path (and then matches no desk).
    #[serde(
        default,
        deserialize_with = "present_or_absent",
        skip_serializing_if = "Option::is_none"
    )]
    pub desk_id: Option<Option<String>>,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub title: String,
    pub agent: String,
    pub project: String,
    pub updated_at: Option<String>,
    /// Matched text with [[highlights]], as Orca returns it.
    pub snippet: String,
    pub role: Option<String>,
    pub desk_id: Option<String>,
    pub agent_id: Option<String>,
    pub resume_command: Option<String>,
}
