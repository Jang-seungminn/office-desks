//! The `app` test binary (libtest-mimic, `harness = false`): the in-process core (`od_app::start`)
//! on a scratch world, and the `gongbang` binary's `hook-relay` dispatch.
//!
//! Started as `claude` (a copy in a trial's `bin/`), this binary *is* od-server's fake agent.
//! Otherwise it points the process-wide homes, temp dirs and git config at a fresh scratch root
//! (a safety net only; every trial passes its own env map) and runs the trials, each in its own
//! sub-root `<process root>/<trial name>`.

#[path = "../../../od-server/tests/native/fake_agent.rs"]
mod fake_agent;
#[path = "../support/world.rs"]
mod world;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use libtest_mimic::{Failed, Trial};
use od_server::{Assets, BackendKind, MemAssets};
use serde_json::{json, Value};

use world::{agent_pids, build, is_our_agent, preflight, scratch_config, PidGuard, AGENT_EXE};

fn main() {
    let exe = std::env::current_exe().expect("current exe");
    if exe.file_stem().and_then(|s| s.to_str()) == Some("claude") {
        fake_agent::run();
    }

    // Parse first: bad arguments exit the process, which must not leave a scratch root behind.
    let args = libtest_mimic::Arguments::from_args();

    // Still single-threaded here: set_var is sound (edition 2021).
    let scratch = tempfile::Builder::new()
        .prefix("od-app-")
        .tempdir()
        .expect("scratch root");
    let root = dunce::canonicalize(scratch.path()).expect("canonical scratch root");
    scrub_process_env(&root);

    let trial = |name: &'static str, f: fn(&Path)| {
        let sub = root.join(name);
        Trial::test(name, move || {
            f(&sub);
            Ok::<(), Failed>(())
        })
    };
    let trials = vec![
        trial("core_serves_app_and_office", core_serves_app_and_office),
        trial(
            "core_is_native_whatever_the_env",
            core_is_native_whatever_the_env,
        ),
        trial("token_is_never_served", token_is_never_served),
        trial("shutdown_disposes_agents", shutdown_disposes_agents),
        trial(
            "gongbang_hook_relay_starts_no_gui",
            gongbang_hook_relay_starts_no_gui,
        ),
    ];
    let conclusion = libtest_mimic::run(&args, trials);
    drop(scratch);
    conclusion.exit();
}

/// Point every home, temp and git-config variable of this process at `root`.
fn scrub_process_env(root: &Path) {
    let home = root.join("home");
    let tmp = root.join("tmp");
    for d in [&home, &tmp] {
        std::fs::create_dir_all(d).expect("scratch dir");
    }
    let gitconfig: PathBuf = root.join("gitconfig");
    std::fs::write(&gitconfig, "").expect("scratch gitconfig");
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::env::set_var("GIT_CONFIG_GLOBAL", &gitconfig);
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    std::env::set_var("CLAUDE_CONFIG_DIR", root.join("claude"));
    std::env::set_var("OFFICE_DESKS_HOME", root.join("office"));
    for k in ["TMPDIR", "TMP", "TEMP"] {
        std::env::set_var(k, &tmp);
    }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime")
}

fn mem(index: &str) -> MemAssets {
    MemAssets(HashMap::from([(
        "index.html".to_string(),
        index.as_bytes().to_vec(),
    )]))
}

fn world_for(sub: &Path) -> world::World {
    let w = build(sub);
    preflight(&w).expect("preflight");
    w
}

/// Start the core on port 0 with in-memory web (`WEB`) and app (`APP`) pages.
fn start_core(
    rt: &tokio::runtime::Runtime,
    w: &world::World,
    env: &od_server::EnvMap,
) -> od_app::Core {
    let app: Arc<dyn Assets> = Arc::new(mem("APP"));
    let cfg = scratch_config(w, mem("WEB"), Some(app));
    let core = rt.block_on(od_app::start(env, 0, cfg)).expect("start core");
    assert_ne!(core.port, 0);
    assert!(
        !(4317..=4320).contains(&core.port),
        "never a real port: {}",
        core.port
    );
    core
}

struct Got {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Got {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|e| panic!("json {e}: {}", self.body))
    }
}

/// ureq 2 turns every non-2xx answer into `Error::Status`; both become a [`Got`].
fn got(r: Result<ureq::Response, ureq::Error>) -> Got {
    let resp = match r {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => panic!("request failed: {e}"),
    };
    let status = resp.status();
    let headers = resp
        .headers_names()
        .into_iter()
        .flat_map(|n| {
            resp.all(&n)
                .into_iter()
                .map(|v| (n.clone(), v.to_string()))
                .collect::<Vec<_>>()
        })
        .collect();
    let body = resp.into_string().expect("body");
    Got {
        status,
        headers,
        body,
    }
}

fn url(port: u16, path: &str) -> String {
    format!("http://127.0.0.1:{port}{path}")
}

fn get(port: u16, path: &str) -> Got {
    got(ureq::get(&url(port, path)).call())
}

fn post(port: u16, path: &str, body: Value) -> Got {
    got(ureq::post(&url(port, path))
        .set("content-type", "application/json")
        .send_string(&body.to_string()))
}

fn until(wait: Duration, what: &str, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + wait;
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

// ---------------------------------------------------------------------------------------------
// Trials
// ---------------------------------------------------------------------------------------------

fn core_serves_app_and_office(sub: &Path) {
    let w = world_for(sub);
    let rt = runtime();
    let core = start_core(&rt, &w, &w.env);

    let app = get(core.port, "/app/");
    assert_eq!((app.status, app.body.as_str()), (200, "APP"));
    let csp = app.header("content-security-policy").expect("app CSP");
    assert!(csp.contains("'unsafe-inline'"), "{csp}");

    let web = get(core.port, "/");
    assert_eq!((web.status, web.body.as_str()), (200, "WEB"));

    // A Tauri custom-protocol origin is refused: the app is served from our own origin.
    let foreign = got(ureq::get(&url(core.port, "/app/"))
        .set("Origin", "tauri://localhost")
        .call());
    assert_eq!(foreign.status, 403);

    assert_eq!(core.kind, BackendKind::Native);
    rt.block_on(core.shutdown());
}

fn core_is_native_whatever_the_env(sub: &Path) {
    let w = world_for(sub);
    let mut env = w.env.clone();
    env.insert("OFFICE_DESKS_BACKEND".into(), "orca".into());
    // Does not exist: nothing named orca can ever run.
    let orca = w.root.join("missing-orca");
    env.insert(
        "ORCA_CLI_COMMAND".into(),
        orca.to_string_lossy().into_owned(),
    );
    let rt = runtime();
    let core = start_core(&rt, &w, &env);
    assert_eq!(core.kind, BackendKind::Native);
    let snap = get(core.port, "/api/snapshot");
    assert_eq!(snap.status, 200, "{}", snap.body);
    assert_eq!(snap.json()["error"], Value::Null, "{}", snap.body);
    // Sanity check: the path really is missing, so a run of it could only fail.
    assert!(!orca.exists());
    rt.block_on(core.shutdown());
}

fn token_is_never_served(sub: &Path) {
    let w = world_for(sub);
    let rt = runtime();
    let core = start_core(&rt, &w, &w.env);
    let token = core.token().to_string();
    assert_eq!(token.len(), 64, "{token}");
    assert!(
        token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "{token}"
    );
    for path in ["/app/", "/", "/api/snapshot", "/api/org", "/app/nope"] {
        let r = get(core.port, path);
        assert!(!r.body.contains(&token), "token in the body of {path}");
        for (k, v) in &r.headers {
            assert!(!v.contains(&token), "token in header {k} of {path}");
        }
    }
    rt.block_on(core.shutdown());
}

fn shutdown_disposes_agents(sub: &Path) {
    let w = world_for(sub);
    let rt = runtime();
    let core = start_core(&rt, &w, &w.env);
    let exe = dunce::canonicalize(w.root.join("bin").join(AGENT_EXE)).expect("fake agent");
    let _guard = PidGuard {
        out: w.out.clone(),
        exe: exe.clone(),
    };

    let r = post(
        core.port,
        "/api/repos",
        json!({ "path": w.repo.to_string_lossy() }),
    );
    assert_eq!(r.status, 200, "{}", r.body);

    // The poller idles without a /ws client; refresh it so the desk shows at once.
    let mut repo_id = String::new();
    until(Duration::from_secs(5), "a desk", || {
        rt.block_on(core.handle.poller().refresh());
        let snap = get(core.port, "/api/snapshot").json();
        match snap["desks"][0]["repoId"].as_str() {
            Some(id) => {
                repo_id = id.to_string();
                true
            }
            None => false,
        }
    });

    let r = post(
        core.port,
        "/api/hire",
        json!({ "agent": "claude", "repoId": repo_id, "name": "t1" }),
    );
    assert_eq!(r.status, 200, "{}", r.body);

    until(Duration::from_secs(10), "the agent pid", || {
        !agent_pids(&w.out).is_empty()
    });
    let pid = agent_pids(&w.out)[0];
    assert!(is_our_agent(pid, &exe), "pid {pid} is not our fake agent");

    rt.block_on(core.shutdown());
    until(Duration::from_secs(5), "the agent to exit", || {
        !is_our_agent(pid, &exe)
    });
    rt.block_on(core.handle.closed());
}

fn gongbang_hook_relay_starts_no_gui(sub: &Path) {
    let w = world_for(sub);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listen");
    let lp = listener.local_addr().expect("addr").port();
    assert!(!(4317..=4320).contains(&lp), "never a real port: {lp}");

    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_gongbang"))
        .arg("hook-relay")
        .env_clear()
        .envs(&w.env)
        .env(
            "OFFICE_DESKS_HOOK_URL",
            format!("http://127.0.0.1:{lp}/hook/x?token=t"),
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn gongbang hook-relay");
    {
        let mut stdin = child.stdin.take().expect("stdin");
        stdin
            .write_all(br#"{"hook_event_name":"Stop"}"#)
            .expect("write stdin");
    } // stdin closes here.

    // Accept in a thread with a deadline: the relay exits 0 even when it never connects, and a
    // relay that never connects must fail the trial, not hang it.
    let server = std::thread::spawn(move || {
        listener.set_nonblocking(true).expect("nonblocking");
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut conn = loop {
            match listener.accept() {
                Ok((c, _)) => break c,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return String::new();
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => panic!("accept: {e}"),
            }
        };
        conn.set_nonblocking(false).expect("blocking");
        conn.set_read_timeout(Some(Duration::from_secs(10)))
            .expect("read timeout");
        let mut seen = Vec::new();
        let mut buf = [0u8; 4096];
        while !String::from_utf8_lossy(&seen).contains("\"Stop\"") {
            match conn.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => seen.extend_from_slice(&buf[..n]),
            }
        }
        let _ = conn.write_all(b"HTTP/1.1 204 No Content\r\n\r\n");
        String::from_utf8_lossy(&seen).into_owned()
    });

    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(s) = child.try_wait().expect("try_wait") {
            break Some(s);
        }
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let Some(status) = status else {
        // Only the child this trial spawned.
        let _ = child.kill();
        let _ = child.wait();
        panic!("gongbang hook-relay did not exit within 10 s (did it start a GUI?)");
    };
    assert!(status.success(), "hook-relay exit status {status}");
    let request = server.join().expect("hook server");
    assert!(request.contains("\"Stop\""), "{request}");
    assert!(request.contains("/hook/x?token=t"), "{request}");
}
