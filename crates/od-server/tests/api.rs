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

#[tokio::test]
async fn hook_post_is_bare_404_with_security_headers() {
    let s = start_fake().await;
    let r = s
        .client
        .request(
            "POST",
            "/hook/a%3Amain?token=t",
            &[("content-type", "application/json")],
            Some(b"{}".to_vec()),
        )
        .await;
    assert_eq!(r.status, 404);
    assert!(r.body.is_empty());
    assert_security_headers(&r);
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
    let mut got = Vec::new();
    for _ in 0..5 {
        got.push(ws_json(&mut ws).await);
    }
    let types: Vec<_> = got.iter().map(msg_type).collect();
    assert_eq!(types, ["snapshot", "org", "awards", "usage", "usage"]);
    assert_eq!(got[3]["usage"]["updatedAt"], 9);
    assert_eq!(got[4]["usage"]["updatedAt"], 10);
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
