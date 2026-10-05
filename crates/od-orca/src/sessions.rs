//! Port of `bridge/src/sessionResolver.ts`: map an Orca agent to its transcript file using
//! Orca's own session index (`orca search`), which covers Claude and Codex on every OS. The
//! cache is keyed by the phrase, so a new prompt (or `/clear`, a new session) re-resolves.
//!
//! New in R3 (PARITY): each search runs in a spawned task bounded by [`RESOLVE_TIMEOUT`], so a
//! caller that goes away does not cancel it and a stuck runner cannot wedge an agent.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::{BoxFuture, FutureExt, Shared};
use od_core::backend::native_backend::NowFn;
use od_core::backend::BackendError;
use od_core::jsstr::{collapse_ws, slice_utf16, utf16_len};
use od_core::model::{OfficeAgent, OfficeDesk};
use od_core::nodepath::same_path;
use od_core::util::lock;
use serde_json::Value;

use crate::cli::OrcaRunner;

/// Don't hammer `orca search --fresh` every poll for an agent we just failed to find.
pub const MISS_TTL_MS: i64 = 30_000;
/// The overall bound on one agent's search (verification included).
pub const RESOLVE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchKey {
    pub phrase: String,
    /// Set when searching by session title, so the exact-title hit wins.
    pub title: Option<String>,
}

/// Confirms a candidate transcript really belongs to this agent (guards against fuzzy hits).
pub type SessionVerifier = Arc<dyn Fn(String, SearchKey) -> BoxFuture<'static, bool> + Send + Sync>;

const SHELL_TITLES: [&str; 7] = [
    "claude",
    "codex",
    "zsh",
    "bash",
    "pwsh",
    "powershell",
    "terminal",
];

/// Port of `searchKey`: a distinctive phrase from what Orca tells us about the agent's latest
/// turn. `windows` is TS `platform === 'win32'`.
pub fn search_key(
    prompt: Option<&str>,
    terminal_title: Option<&str>,
    last_message: Option<&str>,
    windows: bool,
) -> Option<SearchKey> {
    // Search phrases come from agent output (even terminal titles, which any program can set),
    // so on Windows drop characters cmd.exe would interpret; it's only a search query.
    let clean = |s: Option<&str>| -> String {
        let s = s.unwrap_or("");
        if windows {
            let replaced: String = s
                .chars()
                .map(|c| {
                    if matches!(c, '"' | '%' | '&' | '|' | '<' | '>' | '^' | '!' | '`') {
                        ' '
                    } else {
                        c
                    }
                })
                .collect();
            collapse_ws(&replaced)
        } else {
            collapse_ws(s)
        }
    };
    let prompt = clean(prompt);
    if utf16_len(&prompt) >= 6 {
        return Some(SearchKey {
            phrase: slice_utf16(&prompt, 80).to_string(),
            title: None,
        });
    }
    // Claude Code names the terminal tab after the session title (e.g. "✳ Fix login bug").
    let title = clean(terminal_title);
    if utf16_len(&title) >= 4 && !SHELL_TITLES.iter().any(|t| title.eq_ignore_ascii_case(t)) {
        return Some(SearchKey {
            phrase: title.clone(),
            title: Some(title),
        });
    }
    let last = clean(last_message);
    if utf16_len(&last) >= 12 {
        return Some(SearchKey {
            phrase: slice_utf16(&last, 80).to_string(),
            title: None,
        });
    }
    None
}

type SharedResolve = Shared<BoxFuture<'static, Result<Option<String>, BackendError>>>;

struct Entry {
    phrase: String,
    file_path: Option<String>,
    at: i64,
    last_good: Option<String>,
}

/// What one search needs from the desk and agent, owned so it can move into a task.
struct Query {
    desk_path: String,
    id: String,
    agent_type: String,
    prompt: Option<String>,
    terminal_title: Option<String>,
    last_message: Option<String>,
}

pub struct SessionResolver {
    runner: Arc<dyn OrcaRunner>,
    verify: SessionVerifier,
    now: NowFn,
    windows: bool,
    cache: Mutex<HashMap<String, Entry>>,
    inflight: Mutex<HashMap<String, (u64, SharedResolve)>>,
    generation: AtomicU64,
}

/// Removes the in-flight entry when the search task ends, even by panic, unless a newer search
/// for the same agent has replaced it.
struct RemoveOnDrop {
    resolver: Arc<SessionResolver>,
    id: String,
    gen: u64,
}

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let mut inflight = lock(&self.resolver.inflight);
        if inflight.get(&self.id).is_some_and(|(g, _)| *g == self.gen) {
            inflight.remove(&self.id);
        }
    }
}

impl SessionResolver {
    /// `verify` None accepts every hit (the TS default).
    pub fn new(
        runner: Arc<dyn OrcaRunner>,
        verify: Option<SessionVerifier>,
        now: NowFn,
        windows: bool,
    ) -> Arc<Self> {
        let verify = verify.unwrap_or_else(|| Arc::new(|_, _| async { true }.boxed()));
        Arc::new(Self {
            runner,
            verify,
            now,
            windows,
            cache: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
        })
    }

    /// Last known transcript for an agent, without searching.
    pub fn cached(&self, agent_id: &str) -> Option<String> {
        lock(&self.cache)
            .get(agent_id)
            .and_then(|e| e.last_good.clone())
    }

    /// Concurrent callers for the same agent share one search.
    pub async fn resolve(
        self: &Arc<Self>,
        desk: &OfficeDesk,
        agent: &OfficeAgent,
    ) -> Result<Option<String>, BackendError> {
        let shared = {
            let mut inflight = lock(&self.inflight);
            if let Some((_, running)) = inflight.get(&agent.id) {
                running.clone()
            } else {
                let gen = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
                let query = Query {
                    desk_path: desk.path.clone(),
                    id: agent.id.clone(),
                    agent_type: agent.agent_type.clone(),
                    prompt: agent.prompt.clone(),
                    terminal_title: agent.terminal_title.clone(),
                    last_message: agent.last_message.clone(),
                };
                let me = Arc::clone(self);
                let guard = RemoveOnDrop {
                    resolver: Arc::clone(self),
                    id: agent.id.clone(),
                    gen,
                };
                let handle = tokio::spawn(async move {
                    let _guard = guard;
                    match tokio::time::timeout(RESOLVE_TIMEOUT, me.resolve_now(query)).await {
                        Ok(r) => r,
                        Err(_) => Err(BackendError::with_code(
                            "session search timed out",
                            "timeout",
                        )),
                    }
                });
                let shared = async move {
                    handle.await.unwrap_or_else(|e| {
                        Err(BackendError::new(format!("session search failed: {e}")))
                    })
                }
                .boxed()
                .shared();
                // Inserted under the same lock the task's guard takes, so the guard can never
                // run before the entry exists.
                inflight.insert(agent.id.clone(), (gen, shared.clone()));
                shared
            }
        };
        shared.await
    }

    async fn resolve_now(&self, q: Query) -> Result<Option<String>, BackendError> {
        let key = search_key(
            q.prompt.as_deref(),
            q.terminal_title.as_deref(),
            q.last_message.as_deref(),
            self.windows,
        );
        let Some(key) = key else {
            return Ok(self.cached(&q.id));
        };
        let cached_good = {
            let cache = lock(&self.cache);
            let cached = cache.get(&q.id);
            if let Some(c) = cached.filter(|c| c.phrase == key.phrase) {
                if let Some(f) = &c.file_path {
                    return Ok(Some(f.clone()));
                }
                if (self.now)() - c.at < MISS_TTL_MS {
                    return Ok(c.last_good.clone());
                }
            }
            cached.and_then(|c| c.last_good.clone())
        };

        let args: Vec<String> = vec![
            "search".into(),
            format!("--query={}", key.phrase),
            format!("--path={}", q.desk_path),
            format!("--agent={}", q.agent_type),
            "--sort=newest".into(),
            "--limit=5".into(),
            "--fresh".into(),
        ];
        let result = self.runner.run(&args).await?;
        let mut hits: Vec<Hit> = match result.get("hits") {
            Some(Value::Array(hits)) => hits.iter().filter_map(|h| hit(h, &q.desk_path)).collect(),
            _ => Vec::new(),
        };
        if let Some(wanted) = key.title.as_deref().map(str::to_lowercase) {
            // Stable: title matches first, otherwise Orca's order.
            hits.sort_by_key(|h| {
                h.title.as_deref().map(str::to_lowercase).as_deref() != Some(wanted.as_str())
            });
        }
        let mut found = None;
        for h in hits {
            if (self.verify)(h.file_path.clone(), key.clone()).await {
                found = Some(h.file_path);
                break;
            }
        }
        // Keep showing the last known session while a brand-new prompt isn't indexed yet.
        let last_good = found.clone().or(cached_good);
        lock(&self.cache).insert(
            q.id,
            Entry {
                phrase: key.phrase,
                file_path: found,
                at: (self.now)(),
                last_good: last_good.clone(),
            },
        );
        Ok(last_good)
    }

    #[cfg(test)]
    fn inflight_len(&self) -> usize {
        lock(&self.inflight).len()
    }
}

struct Hit {
    title: Option<String>,
    file_path: String,
}

/// A usable search hit: present, with a transcript path, from this desk's folder. A hit that is
/// not an object counts as `{}` (and is dropped).
fn hit(h: &Value, desk_path: &str) -> Option<Hit> {
    let source = h.get("source");
    if source
        .and_then(|s| s.get("presence"))
        .and_then(Value::as_str)
        == Some("missing")
    {
        return None;
    }
    let file_path = source
        .and_then(|s| s.get("filePath"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    let cwd = h
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    if !same_path(cwd, desk_path) {
        return None;
    }
    Some(Hit {
        title: h.get("title").and_then(Value::as_str).map(str::to_string),
        file_path: file_path.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::FakeRunner;
    use async_trait::async_trait;
    use od_core::model::CharacterState;
    use serde_json::json;
    use std::sync::atomic::{AtomicI64, AtomicUsize};
    use tokio::sync::Notify;

    fn agent(prompt: &str, title: Option<&str>, last: Option<&str>) -> OfficeAgent {
        OfficeAgent {
            id: "tab:leaf".into(),
            terminal_handle: Some("term_1".into()),
            agent_type: "claude".into(),
            terminal_title: title.map(str::to_string),
            subagents_running: 0,
            model: None,
            effort: None,
            stats: None,
            state: CharacterState::Done,
            raw_state: "done".into(),
            activity: String::new(),
            prompt: Some(prompt.to_string()),
            last_message: last.map(str::to_string),
            since: None,
        }
    }

    fn desk() -> OfficeDesk {
        OfficeDesk {
            id: "r::/Users/me/proj".into(),
            repo_id: "r".into(),
            is_main: true,
            parent_id: None,
            name: "proj".into(),
            repo: "proj".into(),
            branch: "main".into(),
            path: "/Users/me/proj".into(),
            status: "active".into(),
            workspace_status: None,
            comment: String::new(),
            preview: String::new(),
            is_active: true,
            unread: false,
            last_activity_at: None,
            changes: None,
            pr: None,
            agents: Vec::new(),
        }
    }

    const PROMPT: &str = "add pixel assets please";

    fn key_of(a: &OfficeAgent, windows: bool) -> Option<SearchKey> {
        search_key(
            a.prompt.as_deref(),
            a.terminal_title.as_deref(),
            a.last_message.as_deref(),
            windows,
        )
    }

    fn manual_clock() -> (Arc<AtomicI64>, NowFn) {
        let t = Arc::new(AtomicI64::new(0));
        let c = Arc::clone(&t);
        (t, Arc::new(move || c.load(Ordering::SeqCst)))
    }

    fn clock() -> NowFn {
        manual_clock().1
    }

    #[test]
    fn search_key_prefers_prompt_then_title_then_last_message() {
        assert_eq!(
            key_of(&agent(PROMPT, None, None), false),
            Some(SearchKey {
                phrase: PROMPT.into(),
                title: None
            })
        );
        assert_eq!(
            key_of(&agent("", Some("Command context logging"), None), false),
            Some(SearchKey {
                phrase: "Command context logging".into(),
                title: Some("Command context logging".into())
            })
        );
        assert_eq!(
            key_of(
                &agent(
                    "",
                    Some("claude"),
                    Some("Fixed the orphan pages, lint is clean")
                ),
                false
            )
            .unwrap()
            .phrase,
            "Fixed the orphan pages, lint is clean"
        );
        assert_eq!(key_of(&agent("1", None, None), false), None);
        assert_eq!(
            key_of(&agent("run \"&calc&\" now please", None, None), true)
                .unwrap()
                .phrase,
            "run calc now please"
        );
        // Not Windows: the characters stay.
        assert_eq!(
            key_of(&agent("run \"&calc&\" now please", None, None), false)
                .unwrap()
                .phrase,
            "run \"&calc&\" now please"
        );
    }

    #[test]
    fn search_key_counts_utf16_units() {
        let han = "한".repeat(50);
        assert_eq!(key_of(&agent(&han, None, None), false).unwrap().phrase, han);
        let p = format!("{}😀", "a".repeat(79));
        assert_eq!(
            key_of(&agent(&p, None, None), false).unwrap().phrase,
            "a".repeat(79)
        );
        assert_eq!(
            key_of(&agent("", Some("Claude"), None), false),
            None,
            "a shell-ish title is refused"
        );
        assert_eq!(
            key_of(&agent("  a  b ", None, Some("short")), false),
            None,
            "the prompt is collapsed before it is measured"
        );
    }

    #[tokio::test]
    async fn filters_path_and_agent_and_caches_per_phrase() {
        let runner = FakeRunner::new(|_| {
            Ok(json!({ "hits": [
                { "cwd": "/Users/me/other", "source": { "presence": "present", "filePath": "/x/other.jsonl" } },
                { "cwd": "/Users/me/proj/", "source": { "presence": "present", "filePath": "/x/mine.jsonl" } },
            ]}))
        });
        let r = SessionResolver::new(runner.clone(), None, clock(), false);
        let d = desk();
        assert_eq!(
            r.resolve(&d, &agent(PROMPT, None, None)).await.unwrap(),
            Some("/x/mine.jsonl".into())
        );
        assert_eq!(
            runner.calls()[0],
            crate::fake::argv(&[
                "search",
                "--query=add pixel assets please",
                "--path=/Users/me/proj",
                "--agent=claude",
                "--sort=newest",
                "--limit=5",
                "--fresh",
            ])
        );
        r.resolve(&d, &agent(PROMPT, None, None)).await.unwrap();
        assert_eq!(runner.calls().len(), 1);
        r.resolve(&d, &agent("a brand new prompt", None, None))
            .await
            .unwrap();
        assert_eq!(runner.calls().len(), 2);
        assert_eq!(r.cached("tab:leaf"), Some("/x/mine.jsonl".into()));
        assert_eq!(r.cached("other"), None);
    }

    #[tokio::test]
    async fn caches_misses_for_30s_and_keeps_the_last_good_session() {
        let hits = Arc::new(Mutex::new(
            json!([{ "cwd": "/Users/me/proj", "source": { "filePath": "/x/a.jsonl" } }]),
        ));
        let h = Arc::clone(&hits);
        let runner = FakeRunner::new(move |_| Ok(json!({ "hits": lock(&h).clone() })));
        let (t, now) = manual_clock();
        let r = SessionResolver::new(runner.clone(), None, now, false);
        let d = desk();
        assert_eq!(
            r.resolve(&d, &agent(PROMPT, None, None)).await.unwrap(),
            Some("/x/a.jsonl".into())
        );
        *lock(&hits) = json!([]);
        let fresh = agent("not indexed yet", None, None);
        assert_eq!(
            r.resolve(&d, &fresh).await.unwrap(),
            Some("/x/a.jsonl".into())
        );
        assert_eq!(
            r.resolve(&d, &fresh).await.unwrap(),
            Some("/x/a.jsonl".into())
        );
        assert_eq!(runner.calls().len(), 2);
        t.fetch_add(31_000, Ordering::SeqCst);
        r.resolve(&d, &fresh).await.unwrap();
        assert_eq!(runner.calls().len(), 3);
    }

    #[tokio::test]
    async fn skips_hits_that_fail_verification() {
        let runner = FakeRunner::new(|_| {
            Ok(json!({ "hits": [
                { "cwd": "/Users/me/proj", "source": { "filePath": "/x/wrong.jsonl" } },
                { "cwd": "/Users/me/proj", "source": { "filePath": "/x/right.jsonl" } },
            ]}))
        });
        let verify: SessionVerifier =
            Arc::new(|file, _| async move { file == "/x/right.jsonl" }.boxed());
        let r = SessionResolver::new(runner, Some(verify), clock(), false);
        assert_eq!(
            r.resolve(&desk(), &agent(PROMPT, None, None))
                .await
                .unwrap(),
            Some("/x/right.jsonl".into())
        );
    }

    #[tokio::test]
    async fn title_match_wins_when_searching_by_title() {
        let runner = FakeRunner::new(|_| {
            Ok(json!({ "hits": [
                { "title": "Other session", "cwd": "/Users/me/proj", "source": { "filePath": "/x/other.jsonl" } },
                { "title": "command context logging", "cwd": "/Users/me/proj", "source": { "filePath": "/x/title.jsonl" } },
            ]}))
        });
        let r = SessionResolver::new(runner, None, clock(), false);
        assert_eq!(
            r.resolve(&desk(), &agent("", Some("Command context logging"), None))
                .await
                .unwrap(),
            Some("/x/title.jsonl".into())
        );
    }

    #[tokio::test]
    async fn odd_hits_are_dropped_and_errors_leave_the_cache() {
        let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let f = Arc::clone(&fail);
        let runner = FakeRunner::new(move |_| {
            if f.load(Ordering::SeqCst) {
                return Err(BackendError::with_code("boom", "orca_error"));
            }
            Ok(json!({ "hits": [
                7,
                { "cwd": "/Users/me/proj", "source": { "presence": "missing", "filePath": "/x/gone.jsonl" } },
                { "cwd": "", "source": { "filePath": "/x/nocwd.jsonl" } },
                { "cwd": "/Users/me/proj", "source": { "filePath": "" } },
                { "cwd": "/Users/me/proj", "source": { "filePath": "/x/ok.jsonl" } },
            ]}))
        });
        let r = SessionResolver::new(runner.clone(), None, clock(), false);
        let d = desk();
        assert_eq!(
            r.resolve(&d, &agent(PROMPT, None, None)).await.unwrap(),
            Some("/x/ok.jsonl".into())
        );
        fail.store(true, Ordering::SeqCst);
        let err = r
            .resolve(&d, &agent("another prompt here", None, None))
            .await
            .unwrap_err();
        assert_eq!(err.code.as_deref(), Some("orca_error"));
        assert_eq!(r.cached("tab:leaf"), Some("/x/ok.jsonl".into()));
        // No key: the last good, no search.
        assert_eq!(
            r.resolve(&d, &agent("", None, None)).await.unwrap(),
            Some("/x/ok.jsonl".into())
        );
        assert_eq!(runner.calls().len(), 2);
    }

    #[tokio::test]
    async fn non_array_hits_mean_no_hits() {
        let runner = FakeRunner::new(|_| Ok(json!({ "hits": { "a": 1 } })));
        let r = SessionResolver::new(runner, None, clock(), false);
        assert_eq!(
            r.resolve(&desk(), &agent(PROMPT, None, None))
                .await
                .unwrap(),
            None
        );
    }

    /// Answers one hit after the gate opens; counts its calls.
    struct GatedRunner {
        gate: Notify,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl OrcaRunner for GatedRunner {
        async fn run(&self, _args: &[String]) -> Result<Value, BackendError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.gate.notified().await;
            Ok(
                json!({ "hits": [{ "cwd": "/Users/me/proj", "source": { "filePath": "/x/one.jsonl" } }] }),
            )
        }
    }

    fn gated() -> Arc<GatedRunner> {
        Arc::new(GatedRunner {
            gate: Notify::new(),
            calls: AtomicUsize::new(0),
        })
    }

    async fn until_called(runner: &GatedRunner) {
        while runner.calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_search() {
        let runner = gated();
        let r = SessionResolver::new(runner.clone(), None, clock(), false);
        let d = desk();
        let a = agent(PROMPT, None, None);
        let calls = (0..5).map(|_| r.resolve(&d, &a));
        let (results, ()) = tokio::join!(futures_util::future::join_all(calls), async {
            until_called(&runner).await;
            runner.gate.notify_one();
        });
        for res in results {
            assert_eq!(res.unwrap(), Some("/x/one.jsonl".into()));
        }
        assert_eq!(runner.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            r.resolve(&d, &a).await.unwrap(),
            Some("/x/one.jsonl".into())
        );
        assert_eq!(runner.calls.load(Ordering::SeqCst), 1, "cached");
    }

    #[tokio::test]
    async fn a_dropped_caller_does_not_cancel_the_search() {
        let runner = gated();
        let r = SessionResolver::new(runner.clone(), None, clock(), false);
        let d = desk();
        let a = agent(PROMPT, None, None);
        {
            let mut first = Box::pin(r.resolve(&d, &a));
            while runner.calls.load(Ordering::SeqCst) == 0 {
                tokio::select! {
                    biased;
                    _ = &mut first => panic!("resolved before the gate opened"),
                    _ = tokio::task::yield_now() => {}
                }
            }
        }
        runner.gate.notify_one();
        assert_eq!(
            r.resolve(&d, &a).await.unwrap(),
            Some("/x/one.jsonl".into())
        );
        assert_eq!(runner.calls.load(Ordering::SeqCst), 1);
    }

    struct NeverRunner {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl OrcaRunner for NeverRunner {
        async fn run(&self, _args: &[String]) -> Result<Value, BackendError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            std::future::pending().await
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_stuck_search_times_out_and_frees_the_agent() {
        let runner = Arc::new(NeverRunner {
            calls: AtomicUsize::new(0),
        });
        let r = SessionResolver::new(runner.clone(), None, clock(), false);
        let d = desk();
        let a = agent(PROMPT, None, None);
        let start = tokio::time::Instant::now();
        let err = r.resolve(&d, &a).await.unwrap_err();
        assert!(start.elapsed() >= RESOLVE_TIMEOUT);
        assert_eq!(err.code.as_deref(), Some("timeout"));
        assert_eq!(err.message, "session search timed out");
        assert_eq!(r.inflight_len(), 0);
        let _ = r.resolve(&d, &a).await;
        assert_eq!(runner.calls.load(Ordering::SeqCst), 2);
    }
}
