//! Port of bridge/src/stateMapper.ts: Orca CLI JSON to the office snapshot.
//!
//! The Orca rows are deliberately forgiving: every field is optional and a field of the wrong
//! type reads as absent, so a newer or older Orca degrades instead of failing.

use crate::jsstr::{collapse_ws, slice_utf16, trim};
use crate::model::{CharacterState, DeskPr, OfficeAgent, OfficeDesk, OfficeSnapshot};
use regex::Regex;
use serde::{de::DeserializeOwned, Deserialize, Deserializer};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::OnceLock;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

/// A field of the wrong type (or null) reads as absent.
fn lenient<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    Ok(T::deserialize(Value::deserialize(d)?).ok())
}

/// JS `Boolean(value)` for the flags Orca may send as anything.
fn truthy<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Null => false,
        Value::Bool(b) => b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    })
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaAgentRow {
    #[serde(default, deserialize_with = "lenient")]
    pub pane_key: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub agent_type: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub state: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub tool_name: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub tool_input: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub prompt: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub last_assistant_message: Option<String>,
    /// Ms since epoch; Orca may send a float.
    #[serde(default, deserialize_with = "lenient")]
    pub state_started_at: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaWorktreeRow {
    #[serde(default, deserialize_with = "lenient")]
    pub worktree_id: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub repo_id: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub repo: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub path: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub branch: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub display_name: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub status: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub workspace_status: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub comment: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub preview: Option<String>,
    #[serde(default, deserialize_with = "truthy")]
    pub is_active: bool,
    #[serde(default, deserialize_with = "truthy")]
    pub is_archived: bool,
    #[serde(default, deserialize_with = "truthy")]
    pub unread: bool,
    /// Ms since epoch; Orca may send a float.
    #[serde(default, deserialize_with = "lenient")]
    pub last_activity_at: Option<f64>,
    #[serde(default, rename = "linkedPR")]
    pub linked_pr: Option<Value>,
    #[serde(default, deserialize_with = "truthy")]
    pub is_main_worktree: bool,
    #[serde(default, deserialize_with = "lenient")]
    pub parent_worktree_id: Option<String>,
    #[serde(default, deserialize_with = "lenient_agents")]
    pub agents: Vec<OrcaAgentRow>,
}

fn lenient_agents<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<OrcaAgentRow>, D::Error> {
    Ok(lenient::<_, Vec<OrcaAgentRow>>(d)?.unwrap_or_default())
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaTerminalRow {
    #[serde(default, deserialize_with = "lenient")]
    pub handle: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub tab_id: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub leaf_id: Option<String>,
}

const READ_TOOLS: [&str; 7] = [
    "Read",
    "Grep",
    "Glob",
    "LS",
    "WebFetch",
    "WebSearch",
    "ToolSearch",
];
const RUN_TOOLS: [&str; 3] = ["Bash", "BashOutput", "Monitor"];

/// "✳ Fix login bug" -> "Fix login bug"; drops spinner/status glyphs agents put in front.
pub fn clean_title(title: Option<&str>) -> Option<String> {
    static LEADING: OnceLock<Regex> = OnceLock::new();
    let re = LEADING.get_or_init(|| Regex::new(r"^[^\p{L}\p{N}]+").expect("regex"));
    let t = trim(&re.replace(title.unwrap_or(""), "")).to_string();
    (!t.is_empty()).then_some(t)
}

fn one_line(s: Option<&str>, max: usize) -> String {
    let flat = collapse_ws(s.unwrap_or(""));
    if crate::jsstr::utf16_len(&flat) > max {
        format!("{}…", slice_utf16(&flat, max - 1))
    } else {
        flat
    }
}

fn nonempty(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

pub fn map_agent_state(raw_state: Option<&str>, tool_name: Option<&str>) -> CharacterState {
    match raw_state {
        Some("waiting" | "permission" | "blocked") => CharacterState::Waiting,
        Some("done" | "idle") => CharacterState::Done,
        Some("working") => match tool_name {
            Some(t) if READ_TOOLS.contains(&t) => CharacterState::Reading,
            Some(t) if RUN_TOOLS.contains(&t) => CharacterState::Running,
            _ => CharacterState::Typing,
        },
        _ => CharacterState::Away,
    }
}

fn describe(state: CharacterState, a: &OrcaAgentRow) -> String {
    let tool = a.tool_name.as_deref().unwrap_or("");
    let input = one_line(a.tool_input.as_deref(), 60);
    match state {
        CharacterState::Waiting if !tool.is_empty() => format!("확인 필요: {tool}"),
        CharacterState::Waiting => "확인 필요".into(),
        CharacterState::Done => "완료 · 다음 지시 대기".into(),
        CharacterState::Away => "자리 비움".into(),
        _ if tool.is_empty() => "생각 중…".into(),
        _ if input.is_empty() => tool.into(),
        _ => format!("{tool}: {input}"),
    }
}

fn strip_heads(branch: &str) -> &str {
    branch.strip_prefix("refs/heads/").unwrap_or(branch)
}

/// Orca defaults displayName to the branch; a repo name is more telling than "main" twice.
pub fn orca_desk_name(w: &OrcaWorktreeRow) -> String {
    let branch = strip_heads(w.branch.as_deref().unwrap_or(""));
    if let Some(d) = nonempty(&w.display_name).filter(|d| *d != branch) {
        return d.to_string();
    }
    nonempty(&w.repo)
        .or(Some(branch).filter(|b| !b.is_empty()))
        .unwrap_or("worktree")
        .to_string()
}

/// The native backend names desks by their folder (port of the lambda in backend/native.ts).
pub fn native_desk_name(w: &OrcaWorktreeRow) -> String {
    let base = std::path::Path::new(w.path.as_deref().unwrap_or(""))
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if base.is_empty() {
        orca_desk_name(w)
    } else {
        base
    }
}

/// Port of normalizePr in gitInfo.ts (Orca's `linkedPR` can be a number, a URL or an object).
pub fn normalize_pr(raw: &Value) -> Option<DeskPr> {
    let https = |s: &str| s.starts_with("https://");
    let int = |f: f64| f as i64;
    match raw {
        Value::Null | Value::Bool(_) => None,
        Value::Number(n) => Some(DeskPr {
            number: n.as_i64().or_else(|| n.as_f64().map(int)),
            url: None,
            title: None,
            state: None,
        }),
        Value::String(s) => {
            let t = crate::jsstr::trim_end(s);
            let start = t.trim_end_matches(|c: char| c.is_ascii_digit()).len();
            let digits = &t[start..];
            Some(DeskPr {
                number: if digits.is_empty() {
                    None
                } else {
                    digits.parse().ok()
                },
                url: https(s).then(|| s.clone()),
                title: None,
                state: None,
            })
        }
        Value::Object(_) | Value::Array(_) => {
            let o = raw.as_object();
            let get = |k: &str| o.and_then(|o| o.get(k)).filter(|v| !v.is_null());
            let string = |k: &str| get(k).and_then(Value::as_str);
            let num = get("number")
                .or_else(|| get("prNumber"))
                .or_else(|| get("id"));
            let number = match num {
                Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(int)),
                Some(Value::String(s))
                    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) =>
                {
                    s.parse().ok()
                }
                _ => None,
            };
            let url = string("url").or_else(|| string("htmlUrl"));
            Some(DeskPr {
                number,
                url: url.filter(|u| https(u)).map(String::from),
                title: string("title").map(String::from),
                state: string("state").map(String::from),
            })
        }
    }
}

/// Primary collation weight approximating ICU's root order for `localeCompare`:
/// whitespace/punctuation/symbols < digits < letters (case-insensitive) < everything else.
fn primary(c: char) -> (u8, u32) {
    const PUNCT: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    match c {
        _ if PUNCT.contains(c) => (0, PUNCT.find(c).unwrap_or(0) as u32),
        '0'..='9' => (1, c as u32),
        'a'..='z' | 'A'..='Z' => (2, c.to_ascii_lowercase() as u32),
        _ => (3, c as u32),
    }
}

/// Stand-in for JS `localeCompare` on desk ids, following ICU's levels: base characters first,
/// then accents (via NFD), then case (lowercase first). Exact for ASCII and accented Latin;
/// other scripts sort by code point after the Latin letters.
fn locale_cmp(a: &str, b: &str) -> Ordering {
    let base = |s: &str| {
        s.nfd()
            .filter(|c| !is_combining_mark(*c))
            .map(primary)
            .collect::<Vec<_>>()
    };
    let marks = |s: &str| {
        s.nfd()
            .filter(|c| is_combining_mark(*c))
            .collect::<Vec<_>>()
    };
    base(a)
        .cmp(&base(b))
        .then_with(|| marks(a).cmp(&marks(b)))
        .then_with(|| {
            // Same letters: lowercase sorts before uppercase at the first difference.
            a.chars()
                .zip(b.chars())
                .find(|(x, y)| x != y)
                .map_or(Ordering::Equal, |(x, y)| {
                    x.is_uppercase().cmp(&y.is_uppercase())
                })
        })
        .then_with(|| a.cmp(b))
}

pub type DeskNameFn<'a> = &'a dyn Fn(&OrcaWorktreeRow) -> String;

/// `desk_name` overrides how desks are named (default `orca_desk_name`).
pub fn to_snapshot(
    worktrees: &[OrcaWorktreeRow],
    terminals: &[OrcaTerminalRow],
    now: i64,
    desk_name: Option<DeskNameFn<'_>>,
) -> OfficeSnapshot {
    let mut term_by_pane: HashMap<String, &OrcaTerminalRow> = HashMap::new();
    for t in terminals {
        if let (Some(_), Some(tab), Some(leaf)) = (
            nonempty(&t.handle),
            nonempty(&t.tab_id),
            nonempty(&t.leaf_id),
        ) {
            term_by_pane.insert(format!("{tab}:{leaf}"), t);
        }
    }

    let mut desks: Vec<OfficeDesk> = worktrees
        .iter()
        .filter(|w| nonempty(&w.worktree_id).is_some() && !w.is_archived)
        .map(|w| {
            let desk_id = w.worktree_id.clone().unwrap_or_default();
            let agents = w
                .agents
                .iter()
                .enumerate()
                .map(|(i, a)| {
                    let id = a
                        .pane_key
                        .clone()
                        .unwrap_or_else(|| format!("{desk_id}#{i}"));
                    let raw = a.state.clone().unwrap_or_else(|| "unknown".into());
                    let state = map_agent_state(Some(&raw), a.tool_name.as_deref());
                    let term = nonempty(&a.pane_key).and_then(|k| term_by_pane.get(k));
                    OfficeAgent {
                        id,
                        terminal_handle: term.and_then(|t| t.handle.clone()),
                        agent_type: a.agent_type.clone().unwrap_or_else(|| "agent".into()),
                        terminal_title: clean_title(term.and_then(|t| t.title.as_deref())),
                        subagents_running: 0,
                        model: None,
                        effort: None,
                        stats: None,
                        state,
                        raw_state: raw,
                        activity: describe(state, a),
                        prompt: a.prompt.clone(),
                        last_message: a.last_assistant_message.clone(),
                        since: a.state_started_at.map(|f| f as i64),
                    }
                })
                .collect();
            OfficeDesk {
                repo_id: w
                    .repo_id
                    .clone()
                    .unwrap_or_else(|| desk_id.split("::").next().unwrap_or("").to_string()),
                is_main: w.is_main_worktree,
                parent_id: w.parent_worktree_id.clone(),
                name: desk_name.map_or_else(|| orca_desk_name(w), |f| f(w)),
                repo: w.repo.clone().unwrap_or_default(),
                branch: strip_heads(w.branch.as_deref().unwrap_or("")).to_string(),
                path: w.path.clone().unwrap_or_default(),
                status: w.status.clone().unwrap_or_else(|| "unknown".into()),
                workspace_status: w.workspace_status.clone(),
                // A lone space is how a comment gets cleared (see /api/worktree).
                comment: trim(w.comment.as_deref().unwrap_or("")).to_string(),
                preview: one_line(w.preview.as_deref(), 120),
                is_active: w.is_active,
                unread: w.unread,
                last_activity_at: w.last_activity_at.map(|f| f as i64),
                changes: None,
                pr: w.linked_pr.as_ref().and_then(normalize_pr),
                agents,
                id: desk_id,
            }
        })
        .collect();
    // Stable desk order regardless of Orca's activity-based sort, so desks don't shuffle around.
    desks.sort_by(|a, b| locale_cmp(&a.id, &b.id));

    OfficeSnapshot {
        desks,
        updated_at: now,
        error: None,
    }
}
