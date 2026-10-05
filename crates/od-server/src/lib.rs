//! od-server: the Office Desks HTTP/WS API in Rust, on the wire exactly like the Node server in
//! `bridge/src/server.ts`, on top of `od-core`.
//!
//! [`bind`] a port, build a backend ([`native_backend`] or any `Arc<dyn OfficeBackend>`), then
//! [`serve`]. The server binds `127.0.0.1` only.

mod app;
pub mod assets;
mod enrich;
pub mod hub;
pub mod js;
pub mod poller;
pub mod reqs;
mod routes;
pub mod security;
mod ws;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use std::sync::Mutex;

use od_core::awards::AwardBook;
use od_core::backend::{NativeBackend, NativeDeps, OfficeBackend};
use od_core::model::OrgChart;
use od_core::native::pty_host::PtyHost;
use od_core::native::registry::Registry;
use tokio::net::TcpListener;
use tokio::sync::{watch, OnceCell};

pub use assets::{Assets, MemAssets, WebDist};
pub use hub::{Hub, ServerMessageJson};
pub use poller::Poller;

use app::{lock, AppState};
use enrich::Enricher;

pub type EnvMap = od_core::native::env::EnvMap;

/// The web dev server (`npm run dev`), allowed as an origin next to the bound port.
pub const DEV_WEB_PORT: u16 = 5173;

/// Everything `serve` needs besides the socket and the backend.
#[derive(Clone)]
pub struct ServerConfig {
    /// `OFFICE_DESKS_TUI`: the poller never idles (R5).
    pub tui_active: bool,
    /// 1500 ms.
    pub poll_interval: Duration,
    /// 10 000 ms (poller.ts `IDLE_INTERVAL_MS`).
    pub idle_interval: Duration,
    /// 60 000 ms.
    pub usage_interval: Duration,
    /// 2500 ms (`HIRE_RECHECK_MS`).
    pub hire_recheck: Duration,
    pub upload_dir: PathBuf,
    /// The home `CommandCatalog` scans (`~/.claude`, `~/.codex`).
    pub commands_home: PathBuf,
    pub org_file: PathBuf,
    pub awards_file: PathBuf,
    /// R3 demo: used when the loaded org has no departments.
    pub default_org: Option<OrgChart>,
    pub assets: Arc<dyn Assets>,
    /// Hub broadcast capacity, 256.
    pub ws_buffer: usize,
    /// `/term` outbound queue length per client, 1024 (Task 9).
    pub term_buffer: usize,
}

impl ServerConfig {
    /// Real defaults: `upload_dir()`, `os_home()` (TS `os.homedir()`, the process's own `HOME`,
    /// not `env`), `org_file(None, env)`, `awards_file(None, env)` and [`WebDist`].
    /// `upload_dir()` and `org_file()` only compute paths and do no IO.
    pub fn from_env(env: &EnvMap) -> Self {
        ServerConfig {
            tui_active: env.get("OFFICE_DESKS_TUI").is_some_and(|v| !v.is_empty()),
            poll_interval: Duration::from_millis(1500),
            idle_interval: Duration::from_millis(10_000),
            usage_interval: Duration::from_millis(60_000),
            hire_recheck: Duration::from_millis(2500),
            upload_dir: od_core::uploads::upload_dir(),
            commands_home: od_core::home::os_home(),
            org_file: od_core::org::org_file(None, env),
            awards_file: od_core::awards::awards_file(None, env),
            default_org: None,
            assets: Arc::new(WebDist),
            ws_buffer: 256,
            term_buffer: 1024,
        }
    }
}

/// A listening socket on `127.0.0.1`.
pub struct Bound {
    listener: TcpListener,
    pub port: u16,
}

/// Bind `127.0.0.1:<port>` (0 = any free port). The error text is the `io::Error`'s Display.
pub async fn bind(port: u16) -> std::io::Result<Bound> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let port = listener.local_addr()?.port();
    Ok(Bound { listener, port })
}

/// `http://127.0.0.1:<port>/hook/<encodeURIComponent(agentId)>?token=<token>` (backend/index.ts).
pub fn hook_url(port: u16) -> impl Fn(&str, &str) -> String + Send + Sync + 'static {
    move |agent_id, token| {
        format!(
            "http://127.0.0.1:{port}/hook/{}?token={token}",
            js::encode_uri_component(agent_id)
        )
    }
}

/// Port of `createNativeBackend`: `office_home(env)`, the registry at `<home>/state.json`
/// (loaded on the blocking pool), a fresh `PtyHost`, [`hook_url`] and `env` for the agents.
pub async fn native_backend(env: &EnvMap, port: u16) -> NativeBackend {
    let home = od_core::home::office_home(env);
    let registry = Arc::new(Registry::new(home.join("state.json")));
    let r = Arc::clone(&registry);
    if let Err(e) = tokio::task::spawn_blocking(move || r.load()).await {
        std::panic::resume_unwind(e.into_panic());
    }
    let mut deps = NativeDeps::new(Arc::new(PtyHost::new()), registry, home, hook_url(port));
    deps.env = Some(env.clone());
    NativeBackend::new(deps)
}

/// Start the HTTP server, the poller, the usage loop and the upload cleanup. Returns at once;
/// loading the org chart and the awards also runs in the background, as in `server.ts`.
#[must_use = "dropping the ServerHandle stops the server"]
pub async fn serve(
    bound: Bound,
    backend: Arc<dyn OfficeBackend>,
    cfg: ServerConfig,
) -> ServerHandle {
    let Bound { listener, port } = bound;
    let (stop_tx, mut stop_rx) = watch::channel(false);
    let hub = Arc::new(Hub::new(cfg.ws_buffer));
    let awards = Arc::new(Mutex::new(AwardBook::new(cfg.awards_file.clone())));
    let enricher = Arc::new(Enricher::new(
        Arc::clone(&backend),
        Arc::clone(&awards),
        Arc::clone(&hub),
    ));
    let source: poller::SourceFn = {
        let backend = Arc::clone(&backend);
        Arc::new(move || {
            let backend = Arc::clone(&backend);
            Box::pin(async move { backend.snapshot().await })
        })
    };
    let enrich: poller::EnrichFn = Arc::new(move |s| {
        let enricher = Arc::clone(&enricher);
        Box::pin(async move { enricher.enrich(s).await })
    });
    let poller = Poller::new(source, enrich, cfg.poll_interval, cfg.idle_interval);
    let state = Arc::new(AppState {
        port,
        allowed_ports: [port, DEV_WEB_PORT],
        assets: Arc::clone(&cfg.assets),
        backend: Arc::clone(&backend),
        cfg: cfg.clone(),
        poller: Arc::clone(&poller),
        hub: Arc::clone(&hub),
        org: Mutex::new(OrgChart {
            departments: Vec::new(),
        }),
        usage: Mutex::new(None),
        awards: Arc::clone(&awards),
        stop: stop_tx.subscribe(),
    });
    start_background(&state);

    let (closed_tx, closed_rx) = watch::channel(false);
    let router = app::router(Arc::clone(&state));
    tokio::spawn(async move {
        let stop = async move {
            // A dropped handle (every clone gone) also stops the server.
            let _ = stop_rx.wait_for(|s| *s).await;
        };
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(stop)
            .await;
        closed_tx.send_replace(true);
    });
    ServerHandle {
        port,
        term_token: random_token(),
        inner: Arc::new(HandleInner {
            backend,
            poller,
            hub,
            stop: stop_tx,
            closed: closed_rx,
            disposed: OnceCell::new(),
        }),
    }
}

/// The start-up work of `server.ts` that runs next to listening. Every loop ends on the stop
/// signal.
fn start_background(st: &Arc<AppState>) {
    // Awards: a book is useless (update() does nothing) until loaded.
    {
        let awards = Arc::clone(&st.awards);
        let file = st.cfg.awards_file.clone();
        tokio::task::spawn_blocking(move || {
            let mut book = AwardBook::new(file);
            book.load();
            *lock(&awards) = book;
        });
    }
    // Org chart: load, fall back to the default (the demo's), broadcast.
    {
        let st = Arc::clone(st);
        tokio::spawn(async move {
            let file = st.cfg.org_file.clone();
            let Ok(mut org) =
                tokio::task::spawn_blocking(move || od_core::org::load_org(&file)).await
            else {
                return;
            };
            if org.departments.is_empty() {
                if let Some(default) = &st.cfg.default_org {
                    org = default.clone();
                }
            }
            *lock(&st.org) = org.clone();
            st.hub.send(&ServerMessageJson::Org { org });
        });
    }
    // Plan usage: at once, then every `usage_interval` (the first tick is immediate).
    {
        let st = Arc::clone(st);
        tokio::spawn(async move {
            let mut every = tokio::time::interval(st.cfg.usage_interval);
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = every.tick() => {}
                    _ = st.stopped() => return,
                }
                tokio::select! {
                    _ = refresh_usage(&st) => {}
                    _ = st.stopped() => return,
                }
            }
        });
    }
    // Snapshots that changed go to every client.
    {
        let st = Arc::clone(st);
        let mut changes = st.poller.on_change();
        tokio::spawn(async move {
            loop {
                let snapshot = tokio::select! {
                    s = changes.recv() => match s {
                        Ok(s) => s,
                        // Missed some: the newest one is what counts.
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => st.poller.current(),
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    },
                    _ = st.stopped() => return,
                };
                st.hub.send(&ServerMessageJson::Snapshot { snapshot });
            }
        });
    }
    // Uploads older than a day.
    {
        let dir = st.cfg.upload_dir.clone();
        tokio::task::spawn_blocking(move || {
            od_core::uploads::clean_old_uploads(&dir, poller::now_ms())
        });
    }
    // Until a browser connects (the TUI is a live viewer), then poll.
    st.poller.set_idle(!st.cfg.tui_active);
    st.poller.start();
    {
        let st = Arc::clone(st);
        tokio::spawn(async move {
            st.stopped().await;
            st.poller.stop();
        });
    }
}

/// `refreshUsage`: store and broadcast a usage whose `providers` changed; errors and `None`
/// keep the last value.
async fn refresh_usage(st: &AppState) {
    let Ok(Some(next)) = st.backend.usage().await else {
        return;
    };
    let changed = {
        let mut usage = lock(&st.usage);
        let same = usage.as_ref().is_some_and(|u| {
            serde_json::to_string(&u.providers).ok() == serde_json::to_string(&next.providers).ok()
        });
        if !same {
            *usage = Some(next.clone());
        }
        !same
    };
    if changed {
        st.hub.send(&ServerMessageJson::Usage { usage: next });
    }
}

/// 32 hex chars from the OS RNG.
fn random_token() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS random source");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

struct HandleInner {
    backend: Arc<dyn OfficeBackend>,
    poller: Arc<Poller>,
    hub: Arc<Hub>,
    stop: watch::Sender<bool>,
    closed: watch::Receiver<bool>,
    disposed: OnceCell<()>,
}

/// A running server. Clones share the server; when every clone is dropped the server stops
/// accepting (without disposing the backend).
///
/// Shutdown is graceful for plain HTTP: the accept loop ends once in-flight requests are done,
/// which includes waiting for a request body a client is still sending. Connections upgraded
/// to WebSocket are not tracked by axum 0.8: they outlive [`ServerHandle::closed`] (they never
/// block it), so each WS loop must end itself on the stop signal (`AppState::stop`).
#[derive(Clone)]
#[must_use = "dropping every ServerHandle stops the server"]
pub struct ServerHandle {
    pub port: u16,
    /// The secret a `/term` client must present (Task 9).
    pub term_token: String,
    inner: Arc<HandleInner>,
}

impl ServerHandle {
    /// Stop accepting, then `backend.dispose().await`. Idempotent: concurrent and later calls
    /// wait for the same single dispose.
    pub async fn shutdown(&self) {
        self.inner.stop.send_replace(true);
        self.inner.poller.stop();
        self.inner
            .disposed
            .get_or_init(|| async { self.inner.backend.dispose().await })
            .await;
    }

    /// The office poller (the TUI of R5 reads and refreshes it directly).
    pub fn poller(&self) -> &Arc<Poller> {
        &self.inner.poller
    }

    /// The `/ws` broadcast, to send messages to every web client.
    pub fn hub(&self) -> &Arc<Hub> {
        &self.inner.hub
    }

    /// Resolves when the accept loop has ended (after shutdown), at once if it already has.
    /// It waits for in-flight HTTP requests, including request bodies still being received,
    /// but not for upgraded WebSocket connections, which outlive it.
    pub async fn closed(&self) {
        let mut rx = self.inner.closed.clone();
        let _ = rx.wait_for(|c| *c).await;
    }
}
