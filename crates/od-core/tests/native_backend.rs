//! NativeBackend on a fake PTY host and a fake git (port of bridge/test/nativeBackend.test.ts),
//! plus a check that the real backend works as `Arc<dyn OfficeBackend>`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use async_trait::async_trait;
use od_core::backend::native_backend::{BoxFuture, ExitFn};
use od_core::backend::{
    BackendError, BoardUpdate, HireResult, HireSpec, KeyInput, NativeBackend, NativeDeps,
    OfficeBackend, PtyLike,
};
use od_core::git::{GitError, GitRunner};
use od_core::hire::validate_hire;
use od_core::model::{CharacterState, HireRequest, OfficeSnapshot};
use od_core::native::env::EnvMap;
use od_core::native::pty_host::{PtyHost, PtyOptions, Subscription};
use od_core::native::registry::{DeskMeta, Registry, RepoRecord};
use od_core::native::worktrees::normalize_path;
use serde_json::json;

const RULE: &str = "────────────────────────────────────────";

fn ready() -> Vec<String> {
    vec![
        String::new(),
        RULE.into(),
        "❯ ".into(),
        RULE.into(),
        "  ⏵⏵ auto mode on".into(),
    ]
}

fn trust() -> Vec<String> {
    [
        " Quick safety check: Is this a project you created or one you trust?",
        " ❯ No, exit",
        "   Yes, I trust this folder",
        " Enter to confirm · Esc to cancel",
    ]
    .map(String::from)
    .to_vec()
}

type ExitCb = Arc<dyn Fn(&str, u32) + Send + Sync>;
type Exits = Mutex<Vec<(u64, ExitCb)>>;

#[derive(Default)]
struct FakePty {
    spawned: Mutex<Vec<(String, PtyOptions)>>,
    writes: Mutex<Vec<(String, String)>>,
    screens: Mutex<HashMap<String, Vec<String>>>,
    exits: Arc<Exits>,
    seq: AtomicU64,
    fail_spawn: AtomicBool,
}

impl FakePty {
    fn spawned(&self) -> Vec<(String, PtyOptions)> {
        self.spawned.lock().unwrap().clone()
    }
    fn id(&self, i: usize) -> String {
        self.spawned.lock().unwrap()[i].0.clone()
    }
    fn writes(&self) -> Vec<(String, String)> {
        self.writes.lock().unwrap().clone()
    }
    fn set_screen(&self, id: &str, lines: Vec<String>) {
        self.screens.lock().unwrap().insert(id.into(), lines);
    }
    fn screen_count(&self) -> usize {
        self.screens.lock().unwrap().len()
    }
    /// The token from the hook URL the i-th agent got.
    fn token(&self, i: usize) -> String {
        let url = self.spawned.lock().unwrap()[i].1.env["OFFICE_DESKS_HOOK_URL"].clone();
        url.split("token=").nth(1).unwrap().to_string()
    }
}

#[async_trait]
impl PtyLike for FakePty {
    fn spawn(&self, id: &str, opts: PtyOptions) -> Result<(), BackendError> {
        if self.fail_spawn.load(Ordering::SeqCst) {
            return Err(BackendError::new("spawn failed"));
        }
        self.spawned.lock().unwrap().push((id.into(), opts));
        self.set_screen(id, ready());
        Ok(())
    }
    fn has(&self, id: &str) -> bool {
        self.screens.lock().unwrap().contains_key(id)
    }
    fn write(&self, id: &str, data: &[u8]) -> Result<(), BackendError> {
        let text = String::from_utf8(data.to_vec()).unwrap();
        self.writes.lock().unwrap().push((id.into(), text));
        Ok(())
    }
    fn screen_lines(&self, id: &str) -> Vec<String> {
        self.screens
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_default()
    }
    fn on_exit(&self, f: ExitFn) -> Subscription {
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        self.exits.lock().unwrap().push((n, Arc::from(f)));
        let weak: Weak<Exits> = Arc::downgrade(&self.exits);
        Subscription::new(move || {
            if let Some(exits) = weak.upgrade() {
                exits.lock().unwrap().retain(|(k, _)| *k != n);
            }
        })
    }
    fn kill(&self, id: &str) {
        self.screens.lock().unwrap().remove(id);
        // Like a host that reports the exit synchronously: no lock held while calling back.
        let fns: Vec<ExitCb> = self
            .exits
            .lock()
            .unwrap()
            .iter()
            .map(|(_, f)| f.clone())
            .collect();
        for f in fns {
            f(id, 0);
        }
    }
    async fn dispose(&self) {
        let ids: Vec<String> = self.screens.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.kill(&id);
        }
    }
}

type GitFn = Box<dyn Fn(&str, &[&str]) -> Result<String, GitError> + Send + Sync>;

struct FakeGit {
    calls: Arc<Mutex<Vec<Vec<String>>>>,
    f: GitFn,
}

impl GitRunner for FakeGit {
    fn run(&self, cwd: &str, args: &[&str]) -> Result<String, GitError> {
        let mut call = vec![cwd.to_string()];
        call.extend(args.iter().map(|a| a.to_string()));
        self.calls.lock().unwrap().push(call);
        // Like git, `worktree add` creates the folder.
        if args.len() > 4 && args[0] == "worktree" && args[1] == "add" {
            std::fs::create_dir_all(args[4]).unwrap();
        }
        (self.f)(cwd, args)
    }
}

fn git_err(message: &str) -> GitError {
    GitError {
        message: message.into(),
        stdout: String::new(),
    }
}

const REPO_ID: &str = "abcdef123456";
const MAIN: &str = "abcdef123456::/p/app";
const FEAT: &str = "abcdef123456::/h/worktrees/app/feat";
const PORCELAIN: &str = "worktree /p/app\nHEAD a\nbranch refs/heads/main\n\nworktree /h/worktrees/app/feat\nHEAD b\nbranch refs/heads/feat\n\n";

fn porcelain(_: &str, _: &[&str]) -> Result<String, GitError> {
    Ok(PORCELAIN.into())
}

fn hook_url(id: &str, token: &str) -> String {
    format!("http://127.0.0.1:4317/hook/{id}?token={token}")
}

fn tmp(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new().prefix(prefix).tempdir().unwrap()
}

fn env(pairs: &[(&str, &str)]) -> EnvMap {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn instant_sleep() -> od_core::backend::native_backend::SleepFn {
    Arc::new(|_| Box::pin(async {}) as BoxFuture)
}

type WhichFn = od_core::backend::native_backend::WhichFn;
/// `(command, PATH)` as `which` saw it.
type Lookup = (String, Option<String>);

struct Opts {
    git: GitFn,
    pty: Arc<FakePty>,
    home: Option<PathBuf>,
    which: Option<WhichFn>,
}

impl Default for Opts {
    fn default() -> Self {
        Opts {
            git: Box::new(porcelain),
            pty: Arc::new(FakePty::default()),
            home: None,
            which: None,
        }
    }
}

struct Ctx {
    backend: NativeBackend<FakePty>,
    pty: Arc<FakePty>,
    registry: Arc<Registry>,
    home: PathBuf,
    git_calls: Arc<Mutex<Vec<Vec<String>>>>,
    clock: Arc<AtomicI64>,
    _tmp: tempfile::TempDir,
}

impl Ctx {
    fn git_called(&self, sub: &str) -> bool {
        self.git_calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c.len() > 2 && c[1] == "worktree" && c[2] == sub)
    }
    fn tick(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }
    async fn snap(&self) -> OfficeSnapshot {
        self.backend.snapshot().await.unwrap()
    }
    async fn hire_on(&self, desk: &str, agent: &str, prompt: Option<&str>) -> HireResult {
        self.backend
            .hire(HireSpec::Agent {
                desk_id: desk.into(),
                agent: agent.into(),
                prompt: prompt.map(String::from),
            })
            .await
            .unwrap()
    }
}

fn registry_at(home: &Path) -> Arc<Registry> {
    let registry = Arc::new(Registry::new(home.join("state.json")));
    registry.load();
    registry
        .add_repo(RepoRecord {
            id: REPO_ID.into(),
            path: "/p/app".into(),
            name: "app".into(),
            extra: Default::default(),
        })
        .unwrap();
    registry
}

fn setup(opts: Opts) -> Ctx {
    let t = tmp("od-native-");
    let home = opts.home.unwrap_or_else(|| t.path().to_path_buf());
    let registry = registry_at(&home);
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let git_calls = Arc::new(Mutex::new(Vec::new()));
    let mut deps = NativeDeps::new(opts.pty.clone(), registry.clone(), home.clone(), hook_url);
    deps.git = Some(Arc::new(FakeGit {
        calls: git_calls.clone(),
        f: opts.git,
    }));
    deps.claude_projects = Some(home.join("claude-projects"));
    deps.env = Some(env(&[("PATH", "/bin"), ("CLAUDECODE", "1")]));
    deps.relay = Some(vec!["/r/office-desks".into(), "hook-relay".into()]);
    deps.sleep = Some(instant_sleep());
    let c = clock.clone();
    deps.now = Some(Arc::new(move || c.load(Ordering::SeqCst)));
    deps.which = Some(opts.which.unwrap_or_else(|| {
        Arc::new(|cmd: &str, _: &EnvMap| Some(PathBuf::from(format!("/bin/{cmd}"))))
    }));
    Ctx {
        backend: NativeBackend::new(deps),
        pty: opts.pty,
        registry,
        home,
        git_calls,
        clock,
        _tmp: t,
    }
}

fn with_git(f: impl Fn(&str, &[&str]) -> Result<String, GitError> + Send + Sync + 'static) -> Opts {
    Opts {
        git: Box::new(f),
        ..Opts::default()
    }
}

fn dir_entries(dir: &Path) -> Vec<String> {
    match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Let detached tasks (the Enter after a hook-delivered paste) run, like `setTimeout(0)`.
async fn settle() {
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

// ---------- NativeBackend snapshot ----------

#[tokio::test]
async fn lists_every_worktree_of_registered_repos_as_desks_with_board_metadata() {
    let ctx = setup(Opts::default());
    ctx.registry
        .set_meta(
            FEAT,
            DeskMeta {
                workspace_status: Some("in-review".into()),
                comment: Some("look".into()),
                extra: Default::default(),
            },
        )
        .unwrap();
    let s = ctx.snap().await;
    let got: Vec<_> = s
        .desks
        .iter()
        .map(|d| {
            (
                d.id.as_str(),
                d.is_main,
                d.branch.as_str(),
                d.repo.as_str(),
                d.workspace_status.as_deref(),
                d.comment.as_str(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            (FEAT, false, "feat", "app", Some("in-review"), "look"),
            (MAIN, true, "main", "app", None, ""),
        ]
    );
}

// ---------- NativeBackend desk names ----------

const FIX: &str = "worktree /p/app\nHEAD a\nbranch refs/heads/main\n\nworktree /h/worktrees/app/fix-login\nHEAD b\nbranch refs/heads/fix-login\n\n";

#[tokio::test]
async fn names_a_worktree_desk_after_its_folder_the_main_checkout_too() {
    let ctx = setup(with_git(|_, _| Ok(FIX.into())));
    let s = ctx.snap().await;
    let got: Vec<_> = s
        .desks
        .iter()
        .map(|d| (d.id.as_str(), d.name.as_str()))
        .collect();
    assert_eq!(
        got,
        vec![
            ("abcdef123456::/h/worktrees/app/fix-login", "fix-login"),
            (MAIN, "app"),
        ]
    );
}

#[tokio::test]
async fn refuses_to_hire_a_second_worktree_with_the_same_name() {
    let ctx = setup(with_git(|_, _| Ok(FIX.into())));
    let desks = ctx.snap().await.desks;
    let req = HireRequest {
        repo_id: Some(REPO_ID.into()),
        name: Some("fix-login".into()),
        base_branch: None,
        desk_id: None,
        agent: "claude".into(),
        prompt: None,
    };
    assert_eq!(
        validate_hire(&req, &desks),
        Err("같은 이름의 워크트리가 이미 있어요".to_string())
    );
}

// ---------- NativeBackend stop and remove ----------

#[tokio::test]
async fn stops_an_agent_by_killing_its_terminal() {
    let ctx = setup(Opts::default());
    ctx.hire_on(MAIN, "claude", None).await;
    let id = ctx.pty.id(0);
    ctx.backend.stop_agent(&format!("{id}:main")).await.unwrap();
    assert!(!ctx.pty.has(&id));
    let s = ctx.snap().await;
    assert!(s
        .desks
        .iter()
        .find(|d| d.is_main)
        .unwrap()
        .agents
        .is_empty());
}

#[tokio::test]
async fn reports_an_unknown_agent_as_not_found() {
    let ctx = setup(Opts::default());
    let err = ctx.backend.stop_agent("nope:main").await.unwrap_err();
    assert_eq!(err.code, "not_found");
}

#[tokio::test]
async fn refuses_the_main_checkout_and_unknown_desks_going_by_gits_own_listing() {
    let ctx = setup(Opts::default());
    let code = |r: Result<(), BackendError>| r.unwrap_err().code;
    assert_eq!(
        code(ctx.backend.remove_worktree(MAIN).await),
        "main_checkout"
    );
    assert_eq!(
        code(ctx.backend.remove_worktree("zzz::/p/app").await),
        "not_found"
    );
    assert_eq!(
        code(ctx.backend.remove_worktree("garbage").await),
        "not_found"
    );
    assert_eq!(
        code(
            ctx.backend
                .remove_worktree("abcdef123456::/h/worktrees/app/gone")
                .await
        ),
        "not_found"
    );
    assert!(!ctx.git_called("remove"));
}

#[tokio::test]
async fn knows_the_main_checkout_from_git_even_when_the_registered_path_is_spelled_differently() {
    const MAIN_ELSEWHERE: &str = "worktree /real/app\nHEAD a\nbranch refs/heads/main\n\nworktree /h/worktrees/app/feat\nHEAD b\nbranch refs/heads/feat\n\n";
    let ctx = setup(with_git(|_, _| Ok(MAIN_ELSEWHERE.into())));
    let err = ctx
        .backend
        .remove_worktree("abcdef123456::/real/app")
        .await
        .unwrap_err();
    assert_eq!(err.code, "main_checkout");
    assert!(!ctx.git_called("remove"));
}

#[tokio::test]
async fn refuses_a_worktree_with_a_running_agent() {
    let ctx = setup(Opts::default());
    ctx.hire_on(FEAT, "claude", None).await;
    let err = ctx.backend.remove_worktree(FEAT).await.unwrap_err();
    assert_eq!(err.code, "has_agents");
    assert!(!ctx.git_called("remove"));
}

#[tokio::test]
async fn removes_an_idle_worktree_through_git_without_force() {
    let ctx = setup(Opts::default());
    ctx.backend.remove_worktree(FEAT).await.unwrap();
    let want: Vec<String> = ["/p/app", "worktree", "remove", "/h/worktrees/app/feat"]
        .map(String::from)
        .to_vec();
    assert!(ctx.git_calls.lock().unwrap().contains(&want));
}

#[tokio::test]
async fn maps_a_git_refusal_to_dirty() {
    let ctx = setup(with_git(|_, args| {
        if args.get(1) == Some(&"remove") {
            return Err(git_err("fatal: '/h/worktrees/app/feat' contains modified or untracked files, use --force to delete it"));
        }
        Ok(PORCELAIN.into())
    }));
    let err = ctx.backend.remove_worktree(FEAT).await.unwrap_err();
    assert_eq!(
        err,
        BackendError::with_code("변경사항이 있는 워크트리는 지울 수 없어요", "dirty")
    );
}

#[tokio::test]
async fn reports_any_other_git_failure_as_remove_failed_with_gits_first_line() {
    let ctx = setup(with_git(|_, args| {
        if args.get(1) == Some(&"remove") {
            return Err(git_err(
                "fatal: cannot remove a locked working tree\nlock reason: x",
            ));
        }
        Ok(PORCELAIN.into())
    }));
    let err = ctx.backend.remove_worktree(FEAT).await.unwrap_err();
    assert_eq!(
        err,
        BackendError::with_code(
            "워크트리를 지우지 못했어요 — fatal: cannot remove a locked working tree",
            "remove_failed"
        )
    );
}

#[tokio::test]
async fn reports_a_failed_listing_as_remove_failed_and_removes_nothing() {
    let ctx = setup(with_git(|_, _| Err(git_err("fatal: not a git repository"))));
    let err = ctx.backend.remove_worktree(FEAT).await.unwrap_err();
    assert_eq!(
        err,
        BackendError::with_code(
            "워크트리를 지우지 못했어요 — fatal: not a git repository",
            "remove_failed"
        )
    );
    assert!(!ctx.git_called("remove"));
}

// ---------- NativeBackend hire and hooks ----------

#[tokio::test]
async fn spawns_claude_with_a_session_id_hook_settings_and_a_scrubbed_env() {
    let ctx = setup(Opts::default());
    ctx.hire_on(MAIN, "claude", None).await;
    let (id, opts) = ctx.pty.spawned()[0].clone();
    assert_eq!(opts.file, "claude");
    assert_eq!(opts.cwd, PathBuf::from("/p/app"));
    assert_eq!(opts.args[0], "--session-id");
    assert_eq!(opts.args[2], "--settings");
    assert!(!opts.env.contains_key("CLAUDECODE"));
    let url_re =
        regex::Regex::new(r"^http://127\.0\.0\.1:4317/hook/[0-9a-f-]+:main\?token=[0-9a-f]{32}$")
            .unwrap();
    assert!(url_re.is_match(&opts.env["OFFICE_DESKS_HOOK_URL"]));
    // The settings file runs the relay for every hook event.
    let settings: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&opts.args[3]).unwrap()).unwrap();
    assert_eq!(
        settings["hooks"]["Stop"][0]["hooks"][0]["command"],
        json!("\"/r/office-desks\" \"hook-relay\"")
    );
    let s = ctx.snap().await;
    let desk = s.desks.iter().find(|d| d.id == MAIN).unwrap();
    assert_eq!(desk.agents.len(), 1);
    assert_eq!(desk.agents[0].agent_type, "claude");
    assert_eq!(desk.agents[0].terminal_handle, Some(format!("pty_{id}")));
}

#[tokio::test]
async fn creates_a_worktree_for_a_new_task_then_runs_the_agent_in_it() {
    let ctx = setup(Opts::default());
    ctx.backend
        .hire(HireSpec::Worktree {
            repo_id: REPO_ID.into(),
            name: "fix-login".into(),
            agent: "codex".into(),
            base_branch: Some("origin/main".into()),
            prompt: None,
        })
        .await
        .unwrap();
    let dest = ctx.home.join("worktrees").join("app").join("fix-login");
    let want: Vec<String> = vec![
        "/p/app".into(),
        "worktree".into(),
        "add".into(),
        "-b".into(),
        "fix-login".into(),
        s(&dest),
        "origin/main".into(),
    ];
    assert!(ctx.git_calls.lock().unwrap().contains(&want));
    // The agent runs in the real path, the one git lists (macOS tmp is /var → /private/var).
    let opts = ctx.pty.spawned()[0].1.clone();
    assert_eq!(opts.file, "codex");
    assert!(opts.args.is_empty());
    assert_eq!(opts.cwd, dunce::canonicalize(&dest).unwrap());
}

#[cfg(unix)]
#[tokio::test]
async fn puts_the_new_agent_on_its_desk_when_the_office_home_is_behind_a_symlink() {
    let real_t = tmp("od-real-");
    let real = dunce::canonicalize(real_t.path()).unwrap();
    let link_t = tmp("od-link-");
    let link = link_t.path().join("home");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let wt = format!("{}/worktrees/app/fix-login", s(&real));
    let porcelain = format!("worktree /p/app\nHEAD a\nbranch refs/heads/main\n\nworktree {wt}\nHEAD b\nbranch refs/heads/fix-login\n\n");
    let ctx = setup(Opts {
        home: Some(link),
        ..with_git(move |_, _| Ok(porcelain.clone()))
    });
    ctx.backend
        .hire(HireSpec::Worktree {
            repo_id: REPO_ID.into(),
            name: "fix-login".into(),
            agent: "claude".into(),
            base_branch: None,
            prompt: None,
        })
        .await
        .unwrap();
    assert_eq!(ctx.pty.spawned()[0].1.cwd, PathBuf::from(&wt));
    let s = ctx.snap().await;
    let desk = s
        .desks
        .iter()
        .find(|d| d.id == format!("{REPO_ID}::{wt}"))
        .unwrap();
    assert_eq!(desk.agents.len(), 1);
}

#[tokio::test]
async fn refuses_an_agent_command_that_is_not_installed_before_creating_anything() {
    let ctx = setup(Opts {
        which: Some(Arc::new(|_: &str, _: &EnvMap| None)),
        ..Opts::default()
    });
    let err = ctx
        .backend
        .hire(HireSpec::Agent {
            desk_id: MAIN.into(),
            agent: "claude".into(),
            prompt: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code, "agent_not_found");
    let err = ctx
        .backend
        .hire(HireSpec::Worktree {
            repo_id: REPO_ID.into(),
            name: "fix-login".into(),
            agent: "codex".into(),
            base_branch: None,
            prompt: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code, "agent_not_found");
    assert!(err.message.contains("codex"));
    assert_eq!(
        err.message,
        "codex 명령을 찾지 못했어요. 설치되어 있고 PATH에 있는지 확인해 주세요"
    );
    assert!(!ctx.git_called("add"));
    assert!(ctx.pty.spawned().is_empty());
    assert!(ctx.snap().await.desks[1].agents.is_empty());
    assert!(dir_entries(&ctx.home.join("agents")).is_empty());
}

#[tokio::test]
async fn looks_the_command_up_on_the_agent_path() {
    let seen: Arc<Mutex<Vec<Lookup>>> = Arc::default();
    let log = seen.clone();
    let ctx = setup(Opts {
        which: Some(Arc::new(move |cmd: &str, env: &EnvMap| {
            log.lock()
                .unwrap()
                .push((cmd.to_string(), env.get("PATH").cloned()));
            Some(PathBuf::from(format!("/bin/{cmd}")))
        })),
        ..Opts::default()
    });
    ctx.hire_on(MAIN, "gemini", None).await;
    assert_eq!(
        *seen.lock().unwrap(),
        vec![("gemini".to_string(), Some("/bin".to_string()))]
    );
}

#[tokio::test]
async fn warns_that_only_claude_gets_the_first_prompt_typed_in() {
    let ctx = setup(Opts::default());
    assert_eq!(
        ctx.hire_on(MAIN, "codex", Some("do it")).await,
        HireResult {
            warning: Some("첫 지시는 Claude에만 자동으로 전달돼요. 패널에서 보내 주세요".into())
        }
    );
    assert_eq!(ctx.pty.spawned().len(), 1);
    assert_eq!(
        ctx.hire_on(MAIN, "codex", None).await,
        HireResult::default()
    );
    assert_eq!(
        ctx.hire_on(MAIN, "claude", Some("do it")).await,
        HireResult::default()
    );
    // JS truthiness: an empty prompt is no prompt.
    assert_eq!(
        ctx.hire_on(MAIN, "codex", Some("")).await,
        HireResult::default()
    );
}

#[tokio::test]
async fn does_not_count_the_startup_screen_as_waiting_for_the_first_2_seconds_unless_a_hook_arrived(
) {
    let ctx = setup(Opts::default());
    ctx.hire_on(MAIN, "claude", None).await;
    ctx.hire_on(MAIN, "claude", None).await;
    let (a, b) = (ctx.pty.id(0), ctx.pty.id(1));
    ctx.pty.set_screen(&a, trust());
    ctx.pty.set_screen(&b, trust());
    // The hook says done; the dialog on screen wins.
    assert!(ctx.backend.hook(
        &format!("{b}:main"),
        &ctx.pty.token(1),
        &json!({ "hook_event_name": "SessionStart" })
    ));
    let state = |s: &OfficeSnapshot, id: &str| {
        s.desks[1]
            .agents
            .iter()
            .find(|x| x.id == format!("{id}:main"))
            .unwrap()
            .raw_state
            .clone()
    };
    ctx.tick(1999);
    let s = ctx.snap().await;
    assert_eq!(state(&s, &a), "unknown");
    assert_eq!(state(&s, &b), "waiting");
    ctx.tick(1);
    assert_eq!(state(&ctx.snap().await, &a), "waiting");
}

#[tokio::test]
async fn delivers_the_pending_first_prompt_once_on_session_start_even_after_a_trust_dialog() {
    let ctx = setup(Opts::default());
    ctx.hire_on(MAIN, "claude", Some("fix the login bug")).await;
    let id = ctx.pty.id(0);
    let agent_id = format!("{id}:main");
    ctx.pty.set_screen(&id, trust());
    ctx.tick(2000); // past the startup grace
    let s = ctx.snap().await;
    assert_eq!(s.desks[1].agents[0].state, CharacterState::Waiting); // the trust dialog needs the user
    assert!(ctx.pty.writes().is_empty());

    ctx.pty.set_screen(&id, ready());
    assert!(ctx.backend.hook(
        &agent_id,
        &ctx.pty.token(0),
        &json!({ "hook_event_name": "SessionStart", "session_id": "s1", "transcript_path": "/t/s1.jsonl" })
    ));
    settle().await;
    assert_eq!(
        ctx.pty.writes(),
        vec![
            (
                id.clone(),
                "\x1b[200~fix the login bug\x1b[201~".to_string()
            ),
            (id.clone(), "\r".to_string()),
        ]
    );
    ctx.backend.hook(
        &agent_id,
        &ctx.pty.token(0),
        &json!({ "hook_event_name": "SessionStart", "source": "clear" }),
    );
    settle().await;
    assert_eq!(ctx.pty.writes().len(), 2);
    let s = ctx.snap().await;
    assert_eq!(s.desks[1].agents[0].state, CharacterState::Done);
}

#[test]
fn delivers_the_first_prompt_without_a_tokio_runtime() {
    let ctx = setup(Opts::default());
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    rt.block_on(ctx.hire_on(MAIN, "claude", Some("go")));
    let id = ctx.pty.id(0);
    // Called from a plain thread: the Enter comes from a helper thread after the settle time.
    assert!(ctx.backend.hook(
        &format!("{id}:main"),
        &ctx.pty.token(0),
        &json!({ "hook_event_name": "SessionStart" })
    ));
    assert_eq!(ctx.pty.writes().len(), 1);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while ctx.pty.writes().len() < 2 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(ctx.pty.writes()[1], (id, "\r".to_string()));
}

#[tokio::test]
async fn rejects_a_wrong_token_or_unknown_agent_and_changes_nothing() {
    let ctx = setup(Opts::default());
    ctx.hire_on(MAIN, "claude", None).await;
    let agent_id = format!("{}:main", ctx.pty.id(0));
    let payload = json!({ "hook_event_name": "UserPromptSubmit", "prompt": "x" });
    assert!(!ctx.backend.hook(&agent_id, &"f".repeat(32), &payload));
    assert!(!ctx.backend.hook("nope:main", &ctx.pty.token(0), &payload));
    // A token of the wrong length, and a payload that is not an object.
    assert!(!ctx.backend.hook(&agent_id, "short", &payload));
    assert!(!ctx.backend.hook(&agent_id, &ctx.pty.token(0), &json!("x")));
    assert!(!ctx.backend.hook(&agent_id, &ctx.pty.token(0), &json!(null)));
    assert_eq!(ctx.snap().await.desks[1].agents[0].prompt, None);
}

#[tokio::test]
async fn maps_hook_events_to_states_the_office_understands() {
    let ctx = setup(Opts::default());
    ctx.hire_on(MAIN, "claude", None).await;
    let agent_id = format!("{}:main", ctx.pty.id(0));
    let t = ctx.pty.token(0);
    ctx.backend
        .hook(&agent_id, &t, &json!({ "hook_event_name": "SessionStart" }));
    ctx.backend.hook(
        &agent_id,
        &t,
        &json!({ "hook_event_name": "UserPromptSubmit", "prompt": "go" }),
    );
    ctx.backend.hook(
        &agent_id,
        &t,
        &json!({ "hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": { "file_path": "src/a.ts" } }),
    );
    let a = ctx.snap().await.desks[1].agents[0].clone();
    assert_eq!(a.state, CharacterState::Reading);
    assert_eq!(a.raw_state, "working");
    assert_eq!(a.prompt.as_deref(), Some("go"));
    assert_eq!(a.activity, "Read: src/a.ts");
}

#[tokio::test]
async fn removes_an_agent_whose_process_exited() {
    let ctx = setup(Opts::default());
    ctx.hire_on(MAIN, "claude", None).await;
    assert_eq!(dir_entries(&ctx.home.join("agents")).len(), 1);
    ctx.pty.kill(&ctx.pty.id(0));
    assert!(ctx.snap().await.desks[1].agents.is_empty());
    // Its settings file goes with it.
    assert!(dir_entries(&ctx.home.join("agents")).is_empty());
}

// ---------- NativeBackend input, board, sessions, repos ----------

#[tokio::test]
async fn pastes_prompts_and_types_keys_into_the_pty() {
    let ctx = setup(Opts::default());
    ctx.hire_on(MAIN, "claude", None).await;
    let id = ctx.pty.id(0);
    let handle = format!("pty_{id}");
    ctx.backend
        .send_prompt(&handle, "line one\nline two")
        .await
        .unwrap();
    ctx.backend
        .send_keys(&handle, KeyInput::Bytes("\x1b[A".into()))
        .await
        .unwrap();
    ctx.backend
        .send_keys(&handle, KeyInput::Enter)
        .await
        .unwrap();
    let w = |s: &str| (id.clone(), s.to_string());
    assert_eq!(
        ctx.pty.writes(),
        vec![
            w("\x1b[200~line one\nline two\x1b[201~"),
            w("\r"),
            w("\x1b[A"),
            w("\r"),
        ]
    );
    assert_eq!(ctx.backend.read_screen(&handle).await.unwrap(), ready());
    assert_eq!(ctx.backend.blocked_handle("x"), None);
    assert_eq!(
        ctx.backend.retry_prompt("x").await.unwrap_err(),
        BackendError::with_code(
            "다시 보낼 메시지를 찾지 못했습니다. 새로 보내주세요",
            "not_found"
        )
    );
}

#[tokio::test]
async fn stores_the_board_in_the_registry() {
    let ctx = setup(Opts::default());
    ctx.backend
        .set_board(
            MAIN,
            BoardUpdate {
                workspace_status: Some("todo".into()),
                comment: Some("c".into()),
            },
        )
        .await
        .unwrap();
    ctx.backend
        .set_board(
            MAIN,
            BoardUpdate {
                workspace_status: None,
                comment: Some(String::new()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        ctx.registry.meta(MAIN),
        DeskMeta {
            workspace_status: Some("todo".into()),
            comment: None,
            extra: Default::default(),
        }
    );
}

#[tokio::test]
async fn finds_the_transcript_by_session_id_rate_limited_or_from_the_hook_path_without_scanning() {
    let ctx = setup(Opts::default());
    ctx.hire_on(MAIN, "claude", None).await;
    let sid = ctx.pty.spawned()[0].1.args[1].clone();
    let agent_id = format!("{}:main", ctx.pty.id(0));
    let t = ctx.pty.token(0);
    let snap = ctx.snap().await;
    let (desk, agent) = (&snap.desks[1], &snap.desks[1].agents[0]);
    assert_eq!(ctx.backend.find_session(desk, agent).await.unwrap(), None);
    let dir = ctx.home.join("claude-projects").join("-p-app");
    std::fs::create_dir_all(&dir).unwrap();
    let by_id = dir.join(format!("{sid}.jsonl"));
    std::fs::write(&by_id, "{}\n").unwrap();
    assert_eq!(ctx.backend.find_session(desk, agent).await.unwrap(), None); // rate-limited
    ctx.tick(5001);
    assert_eq!(
        ctx.backend.find_session(desk, agent).await.unwrap(),
        Some(s(&by_id))
    );
    assert_eq!(ctx.backend.cached_session(&agent_id), Some(s(&by_id)));

    // A hook path outside the projects folder, or for another session, is ignored.
    let outside = ctx.home.join(format!("{sid}.jsonl"));
    ctx.backend.hook(
        &agent_id,
        &t,
        &json!({ "hook_event_name": "SessionStart", "transcript_path": s(&outside) }),
    );
    assert_eq!(ctx.backend.cached_session(&agent_id), Some(s(&by_id)));
    ctx.backend.hook(
        &agent_id,
        &t,
        &json!({ "hook_event_name": "SessionStart", "transcript_path": s(&dir.join("other.jsonl")) }),
    );
    assert_eq!(ctx.backend.cached_session(&agent_id), Some(s(&by_id)));

    // A hook-supplied path is authoritative: no scan while it is missing.
    let hook_file = ctx
        .home
        .join("claude-projects")
        .join("-elsewhere")
        .join(format!("{sid}.jsonl"));
    ctx.backend.hook(
        &agent_id,
        &t,
        &json!({ "hook_event_name": "SessionStart", "transcript_path": s(&hook_file) }),
    );
    assert_eq!(ctx.backend.cached_session(&agent_id), None);
    ctx.tick(5001);
    assert_eq!(ctx.backend.cached_session(&agent_id), None);
    std::fs::create_dir_all(hook_file.parent().unwrap()).unwrap();
    std::fs::write(&hook_file, "{}\n").unwrap();
    assert_eq!(ctx.backend.cached_session(&agent_id), Some(s(&hook_file)));
}

#[tokio::test]
async fn follows_a_new_session_id_from_session_start_but_still_rejects_foreign_basenames() {
    let ctx = setup(Opts::default());
    ctx.hire_on(MAIN, "claude", None).await;
    let agent_id = format!("{}:main", ctx.pty.id(0));
    let t = ctx.pty.token(0);
    let dir = ctx.home.join("claude-projects").join("-p-app");
    std::fs::create_dir_all(&dir).unwrap();
    let new_id = "11111111-2222-3333-4444-555555555555";
    let file = dir.join(format!("{new_id}.jsonl"));
    std::fs::write(&file, "{}\n").unwrap();
    ctx.backend.hook(
        &agent_id,
        &t,
        &json!({ "hook_event_name": "SessionStart", "source": "clear", "session_id": new_id, "transcript_path": s(&file) }),
    );
    assert_eq!(ctx.backend.cached_session(&agent_id), Some(s(&file)));
    let snap = ctx.snap().await;
    let desk = &snap.desks[1];
    assert_eq!(
        ctx.backend
            .find_session(desk, &desk.agents[0])
            .await
            .unwrap(),
        Some(s(&file))
    );

    // Scan fallback also follows the new id when no path is given.
    let id2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let file2 = dir.join(format!("{id2}.jsonl"));
    std::fs::write(&file2, "{}\n").unwrap();
    ctx.backend.hook(
        &agent_id,
        &t,
        &json!({ "hook_event_name": "SessionStart", "session_id": id2 }),
    );
    assert_eq!(ctx.backend.cached_session(&agent_id), Some(s(&file2)));

    // A path matching neither id is rejected.
    let id3 = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
    ctx.backend.hook(
        &agent_id,
        &t,
        &json!({ "hook_event_name": "SessionStart", "session_id": id3, "transcript_path": s(&dir.join("other.jsonl")) }),
    );
    assert_eq!(ctx.backend.cached_session(&agent_id), None); // adopted id3, nothing on disk, bogus path ignored
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_a_hook_path_that_leaves_the_projects_root_through_a_symlink() {
    let ctx = setup(Opts::default());
    ctx.hire_on(MAIN, "claude", None).await;
    let sid = ctx.pty.spawned()[0].1.args[1].clone();
    let agent_id = format!("{}:main", ctx.pty.id(0));
    let root = ctx.home.join("claude-projects");
    std::fs::create_dir_all(&root).unwrap();
    assert_eq!(ctx.backend.cached_session(&agent_id), None); // scans once; the next scan waits 5 s
    let outside = tmp("od-outside-");
    std::fs::write(outside.path().join(format!("{sid}.jsonl")), "{}\n").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.join("evil")).unwrap();
    let via_link = root.join("evil").join(format!("{sid}.jsonl"));
    ctx.backend.hook(
        &agent_id,
        &ctx.pty.token(0),
        &json!({ "hook_event_name": "SessionStart", "transcript_path": s(&via_link) }),
    );
    assert_eq!(ctx.backend.cached_session(&agent_id), None);
}

#[tokio::test]
async fn honors_claude_config_dir_for_the_transcript_root() {
    let cfg = tmp("od-cfg-");
    let ctx = setup(Opts::default());
    let pty = Arc::new(FakePty::default());
    let mut deps = NativeDeps::new(
        pty.clone(),
        ctx.registry.clone(),
        ctx.home.clone(),
        hook_url,
    );
    deps.git = Some(Arc::new(FakeGit {
        calls: Arc::default(),
        f: Box::new(porcelain),
    }));
    deps.env = Some(env(&[
        ("PATH", "/bin"),
        ("CLAUDE_CONFIG_DIR", &s(cfg.path())),
    ]));
    deps.relay = Some(vec!["/r/office-desks".into(), "hook-relay".into()]);
    deps.sleep = Some(instant_sleep());
    deps.which = Some(Arc::new(|cmd: &str, _: &EnvMap| {
        Some(PathBuf::from(format!("/bin/{cmd}")))
    }));
    let backend = NativeBackend::new(deps);
    backend
        .hire(HireSpec::Agent {
            desk_id: MAIN.into(),
            agent: "claude".into(),
            prompt: None,
        })
        .await
        .unwrap();
    let sid = pty.spawned()[0].1.args[1].clone();
    let agent_id = format!("{}:main", pty.id(0));
    let dir = cfg.path().join("projects").join("x");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(format!("{sid}.jsonl"));
    std::fs::write(&file, "{}\n").unwrap();
    assert_eq!(backend.cached_session(&agent_id), Some(s(&file)));
}

#[tokio::test]
async fn cleans_up_when_the_spawn_fails() {
    let pty = Arc::new(FakePty::default());
    pty.fail_spawn.store(true, Ordering::SeqCst);
    let ctx = setup(Opts {
        pty,
        ..Opts::default()
    });
    let err = ctx
        .backend
        .hire(HireSpec::Agent {
            desk_id: MAIN.into(),
            agent: "claude".into(),
            prompt: None,
        })
        .await
        .unwrap_err();
    assert!(err.message.contains("spawn failed"));
    assert!(ctx.snap().await.desks[1].agents.is_empty());
    assert!(dir_entries(&ctx.home.join("agents")).is_empty());
}

#[tokio::test]
async fn registers_a_repo_from_any_folder_inside_it() {
    let ctx = setup(with_git(|_, _| {
        Ok("worktree /q/other\nHEAD a\nbranch refs/heads/main\n\n".into())
    }));
    ctx.backend.add_repo("/q/other/src").await.unwrap();
    let paths: Vec<String> = ctx.registry.repos().into_iter().map(|r| r.path).collect();
    assert!(paths.contains(&normalize_path("/q/other")));
    let err = ctx.backend.add_repo("relative/path").await.unwrap_err();
    assert_eq!(err.code, "not_absolute");
    assert_eq!(err.message, "절대 경로를 입력해 주세요");
}

#[tokio::test]
async fn exposes_the_live_terminal_of_an_agent_for_attaching() {
    let ctx = setup(Opts::default());
    ctx.hire_on(MAIN, "claude", None).await;
    let id = ctx.pty.id(0);
    assert_eq!(
        ctx.backend.terminal_of(&format!("{id}:main")),
        Some(id.clone())
    );
    assert!(Arc::ptr_eq(ctx.backend.pty(), &ctx.pty));
    ctx.pty.kill(&id);
    assert_eq!(ctx.backend.terminal_of(&format!("{id}:main")), None);
    assert_eq!(ctx.backend.terminal_of("nope:main"), None);
}

#[tokio::test]
async fn kills_every_agent_on_dispose_and_removes_settings_files() {
    let ctx = setup(Opts::default());
    ctx.hire_on(MAIN, "claude", None).await;
    let dir = ctx.home.join("agents");
    assert_eq!(dir_entries(&dir).len(), 1);
    ctx.backend.dispose().await;
    assert_eq!(ctx.pty.screen_count(), 0);
    assert!(dir_entries(&dir).is_empty());
}

// ---------- the trait object ----------

#[tokio::test]
async fn the_real_backend_works_as_a_trait_object() {
    let t = tmp("od-native-dyn-");
    let registry = Arc::new(Registry::new(t.path().join("state.json")));
    registry.load();
    let mut deps = NativeDeps::new(
        Arc::new(PtyHost::new()),
        registry,
        t.path().to_path_buf(),
        hook_url,
    );
    deps.env = Some(env(&[("PATH", "/bin")]));
    let backend: Arc<dyn OfficeBackend> = Arc::new(NativeBackend::new(deps));
    assert_eq!(backend.name(), "native");
    assert_eq!(
        serde_json::to_value(backend.capabilities()).unwrap(),
        json!({ "usage": false, "search": false, "board": true, "hire": true, "changes": true, "transcripts": true, "focus": false, "repos": true, "stop": true, "remove": true })
    );
    assert_eq!(
        serde_json::to_value(backend.messages()).unwrap(),
        json!({
            "noSession": "이 에이전트의 대화 기록이 아직 없어요. 첫 지시를 보내면 생깁니다.",
            "hireDisabled": "이 백엔드에서는 새 작업을 만들 수 없어요",
        })
    );
    assert!(backend.as_native().is_some());
    let snap = backend.snapshot().await.unwrap();
    assert!(snap.desks.is_empty());
    assert!(backend.search_conversations("x").await.unwrap().is_empty());
    assert_eq!(backend.usage().await.unwrap(), None);
    backend.focus("pty_x").await.unwrap();
    assert!(!backend.hook("nope:main", "t", &json!({})));
    backend.dispose().await;
}
