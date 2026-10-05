//! Claude Code writes each subagent's conversation next to the session transcript:
//!   <dir>/<session>.jsonl
//!   <dir>/<session>/subagents/agent-<id>.jsonl   (+ agent-<id>.meta.json with the toolUseId)
//! Port of `bridge/src/subagents.ts`.

use crate::model::SubagentInfo;
use crate::transcript::SubagentCall;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn subagent_dir(transcript_path: &Path) -> PathBuf {
    let parent = transcript_path.parent().unwrap_or_else(|| Path::new(""));
    let name = transcript_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    // path.basename(p, '.jsonl') does not strip when the name is exactly the extension.
    let base = match name.strip_suffix(".jsonl") {
        Some(b) if !b.is_empty() => b.to_string(),
        _ => name,
    };
    parent.join(base).join("subagents")
}

fn id_chars_ok(s: &str) -> bool {
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// toolUseId to agentId, from the meta files.
pub fn subagent_ids(transcript_path: &Path) -> HashMap<String, String> {
    let dir = subagent_dir(transcript_path);
    let mut out = HashMap::new();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return out;
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name
            .strip_prefix("agent-")
            .and_then(|n| n.strip_suffix(".meta.json"))
        else {
            continue;
        };
        if id.is_empty() || !id_chars_ok(id) {
            continue;
        }
        // Half-written meta: pick it up next time.
        let Ok(text) = std::fs::read_to_string(dir.join(&name)) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(t) = meta
            .get("toolUseId")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        {
            out.insert(t.to_string(), id.to_string());
        }
    }
    out
}

pub fn subagent_infos(calls: &[SubagentCall], ids: &HashMap<String, String>) -> Vec<SubagentInfo> {
    calls
        .iter()
        .map(|c| SubagentInfo {
            tool_use_id: c.tool_use_id.clone(),
            agent_id: ids.get(&c.tool_use_id).cloned(),
            description: c.description.clone(),
            agent_type: c.agent_type.clone(),
            status: c.status,
        })
        .collect()
}

/// Transcript file for one subagent; the id is validated so it can't escape the folder.
pub fn subagent_file(transcript_path: &Path, agent_id: &str) -> Option<PathBuf> {
    if agent_id.is_empty() || agent_id.len() > 64 || !id_chars_ok(agent_id) {
        return None;
    }
    Some(subagent_dir(transcript_path).join(format!("agent-{agent_id}.jsonl")))
}
