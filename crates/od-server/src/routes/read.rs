//! Read routes: `GET /api/snapshot`, `/api/org`, `/api/changes`, `/api/diff`, `/api/search`,
//! `/api/commands`, `/api/terminal` and `/api/conversation`.

use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use axum::response::Response;
use od_core::conversation::{conversation_response, empty_conversation};
use od_core::git::SystemGit;
use od_core::git_info::{change_summary, file_diff};
use od_core::model::{
    ComposerState, ConversationResponse, FileDiffResponse, OfficeAgent, OfficeDesk, SearchResult,
    TerminalScreen,
};
use od_core::screen::composer_state;
use od_core::subagents::{subagent_file, subagent_ids, subagent_infos};
use od_core::transcript::{read_transcript, ReadOptions, TranscriptResult};
use serde_json::json;

use crate::app::AppState;
use crate::js;
use crate::reqs::{json, ApiError, RequestUrl};

/// `poller.current`.
pub(crate) fn snapshot(st: &AppState) -> Response {
    json(StatusCode::OK, &*st.poller.current())
}

/// The org chart as loaded (or last saved).
pub(crate) fn org(st: &AppState) -> Response {
    json(StatusCode::OK, &st.org())
}

/// `GET /api/changes` and `GET /api/diff`.
pub(crate) async fn changes(
    st: &AppState,
    url: &RequestUrl,
    diff: bool,
) -> Result<Response, ApiError> {
    let desk_id = url.get("deskId");
    let desk = st
        .poller
        .current()
        .desks
        .iter()
        .find(|d| Some(d.id.as_str()) == desk_id)
        .cloned();
    let desk = match desk {
        Some(d) if st.backend.capabilities().changes => d,
        _ => {
            return Ok(json(
                StatusCode::NOT_FOUND,
                &json!({ "error": "unknown worktree" }),
            ))
        }
    };
    let cwd = desk.path.clone();
    let summary = tokio::task::spawn_blocking(move || change_summary(&cwd, &SystemGit)).await??;
    if !diff {
        return Ok(json(StatusCode::OK, &summary));
    }
    let want = url.get("file");
    let Some(file) = summary
        .files
        .into_iter()
        .find(|f| Some(f.path.as_str()) == want)
    else {
        return Ok(json(
            StatusCode::NOT_FOUND,
            &json!({ "error": "not a changed file" }),
        ));
    };
    let (cwd, f) = (desk.path, file.clone());
    let d = tokio::task::spawn_blocking(move || file_diff(&cwd, &f, &SystemGit)).await?;
    Ok(json(
        StatusCode::OK,
        &FileDiffResponse {
            file,
            diff: d.diff,
            truncated: d.truncated,
        },
    ))
}

/// `GET /api/search`.
pub(crate) async fn search(st: &AppState, url: &RequestUrl) -> Result<Response, ApiError> {
    let q = js::trim(url.get("q").unwrap_or(""));
    if q.is_empty() || js::utf16_len(q) > 200 {
        return Ok(json(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "검색어를 1~200자로 입력해 주세요" }),
        ));
    }
    if !st.backend.capabilities().search {
        return Ok(json(StatusCode::OK, &json!({ "results": [] })));
    }
    let hits = st.backend.search_conversations(q).await?;
    let snap = st.poller.current();
    let results: Vec<SearchResult> = hits
        .into_iter()
        .map(|h| {
            // Is this the session an agent in the office is running right now?
            let owner = h
                .file_path
                .as_deref()
                .filter(|f| !f.is_empty())
                .and_then(|fp| {
                    snap.desks.iter().find_map(|d| {
                        d.agents
                            .iter()
                            .find(|a| st.backend.cached_session(&a.id).as_deref() == Some(fp))
                            .map(|a| (d.id.clone(), a.id.clone()))
                    })
                });
            SearchResult {
                title: h.title,
                agent: h.agent,
                project: js::node_basename(&h.cwd).to_string(),
                updated_at: h.updated_at,
                snippet: h.snippet,
                role: h.role,
                resume_command: if owner.is_some() {
                    None
                } else {
                    h.resume_command
                },
                desk_id: owner.as_ref().map(|o| o.0.clone()),
                agent_id: owner.map(|o| o.1),
            }
        })
        .collect();
    Ok(json(StatusCode::OK, &json!({ "results": results })))
}

/// `GET /api/commands`.
pub(crate) async fn commands(st: &AppState, url: &RequestUrl) -> Result<Response, ApiError> {
    let Some((desk, agent)) = st.find_agent(url.get("agentId")) else {
        return Ok(json(StatusCode::OK, &json!([])));
    };
    let catalog = st.commands.clone();
    let list =
        tokio::task::spawn_blocking(move || catalog.get(&agent.agent_type, Path::new(&desk.path)))
            .await?;
    Ok(json(StatusCode::OK, &*list))
}

/// `GET /api/terminal`: the rendered screen, for TUI menus and permission prompts.
pub(crate) async fn terminal(st: &AppState, url: &RequestUrl) -> Result<Response, ApiError> {
    let handle = st.find_agent(url.get("agentId")).and_then(|(_, a)| {
        a.terminal_handle
            .clone()
            .filter(|h| !h.is_empty())
            .map(|h| (h, a.agent_type))
    });
    let Some((handle, agent_type)) = handle else {
        return Ok(json(
            StatusCode::OK,
            &TerminalScreen {
                found: false,
                lines: Vec::new(),
                composer: ComposerState::Unknown,
            },
        ));
    };
    let lines = st.backend.read_screen(&handle).await?;
    let composer = composer_state(&lines, &agent_type);
    Ok(json(
        StatusCode::OK,
        &TerminalScreen {
            found: true,
            lines,
            composer,
        },
    ))
}

/// The transcript file the backend knows for this agent, never a client-supplied path.
pub(crate) async fn session_file(
    st: &AppState,
    desk: &OfficeDesk,
    agent: &OfficeAgent,
) -> Option<String> {
    st.backend.find_session(desk, agent).await.ok().flatten()
}

async fn read_file(file: PathBuf, sidechain: bool) -> Result<TranscriptResult, ApiError> {
    Ok(
        tokio::task::spawn_blocking(move || read_transcript(&file, ReadOptions { sidechain }))
            .await??,
    )
}

/// `Number.isInteger(after)` as an `i64`, else -1 (which `conversation_response` treats as 0).
fn after_of(after: f64) -> i64 {
    if after.is_finite() && after.fract() == 0.0 && after.abs() < 9e15 {
        after as i64
    } else {
        -1
    }
}

/// Port of `conversation()` in `server.ts`.
pub(crate) async fn conversation(
    st: &AppState,
    agent_id: Option<&str>,
    after: f64,
    sub: Option<&str>,
) -> Result<ConversationResponse, ApiError> {
    // JS `if (sub)`: an empty string is falsy.
    let sub = sub.filter(|s| !s.is_empty());
    let Some((desk, agent)) = st.find_agent(agent_id) else {
        return Ok(empty_conversation(
            "이 에이전트는 더 이상 사무실에 없습니다.",
        ));
    };
    let Some(file_path) = session_file(st, &desk, &agent).await else {
        return Ok(empty_conversation(&st.backend.messages().no_session));
    };
    let path = PathBuf::from(&file_path);
    let main = read_file(path.clone(), false).await?;
    let p = path.clone();
    let ids = tokio::task::spawn_blocking(move || subagent_ids(&p)).await?;
    let infos = subagent_infos(&main.calls, &ids);
    let mut sub_result = None;
    if let Some(sub) = sub {
        // A subagent's own conversation: only ids this session actually started.
        let file = infos
            .iter()
            .any(|s| s.agent_id.as_deref() == Some(sub))
            .then(|| subagent_file(&path, sub))
            .flatten();
        let file = match file {
            Some(f) => tokio::task::spawn_blocking(move || f.exists().then_some(f)).await?,
            None => None,
        };
        let file = match file {
            Some(f) => f,
            None => {
                let mut e = empty_conversation("서브에이전트 기록을 찾지 못했습니다.");
                e.subagents = infos;
                return Ok(e);
            }
        };
        sub_result = Some(read_file(file, true).await?);
    }
    Ok(conversation_response(
        &main,
        sub_result.as_ref(),
        infos,
        after_of(after),
        &agent.agent_type,
    ))
}

/// `GET /api/conversation`.
pub(crate) async fn conversation_route(
    st: &AppState,
    url: &RequestUrl,
) -> Result<Response, ApiError> {
    let after = js::number_of_param(url.get("after"));
    let res = conversation(st, url.get("agentId"), after, url.get("sub")).await?;
    Ok(json(StatusCode::OK, &res))
}
