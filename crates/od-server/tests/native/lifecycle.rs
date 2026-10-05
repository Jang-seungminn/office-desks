//! `lifecycle_native`: `POST /api/stop` and `/api/remove` on a native backend, with one fake
//! agent hired into a new worktree `wt1`, in the trial's own sub-root.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use libtest_mimic::{Failed, Trial};
use od_core::backend::OfficeBackend;
use serde_json::{json, Value};

use crate::contract::{
    agent_pids, build_world, is_our_agent, path_str, preflight, PidGuard, AGENT_EXE,
};
use crate::support::{scratch_config, Client};

pub fn trials(root: &Path) -> Vec<Trial> {
    let sub = root.join("lifecycle_native");
    vec![Trial::test("lifecycle_native", move || {
        lifecycle_native(&sub)
    })]
}

fn lifecycle_native(sub: &Path) -> Result<(), Failed> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(run(sub));
    Ok(())
}

async fn post(client: &Client, path: &str, body: Value) -> (u16, Value) {
    let r = client
        .request(
            "POST",
            path,
            &[("content-type", "application/json")],
            Some(body.to_string().into_bytes()),
        )
        .await;
    (r.status.as_u16(), r.json())
}

async fn until(what: &str, f: impl FnMut() -> bool) {
    until_within(Duration::from_secs(5), what, f).await;
}

async fn until_within(wait: Duration, what: &str, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + wait;
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn run(sub: &Path) {
    let setup = json!({
        "repo": {
            "files": { "README.md": "lifecycle\n" },
            "commit": {
                "name": "Lifecycle Test",
                "email": "lifecycle@example.invalid",
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
    let _guard = PidGuard {
        out: out.clone(),
        exe: exe.clone(),
    };
    preflight(&world.env, &world.root).expect("preflight");

    let bound = od_server::bind(0).await.expect("bind");
    assert!(
        !(4317..=4320).contains(&bound.port),
        "never a real port: {}",
        bound.port
    );
    let port = bound.port;
    let backend: Arc<dyn OfficeBackend> =
        Arc::new(od_server::native_backend(&world.env, port).await);
    let handle = od_server::serve(bound, backend, scratch_config(&world.root.join("server"))).await;
    let client = Client::new(port);

    let (st, _) = post(
        &client,
        "/api/repos",
        json!({ "path": path_str(&world.root.join("repo")) }),
    )
    .await;
    assert_eq!(st, 200);
    handle.poller().refresh().await;
    let main = handle.poller().current().desks[0].clone();
    assert!(main.is_main);
    let (st, body) = post(
        &client,
        "/api/hire",
        json!({ "agent": "claude", "repoId": main.repo_id, "name": "wt1" }),
    )
    .await;
    assert_eq!(st, 200, "{body}");

    // 1. The new desk and its agent.
    handle.poller().refresh().await;
    let snap = handle.poller().current();
    let wt = snap
        .desks
        .iter()
        .find(|d| d.name == "wt1")
        .expect("desk wt1");
    let (wt_id, wt_path) = (wt.id.clone(), wt.path.clone());
    let agent = wt.agents.first().expect("wt1 agent").id.clone();
    // The fake agent may start slowly while the other trials load the machine.
    until_within(Duration::from_secs(20), "the agent pid", || {
        !agent_pids(&out).is_empty()
    })
    .await;
    let pid = agent_pids(&out)[0];
    assert!(Path::new(&wt_path).exists());

    // 2. A desk with a live agent is refused.
    let (st, body) = post(&client, "/api/remove", json!({ "deskId": wt_id })).await;
    assert_eq!(st, 409, "{body}");
    assert_eq!(body["code"], "has_agents");
    assert!(Path::new(&wt_path).exists());

    // 3. Stop the agent.
    let (st, body) = post(&client, "/api/stop", json!({ "agentId": agent })).await;
    assert_eq!((st, body), (200, json!({ "ok": true })));
    until("the agent to exit", || !is_our_agent(pid, &exe)).await;
    let listed = |h: &od_server::ServerHandle| {
        h.poller()
            .current()
            .desks
            .iter()
            .any(|d| d.agents.iter().any(|a| a.id == agent))
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        handle.poller().refresh().await;
        if !listed(&handle) {
            break;
        }
        assert!(Instant::now() < deadline, "agent still listed");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // 4. Remove the worktree.
    let (st, body) = post(&client, "/api/remove", json!({ "deskId": wt_id })).await;
    assert_eq!((st, body), (200, json!({ "ok": true })));
    until("the folder to go", || !Path::new(&wt_path).exists()).await;

    // 5. Again: gone.
    let (st, body) = post(&client, "/api/remove", json!({ "deskId": wt_id })).await;
    assert_eq!(st, 404, "{body}");
    assert_eq!(body["code"], "not_found");

    // 6. The main checkout stays.
    let (st, body) = post(&client, "/api/remove", json!({ "deskId": main.id })).await;
    assert_eq!(st, 409, "{body}");
    assert_eq!(body["code"], "main_checkout");

    // 7. An unknown agent.
    let (st, body) = post(&client, "/api/stop", json!({ "agentId": "nope" })).await;
    assert_eq!(
        (st, body),
        (
            404,
            json!({ "error": "에이전트를 찾지 못했어요", "code": "not_found" })
        )
    );

    // 8.
    handle.shutdown().await;
}
