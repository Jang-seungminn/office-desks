//! Input routes: `POST /api/send`, `/api/send/retry`, `/api/keys`, `/api/queue`, `/api/focus`
//! and `/api/answer`. Bodies are raw `Value`s checked by hand, as `server.ts` does.

use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::Response;
use od_core::answer::{answer_questions, validate_choices, BackendAnswerIO};
use od_core::backend::{BackendError, KeyInput};
use od_core::keys::{char_bytes, key_bytes};
use od_core::model::{ComposerState, QuestionStatus};
use od_core::screen::composer_state;
use od_core::uploads::{compose_prompt, parse_images, save_images};
use serde_json::{json, Map, Value};

use super::{field, post_body};
use crate::app::{known_handle_in, lock, AppState};
use crate::js;
use crate::reqs::{json, ApiError};

/// `readJson`'s default cap.
const CAP: usize = 64_000;
/// `/api/send` carries pasted images.
const SEND_CAP: usize = 80 * 1024 * 1024;

const BUSY: &str = "에이전트가 지금 새 메시지를 받을 수 없는 상태예요 (질문·권한 확인 중이거나 화면 전환 중). 잠시 후 다시 보내기를 눌러 주세요";

fn ok() -> Response {
    json(StatusCode::OK, &json!({ "ok": true }))
}

fn error(status: StatusCode, msg: &str) -> Response {
    json(status, &json!({ "error": msg }))
}

fn unknown_terminal() -> Response {
    error(StatusCode::NOT_FOUND, "unknown terminal")
}

/// `deliver()`: submit a prompt; a busy agent becomes a 409 the panel can retry by request id.
/// Any other error goes to the catch-all.
pub(crate) async fn deliver(
    st: &AppState,
    send: impl Future<Output = Result<(), BackendError>>,
) -> Result<Response, ApiError> {
    if let Err(e) = send.await {
        if !e.is_busy() {
            return Err(e.into());
        }
        // TS key order: code, requestId, error; `requestId: undefined` is left out.
        let mut body = Map::new();
        body.insert("code".into(), "agent_busy".into());
        if let Some(id) = e.request_id {
            body.insert("requestId".into(), id.into());
        }
        body.insert("error".into(), BUSY.into());
        return Ok(json(StatusCode::CONFLICT, &body));
    }
    st.poller.refresh_detached();
    Ok(ok())
}

/// `body.images?.length` is truthy: a non-empty array or string, or any other object whose
/// `length` field is truthy.
fn has_images(images: Option<&Value>) -> bool {
    match images {
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Object(m)) => m.get("length").is_some_and(js::truthy),
        _ => false,
    }
}

/// `POST /api/send`.
pub(crate) async fn send(st: &AppState, req: Request) -> Result<Response, ApiError> {
    let body = post_body(req, SEND_CAP).await?;
    let snap = st.poller.current();
    let Some(handle) = field(&body, "terminalHandle")?.and_then(|h| known_handle_in(&snap, h))
    else {
        return Ok(unknown_terminal());
    };
    // A dialog (/usage, /config, a permission prompt) would swallow the text: refuse unless forced.
    let forced = field(&body, "force")?.is_some_and(js::truthy);
    let owner = snap
        .desks
        .iter()
        .flat_map(|d| &d.agents)
        .find(|a| a.terminal_handle.as_deref() == Some(handle.as_str()));
    if let (false, Some(owner)) = (forced, owner) {
        let lines = st.backend.read_screen(&handle).await?;
        if composer_state(&lines, &owner.agent_type) == ComposerState::Menu {
            return Ok(json(
                StatusCode::CONFLICT,
                &json!({
                    "error": "에이전트 터미널에 메뉴가 열려 있어 메시지가 전달되지 않습니다",
                    "code": "menu_open",
                }),
            ));
        }
    }
    let text = field(&body, "text")?
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let images = field(&body, "images")?;
    if js::trim(&text).is_empty() && !has_images(images) {
        return Ok(error(StatusCode::BAD_REQUEST, "empty message"));
    }
    let imgs = parse_images(images.unwrap_or(&Value::Null))?;
    let dir: PathBuf = st.cfg.upload_dir.clone();
    let paths = tokio::task::spawn_blocking(move || save_images(&imgs, &dir)).await??;
    let prompt = compose_prompt(&text, &paths);
    deliver(st, st.backend.send_prompt(&handle, &prompt)).await
}

/// `POST /api/send/retry`: re-issue a prompt the backend blocked, by its request id, so it
/// cannot be typed twice.
pub(crate) async fn retry(st: &AppState, req: Request) -> Result<Response, ApiError> {
    let body = post_body(req, CAP).await?;
    let request_id = field(&body, "requestId")?
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let blocked = st.backend.blocked_handle(&request_id).map(Value::String);
    if blocked.and_then(|h| st.known_handle(&h)).is_none() {
        return Ok(error(
            StatusCode::NOT_FOUND,
            "다시 보낼 메시지를 찾지 못했습니다. 새로 보내주세요",
        ));
    }
    deliver(st, st.backend.retry_prompt(&request_id)).await
}

/// `POST /api/keys`.
pub(crate) async fn keys(st: &AppState, req: Request) -> Result<Response, ApiError> {
    let body = post_body(req, CAP).await?;
    let Some(handle) = field(&body, "terminalHandle")?.and_then(|h| st.known_handle(h)) else {
        return Ok(unknown_terminal());
    };
    let key = field(&body, "key")?.and_then(Value::as_str);
    // `body.char !== undefined`: a present `char` alone decides, whatever its type.
    let bytes = match field(&body, "char")? {
        Some(c) => c.as_str().and_then(char_bytes).map(|c| c.to_string()),
        None => key.and_then(key_bytes).map(str::to_owned),
    };
    let Some(bytes) = bytes else {
        return Ok(error(StatusCode::BAD_REQUEST, "unsupported key"));
    };
    let input = if key == Some("enter") {
        KeyInput::Enter
    } else {
        KeyInput::Bytes(bytes)
    };
    st.backend.send_keys(&handle, input).await?;
    st.poller.refresh_detached();
    Ok(ok())
}

/// `POST /api/queue`: act on the prompt Claude Code has queued.
pub(crate) async fn queue(st: &AppState, req: Request) -> Result<Response, ApiError> {
    let body = post_body(req, CAP).await?;
    let Some(handle) = field(&body, "terminalHandle")?.and_then(|h| st.known_handle(h)) else {
        return Ok(unknown_terminal());
    };
    let keys: &[&str] = match field(&body, "action")?.and_then(Value::as_str) {
        Some("send-now") => &["ctrl-enter"],
        Some("cancel") => &["up", "ctrl-u"],
        _ => return Ok(error(StatusCode::BAD_REQUEST, "unknown action")),
    };
    for key in keys {
        let bytes = key_bytes(key).expect("queue keys are known keys");
        st.backend
            .send_keys(&handle, KeyInput::Bytes(bytes.to_owned()))
            .await?;
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    st.poller.refresh_detached();
    Ok(ok())
}

/// `POST /api/focus`.
pub(crate) async fn focus(st: &AppState, req: Request) -> Result<Response, ApiError> {
    let body = post_body(req, CAP).await?;
    let Some(handle) = field(&body, "terminalHandle")?.and_then(|h| st.known_handle(h)) else {
        return Ok(unknown_terminal());
    };
    st.backend.focus(&handle).await?;
    Ok(ok())
}

/// Holds a terminal in `answering` and releases it on drop (also when the request is dropped).
struct Answering<'a> {
    st: &'a AppState,
    handle: String,
}

impl<'a> Answering<'a> {
    /// None when the terminal is already being answered.
    fn claim(st: &'a AppState, handle: &str) -> Option<Self> {
        lock(&st.answering)
            .insert(handle.to_string())
            .then(|| Answering {
                st,
                handle: handle.to_string(),
            })
    }
}

impl Drop for Answering<'_> {
    fn drop(&mut self) {
        lock(&self.st.answering).remove(&self.handle);
    }
}

/// `POST /api/answer`: answer an AskUserQuestion dialog from the chat card by pressing the same
/// keys a person would.
pub(crate) async fn answer(st: &AppState, req: Request) -> Result<Response, ApiError> {
    let body = post_body(req, CAP).await?;
    let agent_id = field(&body, "agentId")?.and_then(Value::as_str);
    let found = st.find_agent(agent_id);
    let Some((desk, agent, handle)) = found.and_then(|(d, a)| {
        let h = a.terminal_handle.clone().filter(|h| !h.is_empty())?;
        Some((d, a, h))
    }) else {
        return Ok(error(StatusCode::NOT_FOUND, "unknown agent"));
    };
    let file = super::media::file_of(st, &desk, &agent).await;
    let tool_use_id = field(&body, "toolUseId")?.and_then(Value::as_str);
    let ask = match file {
        Some(f) => super::read::read_file(PathBuf::from(f), false)
            .await?
            .questions
            .into_iter()
            .find(|q| Some(q.tool_use_id.as_str()) == tool_use_id),
        None => None,
    };
    let Some(ask) = ask else {
        return Ok(error(StatusCode::NOT_FOUND, "질문을 찾지 못했습니다"));
    };
    if ask.status != QuestionStatus::Pending {
        return Ok(error(
            StatusCode::CONFLICT,
            "이미 답했거나 취소된 질문입니다",
        ));
    }
    let choices = field(&body, "choices")?.unwrap_or(&Value::Null);
    let choices = match validate_choices(&ask.questions, choices) {
        Ok(c) => c,
        Err(m) => return Ok(error(StatusCode::BAD_REQUEST, &m)),
    };
    let Some(_claim) = Answering::claim(st, &handle) else {
        return Ok(error(StatusCode::CONFLICT, "답을 입력하는 중입니다"));
    };
    let mut io = BackendAnswerIO {
        backend: &*st.backend,
        handle: &handle,
    };
    if let Err(e) = answer_questions(&mut io, &ask.questions, &choices).await {
        return Ok(error(StatusCode::CONFLICT, &e.message));
    }
    st.poller.refresh_detached();
    Ok(ok())
}
