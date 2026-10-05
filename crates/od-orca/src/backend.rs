//! Port of `bridge/src/backend/orca.ts`: everything the office needs, through the Orca CLI.
//! Every argv is built here.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use od_core::backend::native_backend::NowFn;
use od_core::backend::{
    BackendCapabilities, BackendError, BackendMessages, BoardUpdate, ConversationHit, HireResult,
    HireSpec, KeyInput, OfficeBackend,
};
use od_core::jsstr::is_js_space;
use od_core::jsval;
use od_core::model::{OfficeAgent, OfficeDesk, OfficeSnapshot, UsageSnapshot};
use od_core::state_mapper::{to_snapshot, OrcaTerminalRow, OrcaWorktreeRow};
use od_core::util::{epoch_ms, lock};
use regex::Regex;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::cli::OrcaRunner;
use crate::sessions::{SessionResolver, SessionVerifier};
use crate::usage::to_usage;

/// Terminal rows only change when terminals open/close or retitle: refresh them sparingly.
pub const TERMINALS_MAX_AGE_MS: i64 = 15_000;
/// A refused prompt can be retried for this long (pruned when the next prompt is refused).
pub const BLOCKED_TTL_MS: i64 = 10 * 60_000;
/// R3 bound on the retry map (TS has none): past it the oldest refusals are forgotten.
pub const BLOCKED_MAX: usize = 256;
/// Orca's own wait for a new agent's TUI (`--timeout-ms=60000`) needs more than the 15 s
/// runner default; TS cuts it off at 15 s, R3 lets it finish.
pub const HIRE_WAIT_TIMEOUT: Duration = Duration::from_secs(65);

pub const NOT_WRITABLE: &str = "이 에이전트 터미널에 입력할 수 없어요 (터미널이 끊겼거나 Orca 화면에 붙어 있지 않음). Orca에서 터미널을 다시 연 뒤 보내 주세요";
const NO_SESSION: &str = "Orca 세션 검색에서 이 에이전트의 대화 기록을 찾지 못했습니다. (Orca Settings → Agent Session History가 켜져 있어야 합니다)";
const HIRE_DISABLED: &str = "이 백엔드에서는 새 작업을 만들 수 없어요";
const RETRY_NOT_FOUND: &str = "다시 보낼 메시지를 찾지 못했습니다. 새로 보내주세요";
const ADD_REPO_UNSUPPORTED: &str = "Orca에서는 Orca 앱에서 프로젝트를 추가해 주세요";
const UNSUPPORTED: &str = "이 백엔드에서는 할 수 없어요";
const HIRE_WARNING: &str =
    "에이전트는 띄웠지만 준비가 늦어 첫 지시는 보내지 못했어요. 패널에서 보내 주세요";

pub struct OrcaOptions {
    /// None accepts every session search hit (the TS default).
    pub verify: Option<SessionVerifier>,
    /// None is the wall clock.
    pub now: Option<NowFn>,
    /// Join prompt lines (cmd.exe shims can't carry newlines) and clean search keys.
    pub windows: bool,
}

// Not derivable on Windows, where `cfg!(windows)` is true.
#[allow(clippy::derivable_impls)]
impl Default for OrcaOptions {
    fn default() -> Self {
        Self {
            verify: None,
            now: None,
            windows: cfg!(windows),
        }
    }
}

/// Orca argv for a validated hire. Values only ever go in as `--flag=value`.
pub fn orca_hire_args(spec: &HireSpec) -> Vec<String> {
    match spec {
        HireSpec::Agent { desk_id, agent, .. } => vec![
            "terminal".into(),
            "create".into(),
            format!("--worktree=id:{desk_id}"),
            format!("--command={agent}"),
            format!("--title={agent}"),
        ],
        HireSpec::Worktree {
            repo_id,
            name,
            agent,
            base_branch,
            prompt,
        } => {
            let mut args = vec![
                "worktree".into(),
                "create".into(),
                format!("--repo=id:{repo_id}"),
                format!("--name={name}"),
                "--no-parent".into(),
                format!("--agent={agent}"),
            ];
            if let Some(b) = base_branch.as_deref().filter(|b| !b.is_empty()) {
                args.push(format!("--base-branch={b}"));
            }
            if let Some(p) = prompt.as_deref().filter(|p| !p.is_empty()) {
                args.push(format!("--prompt={p}"));
            }
            args
        }
    }
}

/// JS `text.replace(/\s*\r?\n\s*/g, ' ')`: every run of whitespace holding a line break becomes
/// one space; runs without `\n` stay as they are.
pub fn join_lines_for_cmd(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.contains('\n') {
            out.push(' ');
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for c in text.chars() {
        if is_js_space(c) {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out
}

/// Orca refuses input to a terminal whose process is gone or detached; say so in words.
fn not_writable(e: BackendError) -> BackendError {
    if e.code.as_deref() == Some("terminal_not_writable")
        || e.message.contains("terminal_not_writable")
    {
        BackendError::with_code(NOT_WRITABLE, "terminal_not_writable")
    } else {
        e
    }
}

fn request_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)request ID:\s*([0-9a-f-]{8,64})").expect("valid regex"))
}

/// `result[key]` as a list of rows; a missing or non-array value is empty, a bad row is dropped.
fn rows<T: DeserializeOwned>(result: &Value, key: &str) -> Vec<T> {
    match result.get(key) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| T::deserialize(v).ok())
            .collect(),
        _ => Vec::new(),
    }
}

/// A present, non-null value as JS `String(v)`, else `""`.
fn js_string_or_empty(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => jsval::string(v),
    }
}

fn str_of(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_string)
}

fn args_of(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

/// A prompt Orca refused; the same argv plus the request id may be retried.
struct Blocked {
    args: Vec<String>,
    at: i64,
}

pub struct OrcaBackend {
    runner: Arc<dyn OrcaRunner>,
    sessions: Arc<SessionResolver>,
    now: NowFn,
    windows: bool,
    capabilities: BackendCapabilities,
    messages: BackendMessages,
    /// Cached `terminal list` and when it was read.
    terminals: Mutex<Option<(i64, Vec<OrcaTerminalRow>)>>,
    /// Orca refuses a prompt while the agent can't take one (mid-transition, dialog, …) and hands
    /// back a request id; the exact same command plus that id may be retried later.
    blocked: Mutex<HashMap<String, Blocked>>,
}

impl OrcaBackend {
    pub fn new(runner: Arc<dyn OrcaRunner>, opts: OrcaOptions) -> Self {
        let now = opts.now.unwrap_or_else(|| Arc::new(epoch_ms));
        let sessions = SessionResolver::new(
            Arc::clone(&runner),
            opts.verify,
            Arc::clone(&now),
            opts.windows,
        );
        Self {
            runner,
            sessions,
            now,
            windows: opts.windows,
            capabilities: BackendCapabilities {
                usage: true,
                search: true,
                board: true,
                hire: true,
                changes: true,
                transcripts: true,
                focus: true,
                repos: false,
                stop: false,
                remove: false,
            },
            messages: BackendMessages {
                no_session: NO_SESSION.into(),
                hire_disabled: HIRE_DISABLED.into(),
            },
            terminals: Mutex::new(None),
            blocked: Mutex::new(HashMap::new()),
        }
    }

    fn now(&self) -> i64 {
        (self.now)()
    }

    /// Cached `terminal list`, refreshed when stale or when an agent shows up in a pane we
    /// don't know.
    async fn terminal_rows(
        &self,
        worktrees: &[OrcaWorktreeRow],
    ) -> Result<Vec<OrcaTerminalRow>, BackendError> {
        let cached = lock(&self.terminals).clone();
        let known: HashSet<String> = cached
            .iter()
            .flat_map(|(_, rows)| rows.iter())
            .map(|t| {
                format!(
                    "{}:{}",
                    t.tab_id.as_deref().unwrap_or("undefined"),
                    t.leaf_id.as_deref().unwrap_or("undefined")
                )
            })
            .collect();
        let unknown_pane = worktrees.iter().any(|w| {
            w.agents.iter().any(|a| {
                a.pane_key
                    .as_deref()
                    .is_some_and(|k| !k.is_empty() && !known.contains(k))
            })
        });
        let stale = cached
            .as_ref()
            .is_none_or(|(at, _)| self.now() - at > TERMINALS_MAX_AGE_MS);
        if let (false, false, Some((_, rows))) = (stale, unknown_pane, cached) {
            return Ok(rows);
        }
        let r = self.runner.run(&args_of(&["terminal", "list"])).await?;
        let rows: Vec<OrcaTerminalRow> = rows(&r, "terminals");
        let at = self.now();
        let mut cache = lock(&self.terminals);
        // Overlapping snapshots: never let an older list replace a newer one.
        if cache.as_ref().is_none_or(|(prev, _)| *prev <= at) {
            *cache = Some((at, rows.clone()));
        }
        Ok(rows)
    }

    /// Send a prompt argv; a refusal is remembered for `retry_prompt`.
    async fn deliver(&self, args: Vec<String>, retry_of: Option<&str>) -> Result<(), BackendError> {
        let e = match self.runner.run(&args).await {
            Ok(_) => {
                if let Some(id) = retry_of {
                    lock(&self.blocked).remove(id);
                }
                return Ok(());
            }
            Err(e) => e,
        };
        let request_id = request_id_re()
            .captures(&e.message)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .or_else(|| retry_of.map(str::to_string));
        let is_blocked = e.code.as_deref() == Some("agent_prompt_blocked")
            || e.message.contains("agent_prompt_blocked");
        let Some(request_id) = request_id.filter(|_| is_blocked) else {
            return Err(not_writable(e));
        };
        let now = self.now();
        let mut blocked = lock(&self.blocked);
        // A re-blocked retry keeps pointing at the original prompt, never at the retry argv.
        let base = match retry_of {
            Some(id) => blocked.get(id).map(|b| b.args.clone()),
            None => Some(args),
        };
        if let Some(base) = base {
            blocked.insert(
                request_id.clone(),
                Blocked {
                    args: base,
                    at: now,
                },
            );
        }
        blocked.retain(|_, b| now - b.at <= BLOCKED_TTL_MS);
        while blocked.len() > BLOCKED_MAX {
            let oldest = blocked
                .iter()
                .filter(|(id, _)| **id != request_id)
                .min_by_key(|(_, b)| b.at)
                .map(|(id, _)| id.clone());
            match oldest {
                Some(id) => blocked.remove(&id),
                None => break,
            };
        }
        Err(BackendError::busy(request_id))
    }
}

#[async_trait]
impl OfficeBackend for OrcaBackend {
    fn name(&self) -> &str {
        "orca"
    }

    fn capabilities(&self) -> &BackendCapabilities {
        &self.capabilities
    }

    fn messages(&self) -> &BackendMessages {
        &self.messages
    }

    async fn snapshot(&self) -> Result<OfficeSnapshot, BackendError> {
        let ps = self.runner.run(&args_of(&["worktree", "ps"])).await?;
        let worktrees: Vec<OrcaWorktreeRow> = rows(&ps, "worktrees");
        let terminals = self.terminal_rows(&worktrees).await?;
        Ok(to_snapshot(&worktrees, &terminals, self.now(), None))
    }

    async fn read_screen(&self, handle: &str) -> Result<Vec<String>, BackendError> {
        let r = self
            .runner
            .run(&args_of(&[
                "terminal",
                "read",
                "--terminal",
                handle,
                "--screen",
            ]))
            .await?;
        Ok(match r.pointer("/terminal/tail") {
            Some(Value::Array(lines)) => lines
                .iter()
                .map(|l| l.as_str().unwrap_or("").to_string())
                .collect(),
            _ => Vec::new(),
        })
    }

    async fn send_prompt(&self, handle: &str, text: &str) -> Result<(), BackendError> {
        // cmd.exe shims can't carry newlines in an argument on Windows; send those lines
        // space-joined.
        let body = if self.windows {
            join_lines_for_cmd(text)
        } else {
            text.to_string()
        };
        let mut args = args_of(&["terminal", "send", "--terminal", handle]);
        args.push(format!("--text={body}"));
        args.push("--enter".into());
        self.deliver(args, None).await
    }

    async fn retry_prompt(&self, request_id: &str) -> Result<(), BackendError> {
        let pending = lock(&self.blocked).get(request_id).map(|b| b.args.clone());
        let Some(mut args) = pending else {
            return Err(BackendError::with_code(RETRY_NOT_FOUND, "not_found"));
        };
        args.push(format!("--retry-request={request_id}"));
        args.push("--wait-submit=10".into());
        self.deliver(args, Some(request_id)).await
    }

    fn blocked_handle(&self, request_id: &str) -> Option<String> {
        lock(&self.blocked)
            .get(request_id)
            .and_then(|b| b.args.get(3).cloned())
    }

    async fn send_keys(&self, handle: &str, input: KeyInput) -> Result<(), BackendError> {
        // `--text=value` so text starting with `--` can never be parsed as another flag.
        let mut args = args_of(&["terminal", "send", "--terminal", handle]);
        args.push(match input {
            KeyInput::Enter => "--enter".into(),
            KeyInput::Bytes(bytes) => format!("--text={bytes}"),
        });
        self.runner.run(&args).await.map(drop).map_err(not_writable)
    }

    async fn focus(&self, handle: &str) -> Result<(), BackendError> {
        self.runner
            .run(&args_of(&["terminal", "switch", "--terminal", handle]))
            .await
            .map(drop)
    }

    async fn hire(&self, spec: HireSpec) -> Result<HireResult, BackendError> {
        let result = self.runner.run(&orca_hire_args(&spec)).await?;
        // A new worktree gets its prompt from Orca itself; a new terminal needs us to type it.
        let HireSpec::Agent {
            prompt: Some(prompt),
            ..
        } = &spec
        else {
            return Ok(HireResult::default());
        };
        if prompt.is_empty() {
            return Ok(HireResult::default());
        }
        let handle = match result.pointer("/terminal/handle") {
            None | Some(Value::Null) => result.get("handle"),
            h => h,
        };
        let Some(handle) = handle.and_then(Value::as_str).filter(|h| !h.is_empty()) else {
            return Ok(HireResult::default());
        };
        // The agent's TUI needs a moment; Orca can wait for it to be idle before we type.
        let wait = self
            .runner
            .run_with_timeout(
                &[
                    "terminal".into(),
                    "wait".into(),
                    format!("--terminal={handle}"),
                    "--for=tui-idle".into(),
                    "--timeout-ms=60000".into(),
                ],
                HIRE_WAIT_TIMEOUT,
            )
            .await?;
        if !wait.pointer("/wait/satisfied").is_some_and(jsval::truthy) {
            return Ok(HireResult {
                warning: Some(HIRE_WARNING.into()),
            });
        }
        self.runner
            .run(&[
                "terminal".into(),
                "send".into(),
                format!("--terminal={handle}"),
                format!("--text={prompt}"),
                "--enter".into(),
            ])
            .await?;
        Ok(HireResult::default())
    }

    async fn set_board(&self, desk_id: &str, update: BoardUpdate) -> Result<(), BackendError> {
        let mut args = args_of(&["worktree", "set"]);
        args.push(format!("--worktree=id:{desk_id}"));
        if let Some(s) = update.workspace_status {
            args.push(format!("--workspace-status={s}"));
        }
        // Orca can't clear a comment; a single space is the closest (shown as empty everywhere).
        if let Some(c) = update.comment {
            args.push(format!("--comment={}", if c.is_empty() { " " } else { &c }));
        }
        self.runner.run(&args).await.map(drop)
    }

    async fn find_session(
        &self,
        desk: &OfficeDesk,
        agent: &OfficeAgent,
    ) -> Result<Option<String>, BackendError> {
        self.sessions.resolve(desk, agent).await
    }

    fn cached_session(&self, agent_id: &str) -> Option<String> {
        self.sessions.cached(agent_id)
    }

    async fn search_conversations(
        &self,
        query: &str,
    ) -> Result<Vec<ConversationHit>, BackendError> {
        let r = self
            .runner
            .run(&[
                "search".into(),
                format!("--query={query}"),
                "--scope=conversation".into(),
                "--limit=30".into(),
            ])
            .await?;
        let Some(Value::Array(hits)) = r.get("hits") else {
            return Ok(Vec::new());
        };
        Ok(hits
            .iter()
            .map(|h| ConversationHit {
                agent: js_string_or_empty(h.get("agent")),
                title: js_string_or_empty(h.get("title")),
                cwd: str_of(h.get("cwd")).unwrap_or_default(),
                updated_at: str_of(h.get("updatedAt")),
                snippet: js_string_or_empty(h.pointer("/evidence/snippet")),
                role: str_of(h.pointer("/evidence/role")),
                file_path: str_of(h.pointer("/source/filePath")),
                resume_command: str_of(h.get("resumeCommand")),
            })
            .collect())
    }

    async fn usage(&self) -> Result<Option<UsageSnapshot>, BackendError> {
        let r = self.runner.run(&args_of(&["account", "list"])).await?;
        Ok(Some(to_usage(r.get("rateLimits"), self.now())))
    }

    async fn add_repo(&self, _repo_path: &str) -> Result<(), BackendError> {
        Err(BackendError::with_code(ADD_REPO_UNSUPPORTED, "unsupported"))
    }

    async fn stop_agent(&self, _agent_id: &str) -> Result<(), BackendError> {
        Err(BackendError::with_code(UNSUPPORTED, "unsupported"))
    }

    async fn remove_worktree(&self, _desk_id: &str) -> Result<(), BackendError> {
        Err(BackendError::with_code(UNSUPPORTED, "unsupported"))
    }

    fn hook(&self, _agent_id: &str, _token: &str, _payload: &Value) -> bool {
        false
    }

    /// Orca owns the terminals, so there is nothing to stop; only no new `orca search` may
    /// start (the session resolver answers from its cache from now on).
    async fn dispose(&self) {
        self.sessions.dispose();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{argv, FakeRunner};
    use serde_json::json;
    use std::sync::atomic::{AtomicI64, Ordering};

    fn manual_clock() -> (Arc<AtomicI64>, NowFn) {
        let t = Arc::new(AtomicI64::new(0));
        let c = Arc::clone(&t);
        (t, Arc::new(move || c.load(Ordering::SeqCst)))
    }

    fn backend(fake: &Arc<FakeRunner>) -> OrcaBackend {
        backend_on(fake, false)
    }

    fn backend_on(fake: &Arc<FakeRunner>, windows: bool) -> OrcaBackend {
        OrcaBackend::new(
            Arc::clone(fake) as Arc<dyn OrcaRunner>,
            OrcaOptions {
                verify: None,
                now: None,
                windows,
            },
        )
    }

    fn with_clock(fake: &Arc<FakeRunner>, now: NowFn) -> OrcaBackend {
        OrcaBackend::new(
            Arc::clone(fake) as Arc<dyn OrcaRunner>,
            OrcaOptions {
                verify: None,
                now: Some(now),
                windows: false,
            },
        )
    }

    fn orca_error(message: &str, code: &str) -> BackendError {
        BackendError::with_code(message, code)
    }

    fn blocked(id: &str) -> BackendError {
        orca_error(
            &format!("Agent can not take a prompt (request ID: {id})"),
            "agent_prompt_blocked",
        )
    }

    // orcaBackend.test.ts: OrcaBackend.snapshot
    #[tokio::test]
    async fn snapshot_lists_terminals_only_when_stale_or_on_an_unknown_pane() {
        let panes = Arc::new(Mutex::new(vec!["t1:l1".to_string()]));
        let p = Arc::clone(&panes);
        let fake = FakeRunner::new(move |args| {
            let panes = lock(&p).clone();
            Ok(if args[0] == "worktree" {
                json!({ "worktrees": [{
                    "worktreeId": "r::/a",
                    "agents": panes.iter().map(|k| json!({ "paneKey": k, "state": "working" })).collect::<Vec<_>>(),
                }] })
            } else {
                json!({ "terminals": panes.iter().map(|k| {
                    let (tab, leaf) = k.split_once(':').unwrap();
                    json!({ "handle": format!("h-{k}"), "tabId": tab, "leafId": leaf })
                }).collect::<Vec<_>>() })
            })
        });
        let (now, clock) = manual_clock();
        let b = with_clock(&fake, clock);
        let lists = || {
            fake.calls()
                .iter()
                .filter(|c| c.join(" ") == "terminal list")
                .count()
        };

        b.snapshot().await.unwrap();
        now.store(1500, Ordering::SeqCst);
        b.snapshot().await.unwrap();
        now.store(3000, Ordering::SeqCst);
        b.snapshot().await.unwrap();
        assert_eq!(lists(), 1);

        lock(&panes).push("t2:l2".into()); // a new agent appears
        now.store(4500, Ordering::SeqCst);
        let s = b.snapshot().await.unwrap();
        assert_eq!(lists(), 2);
        assert_eq!(
            s.desks[0].agents[1].terminal_handle.as_deref(),
            Some("h-t2:l2")
        );
        assert_eq!(s.updated_at, 4500);

        now.store(4500 + 16_000, Ordering::SeqCst); // stale
        b.snapshot().await.unwrap();
        assert_eq!(lists(), 3);
    }

    // orcaBackend.test.ts: OrcaBackend input
    #[tokio::test]
    async fn sends_prompts_keys_and_focus_with_flag_value_text() {
        let fake = FakeRunner::ok();
        let b = backend_on(&fake, false);
        b.send_prompt("term_1", "--help\nme").await.unwrap();
        b.send_keys("term_1", KeyInput::Bytes("\x1b[A".into()))
            .await
            .unwrap();
        b.send_keys("term_1", KeyInput::Enter).await.unwrap();
        b.focus("term_1").await.unwrap();
        assert_eq!(
            fake.calls(),
            vec![
                argv(&[
                    "terminal",
                    "send",
                    "--terminal",
                    "term_1",
                    "--text=--help\nme",
                    "--enter"
                ]),
                argv(&["terminal", "send", "--terminal", "term_1", "--text=\x1b[A"]),
                argv(&["terminal", "send", "--terminal", "term_1", "--enter"]),
                argv(&["terminal", "switch", "--terminal", "term_1"]),
            ]
        );
    }

    #[tokio::test]
    async fn joins_prompt_lines_on_windows() {
        let fake = FakeRunner::ok();
        backend_on(&fake, true)
            .send_prompt("term_1", "a\n  b\r\nc")
            .await
            .unwrap();
        assert_eq!(
            fake.calls(),
            vec![argv(&[
                "terminal",
                "send",
                "--terminal",
                "term_1",
                "--text=a b c",
                "--enter"
            ])]
        );
    }

    #[tokio::test]
    async fn reads_the_screen_tail() {
        let fake = FakeRunner::new(|_| Ok(json!({ "terminal": { "tail": ["a", "b"] } })));
        assert_eq!(
            backend(&fake).read_screen("term_1").await.unwrap(),
            vec!["a", "b"]
        );
        let empty = FakeRunner::ok();
        assert!(backend(&empty)
            .read_screen("term_1")
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            empty.calls(),
            vec![argv(&[
                "terminal",
                "read",
                "--terminal",
                "term_1",
                "--screen"
            ])]
        );
    }

    // orcaBackend.test.ts: OrcaBackend blocked prompts
    #[tokio::test]
    async fn agent_prompt_blocked_is_busy_and_retries_the_same_prompt() {
        let refuse = Arc::new(Mutex::new(true));
        let r = Arc::clone(&refuse);
        let fake = FakeRunner::new(move |_| {
            if *lock(&r) {
                Err(blocked("aaaaaaaa-1111"))
            } else {
                Ok(json!({}))
            }
        });
        let b = backend(&fake);
        let err = b.send_prompt("term_1", "hello").await.unwrap_err();
        assert!(err.is_busy());
        assert_eq!(err.request_id.as_deref(), Some("aaaaaaaa-1111"));
        assert_eq!(b.blocked_handle("aaaaaaaa-1111").as_deref(), Some("term_1"));

        *lock(&refuse) = false;
        b.retry_prompt("aaaaaaaa-1111").await.unwrap();
        assert_eq!(
            fake.calls().last().unwrap(),
            &argv(&[
                "terminal",
                "send",
                "--terminal",
                "term_1",
                "--text=hello",
                "--enter",
                "--retry-request=aaaaaaaa-1111",
                "--wait-submit=10",
            ])
        );
        assert_eq!(b.blocked_handle("aaaaaaaa-1111"), None);
    }

    #[tokio::test]
    async fn matches_a_blocked_prompt_by_message_when_the_code_is_generic() {
        let fake = FakeRunner::new(|_| {
            Err(orca_error(
                "agent_prompt_blocked: busy (request ID: cccccccc-3333)",
                "orca_error",
            ))
        });
        let err = backend(&fake)
            .send_prompt("term_1", "hi")
            .await
            .unwrap_err();
        assert!(err.is_busy());
        assert_eq!(err.request_id.as_deref(), Some("cccccccc-3333"));
    }

    #[tokio::test]
    async fn chains_a_re_blocked_retry_to_the_original_prompt() {
        let next = Arc::new(Mutex::new("aaaaaaaa-1111".to_string()));
        let n = Arc::clone(&next);
        let fake = FakeRunner::new(move |_| {
            let id = lock(&n).clone();
            if id.is_empty() {
                Ok(json!({}))
            } else {
                Err(blocked(&id))
            }
        });
        let b = backend(&fake);
        let _ = b.send_prompt("term_1", "hello").await;
        *lock(&next) = "bbbbbbbb-2222".into();
        let again = b.retry_prompt("aaaaaaaa-1111").await.unwrap_err();
        assert_eq!(again.request_id.as_deref(), Some("bbbbbbbb-2222"));
        lock(&next).clear();
        b.retry_prompt("bbbbbbbb-2222").await.unwrap();
        assert_eq!(
            fake.calls().last().unwrap(),
            &argv(&[
                "terminal",
                "send",
                "--terminal",
                "term_1",
                "--text=hello",
                "--enter",
                "--retry-request=bbbbbbbb-2222",
                "--wait-submit=10",
            ])
        );
    }

    #[tokio::test]
    async fn forgets_blocked_prompts_after_ten_minutes_and_rethrows_other_errors() {
        let refuse = Arc::new(Mutex::new(blocked("aaaaaaaa-1111")));
        let r = Arc::clone(&refuse);
        let fake = FakeRunner::new(move |_| Err(lock(&r).clone()));
        let (now, clock) = manual_clock();
        let b = with_clock(&fake, clock);
        let _ = b.send_prompt("term_1", "one").await;
        now.store(10 * 60_000 + 1, Ordering::SeqCst);
        *lock(&refuse) = blocked("bbbbbbbb-2222");
        let _ = b.send_prompt("term_1", "two").await;
        assert_eq!(b.blocked_handle("aaaaaaaa-1111"), None);
        assert_eq!(b.blocked_handle("bbbbbbbb-2222").as_deref(), Some("term_1"));

        *lock(&refuse) = orca_error("boom", "orca_error");
        assert_eq!(
            b.send_prompt("term_1", "x").await.unwrap_err(),
            orca_error("boom", "orca_error")
        );
        let unknown = b.retry_prompt("nope").await.unwrap_err();
        assert_eq!(unknown.code.as_deref(), Some("not_found"));
        assert_eq!(
            unknown.message,
            "다시 보낼 메시지를 찾지 못했습니다. 새로 보내주세요"
        );
    }

    #[tokio::test]
    async fn blocked_without_a_request_id_is_passed_through() {
        let fake = FakeRunner::new(|_| Err(orca_error("agent_prompt_blocked", "orca_error")));
        let err = backend(&fake)
            .send_prompt("term_1", "hi")
            .await
            .unwrap_err();
        assert_eq!(err, orca_error("agent_prompt_blocked", "orca_error"));
    }

    #[tokio::test]
    async fn the_retry_map_is_capped_and_keeps_the_newest() {
        let n = Arc::new(AtomicI64::new(0));
        let c = Arc::clone(&n);
        let fake = FakeRunner::new(move |_| {
            let i = c.fetch_add(1, Ordering::SeqCst);
            Err(blocked(&format!("{i:08x}-0000")))
        });
        // Every refusal at the same instant: the cap must still keep the one just inserted.
        let (_, clock) = manual_clock();
        let b = with_clock(&fake, clock);
        for _ in 0..=BLOCKED_MAX {
            let _ = b.send_prompt("term_1", "x").await;
        }
        assert_eq!(lock(&b.blocked).len(), BLOCKED_MAX);
        assert_eq!(
            b.blocked_handle(&format!("{BLOCKED_MAX:08x}-0000"))
                .as_deref(),
            Some("term_1")
        );

        // With distinct times the oldest goes first.
        let fake = FakeRunner::new({
            let c = Arc::new(AtomicI64::new(0));
            move |_| {
                let i = c.fetch_add(1, Ordering::SeqCst);
                Err(blocked(&format!("{i:08x}-0000")))
            }
        });
        let (now, clock) = manual_clock();
        let b = with_clock(&fake, clock);
        for i in 0..=BLOCKED_MAX {
            now.store(i as i64, Ordering::SeqCst);
            let _ = b.send_prompt("term_1", "x").await;
        }
        assert_eq!(lock(&b.blocked).len(), BLOCKED_MAX);
        assert_eq!(b.blocked_handle("00000000-0000"), None);
        assert!(b.blocked_handle("00000001-0000").is_some());
    }

    // orcaBackend.test.ts: OrcaBackend hire
    #[tokio::test]
    async fn hire_waits_for_the_new_agent_tui_before_typing() {
        let fake = FakeRunner::new(|args| {
            Ok(match args[1].as_str() {
                "create" => json!({ "terminal": { "handle": "term_9" } }),
                "wait" => json!({ "wait": { "satisfied": true } }),
                _ => json!({}),
            })
        });
        let r = backend(&fake)
            .hire(HireSpec::Agent {
                desk_id: "r::/a".into(),
                agent: "claude".into(),
                prompt: Some("go".into()),
            })
            .await
            .unwrap();
        assert_eq!(r, HireResult::default());
        assert_eq!(
            fake.calls(),
            vec![
                argv(&[
                    "terminal",
                    "create",
                    "--worktree=id:r::/a",
                    "--command=claude",
                    "--title=claude"
                ]),
                argv(&[
                    "terminal",
                    "wait",
                    "--terminal=term_9",
                    "--for=tui-idle",
                    "--timeout-ms=60000"
                ]),
                argv(&[
                    "terminal",
                    "send",
                    "--terminal=term_9",
                    "--text=go",
                    "--enter"
                ]),
            ]
        );
        // R3: the 60 s Orca wait gets its own 65 s runner timeout (TS cut it off at 15 s).
        assert_eq!(
            fake.timeouts(),
            vec![None, Some(Duration::from_secs(65)), None]
        );
    }

    #[tokio::test]
    async fn hire_warns_instead_of_typing_when_the_tui_never_became_idle() {
        let fake = FakeRunner::new(|args| {
            Ok(if args[1] == "create" {
                json!({ "handle": "term_9" })
            } else {
                json!({ "wait": { "satisfied": false } })
            })
        });
        let r = backend(&fake)
            .hire(HireSpec::Agent {
                desk_id: "r::/a".into(),
                agent: "claude".into(),
                prompt: Some("go".into()),
            })
            .await
            .unwrap();
        assert_eq!(
            r.warning.as_deref(),
            Some("에이전트는 띄웠지만 준비가 늦어 첫 지시는 보내지 못했어요. 패널에서 보내 주세요")
        );
        assert!(!fake.calls().iter().any(|c| c[1] == "send"));
    }

    #[tokio::test]
    async fn hire_passes_a_new_worktree_prompt_to_orca() {
        let fake = FakeRunner::ok();
        backend(&fake)
            .hire(HireSpec::Worktree {
                repo_id: "r1".into(),
                name: "x".into(),
                agent: "codex".into(),
                base_branch: None,
                prompt: Some("go".into()),
            })
            .await
            .unwrap();
        assert_eq!(
            fake.calls(),
            vec![argv(&[
                "worktree",
                "create",
                "--repo=id:r1",
                "--name=x",
                "--no-parent",
                "--agent=codex",
                "--prompt=go"
            ])]
        );
    }

    #[test]
    fn hire_args_skip_empty_options() {
        let spec = |base: Option<&str>, prompt: Option<&str>| HireSpec::Worktree {
            repo_id: "r1".into(),
            name: "x".into(),
            agent: "codex".into(),
            base_branch: base.map(str::to_string),
            prompt: prompt.map(str::to_string),
        };
        assert_eq!(
            orca_hire_args(&spec(Some("main"), Some(""))),
            argv(&[
                "worktree",
                "create",
                "--repo=id:r1",
                "--name=x",
                "--no-parent",
                "--agent=codex",
                "--base-branch=main"
            ])
        );
        assert_eq!(orca_hire_args(&spec(Some(""), None)).len(), 6);
    }

    #[tokio::test]
    async fn hire_without_a_prompt_or_handle_only_creates() {
        let fake = FakeRunner::new(|_| Ok(json!({ "terminal": { "handle": "" }, "handle": "h" })));
        let b = backend(&fake);
        for prompt in [None, Some(""), Some("go")] {
            let r = b
                .hire(HireSpec::Agent {
                    desk_id: "d".into(),
                    agent: "claude".into(),
                    prompt: prompt.map(str::to_string),
                })
                .await
                .unwrap();
            assert_eq!(r, HireResult::default());
        }
        assert!(fake.calls().iter().all(|c| c[1] == "create"));
    }

    // orcaBackend.test.ts: board, search, usage, sessions
    #[tokio::test]
    async fn clears_a_comment_with_a_single_space() {
        let fake = FakeRunner::ok();
        let b = backend(&fake);
        b.set_board(
            "r::/a",
            BoardUpdate {
                workspace_status: Some("in-review".into()),
                comment: Some(String::new()),
            },
        )
        .await
        .unwrap();
        b.set_board(
            "r::/a",
            BoardUpdate {
                workspace_status: None,
                comment: Some("hi".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            fake.calls(),
            vec![
                argv(&[
                    "worktree",
                    "set",
                    "--worktree=id:r::/a",
                    "--workspace-status=in-review",
                    "--comment= "
                ]),
                argv(&["worktree", "set", "--worktree=id:r::/a", "--comment=hi"]),
            ]
        );
    }

    #[tokio::test]
    async fn maps_conversation_search_hits() {
        let fake = FakeRunner::new(|_| {
            Ok(json!({ "hits": [
                { "agent": "claude", "title": "Fix", "cwd": "/p/a", "updatedAt": "2026-10-01",
                  "evidence": { "snippet": "x [[y]]", "role": "user" },
                  "source": { "filePath": "/f.jsonl" }, "resumeCommand": "claude -r 1" },
                {},
                5,
                { "agent": 7, "title": null, "cwd": 1, "updatedAt": 2, "evidence": { "snippet": true } },
            ] }))
        });
        let hits = backend(&fake).search_conversations("y").await.unwrap();
        let empty = ConversationHit {
            agent: String::new(),
            title: String::new(),
            cwd: String::new(),
            updated_at: None,
            snippet: String::new(),
            role: None,
            file_path: None,
            resume_command: None,
        };
        assert_eq!(
            hits,
            vec![
                ConversationHit {
                    agent: "claude".into(),
                    title: "Fix".into(),
                    cwd: "/p/a".into(),
                    updated_at: Some("2026-10-01".into()),
                    snippet: "x [[y]]".into(),
                    role: Some("user".into()),
                    file_path: Some("/f.jsonl".into()),
                    resume_command: Some("claude -r 1".into()),
                },
                empty.clone(),
                empty.clone(),
                ConversationHit {
                    agent: "7".into(),
                    snippet: "true".into(),
                    ..empty
                },
            ]
        );
        assert_eq!(
            serde_json::to_value(&hits[1]).unwrap(),
            json!({ "agent": "", "title": "", "cwd": "", "updatedAt": null, "snippet": "", "role": null, "filePath": null, "resumeCommand": null })
        );
        assert_eq!(
            fake.calls()[0],
            argv(&["search", "--query=y", "--scope=conversation", "--limit=30"])
        );
    }

    #[tokio::test]
    async fn reads_usage_from_account_list() {
        let fake = FakeRunner::new(|_| {
            Ok(
                json!({ "rateLimits": { "claude": { "provider": "claude", "status": "ok", "session": { "usedPercent": 50 } } } }),
            )
        });
        let (now, clock) = manual_clock();
        now.store(1234, Ordering::SeqCst);
        let u = with_clock(&fake, clock).usage().await.unwrap().unwrap();
        assert_eq!(u.providers.len(), 1);
        assert_eq!(u.providers[0].provider, "claude");
        assert_eq!(u.providers[0].windows.len(), 1);
        assert_eq!(u.providers[0].windows[0].key, "session");
        assert_eq!(u.providers[0].windows[0].used_percent, 50.0);
        assert_eq!(u.updated_at, 1234);
        assert_eq!(fake.calls(), vec![argv(&["account", "list"])]);
    }

    #[tokio::test]
    async fn finds_sessions_through_orca_search_and_caches_them() {
        let fake = FakeRunner::new(|_| {
            Ok(
                json!({ "hits": [{ "cwd": "/p/a", "source": { "presence": "present", "filePath": "/s.jsonl" } }] }),
            )
        });
        let b = backend(&fake);
        let desk = OfficeDesk {
            id: "r::/p/a".into(),
            repo_id: "r".into(),
            is_main: false,
            parent_id: None,
            name: "a".into(),
            repo: "r".into(),
            branch: String::new(),
            path: "/p/a".into(),
            status: "active".into(),
            workspace_status: None,
            comment: String::new(),
            preview: String::new(),
            is_active: false,
            unread: false,
            last_activity_at: None,
            changes: None,
            pr: None,
            agents: Vec::new(),
        };
        let agent = OfficeAgent {
            id: "tab:leaf".into(),
            terminal_handle: None,
            agent_type: "claude".into(),
            terminal_title: None,
            subagents_running: 0,
            model: None,
            effort: None,
            stats: None,
            state: od_core::model::CharacterState::Done,
            raw_state: "done".into(),
            activity: String::new(),
            prompt: Some("add pixel assets please".into()),
            last_message: None,
            since: None,
        };
        assert_eq!(b.cached_session("tab:leaf"), None);
        assert_eq!(
            b.find_session(&desk, &agent).await.unwrap().as_deref(),
            Some("/s.jsonl")
        );
        assert_eq!(b.cached_session("tab:leaf").as_deref(), Some("/s.jsonl"));

        // After dispose: the cache only, no new `orca search`.
        b.dispose().await;
        let calls = fake.calls().len();
        let fresh = OfficeAgent {
            prompt: Some("a prompt after dispose".into()),
            ..agent.clone()
        };
        assert_eq!(
            b.find_session(&desk, &fresh).await.unwrap().as_deref(),
            Some("/s.jsonl")
        );
        let unknown = OfficeAgent {
            id: "other".into(),
            ..agent
        };
        assert_eq!(b.find_session(&desk, &unknown).await.unwrap(), None);
        assert_eq!(fake.calls().len(), calls);
    }

    // orcaBackend.test.ts: OrcaBackend v2
    #[tokio::test]
    async fn terminal_not_writable_becomes_a_friendly_coded_error() {
        let fake = FakeRunner::new(|_| {
            Err(orca_error(
                "terminal_not_writable Terminal prompt request ID: 1fe4f207-0a7f-487d-8c7e-d7f040e56dd6. Re-issue …",
                "terminal_not_writable",
            ))
        });
        let b = backend(&fake);
        let sent = b.send_prompt("term_1", "hi").await.unwrap_err();
        assert_eq!(sent.code.as_deref(), Some("terminal_not_writable"));
        assert_eq!(sent.message, NOT_WRITABLE);
        assert!(sent.message.contains("입력할 수 없어요"));
        let keys = b.send_keys("term_1", KeyInput::Enter).await.unwrap_err();
        assert_eq!(
            keys,
            BackendError::with_code(NOT_WRITABLE, "terminal_not_writable")
        );

        // Matched by message too, as in TS.
        let fake = FakeRunner::new(|_| Err(orca_error("x terminal_not_writable", "orca_error")));
        let keys = backend(&fake)
            .send_keys("term_1", KeyInput::Bytes("a".into()))
            .await
            .unwrap_err();
        assert_eq!(keys.code.as_deref(), Some("terminal_not_writable"));
    }

    #[tokio::test]
    async fn declares_what_orca_can_do_and_refuses_native_only_calls() {
        let b = backend(&FakeRunner::ok());
        assert_eq!(b.name(), "orca");
        assert_eq!(
            serde_json::to_value(b.capabilities()).unwrap(),
            json!({ "usage": true, "search": true, "board": true, "hire": true, "changes": true, "transcripts": true, "focus": true, "repos": false, "stop": false, "remove": false })
        );
        assert_eq!(
            b.messages().no_session,
            "Orca 세션 검색에서 이 에이전트의 대화 기록을 찾지 못했습니다. (Orca Settings → Agent Session History가 켜져 있어야 합니다)"
        );
        assert_eq!(
            b.messages().hire_disabled,
            "이 백엔드에서는 새 작업을 만들 수 없어요"
        );
        assert!(!b.hook("x", "y", &json!({})));
        assert_eq!(
            b.add_repo("/tmp").await.unwrap_err(),
            BackendError::with_code(
                "Orca에서는 Orca 앱에서 프로젝트를 추가해 주세요",
                "unsupported"
            )
        );
        assert_eq!(
            b.stop_agent("x:main").await.unwrap_err(),
            BackendError::with_code("이 백엔드에서는 할 수 없어요", "unsupported")
        );
        assert_eq!(
            b.remove_worktree("r::/p").await.unwrap_err(),
            BackendError::with_code("이 백엔드에서는 할 수 없어요", "unsupported")
        );
        b.dispose().await;
        assert!(b.as_native().is_none());
    }

    #[test]
    fn not_writable_text_is_verbatim() {
        assert_eq!(
            NOT_WRITABLE,
            "이 에이전트 터미널에 입력할 수 없어요 (터미널이 끊겼거나 Orca 화면에 붙어 있지 않음). Orca에서 터미널을 다시 연 뒤 보내 주세요"
        );
        assert_eq!(TERMINALS_MAX_AGE_MS, 15_000);
        assert_eq!(BLOCKED_TTL_MS, 600_000);
    }

    // New in R3.
    #[tokio::test]
    async fn lenient_shapes() {
        let fake = FakeRunner::new(|_| Ok(json!({ "worktrees": 5 })));
        let s = backend(&fake).snapshot().await.unwrap();
        assert!(s.desks.is_empty());

        let fake = FakeRunner::new(|_| Ok(json!({ "terminal": { "tail": ["a", 1, null] } })));
        assert_eq!(
            backend(&fake).read_screen("t").await.unwrap(),
            vec!["a", "", ""]
        );

        let fake = FakeRunner::new(|_| Ok(json!({ "hits": null })));
        assert!(backend(&fake)
            .search_conversations("q")
            .await
            .unwrap()
            .is_empty());

        let fake = FakeRunner::new(|args| {
            Ok(if args[0] == "worktree" {
                json!({ "worktrees": [
                    { "worktreeId": "r::/a", "path": "/a", "lastActivityAt": 1.5e12 },
                    7,
                ] })
            } else {
                json!({ "terminals": "nope" })
            })
        });
        let s = backend(&fake).snapshot().await.unwrap();
        assert_eq!(s.desks.len(), 1);
        assert_eq!(s.desks[0].last_activity_at, Some(1_500_000_000_000));
    }

    #[test]
    fn join_lines_for_cmd_follows_the_js_regex() {
        assert_eq!(join_lines_for_cmd("a\n  b\r\nc"), "a b c");
        assert_eq!(join_lines_for_cmd("a \n \n b"), "a b");
        assert_eq!(join_lines_for_cmd("a  b"), "a  b");
        assert_eq!(join_lines_for_cmd("a\r\n"), "a ");
        assert_eq!(join_lines_for_cmd("\n"), " ");
        assert_eq!(join_lines_for_cmd("a\r b"), "a\r b");
        assert_eq!(join_lines_for_cmd("a\u{3000}\n\u{a0}b"), "a b");
        assert_eq!(join_lines_for_cmd(""), "");
    }

    #[test]
    fn no_plain_errors() {
        // Built with concat! so this test never matches its own source.
        let needles = [
            concat!("BackendError", "::plain"),
            concat!("code", ": None"),
        ];
        let dir = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
        let mut scanned = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for entry in std::fs::read_dir(&d).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                if !name.ends_with(".rs") || name == "fake.rs" {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                for needle in needles {
                    assert!(
                        !text.contains(needle),
                        "{} builds an uncoded error ({needle})",
                        path.display()
                    );
                }
                scanned.push(name);
            }
        }
        for must in [
            "backend.rs",
            "cli.rs",
            "demo.rs",
            "sessions.rs",
            "usage.rs",
            "verify.rs",
        ] {
            assert!(scanned.iter().any(|n| n == must), "{must} not scanned");
        }
    }
}
