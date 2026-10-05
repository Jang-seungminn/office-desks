//! The E2E harness (R4 Task 9): the same in-process core the app runs (`od_app::start`), on a
//! scratch world. It serves the real web build at `/` and the app's E2E build at `/app/`. That
//! build is `app/dist-e2e`, named by `GONGBANG_E2E_APP_DIST` and read from disk through
//! [`DirAssets`]; the production `app/dist` is never read. Playwright (`app/e2e/harness.ts`)
//! spawns the harness and fakes the Tauri IPC.
//!
//! Started as `claude` (the copy in the world's `bin/`), this binary *is* od-server's fake agent.
//!
//! Protocol: one JSON line on stdout, `{"port","token","root","repo","out"}`, then it serves until
//! stdin reaches EOF, shuts the core down (disposing every agent) and exits 0, deleting the
//! scratch root. It binds port 0 only.

#[path = "../../od-server/tests/native/fake_agent.rs"]
mod fake_agent;
#[path = "../tests/support/world.rs"]
mod world;

use std::borrow::Cow;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use od_server::{Assets, MemAssets};

fn main() {
    let exe = std::env::current_exe().expect("current exe");
    if exe.file_stem().and_then(|s| s.to_str()) == Some("claude") {
        fake_agent::run();
    }

    let Some(app_dist) = std::env::var_os("GONGBANG_E2E_APP_DIST").map(PathBuf::from) else {
        eprintln!("e2e_harness: set GONGBANG_E2E_APP_DIST to the E2E build (app/dist-e2e)");
        std::process::exit(2);
    };
    if !app_dist.join("index.html").is_file() {
        eprintln!(
            "e2e_harness: {} has no index.html; run: npm run build:e2e -w app",
            app_dist.display()
        );
        std::process::exit(2);
    }

    let scratch = tempfile::Builder::new()
        .prefix("gongbang-e2e-")
        .tempdir()
        .expect("scratch root");
    let w = world::build(scratch.path());
    if let Err(e) = world::preflight(&w) {
        eprintln!("e2e_harness: {e}");
        drop(scratch);
        std::process::exit(2);
    }
    // Still single-threaded here: set_var is sound (edition 2021). A safety net only: the core
    // gets the world's env map.
    scrub_process_env(&w);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let app: Arc<dyn Assets> = Arc::new(DirAssets(app_dist));
    let mut cfg = world::scratch_config(&w, MemAssets::default(), Some(app));
    cfg.assets = Arc::new(od_server::WebDist);
    let core = rt
        .block_on(od_app::start(&w.env, 0, cfg))
        .expect("start core");
    assert!(
        !(4317..=4320).contains(&core.port),
        "never a real port: {}",
        core.port
    );

    let line = serde_json::json!({
        "port": core.port,
        "token": core.token(),
        "root": path_str(&w.root),
        "repo": path_str(&w.repo),
        "out": path_str(&w.out),
    });
    {
        let mut out = std::io::stdout().lock();
        writeln!(out, "{line}").expect("stdout");
        out.flush().expect("flush stdout");
    }

    // Serve until the test runner closes our stdin.
    rt.block_on(async {
        tokio::task::spawn_blocking(|| {
            let mut sink = [0u8; 256];
            let mut stdin = std::io::stdin().lock();
            while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
        })
        .await
        .expect("stdin reader");
        core.shutdown().await;
    });
    drop(rt);
    drop(scratch);
    std::process::exit(0);
}

/// A built UI read from a folder on disk, per request (relative, plain path components only).
struct DirAssets(PathBuf);

impl Assets for DirAssets {
    fn get(&self, path: &str) -> Option<Cow<'static, [u8]>> {
        let rel = Path::new(path);
        if path.is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
            return None;
        }
        std::fs::read(self.0.join(rel)).ok().map(Cow::Owned)
    }
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Point this process's homes, temp dirs and git config at the world's scratch dirs.
fn scrub_process_env(w: &world::World) {
    for k in [
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TMP",
        "TEMP",
        "CLAUDE_CONFIG_DIR",
        "OFFICE_DESKS_HOME",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
    ] {
        if let Some(v) = w.env.get(k) {
            std::env::set_var(k, v);
        }
    }
}
