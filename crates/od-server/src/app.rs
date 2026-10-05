//! The request dispatcher, a port of the `createServer` callback in `server.ts`:
//! guard → URL → `POST /hook/` → `/api/` → static. WS upgrades go before this chain (Tasks 3, 9).

use std::any::Any;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde_json::json;
use tower_http::catch_panic::CatchPanicLayer;

use crate::assets::Assets;
use crate::reqs::{json, RequestUrl};
use crate::security::{apply_headers, is_allowed_request};
use crate::DEV_WEB_PORT;

pub(crate) struct AppState {
    pub port: u16,
    /// `[bound port, 5173]`.
    pub allowed_ports: [u16; 2],
    pub assets: Arc<dyn Assets>,
}

pub(crate) fn router(state: Arc<AppState>) -> Router {
    layered(Router::new().fallback(dispatch).with_state(state))
}

/// The layers every response goes through. The security headers are outermost, so a 403, a
/// bare `/hook` status and a panic's 502 all carry them. Request bodies have no axum limit:
/// `read_json` enforces each route's cap itself.
fn layered(r: Router) -> Router {
    r.layer(DefaultBodyLimit::disable())
        .layer(CatchPanicLayer::custom(panic_response))
        .layer(axum::middleware::map_response(security_headers))
}

async fn security_headers(mut res: Response) -> Response {
    apply_headers(res.headers_mut());
    res
}

fn panic_response(_: Box<dyn Any + Send + 'static>) -> Response {
    json(
        StatusCode::BAD_GATEWAY,
        &json!({ "error": "internal error" }),
    )
}

async fn dispatch(State(st): State<Arc<AppState>>, req: Request) -> Response {
    if !is_allowed_request(req.headers(), &st.allowed_ports) {
        return json(
            StatusCode::FORBIDDEN,
            &json!({ "error": "forbidden origin" }),
        );
    }
    let url = match RequestUrl::parse(&req.uri().to_string(), st.port) {
        Ok(u) => u,
        Err(message) => return json(StatusCode::BAD_REQUEST, &json!({ "error": message })),
    };
    if req.method() == Method::POST && url.pathname.starts_with("/hook/") {
        // The hook handler arrives in Task 5.
        return StatusCode::NOT_FOUND.into_response();
    }
    if url.pathname.starts_with("/api/") {
        // `routes::dispatch` arrives with the routes (Tasks 3-8).
        return json(StatusCode::NOT_FOUND, &json!({ "error": "not found" }));
    }
    serve_static(&st)
}

/// Until Task 10: the no-dist text when there is no web UI, else 404.
fn serve_static(st: &AppState) -> Response {
    if st.assets.get("index.html").is_none() {
        let text = format!(
            "Office Desks bridge is running. Build the web UI with \"npm run build\", or use \"npm run dev\" and open http://localhost:{DEV_WEB_PORT}"
        );
        let mut res = (StatusCode::OK, text).into_response();
        res.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
        return res;
    }
    StatusCode::NOT_FOUND.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::routing::get;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn a_panic_is_502_with_the_security_headers() {
        async fn boom() -> &'static str {
            panic!("boom")
        }
        let app = layered(Router::new().route("/p", get(boom)));
        let res = app
            .oneshot(Request::builder().uri("/p").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        let h = res.headers();
        assert_eq!(h["content-type"], "application/json");
        for name in [
            "x-frame-options",
            "x-content-type-options",
            "referrer-policy",
            "cross-origin-resource-policy",
            "content-security-policy",
        ] {
            assert!(h.contains_key(name), "{name}");
        }
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], br#"{"error":"internal error"}"#);
    }
}
