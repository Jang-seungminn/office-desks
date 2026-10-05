//! Port of bridge/src/hire.ts: validation for starting work from the UI. Names/branches can't
//! start with '-', and only repos/worktrees the backend already reports qualify.

use crate::backend::HireSpec;
use crate::jsstr::{trim, utf16_len};
use crate::model::{HireRequest, OfficeDesk};

pub const KNOWN_AGENTS: [&str; 8] = [
    "claude", "codex", "gemini", "opencode", "pi", "omp", "grok", "cursor",
];
const MAX_PROMPT: usize = 8000;

/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$`
fn valid_name(s: &str) -> bool {
    valid_token(s, 60, false)
}

/// `^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$`
fn valid_branch(s: &str) -> bool {
    valid_token(s, 120, true)
}

fn valid_token(s: &str, max: usize, slash: bool) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= max
        && b[0].is_ascii_alphanumeric()
        && b[1..].iter().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-') || (slash && *c == b'/')
        })
}

fn non_empty(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

/// Returns the spec, or the user-facing (Korean) error message.
pub fn validate_hire(body: &HireRequest, desks: &[OfficeDesk]) -> Result<HireSpec, String> {
    if !KNOWN_AGENTS.contains(&body.agent.as_str()) {
        return Err("지원하지 않는 에이전트입니다".into());
    }
    let prompt = trim(body.prompt.as_deref().unwrap_or(""));
    if utf16_len(prompt) > MAX_PROMPT {
        return Err("첫 지시가 너무 깁니다".into());
    }

    if let Some(desk_id) = &body.desk_id {
        let desk = desks
            .iter()
            .find(|d| Some(&d.id) == desk_id.as_ref())
            .ok_or("알 수 없는 워크트리입니다")?;
        return Ok(HireSpec::Agent {
            desk_id: desk.id.clone(),
            agent: body.agent.clone(),
            prompt: non_empty(prompt),
        });
    }

    let repo = desks
        .iter()
        .find(|d| Some(&d.repo_id) == body.repo_id.as_ref())
        .ok_or("알 수 없는 프로젝트입니다")?;
    let name = body.name.as_deref().unwrap_or("");
    if !valid_name(name) {
        return Err(
            "이름은 영문·숫자로 시작하고 영문·숫자·. _ - 만 쓸 수 있어요 (60자 이내)".into(),
        );
    }
    if desks
        .iter()
        .any(|d| Some(&d.repo_id) == body.repo_id.as_ref() && d.name == name)
    {
        return Err("같은 이름의 워크트리가 이미 있어요".into());
    }
    let base = body.base_branch.as_deref().unwrap_or("");
    if !base.is_empty() && !valid_branch(base) {
        return Err("기준 브랜치 이름이 올바르지 않아요".into());
    }
    Ok(HireSpec::Worktree {
        repo_id: repo.repo_id.clone(),
        name: name.to_string(),
        agent: body.agent.clone(),
        base_branch: non_empty(base),
        prompt: non_empty(prompt),
    })
}
