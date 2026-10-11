//! Backend selection (port of `createBackend` and `probeOrca` in `bridge/src/backend/index.ts`,
//! plus the demo server files from `server.ts`).
//!
//! The order is Node's: an explicit kind (the binary's `--backend`) > `OFFICE_DESKS_BACKEND` >
//! `--demo`/`OFFICE_DESKS_DEMO` > the `orca status` probe, else native. Callers turn their own
//! flags into a kind and use [`BackendKind::from_env`] for the env part.

use std::future::Future;
use std::io;
use std::sync::Arc;

use od_core::backend::OfficeBackend;
use od_orca::{
    probe_orca, resolve_orca_command, DemoBackend, DemoOptions, OrcaBackend, OrcaCli, OrcaOptions,
    ORCA_TIMEOUT, PROBE_TIMEOUT,
};

use crate::{native_backend, EnvMap, ServerConfig};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    Orca,
    Native,
    Demo,
}

impl BackendKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "orca" => Some(BackendKind::Orca),
            "native" => Some(BackendKind::Native),
            "demo" => Some(BackendKind::Demo),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            BackendKind::Orca => "orca",
            BackendKind::Native => "native",
            BackendKind::Demo => "demo",
        }
    }

    /// The env part of Node's selection: `OFFICE_DESKS_BACKEND` (trimmed; empty counts as
    /// unset) wins, else a non-empty `OFFICE_DESKS_DEMO` means demo, else None (probe). An
    /// unknown `OFFICE_DESKS_BACKEND` is an error with Node's text.
    pub fn from_env(env: &EnvMap) -> Result<Option<BackendKind>, String> {
        let backend = env
            .get("OFFICE_DESKS_BACKEND")
            .map(|v| od_core::jsstr::trim(v))
            .filter(|v| !v.is_empty());
        if let Some(v) = backend {
            return BackendKind::parse(v)
                .map(Some)
                .ok_or_else(|| unknown_backend(v));
        }
        if env.get("OFFICE_DESKS_DEMO").is_some_and(|v| !v.is_empty()) {
            return Ok(Some(BackendKind::Demo));
        }
        Ok(None)
    }
}

/// Node's `createBackend` error, verbatim.
pub fn unknown_backend(value: &str) -> String {
    format!("Unknown OFFICE_DESKS_BACKEND \"{value}\" (use orca, native or demo)")
}

/// The default probe for [`create_backend`]: `orca status` with [`PROBE_TIMEOUT`] (TS
/// `probeOrca()`). The runner is built only when the future is polled, so a caller that picks a
/// kind never builds it.
pub async fn default_probe(env: &EnvMap) -> bool {
    probe_orca(&OrcaCli::from_env(env, PROBE_TIMEOUT)).await
}

/// A backend, which kind it is, and the label of the startup line.
pub struct CreatedBackend {
    pub backend: Arc<dyn OfficeBackend>,
    /// The kind that was built: the one asked for, or what the probe chose. Auto mode picks
    /// Orca whenever it is running, and an Orca backend has no `/term` panes; the desktop app
    /// and the TUI should ask for [`BackendKind::Native`].
    pub kind: BackendKind,
    /// `DEMO data`, `orca backend, orca cli: <command>` or `native backend`.
    pub label: String,
}

/// Build the backend. `kind` None means "auto": `probe` (the `orca status` check) decides, and
/// it is not polled when `kind` is `Some`. The demo also points `cfg` at its own files.
pub async fn create_backend(
    kind: Option<BackendKind>,
    env: &EnvMap,
    port: u16,
    cfg: &mut ServerConfig,
    probe: impl Future<Output = bool>,
) -> io::Result<CreatedBackend> {
    // Not `unwrap_or`: its argument would run the probe even for an explicit kind.
    let kind = match kind {
        Some(k) => k,
        None => {
            if probe.await {
                BackendKind::Orca
            } else {
                BackendKind::Native
            }
        }
    };
    let verify = Some(od_orca::transcript_verifier());
    match kind {
        BackendKind::Native => Ok(CreatedBackend {
            backend: Arc::new(native_backend(env, port).await),
            kind,
            label: "native backend".into(),
        }),
        BackendKind::Orca => {
            let cli = OrcaCli::from_env(env, ORCA_TIMEOUT);
            let backend = OrcaBackend::new(
                Arc::new(cli),
                OrcaOptions {
                    verify,
                    ..Default::default()
                },
            );
            Ok(CreatedBackend {
                backend: Arc::new(backend),
                kind,
                label: format!("orca backend, orca cli: {}", resolve_orca_command(env)),
            })
        }
        BackendKind::Demo => {
            let opts = DemoOptions::from_env(env, verify);
            let (demo, files) = tokio::task::spawn_blocking(move || {
                let demo = DemoBackend::new(opts)?;
                let files = demo.server_files()?;
                io::Result::Ok((demo, files))
            })
            .await
            .map_err(|e| io::Error::other(e.to_string()))??;
            cfg.awards_file = files.awards_file;
            cfg.org_file = files.org_file;
            cfg.default_org = Some(files.default_org);
            Ok(CreatedBackend {
                backend: Arc::new(demo),
                kind,
                label: "DEMO data".into(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch {
        dir: tempfile::TempDir,
        env: EnvMap,
    }

    fn scratch() -> Scratch {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let tmp = p.join("tmp");
        std::fs::create_dir_all(&tmp).unwrap();
        let mut env = EnvMap::new();
        let s = |x: std::path::PathBuf| x.to_string_lossy().into_owned();
        env.insert("OFFICE_DESKS_HOME".into(), s(p.join("od")));
        for k in ["TMPDIR", "TMP", "TEMP"] {
            env.insert(k.into(), s(tmp.clone()));
        }
        env.insert("ORCA_CLI_COMMAND".into(), s(p.join("no-such-orca")));
        Scratch { dir, env }
    }

    fn cfg(sc: &Scratch) -> ServerConfig {
        let p = sc.dir.path();
        let mut c = ServerConfig::from_env(&sc.env);
        c.upload_dir = p.join("uploads");
        c.commands_home = p.join("home");
        c.org_file = p.join("org.json");
        c.awards_file = p.join("awards.json");
        c
    }

    async fn name_of(kind: Option<BackendKind>, probe: bool) -> (String, BackendKind) {
        let sc = scratch();
        let mut c = cfg(&sc);
        let created = create_backend(kind, &sc.env, 0, &mut c, async move { probe })
            .await
            .unwrap();
        let name = created.backend.name().to_string();
        created.backend.dispose().await;
        (name, created.kind)
    }

    fn env_of(pairs: &[(&str, &str)]) -> EnvMap {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn from_env_follows_node() {
        let k = |pairs: &[(&str, &str)]| BackendKind::from_env(&env_of(pairs));
        assert_eq!(k(&[]), Ok(None));
        assert_eq!(
            k(&[("OFFICE_DESKS_BACKEND", "demo")]),
            Ok(Some(BackendKind::Demo))
        );
        assert_eq!(
            k(&[("OFFICE_DESKS_BACKEND", " orca\n")]),
            Ok(Some(BackendKind::Orca))
        );
        assert_eq!(
            k(&[
                ("OFFICE_DESKS_BACKEND", "native"),
                ("OFFICE_DESKS_DEMO", "1")
            ]),
            Ok(Some(BackendKind::Native))
        );
        assert_eq!(
            k(&[("OFFICE_DESKS_DEMO", "1")]),
            Ok(Some(BackendKind::Demo))
        );
        assert_eq!(
            k(&[("OFFICE_DESKS_BACKEND", "  "), ("OFFICE_DESKS_DEMO", "1")]),
            Ok(Some(BackendKind::Demo))
        );
        assert_eq!(k(&[("OFFICE_DESKS_DEMO", "")]), Ok(None));
        assert_eq!(
            k(&[("OFFICE_DESKS_BACKEND", "x")]),
            Err("Unknown OFFICE_DESKS_BACKEND \"x\" (use orca, native or demo)".to_string())
        );
    }

    #[tokio::test]
    async fn default_probe_is_false_without_orca() {
        // ORCA_CLI_COMMAND points at a missing file in the scratch dir: no real orca runs.
        let sc = scratch();
        assert!(!default_probe(&sc.env).await);
    }

    #[tokio::test]
    async fn explicit_kind_never_probes() {
        for (kind, name) in [
            (BackendKind::Orca, "orca"),
            (BackendKind::Demo, "demo"),
            (BackendKind::Native, "native"),
        ] {
            let sc = scratch();
            let mut c = cfg(&sc);
            let created = create_backend(Some(kind), &sc.env, 0, &mut c, async {
                panic!("should not probe")
            })
            .await
            .unwrap();
            assert_eq!(created.backend.name(), name);
            assert_eq!(created.kind, kind);
            created.backend.dispose().await;
        }
    }

    #[tokio::test]
    async fn auto_follows_the_probe() {
        assert_eq!(
            name_of(None, true).await,
            ("orca".into(), BackendKind::Orca)
        );
        assert_eq!(
            name_of(None, false).await,
            ("native".into(), BackendKind::Native)
        );
    }

    #[tokio::test]
    async fn labels() {
        let sc = scratch();
        let mut c = cfg(&sc);
        let o = create_backend(Some(BackendKind::Orca), &sc.env, 0, &mut c, async { true })
            .await
            .unwrap();
        assert_eq!(
            o.label,
            format!(
                "orca backend, orca cli: {}",
                sc.dir.path().join("no-such-orca").display()
            )
        );
        o.backend.dispose().await;
        let n = create_backend(Some(BackendKind::Native), &sc.env, 0, &mut c, async {
            true
        })
        .await
        .unwrap();
        assert_eq!(n.label, "native backend");
        n.backend.dispose().await;
    }

    #[tokio::test]
    async fn demo_points_the_config_at_its_files() {
        let sc = scratch();
        let mut c = cfg(&sc);
        assert!(c.default_org.is_none());
        let d = create_backend(Some(BackendKind::Demo), &sc.env, 0, &mut c, async { false })
            .await
            .unwrap();
        assert_eq!(d.label, "DEMO data");
        assert!(c.default_org.is_some());
        assert!(c.awards_file.starts_with(sc.dir.path().join("tmp")));
        assert!(c.awards_file.exists());
        d.backend.dispose().await;
    }
}
