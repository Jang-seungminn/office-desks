#![allow(dead_code)]
//! Shared test support: scratch dirs, a raw HTTP client and the fake backend.
//! Also compiled into the `native` test binary, so not every item is used everywhere.

pub mod fake_backend;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request, StatusCode};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client as HyperClient;
use hyper_util::rt::TokioExecutor;
use od_core::backend::OfficeBackend;
use od_server::{MemAssets, ServerConfig, ServerHandle};

use fake_backend::FakeBackend;

/// A response, body fully read.
pub struct Resp {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("JSON body")
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

/// HTTP/1 client for one server. Sends exactly the headers given, plus
/// `Host: 127.0.0.1:<port>` unless the test gives a Host.
pub struct Client {
    pub port: u16,
    inner: HyperClient<HttpConnector, Full<Bytes>>,
}

impl Client {
    pub fn new(port: u16) -> Self {
        let mut connector = HttpConnector::new();
        connector.set_nodelay(true);
        let inner = HyperClient::builder(TokioExecutor::new())
            .set_host(false)
            .build(connector);
        Client { port, inner }
    }

    pub async fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Vec<u8>>,
    ) -> Resp {
        let uri = format!("http://127.0.0.1:{}{}", self.port, path);
        let mut req = Request::builder()
            .method(Method::from_bytes(method.as_bytes()).expect("method"))
            .uri(uri)
            .body(Full::new(Bytes::from(body.unwrap_or_default())))
            .expect("request");
        let h = req.headers_mut();
        for (k, v) in headers {
            h.append(
                HeaderName::from_bytes(k.as_bytes()).expect("header name"),
                HeaderValue::from_bytes(v.as_bytes()).expect("header value"),
            );
        }
        if !h.contains_key("host") {
            h.insert(
                "host",
                HeaderValue::from_str(&format!("127.0.0.1:{}", self.port)).unwrap(),
            );
        }
        let res = tokio::time::timeout(Duration::from_secs(30), self.inner.request(req))
            .await
            .expect("request timed out")
            .expect("request failed");
        let status = res.status();
        let headers = res.headers().clone();
        let body = res
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes()
            .to_vec();
        Resp {
            status,
            headers,
            body,
        }
    }

    pub async fn get(&self, path: &str) -> Resp {
        self.request("GET", path, &[], None).await
    }
}

/// A config whose paths all live in `dir`, with no web UI.
pub fn scratch_config(dir: &std::path::Path) -> ServerConfig {
    ServerConfig {
        tui_active: false,
        poll_interval: Duration::from_millis(1500),
        idle_interval: Duration::from_millis(10_000),
        usage_interval: Duration::from_millis(60_000),
        hire_recheck: Duration::from_millis(2500),
        upload_dir: dir.join("uploads"),
        commands_home: dir.join("home"),
        org_file: dir.join("org.json"),
        awards_file: dir.join("awards.json"),
        default_org: None,
        assets: Arc::new(MemAssets(HashMap::new())),
        app_assets: None,
        ws_buffer: 256,
        term_buffer: 1024,
    }
}

/// A server on a free port with its scratch dir (kept alive as long as this is).
pub struct TestServer {
    pub handle: ServerHandle,
    pub client: Client,
    pub dir: tempfile::TempDir,
}

pub async fn start(backend: Arc<dyn OfficeBackend>) -> TestServer {
    let dir = tempfile::tempdir().expect("scratch dir");
    let cfg = scratch_config(dir.path());
    start_with(backend, cfg, dir).await
}

pub async fn start_with(
    backend: Arc<dyn OfficeBackend>,
    cfg: ServerConfig,
    dir: tempfile::TempDir,
) -> TestServer {
    let bound = od_server::bind(0).await.expect("bind");
    let handle = od_server::serve(bound, backend, cfg).await;
    let client = Client::new(handle.port);
    TestServer {
        handle,
        client,
        dir,
    }
}

pub async fn start_fake() -> TestServer {
    start(Arc::new(FakeBackend::default())).await
}

/// A `/ws` client.
pub type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Open `ws://127.0.0.1:<port><path>`; the handshake's HTTP error on refusal.
pub async fn ws_connect(
    port: u16,
    path: &str,
) -> Result<Ws, tokio_tungstenite::tungstenite::Error> {
    let url = format!("ws://127.0.0.1:{port}{path}");
    tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(url),
    )
    .await
    .expect("ws connect timed out")
    .map(|(ws, _)| ws)
}

/// What a `/ws` client saw next.
#[derive(Debug)]
pub enum WsEvent {
    Json(serde_json::Value),
    /// A close frame, EOF or an error: the connection is over.
    Ended,
    /// Nothing within the wait.
    Quiet,
}

/// The next text message as JSON (pings and pongs are skipped).
pub async fn ws_next(ws: &mut Ws, wait: Duration) -> WsEvent {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        match tokio::time::timeout_at(deadline, ws.next()).await {
            Err(_) => return WsEvent::Quiet,
            Ok(None) | Ok(Some(Err(_))) | Ok(Some(Ok(Message::Close(_)))) => return WsEvent::Ended,
            Ok(Some(Ok(Message::Text(t)))) => {
                return WsEvent::Json(serde_json::from_str(&t).expect("JSON message"))
            }
            Ok(Some(Ok(_))) => {}
        }
    }
}

/// The next message, which must arrive within 5 s.
pub async fn ws_json(ws: &mut Ws) -> serde_json::Value {
    match ws_next(ws, Duration::from_secs(5)).await {
        WsEvent::Json(v) => v,
        other => panic!("expected a message, got {other:?}"),
    }
}

/// Read messages until none arrives for `quiet`; returns them.
pub async fn ws_drain(ws: &mut Ws, quiet: Duration) -> Vec<serde_json::Value> {
    let mut seen = Vec::new();
    loop {
        match ws_next(ws, quiet).await {
            WsEvent::Json(v) => seen.push(v),
            WsEvent::Quiet => return seen,
            WsEvent::Ended => panic!("connection ended while draining"),
        }
    }
}

/// Poll `cond` every 10 ms until it holds; panic with `what` after `wait`.
pub async fn wait_until(what: &str, wait: Duration, mut cond: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + wait;
    while !cond() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The `type` of a `/ws` message.
pub fn msg_type(v: &serde_json::Value) -> &str {
    v["type"].as_str().unwrap_or("")
}
