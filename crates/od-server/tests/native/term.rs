//! `/term` trials: a real server on a native backend, with one fake agent hired through
//! `POST /api/hire`, in the trial's own sub-root (own `OD_FAKE_AGENT_OUT`, own `PidGuard`).

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use libtest_mimic::{Failed, Trial};
use od_core::backend::{NativeBackend, OfficeBackend};
use od_core::native::pty_host::{PtyHost, TermSize};
use od_server::js::encode_uri_component;
use od_server::ServerHandle;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::{self, Message};

use crate::contract::{
    agent_pids, build_world, is_our_agent, path_str, preflight, PidGuard, AGENT_EXE,
};
use crate::support::fake_backend::FakeBackend;
use crate::support::{scratch_config, start, ws_connect, Client, Ws};

pub fn trials(root: &Path) -> Vec<Trial> {
    let trial = |name: &'static str, f: fn(&Path) -> Result<(), Failed>| {
        let sub = root.join(name);
        Trial::test(name, move || f(&sub))
    };
    #[cfg_attr(not(unix), expect(unused_mut, reason = "term_mute is unix-only"))]
    let mut v = vec![
        trial("term_attach_stream", term_attach_stream),
        trial("term_resize", term_resize),
        trial("term_exit", term_exit),
        trial("term_rejects", term_rejects),
        trial("term_slow_consumer", term_slow_consumer),
        trial("term_shutdown", term_shutdown),
    ];
    #[cfg(unix)]
    v.push(trial("term_mute", term_mute));
    v
}

/// The reply the headless screen sends to the fake agent's `ESC [ c`, as the agent echoes it.
#[cfg(unix)]
const DA1_ECHO: &str = "in:\"\\u{1b}[?1;2c\"";

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime")
}

/// A scratch server on a native backend with one hired fake agent.
struct Rig {
    handle: ServerHandle,
    backend: Arc<NativeBackend>,
    client: Client,
    port: u16,
    /// The office agent id (what `/term/<id>` takes).
    agent: String,
    /// Its PTY id.
    pty_id: String,
    out: std::path::PathBuf,
    exe: std::path::PathBuf,
    _guard: PidGuard,
}

impl Rig {
    async fn new(sub: &Path, term_buffer: usize) -> Rig {
        let setup = json!({
            "repo": {
                "files": { "README.md": "term\n" },
                "commit": {
                    "name": "Term Test",
                    "email": "term@example.invalid",
                    "date": "2026-01-01T00:00:00Z",
                    "message": "init"
                },
                "after": {}
            },
            "files": {},
            "dirs": [],
            "uploads": {}
        });
        let world = build_world(sub, &setup);
        let out = world.root.join("out");
        let exe = dunce::canonicalize(world.root.join("bin").join(AGENT_EXE)).expect("fake agent");
        let guard = PidGuard {
            out: out.clone(),
            exe: exe.clone(),
        };
        preflight(&world.env, &world.root).expect("preflight");

        let bound = od_server::bind(0).await.expect("bind");
        assert_ne!(bound.port, 4317, "never the real port");
        let port = bound.port;
        let backend = Arc::new(od_server::native_backend(&world.env, port).await);
        let mut cfg = scratch_config(&world.root.join("server"));
        cfg.term_buffer = term_buffer;
        let dyn_backend: Arc<dyn OfficeBackend> = backend.clone();
        let handle = od_server::serve(bound, dyn_backend, cfg).await;
        let client = Client::new(port);

        let post = |path: &'static str, body: Value| {
            let client = &client;
            async move {
                let r = client
                    .request(
                        "POST",
                        path,
                        &[("content-type", "application/json")],
                        Some(body.to_string().into_bytes()),
                    )
                    .await;
                assert_eq!(r.status, 200, "{path}: {}", r.text());
            }
        };
        post(
            "/api/repos",
            json!({ "path": path_str(&world.root.join("repo")) }),
        )
        .await;
        handle.poller().refresh().await;
        let desk = handle
            .poller()
            .current()
            .desks
            .first()
            .map(|d| d.id.clone())
            .expect("the repo's main desk");
        post("/api/hire", json!({ "agent": "claude", "deskId": desk })).await;
        handle.poller().refresh().await;
        let (agent, pty_id) = handle
            .poller()
            .current()
            .desks
            .iter()
            .flat_map(|d| d.agents.iter())
            .find_map(|a| backend.terminal_of(&a.id).map(|t| (a.id.clone(), t)))
            .expect("the hired agent");
        let rig = Rig {
            handle,
            backend,
            client,
            port,
            agent,
            pty_id,
            out,
            exe,
            _guard: guard,
        };
        rig.wait_screen("FAKE AGENT READY", Duration::from_secs(10))
            .await;
        rig
    }

    fn pty(&self) -> &PtyHost {
        self.backend.pty()
    }

    fn token(&self) -> &str {
        &self.handle.term_token
    }

    fn path(&self, agent: &str, token: &str) -> String {
        format!("/term/{}?token={token}", encode_uri_component(agent))
    }

    async fn attach(&self) -> Ws {
        ws_connect(self.port, &self.path(&self.agent, self.token()))
            .await
            .expect("attach")
    }

    fn screen_has(&self, text: &str) -> bool {
        self.pty()
            .screen_lines(&self.pty_id)
            .iter()
            .any(|l| l.contains(text))
    }

    async fn wait_screen(&self, text: &str, wait: Duration) {
        let deadline = Instant::now() + wait;
        while !self.screen_has(text) {
            assert!(
                Instant::now() < deadline,
                "screen never showed {text:?}: {:?}",
                self.pty().screen_lines(&self.pty_id)
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Shut down and check that this trial's fake agents are gone.
    async fn finish(self) {
        self.handle.shutdown().await;
        let pids = agent_pids(&self.out);
        let deadline = Instant::now() + Duration::from_secs(3);
        while pids.iter().any(|p| is_our_agent(*p, &self.exe)) {
            assert!(
                Instant::now() < deadline,
                "fake agents still alive after shutdown: {pids:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

#[derive(Debug)]
enum Frame {
    Bin(Vec<u8>),
    Text(String),
    Close(Option<(u16, String)>),
    Ended,
    Quiet,
}

async fn next_frame(ws: &mut Ws, wait: Duration) -> Frame {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        return match tokio::time::timeout_at(deadline, ws.next()).await {
            Err(_) => Frame::Quiet,
            Ok(None) | Ok(Some(Err(_))) => Frame::Ended,
            Ok(Some(Ok(Message::Binary(b)))) => Frame::Bin(b.to_vec()),
            Ok(Some(Ok(Message::Text(t)))) => Frame::Text(t.to_string()),
            Ok(Some(Ok(Message::Close(c)))) => {
                Frame::Close(c.map(|c| (u16::from(c.code), c.reason.to_string())))
            }
            Ok(Some(Ok(_))) => continue,
        };
    }
}

/// Binary output until it contains `text`.
async fn read_until(ws: &mut Ws, text: &str, wait: Duration) -> String {
    let deadline = Instant::now() + wait;
    let mut seen = Vec::new();
    while !String::from_utf8_lossy(&seen).contains(text) {
        let left = deadline.saturating_duration_since(Instant::now());
        match next_frame(ws, left).await {
            Frame::Bin(b) => seen.extend(b),
            other => panic!(
                "waiting for {text:?}: got {other:?}; output so far {:?}",
                String::from_utf8_lossy(&seen)
            ),
        }
    }
    String::from_utf8_lossy(&seen).into_owned()
}

async fn first_frame(ws: &mut Ws) -> String {
    match next_frame(ws, Duration::from_secs(5)).await {
        Frame::Bin(b) => String::from_utf8_lossy(&b).into_owned(),
        other => panic!("expected the snapshot, got {other:?}"),
    }
}

async fn send_bin(ws: &mut Ws, bytes: &[u8]) {
    ws.send(Message::Binary(bytes.to_vec().into()))
        .await
        .expect("send");
}

/// The handshake must be refused with `status` and exactly `body`.
fn refused(
    what: &str,
    r: Result<Ws, tungstenite::Error>,
    status: u16,
    body: &str,
) -> Result<(), String> {
    match r {
        Err(tungstenite::Error::Http(res)) => {
            let got = String::from_utf8_lossy(res.body().as_deref().unwrap_or_default());
            if res.status() != status || got != body {
                return Err(format!(
                    "{what}: got {} {got}, want {status} {body}",
                    res.status()
                ));
            }
            if res.headers().get("connection").map(|v| v.as_bytes()) != Some(&b"close"[..]) {
                return Err(format!("{what}: no Connection: close"));
            }
            Ok(())
        }
        Ok(_) => Err(format!("{what}: the upgrade was accepted")),
        Err(e) => Err(format!("{what}: {e}")),
    }
}

fn term_attach_stream(sub: &Path) -> Result<(), Failed> {
    runtime().block_on(async {
        let rig = Rig::new(sub, 1024).await;
        let mut ws = rig.attach().await;
        let snapshot = first_frame(&mut ws).await;
        assert!(snapshot.contains("FAKE AGENT READY"), "{snapshot:?}");
        send_bin(&mut ws, b"hello\r").await;
        read_until(&mut ws, "got:hello", Duration::from_secs(5)).await;
        // Text input goes to the agent as UTF-8; unknown commands are ignored.
        ws.send(Message::Text(r#"{"type":"nope"}"#.into()))
            .await
            .unwrap();
        ws.send(Message::Text("not json".into())).await.unwrap();
        ws.send(Message::Text(r#"{"type":"input","data":"héllo\r"}"#.into()))
            .await
            .unwrap();
        read_until(&mut ws, "got:héllo", Duration::from_secs(5)).await;
        // Two clients at once: both get the output.
        let mut other = rig.attach().await;
        first_frame(&mut other).await;
        send_bin(&mut other, b"twice\r").await;
        read_until(&mut ws, "got:twice", Duration::from_secs(5)).await;
        read_until(&mut other, "got:twice", Duration::from_secs(5)).await;
        drop((ws, other));
        rig.finish().await;
    });
    Ok(())
}

fn term_resize(sub: &Path) -> Result<(), Failed> {
    runtime().block_on(async {
        let rig = Rig::new(sub, 1024).await;
        let mut ws = rig.attach().await;
        first_frame(&mut ws).await;
        assert_ne!(
            rig.pty().size(&rig.pty_id),
            Some(TermSize { cols: 90, rows: 30 })
        );
        // Out of range (the screen allocates rows × cols) or malformed: ignored.
        for bad in [
            r#"{"type":"resize","cols":5000,"rows":30}"#,
            r#"{"type":"resize","cols":90,"rows":501}"#,
            r#"{"type":"resize","cols":65535,"rows":65535}"#,
            r#"{"type":"resize","cols":0,"rows":30}"#,
            r#"{"type":"resize","cols":90,"rows":70000}"#,
            r#"{"type":"resize","cols":"90","rows":30}"#,
            r#"{"type":"resize","cols":90.5,"rows":30}"#,
        ] {
            ws.send(Message::Text(bad.into())).await.unwrap();
        }
        ws.send(Message::Text(
            r#"{"type":"resize","cols":90,"rows":30}"#.into(),
        ))
        .await
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while rig.pty().size(&rig.pty_id) != Some(TermSize { cols: 90, rows: 30 }) {
            assert!(
                Instant::now() < deadline,
                "size {:?}",
                rig.pty().size(&rig.pty_id)
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        drop(ws);
        rig.finish().await;
    });
    Ok(())
}

/// Replies stay off while any client is attached, and come back once every client is gone,
/// even when the sockets just drop (no close frame).
#[cfg(unix)]
fn term_mute(sub: &Path) -> Result<(), Failed> {
    runtime().block_on(async {
        let rig = Rig::new(sub, 1024).await;
        let mut a = rig.attach().await;
        first_frame(&mut a).await;
        let mut b = rig.attach().await;
        first_frame(&mut b).await;

        send_bin(&mut a, b"query\r").await;
        let deadline = Instant::now() + Duration::from_millis(700);
        let mut seen = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match next_frame(&mut a, left).await {
                Frame::Bin(bytes) => seen.extend(bytes),
                Frame::Quiet => break,
                other => panic!("{other:?}"),
            }
        }
        let seen = String::from_utf8_lossy(&seen);
        assert!(
            seen.contains("\x1b[c"),
            "the query reached the client: {seen:?}"
        );
        assert!(!seen.contains(DA1_ECHO), "{seen:?}");

        // One client gone: the other still holds its mute.
        drop(a);
        let until = Instant::now() + Duration::from_millis(700);
        while Instant::now() < until {
            rig.pty().write(&rig.pty_id, b"query\r").unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(!rig.screen_has(DA1_ECHO), "a reply while b is attached");
        }

        // Both gone: replies resume (retried, as the server may not have seen the drop yet).
        drop(b);
        let deadline = Instant::now() + Duration::from_secs(2);
        while !rig.screen_has(DA1_ECHO) {
            assert!(Instant::now() < deadline, "replies never resumed");
            rig.pty().write(&rig.pty_id, b"query\r").unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        rig.finish().await;
    });
    Ok(())
}

fn term_exit(sub: &Path) -> Result<(), Failed> {
    runtime().block_on(async {
        let rig = Rig::new(sub, 1024).await;
        let mut ws = rig.attach().await;
        first_frame(&mut ws).await;
        send_bin(&mut ws, b"exit\r").await;
        let mut out = Vec::new();
        let text = loop {
            match next_frame(&mut ws, Duration::from_secs(10)).await {
                Frame::Bin(b) => out.extend(b),
                Frame::Text(t) => break t,
                other => panic!("expected the exit message, got {other:?}"),
            }
        };
        assert_eq!(text, r#"{"type":"exit","code":3}"#);
        assert!(
            String::from_utf8_lossy(&out).contains("bye"),
            "output before the exit: {:?}",
            String::from_utf8_lossy(&out)
        );
        match next_frame(&mut ws, Duration::from_secs(5)).await {
            Frame::Close(Some((1000, _))) => {}
            other => panic!("expected Close 1000, got {other:?}"),
        }
        // The agent is gone now: attaching again is a 404.
        let again = ws_connect(rig.port, &rig.path(&rig.agent, rig.token())).await;
        refused("after exit", again, 404, r#"{"error":"unknown terminal"}"#).unwrap();
        rig.finish().await;
    });
    Ok(())
}

fn term_rejects(sub: &Path) -> Result<(), Failed> {
    runtime().block_on(async {
        let rig = Rig::new(sub, 1024).await;
        let (port, agent, token) = (rig.port, rig.agent.clone(), rig.token().to_string());

        let wrong: String = token
            .chars()
            .map(|c| if c == '0' { '1' } else { '0' })
            .collect();
        for (what, path) in [
            ("wrong token", rig.path(&agent, &wrong)),
            ("short token", rig.path(&agent, &token[..63])),
            ("empty token", rig.path(&agent, "")),
            (
                "no token",
                format!("/term/{}", encode_uri_component(&agent)),
            ),
        ] {
            refused(
                what,
                ws_connect(port, &path).await,
                403,
                r#"{"error":"forbidden"}"#,
            )
            .unwrap();
        }
        // The token is checked before the id.
        refused(
            "bad path, no token",
            ws_connect(port, "/term/%E0%A4%A").await,
            403,
            r#"{"error":"forbidden"}"#,
        )
        .unwrap();
        refused(
            "bad path",
            ws_connect(port, &format!("/term/%E0%A4%A?token={token}")).await,
            400,
            r#"{"error":"bad path"}"#,
        )
        .unwrap();
        for unknown in ["nope", "", "nope:main"] {
            refused(
                unknown,
                ws_connect(port, &rig.path(unknown, &token)).await,
                404,
                r#"{"error":"unknown terminal"}"#,
            )
            .unwrap();
        }

        // No upgrade (the normal chain's /term/ arm), for any method, even with a good token.
        let good = rig.path(&agent, &token);
        for (method, path) in [
            ("GET", "/term/x".to_string()),
            ("POST", "/term/x".to_string()),
            ("GET", good.clone()),
            ("PUT", good),
        ] {
            let r = rig.client.request(method, &path, &[], None).await;
            assert_eq!(r.status, 400, "{method} {path}");
            assert_eq!(r.header("content-type"), Some("application/json"));
            assert_eq!(r.text(), r#"{"error":"websocket upgrade required"}"#);
        }

        // The guard comes first, on both paths.
        let mut req = tungstenite::client::IntoClientRequest::into_client_request(format!(
            "ws://127.0.0.1:{port}{}",
            rig.path(&agent, &token)
        ))
        .unwrap();
        req.headers_mut()
            .insert("origin", "https://evil.example".parse().unwrap());
        let r = tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::connect_async(req),
        )
        .await
        .expect("connect")
        .map(|(ws, _)| ws);
        refused("evil origin", r, 403, r#"{"error":"forbidden origin"}"#).unwrap();
        let r = rig
            .client
            .request(
                "GET",
                "/term/x",
                &[("origin", "https://evil.example")],
                None,
            )
            .await;
        assert_eq!(r.status, 403);
        assert_eq!(r.text(), r#"{"error":"forbidden origin"}"#);

        // A backend that is not native has no terminals.
        let fake = start(Arc::new(FakeBackend::default())).await;
        let r = ws_connect(
            fake.handle.port,
            &format!("/term/a1?token={}", fake.handle.term_token),
        )
        .await;
        refused("fake backend", r, 404, r#"{"error":"unknown terminal"}"#).unwrap();
        // Each server has its own token.
        assert_ne!(fake.handle.term_token, token);
        fake.handle.shutdown().await;

        // The rejected attempts left the agent working and unmuted-by-nobody: attach works.
        let mut ws = rig.attach().await;
        first_frame(&mut ws).await;
        drop(ws);
        rig.finish().await;
    });
    Ok(())
}

/// A client that does not read falls behind and is closed with 1013. The flood is injected
/// into the host (`feed_output`, as if the agent printed it): 16 MiB, far past what the queue
/// (2 chunks, 8 MiB) and the socket buffers can hold, on any OS.
fn term_slow_consumer(sub: &Path) -> Result<(), Failed> {
    const MIB: usize = 1 << 20;
    runtime().block_on(async {
        let rig = Rig::new(sub, 2).await;
        let mut ws = rig.attach().await;
        first_frame(&mut ws).await;
        // Never read while 16 MiB of output arrive.
        let (backend, id) = (Arc::clone(&rig.backend), rig.pty_id.clone());
        tokio::task::spawn_blocking(move || {
            let chunk = vec![b'x'; MIB];
            for _ in 0..16 {
                backend.pty().feed_output(&id, &chunk);
            }
        })
        .await
        .unwrap();
        // The server is not held up by the jammed socket.
        let r = tokio::time::timeout(Duration::from_secs(1), rig.client.get("/api/snapshot"))
            .await
            .expect("snapshot within 1 s");
        assert_eq!(r.status, 200);
        // Now read: what was sent before, then Close 1013.
        let mut bytes = 0usize;
        let close = loop {
            match next_frame(&mut ws, Duration::from_secs(20)).await {
                Frame::Bin(b) => bytes += b.len(),
                Frame::Close(c) => break c,
                other => panic!("after {bytes} bytes: expected Close, got {other:?}"),
            }
        };
        assert_eq!(
            close,
            Some((1013, "slow consumer".to_string())),
            "after {bytes} bytes"
        );
        assert!(bytes < 16 * MIB, "{bytes} bytes: nothing was dropped");
        // The agent is fine and a reattach gets a fresh snapshot.
        let mut again = rig.attach().await;
        first_frame(&mut again).await;
        send_bin(&mut again, b"after\r").await;
        read_until(&mut again, "got:after", Duration::from_secs(5)).await;
        drop((ws, again));
        rig.finish().await;
    });
    Ok(())
}

/// Shutdown ends an attached socket (an upgraded connection outlives axum's graceful shutdown).
fn term_shutdown(sub: &Path) -> Result<(), Failed> {
    runtime().block_on(async {
        let rig = Rig::new(sub, 1024).await;
        let mut ws = rig.attach().await;
        first_frame(&mut ws).await;
        let handle = rig.handle.clone();
        let stopping = tokio::spawn(async move { handle.shutdown().await });
        // The stop signal ends it with 1001, or the stream just ends (the close frame is
        // best-effort); never the agent's exit message, and never an open socket.
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match next_frame(&mut ws, left).await {
                Frame::Bin(_) => {}
                Frame::Close(Some((1001, _))) | Frame::Ended => break,
                other => panic!("expected Close 1001 or the end on shutdown, got {other:?}"),
            }
        }
        stopping.await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), rig.handle.closed())
            .await
            .expect("closed");
        rig.finish().await;
    });
    Ok(())
}
