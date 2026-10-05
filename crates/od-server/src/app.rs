//! The request dispatcher, a port of the `createServer` callback in `server.ts`:
//! guard → URL → `POST /hook/` → `/api/` → static. WS upgrades go before this chain (`/ws`
//! here, `/term/` in Task 9), as Node's `'upgrade'` event never reaches the request handler.

use std::any::Any;
use std::sync::{Arc, Mutex, MutexGuard};

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde_json::json;
use tower_http::catch_panic::CatchPanicLayer;

use od_core::awards::{AwardBook, RawBoard};
use od_core::backend::OfficeBackend;
use od_core::model::{OfficeAgent, OfficeDesk, OfficeSnapshot, OrgChart, UsageSnapshot};
use serde_json::Value;
use tokio::sync::watch;

use crate::assets::Assets;
use crate::hub::Hub;
use crate::poller::Poller;
use crate::reqs::{json, RequestUrl};
use crate::security::{apply_headers, is_allowed_request};
use crate::{routes, ws, ServerConfig, DEV_WEB_PORT};

pub(crate) struct AppState {
    pub port: u16,
    /// `[bound port, 5173]`.
    pub allowed_ports: [u16; 2],
    pub assets: Arc<dyn Assets>,
    pub backend: Arc<dyn OfficeBackend>,
    pub cfg: ServerConfig,
    pub poller: Arc<Poller>,
    pub hub: Arc<Hub>,
    /// The departments (`org` in `server.ts`); empty until `load_org` finishes.
    pub org: Mutex<OrgChart>,
    /// The last plan usage the backend reported (`usage`), None until one is known.
    pub usage: Mutex<Option<UsageSnapshot>>,
    pub awards: Arc<Mutex<AwardBook>>,
    /// Becomes true on `ServerHandle::shutdown` (and errors once every handle is dropped).
    /// Upgraded WS connections outlive the graceful shutdown, so every WS loop and background
    /// task `select!`s on this to end itself.
    pub stop: watch::Receiver<bool>,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl AppState {
    pub fn org(&self) -> OrgChart {
        lock(&self.org).clone()
    }

    pub fn usage(&self) -> Option<UsageSnapshot> {
        lock(&self.usage).clone()
    }

    pub fn awards_board(&self) -> RawBoard {
        lock(&self.awards).current().clone()
    }

    /// `findAgent`: the desk and agent with this id in the current snapshot. A missing id
    /// (`null` in TS) never matches.
    #[expect(dead_code, reason = "used by the routes of Tasks 6-8")]
    pub fn find_agent(&self, agent_id: Option<&str>) -> Option<(OfficeDesk, OfficeAgent)> {
        find_agent_in(&self.poller.current(), agent_id)
    }

    /// `knownHandle`: a string that is the terminal handle of an agent in the office now.
    #[expect(dead_code, reason = "used by the input routes of Task 8")]
    pub fn known_handle(&self, handle: &Value) -> Option<String> {
        known_handle_in(&self.poller.current(), handle)
    }

    /// After a hire: one more refresh once the agent's startup grace has passed, so a trust
    /// dialog shows as waiting right away. Gives up on shutdown.
    pub fn hire_recheck(&self) {
        let (poller, wait, mut stop) = (
            self.poller.clone(),
            self.cfg.hire_recheck,
            self.stop.clone(),
        );
        tokio::spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep(wait) => poller.refresh().await,
                _ = async { let _ = stop.wait_for(|s| *s).await; } => {}
            }
        });
    }

    /// Resolves once the server is stopping (or every handle is gone).
    pub async fn stopped(&self) {
        let mut stop = self.stop.clone();
        let _ = stop.wait_for(|s| *s).await;
    }
}

fn find_agent_in(
    snap: &OfficeSnapshot,
    agent_id: Option<&str>,
) -> Option<(OfficeDesk, OfficeAgent)> {
    let id = agent_id?;
    snap.desks.iter().find_map(|d| {
        d.agents
            .iter()
            .find(|a| a.id == id)
            .map(|a| (d.clone(), a.clone()))
    })
}

fn known_handle_in(snap: &OfficeSnapshot, handle: &Value) -> Option<String> {
    let h = handle.as_str()?;
    snap.desks
        .iter()
        .flat_map(|d| &d.agents)
        .any(|a| a.terminal_handle.as_deref() == Some(h))
        .then(|| h.to_string())
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
    if is_upgrade(req.headers()) {
        return upgrade(st, req).await;
    }
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
        return crate::hook::handle(st, req, url).await;
    }
    if url.pathname.starts_with("/api/") {
        return routes::dispatch(st, req, url).await;
    }
    serve_static(&st)
}

/// Node emits `'upgrade'` (instead of calling the request handler) exactly when `Connection`
/// has an `upgrade` token and `Upgrade` is not empty; `Upgrade` alone is a normal request.
fn is_upgrade(headers: &HeaderMap) -> bool {
    let connection_upgrade = headers.get_all(header::CONNECTION).iter().any(|v| {
        v.as_bytes()
            .split(|&b| b == b',')
            .any(|t| t.trim_ascii().eq_ignore_ascii_case(b"upgrade"))
    });
    connection_upgrade
        && headers
            .get_all(header::UPGRADE)
            .iter()
            .any(|v| !v.as_bytes().trim_ascii().is_empty())
}

/// `req.url === target`: the request-target exactly as sent (origin-form, no query, not even an
/// empty `?`; `Uri == &str` would ignore an empty query).
fn is_raw_target(uri: &axum::http::Uri, target: &str) -> bool {
    uri.scheme().is_none()
        && uri.authority().is_none()
        && uri.path_and_query().map(|p| p.as_str()) == Some(target)
}

/// The `'upgrade'` handler: only the raw target `/ws` (no query, as TS compares `req.url`) with
/// a passing guard is accepted. TS destroys the socket of anything else; this answers 403
/// `forbidden origin` and closes, which a client sees as the same failed handshake.
async fn upgrade(st: Arc<AppState>, req: Request) -> Response {
    let allowed = is_allowed_request(req.headers(), &st.allowed_ports);
    if allowed && is_raw_target(req.uri(), "/ws") {
        return ws::upgrade(st, req).await;
    }
    let mut res = json(
        StatusCode::FORBIDDEN,
        &json!({ "error": "forbidden origin" }),
    );
    res.headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    res
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

    fn office() -> OfficeSnapshot {
        let agent = |id: &str, handle: Option<&str>| {
            json!({
                "id": id, "terminalHandle": handle, "agentType": "claude", "terminalTitle": null,
                "subagentsRunning": 0, "model": null, "effort": null, "stats": null,
                "state": "done", "rawState": "", "activity": "", "prompt": null,
                "lastMessage": null, "since": null
            })
        };
        let desk = |id: &str, agents: Vec<serde_json::Value>| {
            json!({
                "id": id, "repoId": "r", "isMain": true, "parentId": null, "name": id,
                "repo": "repo", "branch": "main", "path": "/x", "status": "",
                "workspaceStatus": null, "comment": "", "preview": "", "isActive": false,
                "unread": false, "lastActivityAt": null, "changes": null, "pr": null,
                "agents": agents
            })
        };
        serde_json::from_value(json!({
            "desks": [
                desk("d1", vec![agent("a1", None)]),
                desk("d2", vec![agent("a2", Some("pty_2")), agent("a3", Some("pty_3"))]),
            ],
            "updatedAt": 0,
            "error": null
        }))
        .unwrap()
    }

    #[test]
    fn find_agent_matches_by_id_only() {
        let snap = office();
        let (d, a) = find_agent_in(&snap, Some("a3")).unwrap();
        assert_eq!((d.id.as_str(), a.id.as_str()), ("d2", "a3"));
        assert!(find_agent_in(&snap, Some("nope")).is_none());
        assert!(find_agent_in(&snap, None).is_none());
    }

    #[test]
    fn known_handle_needs_a_string_handle_in_the_office() {
        let snap = office();
        assert_eq!(
            known_handle_in(&snap, &json!("pty_3")).as_deref(),
            Some("pty_3")
        );
        assert!(known_handle_in(&snap, &json!("pty_9")).is_none());
        assert!(known_handle_in(&snap, &json!(null)).is_none());
        assert!(known_handle_in(&snap, &json!(3)).is_none());
    }

    #[test]
    fn upgrade_needs_a_connection_token_and_a_non_empty_upgrade() {
        let h = |pairs: &[(&'static str, &'static str)]| {
            let mut m = HeaderMap::new();
            for (k, v) in pairs {
                m.append(*k, HeaderValue::from_static(v));
            }
            m
        };
        assert!(is_upgrade(&h(&[
            ("connection", "Upgrade"),
            ("upgrade", "websocket")
        ])));
        assert!(is_upgrade(&h(&[
            ("connection", "keep-alive, UPGRADE"),
            ("upgrade", "foo")
        ])));
        assert!(is_upgrade(&h(&[
            ("connection", "keep-alive"),
            ("connection", "upgrade"),
            ("upgrade", "websocket")
        ])));
        assert!(!is_upgrade(&h(&[("upgrade", "websocket")])));
        assert!(!is_upgrade(&h(&[("connection", "Upgrade")])));
        assert!(!is_upgrade(&h(&[
            ("connection", "Upgrade"),
            ("upgrade", "")
        ])));
        assert!(!is_upgrade(&h(&[
            ("connection", "upgraded"),
            ("upgrade", "websocket")
        ])));
    }

    #[test]
    fn only_the_raw_target_ws_is_accepted() {
        let uri = |s: &str| s.parse::<axum::http::Uri>().unwrap();
        assert!(is_raw_target(&uri("/ws"), "/ws"));
        for other in [
            "/ws?",
            "/ws?x=1",
            "/ws/",
            "/WS",
            "http://127.0.0.1/ws",
            "/./ws",
        ] {
            assert!(!is_raw_target(&uri(other), "/ws"), "{other}");
        }
    }

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
