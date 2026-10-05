//! The `/api/` chain of `server.ts` (`handleApi`), in TS order:
//! 1. the GET arms;
//! 2. `POST /api/org` (no content-type check);
//! 3. any other method: 405;
//! 4. a content-type not starting with `application/json`: 415;
//! 5. the POST arms;
//! 6. 404.

mod input;
mod manage;
mod media;
mod read;

use std::sync::Arc;

use axum::extract::Request;
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use crate::app::AppState;
use crate::reqs::{json, read_json, ApiError, RequestUrl};

/// Reads a POST body as a raw `Value` (never axum's `Json<T>`, which answers 422).
pub(crate) async fn post_body(req: Request, cap: usize) -> Result<Value, ApiError> {
    read_json(req.into_body(), cap).await
}

/// `body.<name>`: V8's `TypeError` for a `null` body, the value when the key is present, else
/// None (also for a body that is not an object, where JS reads `undefined`).
pub(crate) fn field<'a>(
    body: &'a Value,
    name: &'static str,
) -> Result<Option<&'a Value>, ApiError> {
    match body {
        Value::Null => Err(ApiError::NullBody(name)),
        Value::Object(m) => Ok(m.get(name)),
        _ => Ok(None),
    }
}

fn done(r: Result<Response, ApiError>) -> Response {
    r.unwrap_or_else(IntoResponse::into_response)
}

fn not_found() -> Response {
    json(StatusCode::NOT_FOUND, &json!({ "error": "not found" }))
}

/// `req.headers['content-type']?.startsWith('application/json')`: case-sensitive, and a
/// missing header does not match. Node keeps the first of repeated content-type headers.
fn is_json(req: &Request) -> bool {
    req.headers()
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes().starts_with(b"application/json"))
}

pub(crate) async fn dispatch(st: Arc<AppState>, req: Request, url: RequestUrl) -> Response {
    let get = req.method() == Method::GET;
    let p = url.pathname.as_str();

    // 1. GET arms.
    if get && p == "/api/snapshot" {
        return read::snapshot(&st);
    }
    if get && p == "/api/org" {
        return read::org(&st);
    }
    if get && p == "/api/conversation/image" {
        return done(media::conversation_image(&st, &url).await);
    }
    if get && p == "/api/local-image" {
        return done(media::local_image(&st, &url).await);
    }
    if let Some(rest) = p.strip_prefix("/api/uploads/").filter(|_| get) {
        return done(media::upload(&st, rest).await);
    }
    if get && (p == "/api/changes" || p == "/api/diff") {
        return done(read::changes(&st, &url, p == "/api/diff").await);
    }
    if get && p == "/api/search" {
        return done(read::search(&st, &url).await);
    }
    if get && p == "/api/commands" {
        return done(read::commands(&st, &url).await);
    }
    if get && p == "/api/terminal" {
        return done(read::terminal(&st, &url).await);
    }
    if get && p == "/api/conversation" {
        return done(read::conversation_route(&st, &url).await);
    }

    // 2. POST /api/org, before the content-type gate.
    if req.method() == Method::POST && p == "/api/org" {
        return done(manage::org(&st, req).await);
    }

    // 3, 4. The gates.
    if req.method() != Method::POST {
        return json(
            StatusCode::METHOD_NOT_ALLOWED,
            &json!({ "error": "method not allowed" }),
        );
    }
    if !is_json(&req) {
        return json(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            &json!({ "error": "expected application/json" }),
        );
    }

    // 5. POST arms.
    match p {
        "/api/send" => done(input::send(&st, req).await),
        "/api/send/retry" => done(input::retry(&st, req).await),
        "/api/keys" => done(input::keys(&st, req).await),
        "/api/answer" => done(input::answer(Arc::clone(&st), req).await),
        "/api/queue" => done(input::queue(Arc::clone(&st), req).await),
        "/api/hire" => done(manage::hire(&st, req).await),
        "/api/worktree" => done(manage::worktree(&st, req).await),
        "/api/focus" => done(input::focus(&st, req).await),
        "/api/repos" => done(manage::repos(&st, req).await),
        "/api/stop" => done(manage::stop(&st, req).await),
        "/api/remove" => done(manage::remove(&st, req).await),
        // 6.
        _ => not_found(),
    }
}
