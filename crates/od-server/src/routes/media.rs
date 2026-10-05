//! Media routes: `GET /api/conversation/image`, `/api/local-image` and `/api/uploads/<name>`.

use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;
use od_core::local_image::{is_linked_image, read_local_image};
use od_core::model::{OfficeAgent, OfficeDesk};
use od_core::uploads::{decode_base64_lenient, upload_path, IMAGE_TYPES};
use serde_json::json;

use crate::app::AppState;
use crate::js;
use crate::reqs::{json, ApiError, RequestUrl};
use crate::routes::read::{read_file, session_file};

/// `sendBinary` in `server.ts`.
pub(crate) fn binary(content_type: &str, bytes: Vec<u8>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "private, max-age=86400")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Body::from(bytes))
        .expect("static headers")
}

fn no_such(what: &str) -> Response {
    json(StatusCode::NOT_FOUND, &json!({ "error": what }))
}

/// `images[Number(i)]`: only a non-negative integer below `len` indexes (-0 is 0).
fn index_of(i: f64, len: usize) -> Option<usize> {
    (i.is_finite() && i.fract() == 0.0 && i >= 0.0 && i < len as f64).then_some(i as usize)
}

/// The agent's session file; an empty path is falsy in JS.
async fn file_of(st: &AppState, desk: &OfficeDesk, agent: &OfficeAgent) -> Option<String> {
    session_file(st, desk, agent)
        .await
        .filter(|f| !f.is_empty())
}

/// Images embedded in the agent's transcript (screenshots pasted into Claude Code).
pub(crate) async fn conversation_image(
    st: &AppState,
    url: &RequestUrl,
) -> Result<Response, ApiError> {
    let Some((desk, agent)) = st.find_agent(url.get("agentId")) else {
        return Ok(no_such("no such image"));
    };
    let Some(file) = file_of(st, &desk, &agent).await else {
        return Ok(no_such("no such image"));
    };
    let t = read_file(file.into(), false).await?;
    let i = js::number_of_param(url.get("i"));
    let img = index_of(i, t.images.len()).map(|n| &t.images[n]);
    match img {
        Some(img) if IMAGE_TYPES.iter().any(|(m, _)| *m == img.media_type) => {
            Ok(binary(&img.media_type, decode_base64_lenient(&img.data)))
        }
        _ => Ok(no_such("no such image")),
    }
}

/// Local screenshots an agent linked in its own messages.
pub(crate) async fn local_image(st: &AppState, url: &RequestUrl) -> Result<Response, ApiError> {
    let want = url.get("path").unwrap_or("");
    let agent = st.find_agent(url.get("agentId"));
    let Some((desk, agent)) = agent.filter(|_| js::node_is_absolute(want)) else {
        return Ok(no_such("no such image"));
    };
    let linked = match file_of(st, &desk, &agent).await {
        Some(f) => {
            let t = read_file(f.into(), false).await?;
            is_linked_image(&t.messages, want)
        }
        None => false,
    };
    if !linked {
        return Ok(no_such("image not referenced by this agent"));
    }
    let w = want.to_string();
    match tokio::task::spawn_blocking(move || read_local_image(&w)).await? {
        Some(image) => Ok(binary(image.media_type, image.buf)),
        None => Ok(no_such("no such image")),
    }
}

/// Images sent from this UI, referenced by path in the agent's transcript. `rest` is the
/// still-encoded tail of the pathname.
pub(crate) async fn upload(st: &AppState, rest: &str) -> Result<Response, ApiError> {
    let file = upload_path(rest, &st.cfg.upload_dir);
    let image = match file {
        Some(f) => {
            tokio::task::spawn_blocking(move || read_local_image(&f.to_string_lossy())).await?
        }
        None => None,
    };
    match image {
        Some(i) => Ok(binary(i.media_type, i.buf)),
        None => Ok(no_such("no such upload")),
    }
}
