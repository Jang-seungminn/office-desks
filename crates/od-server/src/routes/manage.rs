//! Management routes: `POST /api/org`, `/api/hire`, `/api/worktree`, `/api/repos`, and the
//! R4 additions `POST /api/stop` and `POST /api/remove` (no `server.ts` counterpart).
//! Bodies are raw `Value`s checked by hand, as `server.ts` does.

use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::Response;
use od_core::backend::{BackendError, BoardUpdate};
use od_core::model::{HireRequest, OkResponse};
use od_core::org::{sanitize_org, save_org};
use serde_json::{json, Value};

use super::{field, post_body};
use crate::app::AppState;
use crate::hub::ServerMessageJson;
use crate::js;
use crate::reqs::{json, ApiError, ErrorBody};

const CAP: usize = 64_000;

/// `POST /api/org`.
pub(crate) async fn org(st: &AppState, req: Request) -> Result<Response, ApiError> {
    let body = post_body(req, CAP).await?;
    let next = match sanitize_org(&body) {
        Ok(o) => o,
        Err(msg) => return Ok(json(StatusCode::BAD_REQUEST, &json!({ "error": msg }))),
    };
    let (to_save, file) = (next.clone(), st.cfg.org_file.clone());
    tokio::task::spawn_blocking(move || save_org(&to_save, &file)).await??;
    *crate::app::lock(&st.org) = next.clone();
    st.hub.send(&ServerMessageJson::Org { org: next.clone() });
    Ok(json(StatusCode::OK, &next))
}

fn str_of(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_string)
}

/// `POST /api/hire`.
pub(crate) async fn hire(st: &AppState, req: Request) -> Result<Response, ApiError> {
    let body = post_body(req, CAP).await?;
    if !st.backend.capabilities().hire {
        let msg = &st.backend.messages().hire_disabled;
        return Ok(json(StatusCode::BAD_REQUEST, &json!({ "error": msg })));
    }
    let agent = field(&body, "agent")?;
    let hire_req = HireRequest {
        agent: str_of(agent).unwrap_or_default(),
        prompt: str_of(field(&body, "prompt")?),
        repo_id: str_of(field(&body, "repoId")?),
        base_branch: str_of(field(&body, "baseBranch")?),
        name: str_of(field(&body, "name")?),
        desk_id: field(&body, "deskId")?.map(|v| v.as_str().map(str::to_string)),
    };
    let snap = st.poller.current();
    let spec = match od_core::hire::validate_hire(&hire_req, &snap.desks) {
        Ok(s) => s,
        Err(msg) => return Ok(json(StatusCode::BAD_REQUEST, &json!({ "error": msg }))),
    };
    // Its own task: a client that goes away must not stop a hire halfway (a worktree without
    // its agent, or an agent without its prompt).
    let backend = std::sync::Arc::clone(&st.backend);
    let result = match tokio::spawn(async move { backend.hire(spec).await }).await? {
        Ok(r) => r,
        Err(e) => {
            return Ok(json(
                StatusCode::BAD_REQUEST,
                &json!({ "error": e.message }),
            ))
        }
    };
    st.poller.refresh_detached();
    st.hire_recheck();
    Ok(json(
        StatusCode::OK,
        &OkResponse {
            ok: true,
            warning: result.warning,
        },
    ))
}

/// `/^[a-z0-9][a-z0-9-]{0,39}$/`
fn valid_status(s: &str) -> bool {
    let b = s.as_bytes();
    let ok = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty() && b.len() <= 40 && ok(&b[0]) && b[1..].iter().all(|c| ok(c) || *c == b'-')
}

fn unknown_worktree() -> Response {
    json(
        StatusCode::NOT_FOUND,
        &json!({ "error": "unknown worktree" }),
    )
}

/// `POST /api/worktree`.
pub(crate) async fn worktree(st: &AppState, req: Request) -> Result<Response, ApiError> {
    let body = post_body(req, CAP).await?;
    let snap = st.poller.current();
    let desks = &snap.desks;
    // `find` only reads `body.deskId` when there is a desk to test.
    let desk_id = if desks.is_empty() {
        None
    } else {
        field(&body, "deskId")?
    };
    let desk = desk_id
        .and_then(Value::as_str)
        .and_then(|id| desks.iter().find(|d| d.id == id));
    let Some(desk) = desk else {
        return Ok(unknown_worktree());
    };
    if !st.backend.capabilities().board {
        return Ok(unknown_worktree());
    }
    let mut update = BoardUpdate::default();
    if let Some(v) = field(&body, "workspaceStatus")? {
        if !valid_status(&js::string(v)) {
            return Ok(json(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "invalid status" }),
            ));
        }
        update.workspace_status = Some(js::string(v));
    }
    if let Some(v) = field(&body, "comment")? {
        let c = js::trim(&js::collapse_spaces(&js::string(v))).to_string();
        if js::utf16_len(&c) > 200 {
            return Ok(json(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "코멘트는 200자까지 쓸 수 있어요" }),
            ));
        }
        update.comment = Some(c);
    }
    if update.workspace_status.is_none() && update.comment.is_none() {
        return Ok(json(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "nothing to change" }),
        ));
    }
    st.backend.set_board(&desk.id, update).await?;
    st.poller.refresh_detached();
    Ok(json(StatusCode::OK, &json!({ "ok": true })))
}

/// `POST /api/repos`.
pub(crate) async fn repos(st: &AppState, req: Request) -> Result<Response, ApiError> {
    let body = post_body(req, CAP).await?;
    if !st.backend.capabilities().repos {
        return Ok(json(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "이 백엔드에서는 여기서 프로젝트를 추가할 수 없어요" }),
        ));
    }
    let raw = field(&body, "path")?.and_then(Value::as_str);
    let Some(raw) = raw.filter(|r| js::utf16_len(r) <= 1000 && !js::trim(r).is_empty()) else {
        return Ok(json(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "저장소 경로를 입력해 주세요" }),
        ));
    };
    if let Err(e) = st.backend.add_repo(js::trim(raw)).await {
        return match e.code {
            Some(ref code) => Ok(json(
                StatusCode::BAD_REQUEST,
                &ErrorBody {
                    error: &e.message,
                    code: Some(code),
                },
            )),
            None => Err(e.into()),
        };
    }
    st.poller.refresh_detached();
    Ok(json(StatusCode::OK, &json!({ "ok": true })))
}

/// The error body of `stop` and `remove`: the backend's message and, when it has one, its code.
fn lifecycle_error(e: BackendError) -> Response {
    let status = match e.code.as_deref() {
        Some("not_found") => StatusCode::NOT_FOUND,
        Some("main_checkout" | "has_agents" | "dirty") => StatusCode::CONFLICT,
        Some("unsupported") => StatusCode::BAD_REQUEST,
        _ => StatusCode::BAD_GATEWAY,
    };
    json(
        status,
        &ErrorBody {
            error: &e.message,
            code: e.code.as_deref(),
        },
    )
}

/// The shared front of `stop` and `remove`: the capability, then the id. `Err` is the answer.
fn lifecycle_id(
    body: &Value,
    supported: bool,
    name: &'static str,
) -> Result<String, Box<Response>> {
    if !supported {
        return Err(Box::new(json(
            StatusCode::BAD_REQUEST,
            &ErrorBody {
                error: "이 백엔드에서는 할 수 없어요",
                code: Some("unsupported"),
            },
        )));
    }
    let id = match field(body, name) {
        Ok(v) => v,
        Err(e) => return Err(Box::new(axum::response::IntoResponse::into_response(e))),
    };
    match id.and_then(Value::as_str) {
        Some(s) if !js::trim(s).is_empty() && js::utf16_len(s) <= 1000 => Ok(s.to_string()),
        _ => Err(Box::new(json(
            StatusCode::BAD_REQUEST,
            &json!({ "error": format!("{name}가 필요해요") }),
        ))),
    }
}

/// `POST /api/stop`: `{"agentId"}`.
pub(crate) async fn stop(st: &AppState, req: Request) -> Result<Response, ApiError> {
    let body = post_body(req, CAP).await?;
    let id = match lifecycle_id(&body, st.backend.capabilities().stop, "agentId") {
        Ok(id) => id,
        Err(r) => return Ok(*r),
    };
    // Its own task, like `hire`: a client that goes away must not cut the stop short.
    let backend = std::sync::Arc::clone(&st.backend);
    match tokio::spawn(async move { backend.stop_agent(&id).await }).await? {
        Ok(()) => {
            st.poller.refresh_detached();
            Ok(json(StatusCode::OK, &json!({ "ok": true })))
        }
        Err(e) => Ok(lifecycle_error(e)),
    }
}

/// `POST /api/remove`: `{"deskId"}`.
pub(crate) async fn remove(st: &AppState, req: Request) -> Result<Response, ApiError> {
    let body = post_body(req, CAP).await?;
    let id = match lifecycle_id(&body, st.backend.capabilities().remove, "deskId") {
        Ok(id) => id,
        Err(r) => return Ok(*r),
    };
    // Its own task: a client that goes away must not stop a `git worktree remove` partway.
    let backend = std::sync::Arc::clone(&st.backend);
    match tokio::spawn(async move { backend.remove_worktree(&id).await }).await? {
        Ok(()) => {
            st.poller.refresh_detached();
            Ok(json(StatusCode::OK, &json!({ "ok": true })))
        }
        Err(e) => Ok(lifecycle_error(e)),
    }
}
