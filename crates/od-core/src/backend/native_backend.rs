//! Office Desks running the agents itself: PTYs, git worktrees and Claude hooks, no Orca.
//! Port of `bridge/src/backend/native.ts`.
//!
//! Concurrency: all mutable state (agents, the worktree cache) lives in one `std::sync::Mutex`
//! that is never held across an `.await` or a call into the PTY host (a host may fire `on_exit`
//! synchronously from `kill`, and the exit callback takes the same lock). Git runs on tokio's
//! blocking pool; registry writes, settings files and transcript lookups are short and run
//! inline.

use std::any::Any;
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use super::{
    BackendCapabilities, BackendError, BackendMessages, BoardUpdate, ConversationHit, HireResult,
    HireSpec, KeyInput, OfficeBackend,
};
use crate::git::{GitError, GitRunner, SystemGit};
use crate::model::{ComposerState, OfficeAgent, OfficeDesk, OfficeSnapshot, UsageSnapshot};
use crate::native::env::{agent_env, find_command, process_env, win32_is_absolute, EnvMap};
use crate::native::hooks::{
    apply_hook, hook_settings, initial_hook_state, relay_command, HookState,
};
use crate::native::pty_host::{PtyHost, PtyOptions, Subscription};
use crate::native::registry::{DeskMeta, Registry};
use crate::native::worktrees::{
    add_worktree, list_worktrees, normalize_path, remove_worktree, resolve_repo, worktree_dest,
    WorktreeInfo,
};
use crate::screen::composer_state;
use crate::state_mapper::{
    native_desk_name, to_snapshot, OrcaAgentRow, OrcaTerminalRow, OrcaWorktreeRow,
};

const WORKTREES_TTL_MS: i64 = 5000;
/// How long the agent's TUI gets to take in a bracketed paste before Enter.
pub const PASTE_SETTLE_MS: u64 = 400;
const SESSION_RESCAN_MS: i64 = 5000;
/// Claude's splash right after spawn looks like a menu; don't raise 🙋 for it.
const STARTUP_GRACE_MS: i64 = 2000;
const PROMPT_NOT_SENT: &str = "첫 지시는 Claude에만 자동으로 전달돼요. 패널에서 보내 주세요";
const NOT_FOUND_AGENT: &str = "에이전트를 찾지 못했어요";
const NOT_FOUND_WORKTREE: &str = "워크트리를 찾지 못했어요";

/// A boxed `Send` future, what an injected `sleep` returns.
pub type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
/// Injected sleep (tests pass one that returns at once).
pub type SleepFn = Arc<dyn Fn(Duration) -> BoxFuture + Send + Sync>;
/// Injected clock, epoch ms.
pub type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;
/// `(agent id, token)` → the URL the agent's hook relay posts to.
pub type HookUrlFn = Arc<dyn Fn(&str, &str) -> String + Send + Sync>;
/// Where an agent command lives on the given PATH, or None when it isn't installed.
pub type WhichFn = Arc<dyn Fn(&str, &EnvMap) -> Option<PathBuf> + Send + Sync>;
/// `on_exit` callback: `(pty id, exit code)`.
pub type ExitFn = Box<dyn Fn(&str, u32) + Send + Sync>;

/// What the native backend needs from the PTY host (TS `PtyLike`). [`PtyHost`] implements it;
/// tests use a fake. The terminal app reaches the full host through [`NativeBackend::pty`].
#[async_trait]
pub trait PtyLike: Send + Sync + 'static {
    fn spawn(&self, id: &str, opts: PtyOptions) -> Result<(), BackendError>;
    fn has(&self, id: &str) -> bool;
    fn write(&self, id: &str, data: &[u8]) -> Result<(), BackendError>;
    fn screen_lines(&self, id: &str) -> Vec<String>;
    /// May fire on any thread, and synchronously from `kill`.
    fn on_exit(&self, f: ExitFn) -> Subscription;
    fn kill(&self, id: &str);
    async fn dispose(&self);
}

#[async_trait]
impl PtyLike for PtyHost {
    fn spawn(&self, id: &str, opts: PtyOptions) -> Result<(), BackendError> {
        PtyHost::spawn(self, id, opts)
    }
    fn has(&self, id: &str) -> bool {
        PtyHost::has(self, id)
    }
    fn write(&self, id: &str, data: &[u8]) -> Result<(), BackendError> {
        PtyHost::write(self, id, data)
    }
    fn screen_lines(&self, id: &str) -> Vec<String> {
        PtyHost::screen_lines(self, id)
    }
    fn on_exit(&self, f: ExitFn) -> Subscription {
        PtyHost::on_exit(self, f)
    }
    fn kill(&self, id: &str) {
        PtyHost::kill(self, id)
    }
    async fn dispose(&self) {
        PtyHost::dispose(self).await
    }
}

/// Everything the backend uses from the outside world. `None` fields get the real thing.
pub struct NativeDeps<P> {
    pub pty: Arc<P>,
    pub registry: Arc<Registry>,
    /// The office home (`office_home`), for worktrees and agent settings files.
    pub home: PathBuf,
    pub hook_url: HookUrlFn,
    /// Default [`SystemGit`].
    pub git: Option<Arc<dyn GitRunner>>,
    /// Default `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`.
    pub claude_projects: Option<PathBuf>,
    /// The environment agents start from. Default: this process's.
    pub env: Option<EnvMap>,
    pub now: Option<NowFn>,
    /// The hook relay argv. Default `relay_command(current_exe)`.
    pub relay: Option<Vec<String>>,
    pub sleep: Option<SleepFn>,
    /// Default [`find_command`].
    pub which: Option<WhichFn>,
}

impl<P> NativeDeps<P> {
    pub fn new(
        pty: Arc<P>,
        registry: Arc<Registry>,
        home: impl Into<PathBuf>,
        hook_url: impl Fn(&str, &str) -> String + Send + Sync + 'static,
    ) -> Self {
        Self {
            pty,
            registry,
            home: home.into(),
            hook_url: Arc::new(hook_url),
            git: None,
            claude_projects: None,
            env: None,
            now: None,
            relay: None,
            sleep: None,
            which: None,
        }
    }
}

#[derive(Debug, Clone)]
struct Agent {
    /// The PTY id; the office knows the agent as `<id>:main`, its terminal as `pty_<id>`.
    id: String,
    desk_id: String,
    agent_type: String,
    token: String,
    settings_file: Option<PathBuf>,
    session_id: Option<String>,
    hook: HookState,
    /// First prompt from the hire dialog, typed once the agent is ready (after any trust dialog).
    pending: Option<String>,
    transcript: Option<String>,
    looked_at: i64,
    spawned_at: i64,
    /// A valid hook arrived, so a dialog on screen is real (not the startup splash).
    hooked: bool,
}

#[derive(Default)]
struct State {
    /// In hire order (a JS Map's iteration order).
    agents: Vec<Agent>,
    worktrees: HashMap<String, (i64, Vec<WorktreeInfo>)>,
}

impl State {
    fn agent_mut(&mut self, id: &str) -> Option<&mut Agent> {
        self.agents.iter_mut().find(|a| a.id == id)
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn agent_key(id: &str) -> String {
    format!("{id}:main")
}

fn strip_main(agent_id: &str) -> &str {
    agent_id.strip_suffix(":main").unwrap_or(agent_id)
}

/// Desk ids use forward slashes on every OS (git prints them that way on Windows too).
fn slash(p: &str) -> String {
    p.replace('\\', "/")
}

fn pty_id(handle: &str) -> &str {
    handle.strip_prefix("pty_").unwrap_or(handle)
}

/// `path.isAbsolute` with Node's rules for this OS (`/x` is absolute on Windows too).
fn node_is_absolute(p: &str) -> bool {
    if cfg!(windows) {
        win32_is_absolute(p)
    } else {
        p.starts_with('/')
    }
}

/// `path.basename` of a string (either separator on Windows).
fn basename(p: &str) -> &str {
    let trimmed = p.trim_end_matches(|c| c == '/' || (cfg!(windows) && c == '\\'));
    trimmed
        .rsplit(|c| c == '/' || (cfg!(windows) && c == '\\'))
        .next()
        .unwrap_or("")
}

fn io_error(e: std::io::Error) -> BackendError {
    BackendError::new(e.to_string())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_bytes<const N: usize>() -> Result<[u8; N], BackendError> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|e| BackendError::new(e.to_string()))?;
    Ok(b)
}

/// A random (v4) UUID, like `crypto.randomUUID()`.
fn random_uuid() -> Result<String, BackendError> {
    let mut b = random_bytes::<16>()?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}

/// Constant-time for equal lengths (like `timingSafeEqual`; a length mismatch returns early,
/// as in TS, and only says the length is wrong).
fn same_token(want: &[u8], got: &[u8]) -> bool {
    if want.len() != got.len() {
        return false;
    }
    let diff = want.iter().zip(got).fold(0u8, |acc, (a, b)| acc | (a ^ b));
    std::hint::black_box(diff) == 0
}

/// `/^[0-9a-f-]{8,64}$/i`
fn plausible_session_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// The path with symlinks resolved as far as it exists; the missing rest is appended as is
/// (after a lexical normalize, so it holds no `..`). None for a path that can't be resolved.
fn real_path(p: &Path) -> Option<PathBuf> {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(p)
    };
    let norm = PathBuf::from(normalize_path(&abs.to_string_lossy()));
    let mut base = norm.as_path();
    let mut tail = Vec::new();
    loop {
        if let Ok(real) = dunce::canonicalize(base) {
            let mut out = real;
            for c in tail.iter().rev() {
                out.push(c);
            }
            return Some(out);
        }
        tail.push(base.file_name()?.to_os_string());
        base = base.parent()?;
    }
}

/// Only `<our session id>.jsonl` under Claude's projects folder; anything else falls back to the
/// scan. Both sides are resolved through symlinks, so a link inside the root can't point out.
fn own_transcript(session_id: Option<&str>, p: &str, root: &Path) -> bool {
    let Some(sid) = session_id else {
        return false;
    };
    if basename(p) != format!("{sid}.jsonl") {
        return false;
    }
    let (Some(file), Some(root)) = (real_path(Path::new(p)), real_path(root)) else {
        return false;
    };
    file != root && file.starts_with(&root)
}

/// The native backend. Generic over the PTY host so tests can run it on a fake; the server uses
/// `NativeBackend` (= `NativeBackend<PtyHost>`).
pub struct NativeBackend<P: PtyLike = PtyHost> {
    pty: Arc<P>,
    registry: Arc<Registry>,
    home: PathBuf,
    hook_url: HookUrlFn,
    git: Arc<dyn GitRunner>,
    claude_projects: Option<PathBuf>,
    env: EnvMap,
    now: NowFn,
    relay: Vec<String>,
    sleep: SleepFn,
    which: WhichFn,
    capabilities: BackendCapabilities,
    messages: BackendMessages,
    state: Arc<Mutex<State>>,
    _exit: Subscription,
}

impl<P: PtyLike> NativeBackend<P> {
    pub fn new(deps: NativeDeps<P>) -> Self {
        let state = Arc::new(Mutex::new(State::default()));
        let weak = Arc::downgrade(&state);
        let exit = deps.pty.on_exit(Box::new(move |id, _code| {
            let Some(state) = weak.upgrade() else {
                return;
            };
            let gone = {
                let mut s = lock(&state);
                let at = s.agents.iter().position(|a| a.id == id);
                at.map(|i| s.agents.remove(i))
            };
            if let Some(file) = gone.and_then(|a| a.settings_file) {
                let _ = std::fs::remove_file(file);
            }
        }));
        let relay = deps.relay.unwrap_or_else(|| {
            relay_command(
                &std::env::current_exe().unwrap_or_else(|_| PathBuf::from("office-desks")),
            )
        });
        Self {
            pty: deps.pty,
            registry: deps.registry,
            home: deps.home,
            hook_url: deps.hook_url,
            git: deps.git.unwrap_or_else(|| Arc::new(SystemGit)),
            claude_projects: deps.claude_projects,
            env: deps.env.unwrap_or_else(process_env),
            now: deps
                .now
                .unwrap_or_else(|| Arc::new(|| chrono::Utc::now().timestamp_millis())),
            relay,
            sleep: deps
                .sleep
                .unwrap_or_else(|| Arc::new(|d| Box::pin(tokio::time::sleep(d)) as BoxFuture)),
            which: deps
                .which
                .unwrap_or_else(|| Arc::new(|cmd: &str, env: &EnvMap| find_command(cmd, env))),
            capabilities: BackendCapabilities {
                usage: false,
                search: false,
                board: true,
                hire: true,
                changes: true,
                transcripts: true,
                focus: false,
                repos: true,
                stop: true,
                remove: true,
            },
            messages: BackendMessages {
                no_session: "이 에이전트의 대화 기록이 아직 없어요. 첫 지시를 보내면 생깁니다."
                    .into(),
                hire_disabled: "이 백엔드에서는 새 작업을 만들 수 없어요".into(),
            },
            state,
            _exit: exit,
        }
    }

    /// The PTY host, for the terminal app's attach view.
    pub fn pty(&self) -> &Arc<P> {
        &self.pty
    }

    /// The PTY id of a live agent (`<id>:main` → `<id>`), or None when it is gone.
    pub fn terminal_of(&self, agent_id: &str) -> Option<String> {
        let id = strip_main(agent_id);
        let known = lock(&self.state).agents.iter().any(|a| a.id == id);
        (known && self.pty.has(id)).then(|| id.to_string())
    }

    fn now(&self) -> i64 {
        (self.now)()
    }

    /// Run git on the blocking pool (a git call can take seconds).
    async fn with_git<T: Send + 'static>(
        &self,
        f: impl FnOnce(&dyn GitRunner) -> T + Send + 'static,
    ) -> T {
        let git = self.git.clone();
        match tokio::task::spawn_blocking(move || f(&*git)).await {
            Ok(v) => v,
            Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
            Err(e) => panic!("git task did not run: {e}"),
        }
    }

    async fn worktrees_of(&self, repo_path: &str) -> Result<Vec<WorktreeInfo>, GitError> {
        if let Some((at, list)) = lock(&self.state).worktrees.get(repo_path) {
            if self.now() - at < WORKTREES_TTL_MS {
                return Ok(list.clone());
            }
        }
        let path = repo_path.to_string();
        let list: Vec<WorktreeInfo> = self
            .with_git(move |g| list_worktrees(&path, g))
            .await?
            .into_iter()
            .map(|w| WorktreeInfo {
                path: slash(&w.path),
                ..w
            })
            .collect();
        lock(&self.state)
            .worktrees
            .insert(repo_path.to_string(), (self.now(), list.clone()));
        Ok(list)
    }

    /// Hooks are the main signal; the screen covers what hooks can't see. A dialog (trust prompt,
    /// permission prompt, /usage) always means the user is needed. An agent without hooks (not
    /// Claude, or hooks disabled by policy) counts as done while its input box shows.
    fn raw_state(&self, a: &Agent) -> String {
        let screen = composer_state(&self.pty.screen_lines(&a.id), &a.agent_type);
        if screen == ComposerState::Menu {
            let grace = !a.hooked && self.now() - a.spawned_at < STARTUP_GRACE_MS;
            return if grace { "unknown" } else { "waiting" }.into();
        }
        if a.hook.raw_state == "unknown" {
            let done = screen == ComposerState::Ready || a.agent_type != "claude";
            return if done { "done" } else { "unknown" }.into();
        }
        a.hook.raw_state.clone()
    }

    /// Bracketed paste keeps a multi-line prompt one message; Enter after the TUI took it in.
    async fn paste(&self, id: &str, text: &str) -> Result<(), BackendError> {
        self.pty.write(id, paste_bytes(text).as_bytes())?;
        (self.sleep)(Duration::from_millis(PASTE_SETTLE_MS)).await;
        self.pty.write(id, b"\r")
    }

    /// The first prompt, typed from `hook` without waiting: the paste goes out now, the Enter
    /// after the settle time on the tokio runtime (a plain thread when there is none).
    fn paste_detached(&self, id: &str, text: &str) {
        let _ = self.pty.write(id, paste_bytes(text).as_bytes());
        let pty = self.pty.clone();
        let id = id.to_string();
        match tokio::runtime::Handle::try_current() {
            Ok(rt) => {
                let sleep = self.sleep.clone();
                rt.spawn(async move {
                    sleep(Duration::from_millis(PASTE_SETTLE_MS)).await;
                    let _ = pty.write(&id, b"\r");
                });
            }
            Err(_) => {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(PASTE_SETTLE_MS));
                    let _ = pty.write(&id, b"\r");
                });
            }
        }
    }

    fn projects_root(&self) -> PathBuf {
        if let Some(p) = &self.claude_projects {
            return p.clone();
        }
        let base = match self.env.get("CLAUDE_CONFIG_DIR") {
            Some(d) if !d.is_empty() => PathBuf::from(d),
            _ => crate::home::os_home().join(".claude"),
        };
        base.join("projects")
    }

    fn spawn_agent(
        &self,
        desk_id: String,
        cwd: PathBuf,
        agent_type: &str,
        prompt: Option<String>,
    ) -> Result<(), BackendError> {
        let id = random_uuid()?;
        let token = hex(&random_bytes::<16>()?);
        let mut args = Vec::new();
        let mut settings_file = None;
        let mut session_id = None;
        if agent_type == "claude" {
            let sid = random_uuid()?;
            let file = self.home.join("agents").join(format!("{id}.json"));
            std::fs::create_dir_all(self.home.join("agents")).map_err(io_error)?;
            let json = serde_json::to_string(&hook_settings(&self.relay))
                .map_err(|e| BackendError::new(e.to_string()))?;
            std::fs::write(&file, json).map_err(io_error)?;
            args = vec![
                "--session-id".to_string(),
                sid.clone(),
                "--settings".to_string(),
                file.to_string_lossy().into_owned(),
            ];
            settings_file = Some(file);
            session_id = Some(sid);
        }
        let extra = EnvMap::from([(
            "OFFICE_DESKS_HOOK_URL".to_string(),
            (self.hook_url)(&agent_key(&id), &token),
        )]);
        let env = agent_env(&self.env, &extra);
        let now = self.now();
        lock(&self.state).agents.push(Agent {
            id: id.clone(),
            desk_id,
            agent_type: agent_type.to_string(),
            token,
            settings_file: settings_file.clone(),
            session_id,
            hook: initial_hook_state(now),
            // Without hooks there is no reliable "ready" signal, so only Claude gets a queued
            // first prompt.
            pending: if agent_type == "claude" {
                prompt.filter(|p| !p.is_empty())
            } else {
                None
            },
            transcript: None,
            looked_at: 0,
            spawned_at: now,
            hooked: false,
        });
        let opts = PtyOptions {
            file: agent_type.to_string(),
            args,
            cwd,
            env,
            cols: None,
            rows: None,
        };
        if let Err(e) = self.pty.spawn(&id, opts) {
            lock(&self.state).agents.retain(|a| a.id != id);
            if let Some(f) = settings_file {
                let _ = std::fs::remove_file(f);
            }
            return Err(e);
        }
        Ok(())
    }
}

fn paste_bytes(text: &str) -> String {
    format!("\x1b[200~{text}\x1b[201~")
}

#[async_trait]
impl<P: PtyLike> OfficeBackend for NativeBackend<P> {
    fn name(&self) -> &str {
        "native"
    }

    fn capabilities(&self) -> &BackendCapabilities {
        &self.capabilities
    }

    fn messages(&self) -> &BackendMessages {
        &self.messages
    }

    async fn snapshot(&self) -> Result<OfficeSnapshot, BackendError> {
        let mut rows: Vec<OrcaWorktreeRow> = Vec::new();
        let mut terminals: Vec<OrcaTerminalRow> = Vec::new();
        for repo in self.registry.repos() {
            // A repo that moved or was deleted just has no desks.
            let Ok(list) = self.worktrees_of(&repo.path).await else {
                continue;
            };
            for wt in list {
                let desk_id = format!("{}::{}", repo.id, wt.path);
                let meta = self.registry.meta(&desk_id);
                let agents: Vec<Agent> = lock(&self.state)
                    .agents
                    .iter()
                    .filter(|a| a.desk_id == desk_id)
                    .cloned()
                    .collect();
                for a in &agents {
                    terminals.push(OrcaTerminalRow {
                        handle: Some(format!("pty_{}", a.id)),
                        tab_id: Some(a.id.clone()),
                        leaf_id: Some("main".into()),
                        title: Some(a.agent_type.clone()),
                    });
                }
                let states: Vec<String> = agents.iter().map(|a| self.raw_state(a)).collect();
                let has = |s: &str| states.iter().any(|x| x == s);
                let status = if has("waiting") {
                    "permission"
                } else if has("working") {
                    "working"
                } else if !agents.is_empty() {
                    "active"
                } else {
                    "inactive"
                };
                rows.push(OrcaWorktreeRow {
                    worktree_id: Some(desk_id.clone()),
                    repo_id: Some(repo.id.clone()),
                    repo: Some(repo.name.clone()),
                    display_name: Some(basename(&wt.path).to_string()),
                    branch: Some(wt.branch.clone()),
                    is_main_worktree: wt.is_main,
                    workspace_status: meta.workspace_status,
                    comment: Some(meta.comment.unwrap_or_default()),
                    status: Some(status.into()),
                    agents: agents
                        .iter()
                        .zip(states)
                        .map(|(a, state)| OrcaAgentRow {
                            pane_key: Some(agent_key(&a.id)),
                            agent_type: Some(a.agent_type.clone()),
                            state: Some(state),
                            tool_name: a.hook.tool_name.clone(),
                            tool_input: a.hook.tool_input.clone(),
                            prompt: a.hook.prompt.clone(),
                            last_assistant_message: a.hook.last_message.clone(),
                            state_started_at: Some(a.hook.since as f64),
                        })
                        .collect(),
                    path: Some(wt.path),
                    ..Default::default()
                });
            }
        }
        // A native worktree's folder is its name (it usually equals the branch, which Orca's
        // rule would hide).
        Ok(to_snapshot(
            &rows,
            &terminals,
            self.now(),
            Some(&native_desk_name),
        ))
    }

    async fn read_screen(&self, handle: &str) -> Result<Vec<String>, BackendError> {
        Ok(self.pty.screen_lines(pty_id(handle)))
    }

    async fn send_prompt(&self, handle: &str, text: &str) -> Result<(), BackendError> {
        self.paste(pty_id(handle), text).await
    }

    async fn retry_prompt(&self, _request_id: &str) -> Result<(), BackendError> {
        Err(BackendError::with_code(
            "다시 보낼 메시지를 찾지 못했습니다. 새로 보내주세요",
            "not_found",
        ))
    }

    fn blocked_handle(&self, _request_id: &str) -> Option<String> {
        None
    }

    async fn send_keys(&self, handle: &str, input: KeyInput) -> Result<(), BackendError> {
        let bytes = match &input {
            KeyInput::Enter => "\r",
            KeyInput::Bytes(b) => b.as_str(),
        };
        self.pty.write(pty_id(handle), bytes.as_bytes())
    }

    async fn focus(&self, _handle: &str) -> Result<(), BackendError> {
        Ok(())
    }

    async fn hire(&self, spec: HireSpec) -> Result<HireResult, BackendError> {
        let (agent, prompt) = match &spec {
            HireSpec::Agent { agent, prompt, .. } | HireSpec::Worktree { agent, prompt, .. } => {
                (agent.clone(), prompt.clone())
            }
        };
        // Before any worktree exists: a missing command would otherwise leave an empty desk.
        let env = agent_env(&self.env, &EnvMap::new());
        if (self.which)(&agent, &env).is_none() {
            return Err(BackendError::with_code(
                format!("{agent} 명령을 찾지 못했어요. 설치되어 있고 PATH에 있는지 확인해 주세요"),
                "agent_not_found",
            ));
        }
        let (desk_id, cwd) = match spec {
            HireSpec::Agent { desk_id, .. } => {
                let cwd = match desk_id.find("::") {
                    Some(i) => desk_id[i + 2..].to_string(),
                    // `slice(indexOf('::') + 2)` with -1: everything but the first character.
                    None => desk_id.chars().skip(1).collect(),
                };
                (desk_id, PathBuf::from(cwd))
            }
            HireSpec::Worktree {
                repo_id,
                name,
                base_branch,
                ..
            } => {
                let Some(repo) = self.registry.repos().into_iter().find(|r| r.id == repo_id) else {
                    return Err(BackendError::with_code(
                        "알 수 없는 프로젝트입니다",
                        "unknown_repo",
                    ));
                };
                let dest = worktree_dest(&self.home, &repo.name, &name);
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(io_error)?;
                }
                let (repo_path, dest_s) = (repo.path.clone(), dest.to_string_lossy().into_owned());
                self.with_git(move |g| {
                    add_worktree(&repo_path, &dest_s, &name, base_branch.as_deref(), g)
                })
                .await
                .map_err(|e| BackendError::new(e.message))?;
                lock(&self.state).worktrees.remove(&repo.path);
                // git lists the resolved path (symlinked home, macOS /var → /private/var); the
                // desk id must match.
                let real = dunce::canonicalize(&dest).map_err(io_error)?;
                let desk_id = format!("{}::{}", repo.id, slash(&real.to_string_lossy()));
                (desk_id, real)
            }
        };
        self.spawn_agent(desk_id, cwd, &agent, prompt.clone())?;
        let sent_elsewhere = prompt.is_some_and(|p| !p.is_empty()) && agent != "claude";
        Ok(HireResult {
            warning: sent_elsewhere.then(|| PROMPT_NOT_SENT.to_string()),
        })
    }

    async fn set_board(&self, desk_id: &str, update: BoardUpdate) -> Result<(), BackendError> {
        self.registry
            .set_meta(
                desk_id,
                DeskMeta {
                    workspace_status: update.workspace_status,
                    comment: update.comment,
                    extra: Default::default(),
                },
            )
            .map_err(io_error)
    }

    async fn find_session(
        &self,
        _desk: &OfficeDesk,
        agent: &OfficeAgent,
    ) -> Result<Option<String>, BackendError> {
        Ok(self.cached_session(&agent.id))
    }

    /// The hook names the file; until then look for `<session-id>.jsonl` (cheap, rate-limited).
    fn cached_session(&self, agent_id: &str) -> Option<String> {
        let id = strip_main(agent_id);
        let now = self.now();
        let sid = {
            let mut s = lock(&self.state);
            let a = s.agent_mut(id)?;
            let sid = a.session_id.clone()?;
            // The hook named the file: never scan, just wait for it to appear on disk.
            if let Some(t) = a.transcript.clone() {
                drop(s);
                return Path::new(&t).exists().then_some(t);
            }
            if a.looked_at != 0 && now - a.looked_at < SESSION_RESCAN_MS {
                return None;
            }
            a.looked_at = now;
            sid
        };
        let root = self.projects_root();
        // No projects folder yet: nothing to find.
        let dirs = std::fs::read_dir(&root).ok()?;
        for dir in dirs.flatten() {
            let file = root.join(dir.file_name()).join(format!("{sid}.jsonl"));
            if file.exists() {
                let found = file.to_string_lossy().into_owned();
                let mut s = lock(&self.state);
                if let Some(a) = s.agent_mut(id) {
                    if a.session_id.as_deref() == Some(sid.as_str()) {
                        a.transcript = Some(found.clone());
                    }
                }
                return Some(found);
            }
        }
        None
    }

    async fn search_conversations(
        &self,
        _query: &str,
    ) -> Result<Vec<ConversationHit>, BackendError> {
        Ok(Vec::new())
    }

    async fn usage(&self) -> Result<Option<UsageSnapshot>, BackendError> {
        Ok(None)
    }

    async fn add_repo(&self, repo_path: &str) -> Result<(), BackendError> {
        if !node_is_absolute(repo_path) {
            return Err(BackendError::with_code(
                "절대 경로를 입력해 주세요",
                "not_absolute",
            ));
        }
        let dir = repo_path.to_string();
        let repo = self.with_git(move |g| resolve_repo(&dir, g)).await?;
        self.registry.add_repo(repo).map_err(io_error)
    }

    async fn stop_agent(&self, agent_id: &str) -> Result<(), BackendError> {
        let Some(id) = self.terminal_of(agent_id) else {
            return Err(BackendError::with_code(NOT_FOUND_AGENT, "not_found"));
        };
        self.pty.kill(&id);
        Ok(())
    }

    async fn remove_worktree(&self, desk_id: &str) -> Result<(), BackendError> {
        let not_found = || BackendError::with_code(NOT_FOUND_WORKTREE, "not_found");
        let Some(sep) = desk_id.find("::") else {
            return Err(not_found());
        };
        let Some(repo) = self
            .registry
            .repos()
            .into_iter()
            .find(|r| r.id == desk_id[..sep])
        else {
            return Err(not_found());
        };
        let wt_path = desk_id[sep + 2..].to_string();
        let failed = |message: &str| {
            BackendError::with_code(
                format!(
                    "워크트리를 지우지 못했어요 — {}",
                    message.split('\n').next().unwrap_or("")
                ),
                "remove_failed",
            )
        };
        // Git's own listing decides what this desk is (fresh, not the snapshot cache).
        let path = repo.path.clone();
        let list = self
            .with_git(move |g| list_worktrees(&path, g))
            .await
            .map_err(|e| failed(&e.message))?;
        let Some(wt) = list.into_iter().find(|w| slash(&w.path) == wt_path) else {
            return Err(not_found());
        };
        if wt.is_main {
            return Err(BackendError::with_code(
                "메인 체크아웃은 지울 수 없어요",
                "main_checkout",
            ));
        }
        if lock(&self.state)
            .agents
            .iter()
            .any(|a| a.desk_id == desk_id)
        {
            return Err(BackendError::with_code(
                "에이전트가 실행 중인 워크트리는 지울 수 없어요 (x로 먼저 종료)",
                "has_agents",
            ));
        }
        let (path, target) = (repo.path.clone(), wt_path.clone());
        self.with_git(move |g| remove_worktree(&path, &target, g))
            .await
            .map_err(|e| {
                if e.message.contains("modified or untracked") {
                    BackendError::with_code("변경사항이 있는 워크트리는 지울 수 없어요", "dirty")
                } else {
                    failed(&e.message)
                }
            })?;
        lock(&self.state).worktrees.remove(&repo.path);
        Ok(())
    }

    fn hook(&self, agent_id: &str, token: &str, payload: &Value) -> bool {
        // TS: `!payload || typeof payload !== 'object'` (an array is an object there).
        if !matches!(payload, Value::Object(_) | Value::Array(_)) {
            return false;
        }
        let id = strip_main(agent_id);
        let now = self.now();
        let root = self.projects_root();
        let first_prompt = {
            let mut s = lock(&self.state);
            let Some(a) = s.agent_mut(id) else {
                return false;
            };
            if !same_token(a.token.as_bytes(), token.as_bytes()) {
                return false;
            }
            a.hooked = true;
            // /clear, resume and compact start a new Claude session; follow it (only the token
            // holder gets here).
            if payload.get("hook_event_name").and_then(Value::as_str) == Some("SessionStart") {
                if let Some(sid) = payload.get("session_id").and_then(Value::as_str) {
                    if plausible_session_id(sid) && a.session_id.as_deref() != Some(sid) {
                        a.session_id = Some(sid.to_string());
                        a.transcript = None;
                        a.looked_at = 0;
                    }
                }
            }
            a.hook = apply_hook(&a.hook, payload, now);
            if let Some(p) = a.hook.transcript_path.clone() {
                if own_transcript(a.session_id.as_deref(), &p, &root) {
                    a.transcript = Some(p);
                }
            }
            if a.pending.is_some() && a.hook.started {
                a.pending.take()
            } else {
                None
            }
        };
        if let Some(prompt) = first_prompt {
            self.paste_detached(id, &prompt);
        }
        true
    }

    async fn dispose(&self) {
        let files: Vec<PathBuf> = lock(&self.state)
            .agents
            .iter()
            .filter_map(|a| a.settings_file.clone())
            .collect();
        self.pty.dispose().await;
        for f in files {
            let _ = std::fs::remove_file(f);
        }
    }

    fn as_native(&self) -> Option<&NativeBackend> {
        (self as &dyn Any).downcast_ref::<NativeBackend>()
    }
}
