//! `POST /hook/<id>?token=<t>`: the agent hook relay, a port of the `/hook/` branch of
//! `server.ts`. It sits before the `/api` chain, so none of the API's gates apply: no content
//! type, no method check beyond POST. Every outcome is a bare status with no body.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use crate::app::AppState;
use crate::js::decode_uri_component;
use crate::reqs::{read_json, RequestUrl};

/// The body cap, `2 * 1024 * 1024` in TS.
const HOOK_BODY_CAP: usize = 2 * 1024 * 1024;

/// The longest a hook waits for the refresh it triggered before answering.
const REFRESH_WAIT: Duration = Duration::from_millis(500);

pub(crate) async fn handle(st: Arc<AppState>, req: Request, url: RequestUrl) -> Response {
    // Any failure (body, parse, bad escape) is a bare 400, as the `.catch` in TS.
    let Ok(payload) = read_json(req.into_body(), HOOK_BODY_CAP).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(id) = decode_uri_component(&url.pathname["/hook/".len()..]) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let token = url.get("token").unwrap_or("");
    // Sync and only locks (the backend constant-time compares the token itself).
    if st.backend.hook(&id, token, &payload) {
        // TS fires `void poller.refresh()` and answers at once. The poll (source + enrichment)
        // takes a few ms and the client's next GET arrives first, so wait for it, bounded so a
        // slow poll cannot stall the agent (the relay gives up at 3 s). On timeout the poll
        // carries on in its own task.
        let _ = tokio::time::timeout(REFRESH_WAIT, st.poller.refresh()).await;
        StatusCode::NO_CONTENT.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}
