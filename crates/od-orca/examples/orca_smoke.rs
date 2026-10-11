//! Read-only smoke test of the Rust Orca backend against the user's running Orca (R3 Task 8).
//!
//! Run it by hand, on the user's machine, and only after the user said yes:
//!
//! ```text
//! cargo run -p od-orca --example orca_smoke -- --user-approved-read-only
//! ```
//!
//! Every CLI call goes through [`ReadOnly`], which runs only `orca status`, `orca worktree ps`,
//! `orca terminal list` and `orca terminal read`. Anything else is refused, recorded and makes
//! the script exit 2. It prints one JSON object to stdout and never prints screen text.

use std::collections::BTreeMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use od_core::backend::{BackendError, OfficeBackend};
use od_core::native::env::process_env;
use od_core::screen::composer_state;
use od_orca::{
    probe_orca, OrcaBackend, OrcaCli, OrcaOptions, OrcaRunner, ORCA_TIMEOUT, PROBE_TIMEOUT,
};
use serde_json::{json, Value};

const FLAG: &str = "--user-approved-read-only";
const REFUSAL: &str = "This runs only: orca status, orca worktree ps, orca terminal list, orca terminal read. Ask the user first, then pass --user-approved-read-only.";

/// The only argv prefixes [`ReadOnly`] lets through.
const ALLOWED: &[&[&str]] = &[
    &["status"],
    &["worktree", "ps"],
    &["terminal", "list"],
    &["terminal", "read"],
];

/// Calls per allowed prefix and every refused argv, shared by all [`ReadOnly`] wrappers.
#[derive(Default)]
struct Log {
    calls: BTreeMap<String, u64>,
    refused: Vec<String>,
}

/// Wraps a runner and lets only the [`ALLOWED`] prefixes through.
struct ReadOnly {
    inner: Arc<dyn OrcaRunner>,
    log: Arc<Mutex<Log>>,
}

impl ReadOnly {
    fn new(inner: Arc<dyn OrcaRunner>, log: Arc<Mutex<Log>>) -> Self {
        Self { inner, log }
    }

    /// Ok(()) and a counted call when allowed; the `smoke_refused` error and a record otherwise.
    fn check(&self, args: &[String]) -> Result<(), BackendError> {
        let mut log = self.log.lock().unwrap_or_else(|e| e.into_inner());
        let allowed = ALLOWED.iter().find(|p| {
            args.len() >= p.len() && p.iter().zip(args).all(|(want, got)| *want == got.as_str())
        });
        match allowed {
            Some(prefix) => {
                *log.calls.entry(prefix.join(" ")).or_insert(0) += 1;
                Ok(())
            }
            None => {
                let joined = args.join(" ");
                log.refused.push(joined.clone());
                Err(BackendError::with_code(
                    format!("smoke: refused {joined}"),
                    "smoke_refused",
                ))
            }
        }
    }
}

#[async_trait]
impl OrcaRunner for ReadOnly {
    async fn run(&self, args: &[String]) -> Result<Value, BackendError> {
        self.check(args)?;
        self.inner.run(args).await
    }

    async fn run_with_timeout(
        &self,
        args: &[String],
        timeout: Duration,
    ) -> Result<Value, BackendError> {
        self.check(args)?;
        self.inner.run_with_timeout(args, timeout).await
    }
}

fn calls_json(log: &Log) -> Value {
    let mut calls = serde_json::Map::new();
    for prefix in ALLOWED {
        let key = prefix.join(" ");
        let n = log.calls.get(&key).copied().unwrap_or(0);
        calls.insert(key, json!(n));
    }
    Value::Object(calls)
}

fn finish(out: &Value, code: i32) -> ! {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{out}");
    let _ = stdout.flush();
    std::process::exit(code)
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    // The gate comes first: without the flag no runner is built and no orca command runs.
    if !std::env::args().skip(1).any(|a| a == FLAG) {
        println!("{REFUSAL}");
        std::process::exit(1);
    }

    let env = process_env();
    let log = Arc::new(Mutex::new(Log::default()));
    let probe = ReadOnly::new(
        Arc::new(OrcaCli::from_env(&env, PROBE_TIMEOUT)),
        Arc::clone(&log),
    );
    let ro: Arc<dyn OrcaRunner> = Arc::new(ReadOnly::new(
        Arc::new(OrcaCli::from_env(&env, ORCA_TIMEOUT)),
        Arc::clone(&log),
    ));

    // 1. Is Orca there at all?
    if !probe_orca(&probe).await {
        let refused = !log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .refused
            .is_empty();
        finish(&json!({ "reachable": false }), if refused { 2 } else { 0 });
    }

    // 2. No verifier, so session searches are never needed; find_session is never called.
    let backend = OrcaBackend::new(Arc::clone(&ro), OrcaOptions::default());

    // 3. Two snapshots back to back: the second must not list terminals again unless a pane is new.
    let mut errors: Vec<String> = Vec::new();
    let mut snapshot = None;
    for round in 1..=2 {
        match backend.snapshot().await {
            Ok(s) => snapshot = Some(s),
            Err(e) => errors.push(format!(
                "snapshot {round}: {}",
                e.code.as_deref().unwrap_or("error")
            )),
        }
        let counts = calls_json(&log.lock().unwrap_or_else(|e| e.into_inner()));
        eprintln!("[orca_smoke] after snapshot {round}: {counts}");
    }

    let mut desks = snapshot.map(|s| s.desks).unwrap_or_default();
    desks.sort_by(|a, b| a.id.cmp(&b.id));
    for d in &mut desks {
        d.agents.sort_by(|a, b| a.id.cmp(&b.id));
    }

    // 4. Up to 3 screens: line counts and composer states only, never the text.
    let mut screens = Vec::new();
    let with_handles = desks
        .iter()
        .flat_map(|d| d.agents.iter())
        .filter_map(|a| {
            a.terminal_handle
                .as_ref()
                .map(|h| (h.clone(), a.agent_type.clone()))
        })
        .take(3)
        .collect::<Vec<_>>();
    for (handle, agent_type) in with_handles {
        match backend.read_screen(&handle).await {
            Ok(lines) => screens.push(json!({
                "handle": handle,
                "lines": lines.len(),
                "composer": composer_state(&lines, &agent_type),
            })),
            Err(e) => {
                errors.push(format!(
                    "read_screen {handle}: {}",
                    e.code.as_deref().unwrap_or("error")
                ));
                screens.push(json!({ "handle": handle, "lines": null, "composer": null }));
            }
        }
    }

    // 5. One JSON object.
    let log = log.lock().unwrap_or_else(|e| e.into_inner());
    let desks_json: Vec<Value> = desks
        .iter()
        .map(|d| {
            json!({
                "id": d.id,
                "agents": d.agents.iter().map(|a| json!({
                    "id": a.id,
                    "terminalHandle": a.terminal_handle,
                    "agentType": a.agent_type,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let out = json!({
        "reachable": true,
        "desks": desks_json,
        "calls": calls_json(&log),
        "screens": screens,
        "refused": log.refused,
    });
    for e in &errors {
        eprintln!("[orca_smoke] {e}");
    }
    let code = if !log.refused.is_empty() {
        2
    } else if !errors.is_empty() {
        1
    } else {
        0
    };
    drop(log);
    finish(&out, code)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records every argv it is asked to run and answers `{}`. Never spawns anything.
    #[derive(Default)]
    struct Inner {
        ran: Mutex<Vec<Vec<String>>>,
    }

    #[async_trait]
    impl OrcaRunner for Inner {
        async fn run(&self, args: &[String]) -> Result<Value, BackendError> {
            self.ran.lock().unwrap().push(args.to_vec());
            Ok(json!({}))
        }
    }

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn read_only_refuses_and_records_a_send_without_running_it() {
        let inner = Arc::new(Inner::default());
        let log = Arc::new(Mutex::new(Log::default()));
        let ro = ReadOnly::new(Arc::clone(&inner) as Arc<dyn OrcaRunner>, Arc::clone(&log));

        let err = ro
            .run(&argv(&[
                "terminal",
                "send",
                "--terminal",
                "t1",
                "--text=hi",
            ]))
            .await
            .unwrap_err();
        assert_eq!(err.code.as_deref(), Some("smoke_refused"));
        assert_eq!(
            err.message,
            "smoke: refused terminal send --terminal t1 --text=hi"
        );
        let err = ro
            .run_with_timeout(&argv(&["worktree", "create"]), Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(err.code.as_deref(), Some("smoke_refused"));
        // A prefix must match whole words, and a bare first word is not enough.
        assert!(ro.run(&argv(&["terminal"])).await.is_err());
        assert!(ro.run(&argv(&["statusx"])).await.is_err());

        assert!(inner.ran.lock().unwrap().is_empty());
        let log = log.lock().unwrap();
        assert_eq!(
            log.refused,
            vec![
                "terminal send --terminal t1 --text=hi",
                "worktree create",
                "terminal",
                "statusx"
            ]
        );
        assert!(log.calls.is_empty());
    }

    #[tokio::test]
    async fn read_only_runs_and_counts_the_allowed_prefixes() {
        let inner = Arc::new(Inner::default());
        let log = Arc::new(Mutex::new(Log::default()));
        let ro = ReadOnly::new(Arc::clone(&inner) as Arc<dyn OrcaRunner>, Arc::clone(&log));

        for a in [
            argv(&["status"]),
            argv(&["worktree", "ps"]),
            argv(&["terminal", "list"]),
            argv(&["terminal", "read", "--terminal", "t1", "--screen"]),
            argv(&["terminal", "read", "--terminal", "t2", "--screen"]),
        ] {
            ro.run(&a).await.unwrap();
        }

        assert_eq!(inner.ran.lock().unwrap().len(), 5);
        let log = log.lock().unwrap();
        assert!(log.refused.is_empty());
        assert_eq!(
            calls_json(&log),
            json!({ "status": 1, "worktree ps": 1, "terminal list": 1, "terminal read": 2 })
        );
    }
}
