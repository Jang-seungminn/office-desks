//! The in-process core: od-server on the native backend, bound to `127.0.0.1:<port>`.

use std::ffi::OsString;
use std::sync::Arc;

use od_core::native::env::EnvMap;
use od_server::{BackendKind, ServerConfig, ServerHandle};

use crate::assets::AppDist;

/// A running server. Dropping it does not dispose the agents: call [`Core::shutdown`].
pub struct Core {
    pub handle: ServerHandle,
    pub port: u16,
    pub kind: BackendKind,
}

impl Core {
    /// The `/term` token. Only the in-process UI gets it (over IPC); never sent over HTTP.
    pub fn token(&self) -> &str {
        &self.handle.term_token
    }

    /// Stop the server and dispose the backend (its agents). Idempotent.
    pub async fn shutdown(&self) {
        self.handle.shutdown().await;
    }
}

/// `ServerConfig::from_env(env)` with the app UI mounted at `/app/`. `tui_active` stays as
/// `from_env` has it: the UI keeps a `/ws` open, so the poller runs.
pub fn app_config(env: &EnvMap) -> ServerConfig {
    let mut cfg = ServerConfig::from_env(env);
    cfg.app_assets = Some(Arc::new(AppDist));
    cfg
}

/// Bind `127.0.0.1:<port>`, create the native backend (never probes Orca) and serve.
pub async fn start(env: &EnvMap, port: u16, mut cfg: ServerConfig) -> std::io::Result<Core> {
    let bound = od_server::bind(port).await?;
    let port = bound.port;
    // Some(Native): Orca/demo have no PTYs of ours, so /term would 404 (PARITY "R4/R5").
    let created = od_server::create_backend(
        Some(BackendKind::Native),
        env,
        port,
        &mut cfg,
        std::future::ready(false),
    )
    .await?;
    if created.kind != BackendKind::Native {
        return Err(std::io::Error::other("Gongbang needs the native backend"));
    }
    let handle = od_server::serve(bound, created.backend, cfg).await;
    Ok(Core {
        handle,
        port,
        kind: created.kind,
    })
}

/// `argv[1] == "hook-relay"`, compared as an `OsString` so a non-UTF-8 argument never panics.
pub fn hook_relay_requested(args: impl IntoIterator<Item = OsString>) -> bool {
    args.into_iter().nth(1).is_some_and(|a| a == "hook-relay")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(a: &[&str]) -> Vec<OsString> {
        a.iter().map(OsString::from).collect()
    }

    #[test]
    fn hook_relay_is_argv1_only() {
        assert!(hook_relay_requested(argv(&["gongbang", "hook-relay"])));
        assert!(!hook_relay_requested(argv(&["gongbang"])));
        assert!(!hook_relay_requested(argv(&["gongbang", "--hook-relay"])));
        assert!(!hook_relay_requested(argv(&[
            "gongbang",
            "x",
            "hook-relay"
        ])));
    }

    #[cfg(unix)]
    #[test]
    fn hook_relay_non_utf8_is_false() {
        use std::os::unix::ffi::OsStringExt;
        let args = vec![
            OsString::from("gongbang"),
            OsString::from_vec(vec![0x68, 0xff, 0xfe]),
        ];
        assert!(!hook_relay_requested(args));
    }
}
