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
async fn unknown_api_is_404_not_found() {
    let s = start_fake().await;
    let r = s.client.get("/api/nope").await;
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
