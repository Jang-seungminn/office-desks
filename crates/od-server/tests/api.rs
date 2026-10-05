//! od-server against a `FakeBackend`, over real HTTP.

mod support;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use od_server::MemAssets;
use support::{scratch_config, start_fake, start_with};

const SECURITY_HEADERS: [&str; 5] = [
    "x-frame-options",
    "x-content-type-options",
    "referrer-policy",
    "cross-origin-resource-policy",
    "content-security-policy",
];

fn assert_security_headers(r: &support::Resp) {
    assert_eq!(r.header("x-frame-options"), Some("DENY"));
    assert_eq!(r.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(r.header("referrer-policy"), Some("no-referrer"));
    assert_eq!(
        r.header("cross-origin-resource-policy"),
        Some("same-origin")
    );
    assert_eq!(
        r.header("content-security-policy"),
        Some(
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; \
             connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; \
             object-src 'none'"
        )
    );
    for name in SECURITY_HEADERS {
        assert_eq!(r.headers.get_all(name).iter().count(), 1, "{name}");
    }
}

#[tokio::test]
async fn foreign_host_is_403_with_security_headers() {
    let s = start_fake().await;
    let host = format!("evil.example:{}", s.handle.port);
    let r = s
        .client
        .request("GET", "/api/snapshot", &[("host", &host)], None)
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.header("content-type"), Some("application/json"));
    assert_eq!(r.body, br#"{"error":"forbidden origin"}"#);
    assert_security_headers(&r);
}

#[tokio::test]
async fn cross_site_origin_is_403() {
    let s = start_fake().await;
    let r = s
        .client
        .request("GET", "/", &[("origin", "https://evil.example")], None)
        .await;
    assert_eq!(r.status, 403);
    // The dev web server's origin is allowed next to the bound port.
    let r = s
        .client
        .request("GET", "/", &[("origin", "http://localhost:5173")], None)
        .await;
    assert_eq!(r.status, 200);
}

#[tokio::test]
async fn root_without_dist_is_the_no_dist_text() {
    let s = start_fake().await;
    let r = s.client.get("/").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-type"), Some("text/plain; charset=utf-8"));
    assert_eq!(
        r.text(),
        "Office Desks bridge is running. Build the web UI with \"npm run build\", or use \"npm run dev\" and open http://localhost:5173"
    );
    assert_security_headers(&r);
}

#[tokio::test]
async fn static_with_dist_is_404_until_task_10() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = scratch_config(dir.path());
    cfg.assets = Arc::new(MemAssets(HashMap::from([(
        "index.html".to_string(),
        b"<!doctype html>".to_vec(),
    )])));
    let s = start_with(
        Arc::new(support::fake_backend::FakeBackend::default()),
        cfg,
        dir,
    )
    .await;
    assert_eq!(s.client.get("/").await.status, 404);
}

#[tokio::test]
async fn unknown_post_api_is_404_not_found() {
    let s = start_fake().await;
    let r = s
        .client
        .request(
            "POST",
            "/api/nope",
            &[("content-type", "application/json")],
            Some(b"{}".to_vec()),
        )
        .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.header("content-type"), Some("application/json"));
    assert_eq!(r.body, br#"{"error":"not found"}"#);
    assert_security_headers(&r);
}

async fn hook_post(s: &support::TestServer, path: &str, body: Vec<u8>) -> support::Resp {
    // No content-type on purpose: /hook does not need one.
    s.client.request("POST", path, &[], Some(body)).await
}

#[tokio::test]
async fn hook_true_is_204_and_refreshes() {
    let fake = Arc::new(FakeBackend::default());
    *fake.hook.lock().unwrap() = true;
    let s = start_cfg(&fake, |_| {}).await;
    s.handle.poller().refresh().await; // let the startup poll finish first
    let before = fake.calls_of("snapshot").len();
    let r = hook_post(&s, "/hook/a%2Fb%3Amain?token=tok", br#"{"x":1}"#.to_vec()).await;
    assert_eq!(r.status, 204);
    assert!(r.body.is_empty());
    assert_security_headers(&r);
    // The refresh was awaited: its poll has already run, with no waiting.
    assert!(fake.calls_of("snapshot").len() > before);
    assert_eq!(fake.calls_of("hook"), vec![r#"hook a/b:main tok {"x":1}"#]);
}

#[tokio::test]
async fn hook_false_is_bare_404_and_a_missing_token_is_empty() {
    let fake = Arc::new(FakeBackend::default());
    let s = start_cfg(&fake, |_| {}).await;
    let r = hook_post(&s, "/hook/x", b"null".to_vec()).await;
    assert_eq!(r.status, 404);
    assert!(r.body.is_empty());
    assert_security_headers(&r);
    assert_eq!(fake.calls_of("hook"), vec!["hook x  null"]);
}

#[tokio::test]
async fn hook_bad_bodies_and_ids_are_bare_400() {
    let fake = Arc::new(FakeBackend::default());
    *fake.hook.lock().unwrap() = true;
    let s = start_cfg(&fake, |_| {}).await;
    for (path, body) in [
        ("/hook/x", b"{".to_vec()),
        ("/hook/x", Vec::new()),
        ("/hook/%E0%A4%A", b"{}".to_vec()),
    ] {
        let r = hook_post(&s, path, body).await;
        assert_eq!(r.status, 400, "{path}");
        assert!(r.body.is_empty());
        assert_security_headers(&r);
    }
    // Exactly at the 2 MiB cap passes; one byte over is 400.
    let cap = 2 * 1024 * 1024;
    let pad = |n: usize| {
        let mut b = b"[".to_vec();
        b.extend(std::iter::repeat_n(b' ', n - 2));
        b.push(b']');
        b
    };
    assert_eq!(hook_post(&s, "/hook/x", pad(cap)).await.status, 204);
    let r = hook_post(&s, "/hook/x", pad(cap + 1)).await;
    assert_eq!(r.status, 400);
    assert!(r.body.is_empty());
    assert_eq!(fake.calls_of("hook").len(), 1);
}

#[tokio::test]
async fn hook_skips_the_api_gate_chain_but_not_the_origin_guard() {
    let fake = Arc::new(FakeBackend::default());
    *fake.hook.lock().unwrap() = true;
    let s = start_cfg(&fake, |_| {}).await;
    // A non-JSON content-type is fine.
    let r = s
        .client
        .request(
            "POST",
            "/hook/x",
            &[("content-type", "text/plain")],
            Some(b"{}".to_vec()),
        )
        .await;
    assert_eq!(r.status, 204);
    // The guard still applies.
    let host = format!("evil.example:{}", s.handle.port);
    let r = s
        .client
        .request("POST", "/hook/x", &[("host", &host)], Some(b"{}".to_vec()))
        .await;
    assert_eq!(r.status, 403);
    assert_eq!(fake.calls_of("hook").len(), 1);
}

#[tokio::test]
async fn get_hook_is_static_not_the_hook() {
    let fake = Arc::new(FakeBackend::default());
    *fake.hook.lock().unwrap() = true;
    let s = start_cfg(&fake, |_| {}).await;
    let r = s.client.get("/hook/x").await;
    assert_eq!(r.status, 200);
    assert!(String::from_utf8_lossy(&r.body).contains("Office Desks bridge is running"));
    assert!(fake.calls_of("hook").is_empty());
}

#[tokio::test]
async fn shutdown_is_idempotent_and_closes() {
    let s = start_fake().await;
    assert_eq!(s.client.get("/").await.status, 200);
    let port = s.handle.port;
    drop(s.client);
    let (a, b) = tokio::join!(s.handle.shutdown(), s.handle.shutdown());
    let _ = (a, b);
    tokio::time::timeout(Duration::from_secs(10), s.handle.closed())
        .await
        .expect("accept loop ended");
    s.handle.shutdown().await;
    s.handle.closed().await;
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_err());
    assert_eq!(s.handle.term_token.len(), 32);
}

#[test]
fn hook_url_encodes_the_agent_id() {
    let f = od_server::hook_url(1234);
    assert_eq!(
        f("wt/a b:main", "tok"),
        "http://127.0.0.1:1234/hook/wt%2Fa%20b%3Amain?token=tok"
    );
}

#[tokio::test]
async fn native_backend_uses_the_scratch_home() {
    let dir = tempfile::tempdir().unwrap();
    let scratch = |name: &str| {
        let p = dir.path().join(name);
        std::fs::create_dir_all(&p).unwrap();
        p.to_string_lossy().into_owned()
    };
    let env = HashMap::from([
        ("OFFICE_DESKS_HOME".to_string(), scratch("office")),
        ("HOME".to_string(), scratch("home")),
        ("USERPROFILE".to_string(), scratch("home")),
        ("CLAUDE_CONFIG_DIR".to_string(), scratch("claude")),
    ]);
    let b = od_server::native_backend(&env, 1).await;
    use od_core::backend::OfficeBackend;
    assert_eq!(b.name(), "native");
    b.dispose().await;
}

// ---- Task 3: gates, snapshot, /ws, poller, enrichment ----

use od_core::backend::{BackendCapabilities, OfficeBackend};
use od_core::model::{DeskChanges, UsageProvider, UsageSnapshot, UsageWindow};
use od_server::ServerMessageJson;
use support::fake_backend::{agent, desk, no_capabilities, office, FakeBackend};
use support::{msg_type, wait_until, ws_connect, ws_drain, ws_json, ws_next, WsEvent};

const QUIET: Duration = Duration::from_millis(300);

/// A server on `fake` with a tweaked scratch config.
async fn start_cfg(
    fake: &Arc<FakeBackend>,
    tweak: impl FnOnce(&mut od_server::ServerConfig),
) -> support::TestServer {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = scratch_config(dir.path());
    tweak(&mut cfg);
    let backend: Arc<dyn OfficeBackend> = fake.clone();
    start_with(backend, cfg, dir).await
}

fn with_caps(caps: BackendCapabilities) -> Arc<FakeBackend> {
    Arc::new(FakeBackend {
        capabilities: caps,
        ..FakeBackend::default()
    })
}

fn usage(updated_at: i64) -> UsageSnapshot {
    UsageSnapshot {
        providers: vec![UsageProvider {
            provider: "claude".into(),
            windows: vec![UsageWindow {
                key: "five_hour".into(),
                label: "5h".into(),
                used_percent: 12.0,
                resets_at: None,
                reset_description: None,
            }],
        }],
        updated_at,
    }
}

#[tokio::test]
async fn api_gates() {
    let s = start_fake().await;
    let r = s.client.get("/api/nope").await;
    assert_eq!(r.status, 405);
    assert_eq!(r.body, br#"{"error":"method not allowed"}"#);
    assert_eq!(r.header("content-type"), Some("application/json"));

    let r = s.client.request("HEAD", "/api/snapshot", &[], None).await;
    assert_eq!(r.status, 405);
    assert!(r.body.is_empty());

    for headers in [vec![], vec![("content-type", "text/plain")]] {
        let r = s
            .client
            .request("POST", "/api/send", &headers, Some(b"{}".to_vec()))
            .await;
        assert_eq!(r.status, 415, "{headers:?}");
        assert_eq!(r.body, br#"{"error":"expected application/json"}"#);
    }
    // Case-sensitive, like `startsWith`.
    let r = s
        .client
        .request(
            "POST",
            "/api/send",
            &[("content-type", "Application/JSON")],
            Some(b"{}".to_vec()),
        )
        .await;
    assert_eq!(r.status, 415);
}

#[tokio::test]
async fn snapshot_and_org() {
    let s = start_fake().await;
    let r = s.client.get("/api/snapshot").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-type"), Some("application/json"));
    let v = r.json();
    assert_eq!(v["desks"], serde_json::json!([]));
    assert_eq!(v["error"], serde_json::Value::Null);
    let r = s.client.get("/api/org").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, br#"{"departments":[]}"#);
}

#[tokio::test]
async fn ws_initial_messages_without_usage() {
    let fake = Arc::new(FakeBackend::default());
    let s = start_cfg(&fake, |_| {}).await;
    let mut ws = ws_connect(s.handle.port, "/ws").await.unwrap();
    let mut seen = Vec::new();
    for _ in 0..4 {
        seen.push(ws_json(&mut ws).await);
    }
    let types: Vec<_> = seen.iter().map(msg_type).collect();
    assert_eq!(types, ["backend", "snapshot", "org", "awards"]);
    assert_eq!(
        seen[0],
        serde_json::json!({
            "type": "backend",
            "backend": { "name": "fake", "capabilities": serde_json::to_value(no_capabilities()).unwrap() }
        })
    );
    assert_eq!(seen[2]["org"], serde_json::json!({ "departments": [] }));
    assert_eq!(
        seen[3]["awards"],
        serde_json::json!({ "leader": null, "hall": [] })
    );
    // No usage message ever comes when the backend has none.
    assert!(ws_drain(&mut ws, QUIET)
        .await
        .iter()
        .all(|m| msg_type(m) != "usage"));
}

#[tokio::test]
async fn usage_is_polled_at_start_and_sent_third() {
    let fake = Arc::new(FakeBackend::default());
    fake.set_usage(Some(usage(7)));
    let s = start_cfg(&fake, |c| c.usage_interval = Duration::from_secs(3600)).await;
    // The first poll is at start, not after an hour: a client sees usage without waiting.
    let mut first = ws_connect(s.handle.port, "/ws").await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        match ws_next(&mut first, deadline - tokio::time::Instant::now()).await {
            WsEvent::Json(m) if msg_type(&m) == "usage" => {
                assert_eq!(m["usage"]["updatedAt"], 7);
                assert_eq!(m["usage"]["providers"][0]["windows"][0]["usedPercent"], 12);
                break;
            }
            WsEvent::Json(_) => {}
            other => panic!("no usage message: {other:?}"),
        }
    }
    // Once known, usage is the third initial message.
    let mut second = ws_connect(s.handle.port, "/ws").await.unwrap();
    let mut types = Vec::new();
    for _ in 0..5 {
        types.push(msg_type(&ws_json(&mut second).await).to_string());
    }
    assert_eq!(types, ["backend", "snapshot", "usage", "org", "awards"]);
    assert_eq!(fake.calls_of("usage").len(), 1);
}

#[tokio::test]
async fn snapshot_changes_are_broadcast_once() {
    let fake = Arc::new(FakeBackend::default());
    let s = start_cfg(&fake, |c| c.poll_interval = Duration::from_millis(20)).await;
    let mut ws = ws_connect(s.handle.port, "/ws").await.unwrap();
    ws_drain(&mut ws, QUIET).await;

    fake.set_snapshot(Ok(office(vec![desk("d1", "/nowhere", vec![])])));
    let m = ws_json(&mut ws).await;
    assert_eq!(msg_type(&m), "snapshot");
    assert_eq!(m["snapshot"]["desks"][0]["id"], "d1");
    // Many more polls of the same office: nothing new is sent.
    let polls = fake.calls_of("snapshot").len();
    let rest = ws_drain(&mut ws, QUIET).await;
    assert!(fake.calls_of("snapshot").len() > polls + 3);
    assert!(rest.is_empty(), "{rest:?}");

    // An error is a change too, and keeps the desks.
    fake.set_snapshot(Err(od_core::backend::BackendError::plain("orca down")));
    let m = ws_json(&mut ws).await;
    assert_eq!(m["snapshot"]["error"], "orca down");
    assert_eq!(m["snapshot"]["desks"][0]["id"], "d1");
}

#[tokio::test]
async fn rejected_upgrades_are_403() {
    let s = start_fake().await;
    for path in ["/ws?x=1", "/ws?", "/other", "/api/snapshot", "/term/x"] {
        match ws_connect(s.handle.port, path).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(res)) => {
                assert_eq!(res.status(), 403, "{path}");
                assert_eq!(
                    res.body().as_deref(),
                    Some(&br#"{"error":"forbidden origin"}"#[..]),
                    "{path}"
                );
            }
            other => panic!("{path}: expected a 403, got {other:?}"),
        }
    }
    // The guard applies to /ws itself.
    let mut req = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
        format!("ws://127.0.0.1:{}/ws", s.handle.port),
    )
    .unwrap();
    req.headers_mut()
        .insert("origin", "https://evil.example".parse().unwrap());
    match tokio_tungstenite::connect_async(req).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(res)) => assert_eq!(res.status(), 403),
        other => panic!("expected a 403, got {other:?}"),
    }
}

#[tokio::test]
async fn upgrade_header_without_connection_upgrade_is_a_normal_request() {
    let s = start_fake().await;
    let r = s
        .client
        .request("GET", "/api/snapshot", &[("upgrade", "websocket")], None)
        .await;
    assert_eq!(r.status, 200);
}

#[tokio::test]
async fn plain_get_ws_is_static() {
    let s = start_fake().await;
    let r = s.client.get("/ws").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-type"), Some("text/plain; charset=utf-8"));
}

#[tokio::test]
async fn poller_idles_after_the_last_client_closes() {
    let s = start_fake().await;
    let poller = Arc::clone(s.handle.poller());
    assert!(poller.is_idle(), "idle until a browser connects");
    let mut a = ws_connect(s.handle.port, "/ws").await.unwrap();
    let mut b = ws_connect(s.handle.port, "/ws").await.unwrap();
    ws_json(&mut a).await;
    ws_json(&mut b).await;
    wait_until("two clients", Duration::from_secs(2), || {
        s.handle.hub().clients() == 2
    })
    .await;
    assert!(!poller.is_idle());
    a.close(None).await.unwrap();
    wait_until("one client", Duration::from_secs(2), || {
        s.handle.hub().clients() == 1
    })
    .await;
    assert!(!poller.is_idle());
    b.close(None).await.unwrap();
    wait_until("idle after the last client", Duration::from_secs(2), || {
        poller.is_idle()
    })
    .await;
    assert_eq!(s.handle.hub().clients(), 0);
}

#[tokio::test]
async fn tui_active_never_idles() {
    let fake = Arc::new(FakeBackend::default());
    let s = start_cfg(&fake, |c| c.tui_active = true).await;
    assert!(!s.handle.poller().is_idle());
    let mut ws = ws_connect(s.handle.port, "/ws").await.unwrap();
    ws_json(&mut ws).await;
    ws.close(None).await.unwrap();
    wait_until("client gone", Duration::from_secs(2), || {
        s.handle.hub().clients() == 0
    })
    .await;
    assert!(!s.handle.poller().is_idle());
}

// Deterministic only on the default current-thread runtime: the flood below never yields, so the
// server's client task cannot read the hub in between. Do not make this `multi_thread`.
#[tokio::test]
async fn a_lagged_client_gets_a_full_resend() {
    let fake = Arc::new(FakeBackend::default());
    let s = start_cfg(&fake, |c| c.ws_buffer = 2).await;
    let mut ws = ws_connect(s.handle.port, "/ws").await.unwrap();
    ws_drain(&mut ws, QUIET).await;
    for i in 1..=10 {
        s.handle
            .hub()
            .send(&ServerMessageJson::Usage { usage: usage(i) });
    }
    // The lagged client skips the queued messages and gets the current state instead.
    let mut got = Vec::new();
    for _ in 0..3 {
        got.push(ws_json(&mut ws).await);
    }
    let types: Vec<_> = got.iter().map(msg_type).collect();
    assert_eq!(types, ["snapshot", "org", "awards"]);
    assert!(ws_drain(&mut ws, QUIET).await.is_empty());
}

#[tokio::test]
async fn shutdown_ends_ws_clients() {
    let s = start_fake().await;
    let mut ws = ws_connect(s.handle.port, "/ws").await.unwrap();
    ws_drain(&mut ws, QUIET).await;
    s.handle.shutdown().await;
    match ws_next(&mut ws, Duration::from_secs(2)).await {
        WsEvent::Ended => {}
        other => panic!("the client was not closed: {other:?}"),
    }
    tokio::time::timeout(Duration::from_secs(5), s.handle.closed())
        .await
        .expect("closed");
}

#[tokio::test]
async fn changes_capability_off_leaves_changes_untouched() {
    let fake = Arc::new(FakeBackend::default());
    let mut d = desk("d1", "/nowhere", vec![]);
    d.changes = Some(DeskChanges {
        files: 7,
        added: 1,
        deleted: 2,
    });
    fake.set_snapshot(Ok(office(vec![d])));
    let s = start_cfg(&fake, |c| c.poll_interval = Duration::from_millis(20)).await;
    let poller = Arc::clone(s.handle.poller());
    poller.refresh().await;
    let r = s.client.get("/api/snapshot").await.json();
    assert_eq!(
        r["desks"][0]["changes"],
        serde_json::json!({ "files": 7, "added": 1, "deleted": 2 })
    );
}

#[tokio::test]
async fn transcripts_capability_off_skips_find_session() {
    let fake = Arc::new(FakeBackend::default());
    fake.set_snapshot(Ok(office(vec![desk(
        "d1",
        "/nowhere",
        vec![agent("a1", Some("pty_1"))],
    )])));
    let s = start_cfg(&fake, |c| c.poll_interval = Duration::from_millis(20)).await;
    for _ in 0..3 {
        s.handle.poller().refresh().await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(fake.calls_of("snapshot").len() >= 3);
    assert!(fake.calls_of("find_session").is_empty());
    assert!(fake.calls_of("cached_session").is_empty());
}

#[tokio::test]
async fn transcripts_fill_model_effort_and_stats() {
    let fake = with_caps(BackendCapabilities {
        transcripts: true,
        ..no_capabilities()
    });
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("session.jsonl");
    std::fs::copy(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../bridge/test/fixtures/claude-rich.jsonl"
        ),
        &file,
    )
    .unwrap();
    fake.set_session(Some(file.to_string_lossy().into_owned()));
    let mut codex = agent("a2", None);
    codex.agent_type = "codex".into();
    let mut shell = agent("a3", None);
    shell.agent_type = "shell".into();
    fake.set_snapshot(Ok(office(vec![desk(
        "d1",
        "/nowhere",
        vec![agent("a1", Some("pty_1")), codex, shell],
    )])));
    let s = start_cfg(&fake, |_| {}).await;
    s.handle.poller().refresh().await;
    let snap = s.handle.poller().current();
    let a1 = &snap.desks[0].agents[0];
    assert_eq!(a1.model.as_deref(), Some("claude-opus-5-5"));
    assert_eq!(a1.effort.as_deref(), Some("high"));
    assert!(a1.stats.is_some());
    assert!(snap.desks[0].agents[1].stats.is_some(), "codex too");
    assert!(snap.desks[0].agents[2].stats.is_none(), "not a shell");
    wait_until("background find_session", Duration::from_secs(2), || {
        fake.calls_of("find_session").len() >= 2
    })
    .await;
    assert!(fake
        .calls_of("find_session")
        .iter()
        .all(|c| c != "find_session a3"));
}

// ---- Task 4: POST plumbing and the management routes ----

use od_core::backend::BackendError;

const JSON_CT: [(&str, &str); 1] = [("content-type", "application/json")];

async fn post(s: &support::TestServer, path: &str, body: &str) -> support::Resp {
    s.client
        .request("POST", path, &JSON_CT, Some(body.as_bytes().to_vec()))
        .await
}

fn err_of(fake: &FakeBackend, method: &'static str, e: BackendError) {
    fake.errors.lock().unwrap().insert(method, e);
}

/// A server whose snapshot has desk `d1`, already polled.
async fn with_desk(caps: BackendCapabilities) -> (Arc<FakeBackend>, support::TestServer) {
    let fake = with_caps(caps);
    fake.set_snapshot(Ok(office(vec![desk("d1", "/nowhere", vec![])])));
    let s = start_cfg(&fake, |c| c.hire_recheck = Duration::from_millis(50)).await;
    s.handle.poller().refresh().await;
    (fake, s)
}

fn error_of(r: &support::Resp) -> String {
    r.json()["error"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn hire_disabled_is_400_with_the_backend_text() {
    let (_f, s) = with_desk(no_capabilities()).await;
    let r = post(&s, "/api/hire", r#"{"agent":"claude","deskId":"d1"}"#).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.body, br#"{"error":"hire disabled"}"#);
    // The capability check comes before the null-body TypeError.
    let r = post(&s, "/api/hire", "null").await;
    assert_eq!(r.status, 400);
}

#[tokio::test]
async fn hire_errors_and_success() {
    let caps = BackendCapabilities {
        hire: true,
        ..no_capabilities()
    };
    let (fake, s) = with_desk(caps).await;
    let r = post(&s, "/api/hire", "null").await;
    assert_eq!(r.status, 502);
    assert_eq!(
        r.body,
        br#"{"error":"Cannot read properties of null (reading 'agent')"}"#
    );
    // Non-string agent is unknown; a validation message is a 400.
    let r = post(&s, "/api/hire", r#"{"agent":5}"#).await;
    assert_eq!(
        (r.status.as_u16(), error_of(&r)),
        (400, "지원하지 않는 에이전트입니다".into())
    );
    // deskId null selects the worktree path and matches nothing.
    let r = post(&s, "/api/hire", r#"{"agent":"claude","deskId":null}"#).await;
    assert_eq!(error_of(&r), "알 수 없는 워크트리입니다");
    assert!(fake.calls_of("hire").is_empty());

    err_of(
        &fake,
        "hire",
        BackendError::with_code("ro", "terminal_not_writable"),
    );
    let r = post(&s, "/api/hire", r#"{"agent":"claude","deskId":"d1"}"#).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.body, br#"{"error":"ro"}"#);
    fake.errors.lock().unwrap().clear();

    let before = fake.calls_of("snapshot").len();
    let r = post(
        &s,
        "/api/hire",
        r#"{"agent":"claude","deskId":"d1","prompt":"hi"}"#,
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, br#"{"ok":true}"#);
    assert_eq!(fake.calls_of("hire").len(), 2);
    // One refresh now and one at hire_recheck (50 ms here; the poll interval is 1.5 s).
    wait_until("two refreshes after a hire", Duration::from_secs(3), || {
        fake.calls_of("snapshot").len() >= before + 2
    })
    .await;
}

#[tokio::test]
async fn repos_route() {
    let (fake, s) = with_desk(no_capabilities()).await;
    let r = post(&s, "/api/repos", "null").await;
    assert_eq!(r.status, 400);
    assert_eq!(
        error_of(&r),
        "이 백엔드에서는 여기서 프로젝트를 추가할 수 없어요"
    );

    let caps = BackendCapabilities {
        repos: true,
        ..no_capabilities()
    };
    let (fake2, s2) = with_desk(caps).await;
    drop((fake, s));
    let r = post(&s2, "/api/repos", "null").await;
    assert_eq!(r.status, 502);
    assert_eq!(
        error_of(&r),
        "Cannot read properties of null (reading 'path')"
    );
    for body in [r#"{}"#, r#"{"path":5}"#, r#"{"path":"   "}"#] {
        let r = post(&s2, "/api/repos", body).await;
        assert_eq!(
            (r.status.as_u16(), error_of(&r)),
            (400, "저장소 경로를 입력해 주세요".into()),
            "{body}"
        );
    }
    // The cap counts the untrimmed string.
    let path = "a".repeat(999);
    let r = post(&s2, "/api/repos", &format!(r#"{{"path":"  {path}  "}}"#)).await;
    assert_eq!(r.status, 400);
    assert!(fake2.calls_of("add_repo").is_empty());
    let r = post(&s2, "/api/repos", &format!(r#"{{"path":"{path}"}}"#)).await;
    assert_eq!(r.status, 200);
    assert_eq!(fake2.calls_of("add_repo"), vec![format!("add_repo {path}")]);
    let r = post(&s2, "/api/repos", r#"{"path":"  /x/y \n"}"#).await;
    assert_eq!(r.status, 200);
    assert_eq!(fake2.calls_of("add_repo")[1], "add_repo /x/y");

    err_of(&fake2, "add_repo", BackendError::plain("boom"));
    let r = post(&s2, "/api/repos", r#"{"path":"/x"}"#).await;
    assert_eq!(r.status, 502);
    assert_eq!(r.body, br#"{"error":"boom"}"#);
    err_of(
        &fake2,
        "add_repo",
        BackendError::with_code("nope", "not_a_repo"),
    );
    let r = post(&s2, "/api/repos", r#"{"path":"/x"}"#).await;
    assert_eq!(r.status, 400);
    assert_eq!(
        r.body,
        "{\"error\":\"nope\",\"code\":\"not_a_repo\"}".as_bytes()
    );
}

#[tokio::test]
async fn worktree_route() {
    let caps = BackendCapabilities {
        board: true,
        ..no_capabilities()
    };
    let (fake, s) = with_desk(caps).await;
    let unknown = br#"{"error":"unknown worktree"}"#;
    assert_eq!(post(&s, "/api/worktree", "{}").await.body, unknown);
    assert_eq!(
        post(&s, "/api/worktree", r#"{"deskId":1}"#).await.body,
        unknown
    );
    let r = post(&s, "/api/worktree", "null").await;
    assert_eq!(r.status, 502);
    assert_eq!(
        error_of(&r),
        "Cannot read properties of null (reading 'deskId')"
    );
    let r = post(&s, "/api/worktree", r#"{"deskId":"d1"}"#).await;
    assert_eq!(
        (r.status.as_u16(), error_of(&r)),
        (400, "nothing to change".into())
    );
    let r = post(
        &s,
        "/api/worktree",
        r#"{"deskId":"d1","workspaceStatus":"Bad"}"#,
    )
    .await;
    assert_eq!(
        (r.status.as_u16(), error_of(&r)),
        (400, "invalid status".into())
    );
    let r = post(
        &s,
        "/api/worktree",
        r#"{"deskId":"d1","workspaceStatus":"-a"}"#,
    )
    .await;
    assert_eq!(error_of(&r), "invalid status");
    let long = "a".repeat(41);
    let r = post(
        &s,
        "/api/worktree",
        &format!(r#"{{"deskId":"d1","workspaceStatus":"{long}"}}"#),
    )
    .await;
    assert_eq!(error_of(&r), "invalid status");
    assert!(fake.calls_of("set_board").is_empty());

    let r = post(
        &s,
        "/api/worktree",
        r#"{"deskId":"d1","workspaceStatus":1}"#,
    )
    .await;
    assert_eq!(
        (r.status.as_u16(), r.body.as_slice()),
        (200, &br#"{"ok":true}"#[..])
    );
    assert_eq!(
        fake.calls_of("set_board")[0],
        r#"set_board d1 {"workspaceStatus":"1"}"#
    );
    let r = post(&s, "/api/worktree", r#"{"deskId":"d1","comment":[1,2]}"#).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        fake.calls_of("set_board")[1],
        r#"set_board d1 {"comment":"1,2"}"#
    );
    let r = post(
        &s,
        "/api/worktree",
        r#"{"deskId":"d1","comment":"  a \n\t b  "}"#,
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        fake.calls_of("set_board")[2],
        r#"set_board d1 {"comment":"a b"}"#
    );

    let ok200 = "가".repeat(200);
    let r = post(
        &s,
        "/api/worktree",
        &format!(r#"{{"deskId":"d1","comment":"{ok200}"}}"#),
    )
    .await;
    assert_eq!(r.status, 200);
    let r = post(
        &s,
        "/api/worktree",
        &format!(r#"{{"deskId":"d1","comment":"{ok200}가"}}"#),
    )
    .await;
    assert_eq!(
        (r.status.as_u16(), error_of(&r)),
        (400, "코멘트는 200자까지 쓸 수 있어요".into())
    );

    err_of(
        &fake,
        "set_board",
        BackendError::with_code("ro", "terminal_not_writable"),
    );
    let r = post(&s, "/api/worktree", r#"{"deskId":"d1","comment":"x"}"#).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.body, br#"{"error":"ro","code":"terminal_not_writable"}"#);
}

#[tokio::test]
async fn worktree_without_board_or_desks() {
    let (_f, s) = with_desk(no_capabilities()).await;
    let r = post(&s, "/api/worktree", r#"{"deskId":"d1","comment":"x"}"#).await;
    assert_eq!(r.status, 404);
    // No desks at all: a null body is 404, not the TypeError (the find callback never runs).
    let s = start_fake().await;
    let r = post(&s, "/api/worktree", "null").await;
    assert_eq!(
        (r.status.as_u16(), error_of(&r)),
        (404, "unknown worktree".into())
    );
}

#[tokio::test]
async fn org_post_saves_broadcasts_and_ignores_content_type() {
    let s = start_fake().await;
    let mut ws = ws_connect(s.handle.port, "/ws").await.unwrap();
    ws_drain(&mut ws, QUIET).await;
    let body =
        br#"{"departments":[{"id":"d-a","name":" Dev  Team ","theme":"x","repoIds":["r1"]}]}"#;
    let r = s
        .client
        .request(
            "POST",
            "/api/org",
            &[("content-type", "text/plain")],
            Some(body.to_vec()),
        )
        .await;
    assert_eq!(r.status, 200);
    let org = r.json();
    assert_eq!(org["departments"][0]["name"], "Dev Team");
    let m = ws_json(&mut ws).await;
    assert_eq!(msg_type(&m), "org");
    assert_eq!(m["org"], org);
    assert_eq!(s.client.get("/api/org").await.json(), org);
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(s.dir.path().join("org.json")).unwrap()).unwrap();
    assert_eq!(saved, org);

    let r = post(&s, "/api/org", r#"{"departments":5}"#).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.body, br#"{"error":"departments must be a list"}"#);
    let r = post(&s, "/api/org", "null").await;
    assert_eq!(r.status, 400);
    // Over the cap.
    let big = format!(r#"{{"departments":[],"pad":"{}"}}"#, "x".repeat(64_000));
    let r = post(&s, "/api/org", &big).await;
    assert_eq!(
        (r.status.as_u16(), error_of(&r)),
        (400, "요청이 너무 큽니다".into())
    );
}

#[tokio::test]
async fn org_save_failure_is_502_without_code() {
    let fake = Arc::new(FakeBackend::default());
    let s = start_cfg(&fake, |c| {
        // A directory where the file should go: the atomic rename fails with an io::Error.
        std::fs::create_dir_all(&c.org_file).unwrap();
    })
    .await;
    let r = post(&s, "/api/org", r#"{"departments":[]}"#).await;
    assert_eq!(r.status, 502);
    assert!(r.json().get("code").is_none());
    assert!(r.json()["error"].as_str().is_some());
    // Not stored on failure.
    assert_eq!(
        s.client.get("/api/org").await.json()["departments"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

// ---- Task 4 fix round 1 ----

#[tokio::test]
async fn repos_path_limit_counts_utf16_units() {
    let caps = BackendCapabilities {
        repos: true,
        ..no_capabilities()
    };
    let (fake, s) = with_desk(caps).await;
    // 500 astral chars are 1000 UTF-16 units; 1001 units is over.
    let ok = "😀".repeat(500);
    let r = post(&s, "/api/repos", &format!(r#"{{"path":"{ok}"}}"#)).await;
    assert_eq!(r.status, 200);
    let r = post(&s, "/api/repos", &format!(r#"{{"path":"{ok}a"}}"#)).await;
    assert_eq!(r.status, 400);
    let ascii = "a".repeat(1000);
    assert_eq!(
        post(&s, "/api/repos", &format!(r#"{{"path":"{ascii}"}}"#))
            .await
            .status,
        200
    );
    let r = post(&s, "/api/repos", &format!(r#"{{"path":"{ascii}a"}}"#)).await;
    assert_eq!(r.status, 400);
    assert_eq!(fake.calls_of("add_repo").len(), 2);
}

#[tokio::test]
async fn hire_warning_is_in_the_200() {
    let caps = BackendCapabilities {
        hire: true,
        ..no_capabilities()
    };
    let (fake, s) = with_desk(caps).await;
    *fake.hire_warning.lock().unwrap() = Some("prompt not delivered".into());
    let r = post(&s, "/api/hire", r#"{"agent":"claude","deskId":"d1"}"#).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, br#"{"ok":true,"warning":"prompt not delivered"}"#);
}

#[tokio::test]
async fn hire_non_string_name_and_base_branch_count_as_absent() {
    let caps = BackendCapabilities {
        hire: true,
        ..no_capabilities()
    };
    let (fake, s) = with_desk(caps).await;
    // Parked difference: TS coerces a numeric name; here it is dropped, so the name is missing.
    let r = post(
        &s,
        "/api/hire",
        r#"{"agent":"claude","repoId":"repo1","name":5}"#,
    )
    .await;
    assert_eq!(r.status, 400);
    let r = post(
        &s,
        "/api/hire",
        r#"{"agent":"claude","repoId":"repo1","name":"w1","baseBranch":7}"#,
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.text());
    let call = &fake.calls_of("hire")[0];
    assert!(
        call.contains(r#""name":"w1""#) && !call.contains("7"),
        "{call}"
    );
}

#[tokio::test]
async fn worktree_status_null_is_stored_as_the_string_null() {
    let caps = BackendCapabilities {
        board: true,
        ..no_capabilities()
    };
    let (fake, s) = with_desk(caps).await;
    let r = post(
        &s,
        "/api/worktree",
        r#"{"deskId":"d1","workspaceStatus":null}"#,
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        fake.calls_of("set_board")[0],
        r#"set_board d1 {"workspaceStatus":"null"}"#
    );
    err_of(&fake, "set_board", BackendError::plain("disk"));
    let r = post(&s, "/api/worktree", r#"{"deskId":"d1","comment":"x"}"#).await;
    assert_eq!(r.status, 502);
    assert_eq!(r.body, br#"{"error":"disk"}"#);
}

// ---- read routes (Task 6) ----

fn hit(
    title: &str,
    cwd: &str,
    file: Option<&str>,
    resume: &str,
) -> od_core::backend::ConversationHit {
    od_core::backend::ConversationHit {
        agent: "claude".into(),
        title: title.into(),
        cwd: cwd.into(),
        updated_at: None,
        snippet: "[[hi]]".into(),
        role: None,
        file_path: file.map(str::to_string),
        resume_command: Some(resume.into()),
    }
}

async fn with_agent(caps: BackendCapabilities) -> (Arc<FakeBackend>, support::TestServer) {
    let fake = with_caps(caps);
    fake.set_snapshot(Ok(office(vec![desk(
        "d1",
        "/nowhere",
        vec![agent("a1", Some("pty_1")), agent("a2", None)],
    )])));
    let s = start_cfg(&fake, |_| {}).await;
    s.handle.poller().refresh().await;
    (fake, s)
}

#[tokio::test]
async fn search_matches_the_running_session_and_keeps_other_resume_commands() {
    let caps = BackendCapabilities {
        search: true,
        ..no_capabilities()
    };
    let (fake, s) = with_agent(caps).await;
    fake.set_session(Some("/s/live.jsonl".into()));
    *fake.search.lock().unwrap() = vec![
        hit(
            "live",
            "/work/proj",
            Some("/s/live.jsonl"),
            "claude --resume 1",
        ),
        hit(
            "old",
            "C:\\work\\proj\\",
            Some("/s/old.jsonl"),
            "claude --resume 2",
        ),
        hit("nofile", "/work/x", None, "claude --resume 3"),
    ];
    let r = s.client.get("/api/search?q=%20hi%20").await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(
        fake.calls_of("search_conversations"),
        ["search_conversations hi"]
    );
    let v = r.json();
    let res = v["results"].as_array().unwrap();
    assert_eq!(res.len(), 3);
    assert_eq!(res[0]["deskId"], "d1");
    assert_eq!(res[0]["agentId"], "a1");
    assert!(res[0]["resumeCommand"].is_null());
    assert_eq!(res[0]["project"], "proj");
    assert!(res[1]["deskId"].is_null() && res[1]["agentId"].is_null());
    assert_eq!(res[1]["resumeCommand"], "claude --resume 2");
    let want = if cfg!(windows) {
        "proj"
    } else {
        "C:\\work\\proj\\"
    };
    assert_eq!(res[1]["project"], want);
    assert!(res[2]["deskId"].is_null());
    assert_eq!(res[2]["resumeCommand"], "claude --resume 3");
}

#[tokio::test]
async fn search_validates_q_before_the_capability() {
    let (fake, s) = with_agent(no_capabilities()).await;
    for q in [
        "",
        "%20%20",
        "a".repeat(201).as_str(),
        "😀".repeat(101).as_str(),
    ] {
        let r = s.client.get(&format!("/api/search?q={q}")).await;
        assert_eq!(r.status, 400, "{q}");
        assert_eq!(
            r.body,
            "{\"error\":\"검색어를 1~200자로 입력해 주세요\"}".as_bytes()
        );
    }
    // 100 emoji are 200 units: in range, and without the capability the list is empty.
    let r = s
        .client
        .get(&format!("/api/search?q={}", "😀".repeat(100)))
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, br#"{"results":[]}"#);
    assert!(fake.calls_of("search_conversations").is_empty());
}

#[tokio::test]
async fn changes_and_diff_need_a_known_desk_and_the_capability() {
    let (_f, s) = with_agent(no_capabilities()).await;
    for path in [
        "/api/changes?deskId=d1",
        "/api/diff?deskId=d1&file=x",
        "/api/changes",
    ] {
        let r = s.client.get(path).await;
        assert_eq!(r.status, 404, "{path}");
        assert_eq!(r.body, br#"{"error":"unknown worktree"}"#);
    }
    let caps = BackendCapabilities {
        changes: true,
        ..no_capabilities()
    };
    let (_f, s) = with_agent(caps).await;
    let r = s.client.get("/api/changes?deskId=nope").await;
    assert_eq!(r.status, 404);
    // d1's path does not exist: a git failure is 502 with no code.
    let r = s.client.get("/api/changes?deskId=d1").await;
    assert_eq!(r.status, 502);
    assert!(r.json().get("code").is_none());
}

#[tokio::test]
async fn terminal_route() {
    let (fake, s) = with_agent(no_capabilities()).await;
    *fake.screen.lock().unwrap() = vec!["hello".into()];
    let r = s.client.get("/api/terminal?agentId=a2").await;
    assert_eq!(
        r.body,
        br#"{"found":false,"lines":[],"composer":"unknown"}"#
    );
    let r = s.client.get("/api/terminal").await;
    assert_eq!(
        r.body,
        br#"{"found":false,"lines":[],"composer":"unknown"}"#
    );
    let r = s.client.get("/api/terminal?agentId=a1").await;
    assert_eq!(r.status, 200);
    let v = r.json();
    assert_eq!(
        (v["found"].clone(), v["lines"][0].clone()),
        (true.into(), "hello".into())
    );
    assert_eq!(fake.calls_of("read_screen"), ["read_screen pty_1"]);

    err_of(
        &fake,
        "read_screen",
        BackendError::with_code("read only", "terminal_not_writable"),
    );
    let r = s.client.get("/api/terminal?agentId=a1").await;
    assert_eq!(r.status, 409);
    assert_eq!(
        r.body,
        br#"{"error":"read only","code":"terminal_not_writable"}"#
    );
    err_of(&fake, "read_screen", BackendError::plain("boom"));
    let r = s.client.get("/api/terminal?agentId=a1").await;
    assert_eq!(r.status, 502);
    assert_eq!(r.body, br#"{"error":"boom"}"#);
}

#[tokio::test]
async fn commands_route() {
    let (_f, s) = with_agent(no_capabilities()).await;
    let r = s.client.get("/api/commands?agentId=nope").await;
    assert_eq!(r.body, b"[]");
    let r = s.client.get("/api/commands?agentId=a1").await;
    assert_eq!(r.status, 200);
    assert!(r.json().is_array());
}

#[tokio::test]
async fn conversation_without_agent_or_session() {
    let (fake, s) = with_agent(no_capabilities()).await;
    let r = s.client.get("/api/conversation?agentId=nope").await;
    assert_eq!(r.status, 200);
    let v = r.json();
    assert_eq!(v["found"], false);
    assert_eq!(v["reason"], "이 에이전트는 더 이상 사무실에 없습니다.");
    let v = s.client.get("/api/conversation").await.json();
    assert_eq!(v["found"], false);
    let v = s.client.get("/api/conversation?agentId=a1").await.json();
    assert_eq!(v["reason"], "no session");
    assert_eq!(v["screenSupport"], "unknown");
    // A transcript that cannot be read is 502.
    fake.set_session(Some(
        s.dir.path().join("missing.jsonl").display().to_string(),
    ));
    let r = s.client.get("/api/conversation?agentId=a1").await;
    assert_eq!(r.status, 502);
    assert!(r.json().get("code").is_none());
}

#[tokio::test]
async fn conversation_empty_sub_is_the_main_conversation() {
    let (fake, s) = with_agent(no_capabilities()).await;
    let file = s.dir.path().join("s.jsonl");
    std::fs::write(
        &file,
        "{\"type\":\"user\",\"timestamp\":\"2026-10-04T09:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
    )
    .unwrap();
    fake.set_session(Some(file.display().to_string()));
    let main = s.client.get("/api/conversation?agentId=a1").await.json();
    assert_eq!(main["found"], true);
    let empty = s
        .client
        .get("/api/conversation?agentId=a1&sub=")
        .await
        .json();
    assert_eq!(empty, main);
    let unknown = s
        .client
        .get("/api/conversation?agentId=a1&sub=x")
        .await
        .json();
    assert_eq!(unknown["found"], false);
    assert_eq!(unknown["reason"], "서브에이전트 기록을 찾지 못했습니다.");
}

#[tokio::test]
async fn empty_file_path_and_empty_handle_are_falsy() {
    let caps = BackendCapabilities {
        search: true,
        ..no_capabilities()
    };
    let fake = with_caps(caps);
    fake.set_snapshot(Ok(office(vec![desk(
        "d1",
        "/nowhere",
        vec![agent("a1", Some(""))],
    )])));
    let s = start_cfg(&fake, |_| {}).await;
    s.handle.poller().refresh().await;
    fake.set_session(Some(String::new()));
    *fake.search.lock().unwrap() = vec![hit("t", "/w/p", Some(""), "resume")];
    let v = s.client.get("/api/search?q=t").await.json();
    assert!(v["results"][0]["agentId"].is_null());
    assert_eq!(v["results"][0]["resumeCommand"], "resume");
    let r = s.client.get("/api/terminal?agentId=a1").await;
    assert_eq!(
        r.body,
        br#"{"found":false,"lines":[],"composer":"unknown"}"#
    );
    assert!(fake.calls_of("read_screen").is_empty());
}
