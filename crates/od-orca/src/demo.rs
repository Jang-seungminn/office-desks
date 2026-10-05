//! Port of `bridge/src/demo.ts` and `bridge/src/backend/demo.ts`: a deterministic fake office
//! for `office-desks demo`. A fake Orca ([`DemoRunner`]) feeds the real [`OrcaBackend`]; the
//! data real transcripts and git would add is filled in by [`DemoBackend::snapshot`].
//!
//! New in R3: `OFFICE_DESKS_DEMO_EPOCH` fixes the demo clock, so a recording is repeatable.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Local, TimeZone, Utc};
use od_core::awards::local_date;
use od_core::backend::{
    BackendCapabilities, BackendError, BackendMessages, BoardUpdate, ConversationHit, HireResult,
    HireSpec, KeyInput, OfficeBackend,
};
use od_core::model::{
    AgentStats, Award, AwardBoard, Department, DepartmentTheme, DeskChanges, OfficeAgent,
    OfficeDesk, OfficeSnapshot, OrgChart, UsageSnapshot,
};
use od_core::native::env::EnvMap;
use od_core::util::epoch_ms;
use serde_json::{json, Value};

use crate::backend::{OrcaBackend, OrcaOptions};
use crate::cli::OrcaRunner;
use crate::sessions::SessionVerifier;

/// Env var that fixes the demo clock (epoch milliseconds).
pub const DEMO_EPOCH_ENV: &str = "OFFICE_DESKS_DEMO_EPOCH";

const NO_SESSION: &str = "Orca 세션 검색에서 이 에이전트의 대화 기록을 찾지 못했습니다. (Orca Settings → Agent Session History가 켜져 있어야 합니다)";
const HIRE_DISABLED: &str = "데모 모드에서는 만들 수 없어요";

struct DemoAgent {
    pane: &'static str,
    kind: &'static str,
    /// (state, tool name, tool input)
    states: &'static [(&'static str, Option<&'static str>, Option<&'static str>)],
}

struct DemoWorktree {
    repo: &'static str,
    name: &'static str,
    branch: &'static str,
    main: bool,
    parent: Option<&'static str>,
    agents: &'static [DemoAgent],
}

impl DemoWorktree {
    fn repo_id(&self) -> String {
        format!("demo-{}", self.repo)
    }
}

type St = (&'static str, Option<&'static str>, Option<&'static str>);
const DONE: St = ("done", None, None);

static WORKTREES: &[DemoWorktree] = &[
    DemoWorktree {
        repo: "shop-web",
        name: "shop-web",
        branch: "main",
        main: true,
        parent: None,
        agents: &[DemoAgent {
            pane: "p1",
            kind: "claude",
            states: &[
                ("working", Some("Edit"), Some("src/cart/Cart.tsx")),
                ("working", Some("Bash"), Some("npm test")),
                DONE,
            ],
        }],
    },
    DemoWorktree {
        repo: "shop-web",
        name: "checkout-flow",
        branch: "feat/checkout-flow",
        main: false,
        parent: Some("shop-web"),
        agents: &[DemoAgent {
            pane: "p2",
            kind: "claude",
            states: &[
                ("waiting", Some("ExitPlanMode"), None),
                ("working", Some("Write"), Some("src/checkout/Pay.tsx")),
            ],
        }],
    },
    DemoWorktree {
        repo: "shop-web",
        name: "login-bug",
        branch: "fix/login-redirect",
        main: false,
        parent: Some("shop-web"),
        agents: &[DemoAgent {
            pane: "p3",
            kind: "codex",
            states: &[
                ("working", Some("exec_command"), Some("pnpm vitest login")),
                ("working", Some("Read"), Some("src/auth/session.ts")),
            ],
        }],
    },
    DemoWorktree {
        repo: "shop-web",
        name: "deps-bump",
        branch: "chore/deps-bump",
        main: false,
        parent: None,
        agents: &[],
    },
    DemoWorktree {
        repo: "api-server",
        name: "api-server",
        branch: "main",
        main: true,
        parent: None,
        agents: &[DemoAgent {
            pane: "p4",
            kind: "codex",
            states: &[("working", Some("Grep"), Some("rateLimit")), DONE],
        }],
    },
    DemoWorktree {
        repo: "api-server",
        name: "rate-limit",
        branch: "feat/rate-limit",
        main: false,
        parent: None,
        agents: &[
            DemoAgent {
                pane: "p5",
                kind: "claude",
                states: &[
                    ("working", Some("Edit"), Some("internal/limiter/bucket.go")),
                    ("waiting", Some("Bash"), Some("go test ./...")),
                ],
            },
            DemoAgent {
                pane: "p6",
                kind: "claude",
                states: &[
                    ("working", Some("WebSearch"), Some("token bucket redis lua")),
                    ("working", Some("Read"), Some("docs/limits.md")),
                ],
            },
        ],
    },
    DemoWorktree {
        repo: "docs",
        name: "docs",
        branch: "main",
        main: true,
        parent: None,
        agents: &[DemoAgent {
            pane: "p7",
            kind: "gemini",
            states: &[DONE, ("working", Some("Edit"), Some("guide/intro.md"))],
        }],
    },
    // Finished a while ago: these take a break in the lounge.
    DemoWorktree {
        repo: "docs",
        name: "faq-rewrite",
        branch: "docs/faq-rewrite",
        main: false,
        parent: None,
        agents: &[
            DemoAgent {
                pane: "p8",
                kind: "claude",
                states: &[DONE],
            },
            DemoAgent {
                pane: "p9",
                kind: "claude",
                states: &[DONE],
            },
        ],
    },
    DemoWorktree {
        repo: "api-server",
        name: "perf-tuning",
        branch: "perf/query-cache",
        main: false,
        parent: None,
        agents: &[DemoAgent {
            pane: "p10",
            kind: "codex",
            states: &[DONE],
        }],
    },
];

/// `OFFICE_DESKS_DEMO_EPOCH`: only plain ASCII digits that make a positive `i64` count.
pub fn parse_epoch(v: Option<&str>) -> Option<i64> {
    let v = v?;
    if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    v.parse::<i64>().ok().filter(|n| *n > 0)
}

/// Node's `os.tmpdir()` over an env map.
pub fn os_tmpdir(env: &EnvMap) -> PathBuf {
    os_tmpdir_for(env, cfg!(windows))
}

fn os_tmpdir_for(env: &EnvMap, windows: bool) -> PathBuf {
    let first = |keys: &[&str]| {
        keys.iter()
            .filter_map(|k| env.get(*k))
            .find(|v| !v.is_empty())
            .cloned()
    };
    if windows {
        // Node: TEMP, TMP, then `<SystemRoot or windir>\temp`.
        let mut p = first(&["TEMP", "TMP"])
            .or_else(|| first(&["SystemRoot", "windir"]).map(|r| format!("{r}\\temp")))
            .unwrap_or_else(|| std::env::temp_dir().to_string_lossy().into_owned());
        if p.len() > 1 && p.ends_with('\\') && !p.ends_with(":\\") {
            p.pop();
        }
        PathBuf::from(p)
    } else {
        let mut p = first(&["TMPDIR", "TMP", "TEMP"]).unwrap_or_else(|| "/tmp".to_string());
        if p.len() > 1 && p.ends_with('/') {
            p.pop();
        }
        PathBuf::from(p)
    }
}

fn iso(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn demo_dir(tmp_dir: &Path) -> PathBuf {
    tmp_dir.join("office-desks-demo")
}

/// Process-wide demo clock: the fixed epoch, else the wall clock.
#[derive(Clone, Copy)]
struct Clock(Option<i64>);

impl Clock {
    fn now(self) -> i64 {
        self.0.unwrap_or_else(epoch_ms)
    }
}

fn worktree_ps(start: i64, now: i64) -> Value {
    let tick = (now - start).div_euclid(8000);
    let worktrees: Vec<Value> = WORKTREES
        .iter()
        .enumerate()
        .map(|(index, w)| {
            let agents: Vec<Value> = w
                .agents
                .iter()
                .enumerate()
                .map(|(i, a)| {
                    let at = (tick + i as i64).rem_euclid(a.states.len() as i64) as usize;
                    let (state, tool_name, tool_input) = a.states[at];
                    json!({
                        "paneKey": format!("{}:leaf", a.pane),
                        "agentType": a.kind,
                        "state": state,
                        "toolName": tool_name,
                        "toolInput": tool_input,
                        "prompt": format!("Demo task for {}", w.branch),
                        "lastAssistantMessage": if state == "done" {
                            Value::String(format!("{} 작업을 끝냈습니다. 테스트 통과.", w.branch))
                        } else {
                            Value::Null
                        },
                        // Agents with a single 'done' state finished long ago (they rest in the lounge).
                        "stateStartedAt": if a.states.len() == 1 {
                            start - 20 * 60_000
                        } else {
                            start + tick * 8000
                        },
                    })
                })
                .collect();
            let has = |s: &str| agents.iter().any(|a| a["state"] == s);
            let status = if has("waiting") {
                "permission"
            } else if has("working") {
                "working"
            } else if !agents.is_empty() {
                "active"
            } else {
                "inactive"
            };
            let repo_id = w.repo_id();
            json!({
                "worktreeId": format!("{repo_id}::/demo/{}/{}", w.repo, w.name),
                "repoId": repo_id,
                "repo": w.repo,
                "path": format!("/demo/{}/{}", w.repo, w.name),
                "branch": format!("refs/heads/{}", w.branch),
                "displayName": w.name,
                "isMainWorktree": w.main,
                "parentWorktreeId": w.parent.map(|p| format!("{repo_id}::/demo/{}/{p}", w.repo)),
                "status": status,
                "lastActivityAt": start - index as i64 * 60_000,
                "workspaceStatus": "in-progress",
                "comment": if w.name == "checkout-flow" { "결제 플로우 플랜 승인 대기" } else { "" },
                "agents": agents,
            })
        })
        .collect();
    json!({ "worktrees": worktrees })
}

fn terminal_list() -> Value {
    let terminals: Vec<Value> = WORKTREES
        .iter()
        .flat_map(|w| {
            w.agents.iter().map(move |a| {
                json!({
                    "handle": format!("demo_{}", a.pane),
                    "tabId": a.pane,
                    "leafId": "leaf",
                    "title": format!("✳ {}", w.branch),
                })
            })
        })
        .collect();
    json!({ "terminals": terminals })
}

/// A small fake transcript per demo agent, so the chat panel has something to show. The map is
/// `<desk path>|<agent type>` to the file: the first agent of a kind owns the demo transcript.
fn write_demo_transcripts(tmp_dir: &Path, start: i64) -> std::io::Result<HashMap<String, PathBuf>> {
    let dir = demo_dir(tmp_dir);
    std::fs::create_dir_all(&dir)?;
    let mut files = HashMap::new();
    let t = |min: i64| iso(start - min * 60_000);
    for w in WORKTREES {
        for a in w.agents {
            let mut lines = vec![
                json!({ "type": "ai-title", "aiTitle": format!("{} 작업", w.branch) }),
                json!({
                    "type": "user",
                    "timestamp": t(30),
                    "message": { "role": "user", "content": format!("Demo task for {}", w.branch) },
                }),
                json!({
                    "type": "assistant",
                    "timestamp": t(29),
                    "effort": "high",
                    "message": {
                        "role": "assistant",
                        "model": "claude-opus-5-5",
                        "content": [{
                            "type": "text",
                            "text": format!(
                                "**{}** 작업을 시작합니다.\n\n1. 코드 읽기\n2. 수정\n3. 테스트\n\n```ts\nexport const ok = true;\n```",
                                w.branch
                            ),
                        }],
                    },
                }),
                json!({
                    "type": "assistant",
                    "timestamp": t(28),
                    "message": {
                        "role": "assistant",
                        "content": [{
                            "type": "tool_use",
                            "id": format!("r-{}", a.pane),
                            "name": "Read",
                            "input": { "file_path": "src/index.ts" },
                        }],
                    },
                }),
                json!({
                    "type": "assistant",
                    "timestamp": t(27),
                    "message": {
                        "role": "assistant",
                        "content": [{
                            "type": "tool_use",
                            "id": format!("sa-{}", a.pane),
                            "name": "Agent",
                            "input": { "description": "관련 파일 찾기", "subagent_type": "Explore" },
                        }],
                    },
                }),
            ];
            if a.pane == "p5" || a.pane == "p2" {
                let targets: Vec<Value> = ["로그인", "검색", "결제"]
                    .iter()
                    .map(|label| json!({ "label": label, "description": "" }))
                    .collect();
                lines.push(json!({
                    "type": "assistant",
                    "timestamp": t(1),
                    "message": {
                        "role": "assistant",
                        "content": [{
                            "type": "tool_use",
                            "id": format!("ask-{}", a.pane),
                            "name": "AskUserQuestion",
                            "input": {
                                "questions": [
                                    {
                                        "header": "저장소",
                                        "question": "레이트 리밋 카운터를 어디에 둘까요?",
                                        "multiSelect": false,
                                        "options": [
                                            { "label": "Redis", "description": "여러 서버가 공유, 운영 부담 조금" },
                                            { "label": "메모리", "description": "가장 간단, 서버마다 따로 셈" },
                                        ],
                                    },
                                    {
                                        "header": "대상",
                                        "question": "어떤 API에 적용할까요?",
                                        "multiSelect": true,
                                        "options": targets,
                                    },
                                ],
                            },
                        }],
                    },
                }));
            }
            let file = dir.join(format!("{}.jsonl", a.pane));
            let mut text = lines
                .iter()
                .map(|l| serde_json::to_string(l).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\n");
            text.push('\n');
            std::fs::write(&file, text)?;
            files
                .entry(format!("/demo/{}/{}|{}", w.repo, w.name, a.kind))
                .or_insert(file);
        }
    }
    Ok(files)
}

/// The fake Orca CLI behind the demo.
struct DemoRunner {
    start: i64,
    clock: Clock,
    transcripts: HashMap<String, PathBuf>,
}

impl DemoRunner {
    fn terminal_read(&self, args: &[String]) -> Value {
        // Waiting agents show a permission dialog; everyone else shows Claude's normal input box.
        let at = args
            .iter()
            .position(|a| a == "--terminal")
            .map_or(0, |i| i + 1);
        let given = args.get(at).map_or("", String::as_str);
        let pane = given.strip_prefix("demo_").unwrap_or(given);
        let ps = worktree_ps(self.start, self.clock.now());
        let prefix = format!("{pane}:");
        let state = ps["worktrees"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|w| w["agents"].as_array().into_iter().flatten())
            .find(|a| {
                a["paneKey"]
                    .as_str()
                    .is_some_and(|k| k.starts_with(&prefix))
            })
            .and_then(|a| a["state"].as_str().map(str::to_string));
        let rule = "─".repeat(48);
        let waiting = state.as_deref() == Some("waiting");
        let tail: Vec<String> = if waiting && (pane == "p5" || pane == "p2") {
            vec![
                "(demo)".into(),
                rule.clone(),
                "←  ☐ 저장소  ☐ 대상  ✔ Submit  →".into(),
                "레이트 리밋 카운터를 어디에 둘까요?".into(),
                "❯ 1. Redis".into(),
                "  2. 메모리".into(),
                "  3. Type something.".into(),
                rule,
            ]
        } else if waiting {
            [
                "(demo) Bash command",
                "",
                "  go test ./...",
                "",
                "Do you want to proceed?",
                "❯ 1. Yes",
                "  2. No, and tell Claude what to do differently",
                "",
                "Esc to cancel",
            ]
            .map(String::from)
            .to_vec()
        } else {
            vec![
                "(demo) ⏺ 작업 중입니다…".into(),
                String::new(),
                rule.clone(),
                "❯ ".into(),
                rule,
                "  ⏵⏵ auto mode on".into(),
            ]
        };
        json!({ "terminal": { "tail": tail, "source": "screen" } })
    }

    fn search(&self, args: &[String]) -> Value {
        let opt = |name: &str| {
            let prefix = format!("--{name}=");
            args.iter()
                .find_map(|x| x.strip_prefix(&prefix))
                .unwrap_or("")
        };
        let cwd = opt("path");
        let hits: Vec<Value> = self
            .transcripts
            .get(&format!("{cwd}|{}", opt("agent")))
            .map(|file| {
                json!({
                    "title": "demo",
                    "cwd": cwd,
                    "source": { "presence": "present", "filePath": file.to_string_lossy() },
                })
            })
            .into_iter()
            .collect();
        json!({ "hits": hits })
    }

    fn account_list(&self) -> Value {
        let now = self.clock.now();
        let in3h = now + 3 * 3_600_000;
        let in4d = now + 4 * 86_400_000;
        json!({
            "rateLimits": {
                "claude": {
                    "provider": "claude",
                    "status": "ok",
                    "session": { "usedPercent": 62, "windowMinutes": 300, "resetsAt": in3h, "resetDescription": "3:00 PM" },
                    "weekly": { "usedPercent": 21, "windowMinutes": 10080, "resetsAt": in4d, "resetDescription": "Fri 4:00 AM" },
                    "fableWeekly": { "usedPercent": 9, "windowMinutes": 10080, "resetsAt": in4d, "resetDescription": "Fri 4:00 AM" },
                },
                "codex": { "provider": "codex", "status": "unavailable", "session": null, "weekly": null },
            },
        })
    }
}

#[async_trait]
impl OrcaRunner for DemoRunner {
    async fn run(&self, args: &[String]) -> Result<Value, BackendError> {
        let a = args.first().map(String::as_str);
        let b = args.get(1).map(String::as_str);
        Ok(match (a, b) {
            (Some("worktree"), Some("ps")) => worktree_ps(self.start, self.clock.now()),
            (Some("terminal"), Some("list")) => terminal_list(),
            (Some("terminal"), Some("read")) => self.terminal_read(args),
            (Some("search"), _) => self.search(args),
            (Some("account"), Some("list")) => self.account_list(),
            _ => json!({ "ok": true }),
        })
    }
}

/// What the bridge would learn from demo transcripts: running subagents, model, effort, stats.
fn demo_enrichment(agent_id: &str, start: i64) -> (i64, &'static str, &'static str, AgentStats) {
    let (subagents_running, model, effort) = match agent_id {
        "p1:leaf" => (2, "claude-opus-5-5", "xhigh"),
        "p2:leaf" => (0, "claude-fable-5-1", "high"),
        "p3:leaf" => (0, "gpt-5.4", "medium"),
        "p4:leaf" => (0, "gpt-5.4", "high"),
        "p5:leaf" => (1, "claude-sonnet-5-5", "medium"),
        "p6:leaf" => (0, "claude-haiku-4-5-20251001", "low"),
        "p7:leaf" => (0, "gemini-3-pro", "medium"),
        _ => (0, "claude-opus-5-5", "medium"),
    };
    // First run of digits; none means 1. Too big for usize is out of every table anyway.
    let digits: String = agent_id
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    let n = if digits.is_empty() {
        1
    } else {
        digits.parse::<usize>().unwrap_or(usize::MAX)
    };
    let pick = |t: [i64; 8], fallback: i64| t.get(n).copied().unwrap_or(fallback);
    let days = pick([0, 40, 9, 2, 21, 60, 5, 30], 1);
    let stats = AgentStats {
        instructions: pick([0, 142, 37, 8, 64, 211, 19, 90], 10),
        instructions_today: pick([0, 12, 5, 2, 7, 18, 3, 4], 1),
        tool_calls: pick([0, 1840, 402, 77, 690, 2650, 230, 512], 50),
        tool_calls_today: pick([0, 160, 44, 12, 70, 210, 31, 25], 5),
        subagents: pick([0, 31, 4, 0, 9, 44, 2, 6], 0),
        hired_at: Some(iso(start - days * 86_400_000)),
    };
    (subagents_running, model, effort, stats)
}

/// The departments of the demo office.
pub fn demo_org() -> OrgChart {
    let dept = |id: &str, name: &str, theme, repo: &str| Department {
        id: id.into(),
        name: name.into(),
        theme,
        repo_ids: vec![repo.into()],
    };
    OrgChart {
        departments: vec![
            dept(
                "d-dev",
                "쇼핑 개발팀",
                DepartmentTheme::Dev,
                "demo-shop-web",
            ),
            dept("d-ops", "플랫폼팀", DepartmentTheme::Ops, "demo-api-server"),
            dept("d-doc", "기획·문서팀", DepartmentTheme::Design, "demo-docs"),
        ],
    }
}

pub struct DemoOptions {
    /// Where `office-desks-demo/` goes (Node `os.tmpdir()`).
    pub tmp_dir: PathBuf,
    /// Fixed clock in epoch ms; None is the wall clock.
    pub epoch: Option<i64>,
    pub verify: Option<SessionVerifier>,
    pub windows: bool,
}

impl DemoOptions {
    /// Temp dir and `OFFICE_DESKS_DEMO_EPOCH` from an env map.
    pub fn from_env(env: &EnvMap, verify: Option<SessionVerifier>) -> Self {
        Self {
            tmp_dir: os_tmpdir(env),
            epoch: parse_epoch(env.get(DEMO_EPOCH_ENV).map(String::as_str)),
            verify,
            windows: cfg!(windows),
        }
    }
}

/// Files the server needs for the demo.
#[derive(Debug, Clone, PartialEq)]
pub struct DemoServerFiles {
    pub awards_file: PathBuf,
    /// Not written: the demo org lives in `default_org`.
    pub org_file: PathBuf,
    pub default_org: OrgChart,
}

/// `npm run demo`: the Orca backend over a fake Orca, plus the data real transcripts and git
/// would add.
pub struct DemoBackend {
    inner: OrcaBackend,
    capabilities: BackendCapabilities,
    messages: BackendMessages,
    start: i64,
    tmp_dir: PathBuf,
}

impl DemoBackend {
    /// Writes the demo transcripts under `<tmp_dir>/office-desks-demo`.
    pub fn new(opts: DemoOptions) -> std::io::Result<Self> {
        let clock = Clock(opts.epoch);
        // TS takes START at module load; here it is taken at construction.
        let start = clock.now();
        let transcripts = write_demo_transcripts(&opts.tmp_dir, start)?;
        let runner = DemoRunner {
            start,
            clock,
            transcripts,
        };
        let inner = OrcaBackend::new(
            Arc::new(runner),
            OrcaOptions {
                verify: opts.verify,
                // Under a fixed epoch the cache TTLs never expire; harmless for a static demo.
                now: Some(Arc::new(move || clock.now())),
                windows: opts.windows,
            },
        );
        Ok(Self {
            inner,
            capabilities: BackendCapabilities {
                usage: true,
                search: false,
                board: false,
                hire: false,
                changes: false,
                transcripts: false,
                focus: false,
                repos: false,
                stop: false,
                remove: false,
            },
            messages: BackendMessages {
                no_session: NO_SESSION.into(),
                hire_disabled: HIRE_DISABLED.into(),
            },
            start,
            tmp_dir: opts.tmp_dir,
        })
    }

    /// The demo START (ms).
    pub fn start(&self) -> i64 {
        self.start
    }

    /// A sample hall of fame; writes `awards.json` under the demo dir.
    pub fn server_files(&self) -> std::io::Result<DemoServerFiles> {
        let dir = demo_dir(&self.tmp_dir);
        std::fs::create_dir_all(&dir)?;
        let day = |n: i64| {
            let ms = self.start - n * 86_400_000;
            let utc = Utc
                .timestamp_millis_opt(ms)
                .single()
                .unwrap_or(DateTime::<Utc>::UNIX_EPOCH);
            local_date(&utc.with_timezone(&Local))
        };
        let win =
            |n: i64, pane: &str, name: &str, repo: &str, instructions: i64, tool_calls: i64| {
                Award {
                    date: day(n),
                    agent_id: format!("{pane}:leaf"),
                    desk_id: format!("demo-{repo}::/demo/{repo}/{name}"),
                    name: name.into(),
                    repo: repo.into(),
                    repo_id: format!("demo-{repo}"),
                    agent_type: "claude".into(),
                    instructions,
                    tool_calls,
                    score: instructions * 10 + tool_calls,
                }
            };
        let board = AwardBoard {
            leader: None,
            hall: vec![
                win(1, "p5", "rate-limit", "api-server", 21, 240),
                win(2, "p1", "shop-web", "shop-web", 17, 198),
                win(3, "p2", "checkout-flow", "shop-web", 12, 130),
                win(4, "p5", "rate-limit", "api-server", 15, 171),
            ],
        };
        let awards_file = dir.join("awards.json");
        std::fs::write(
            &awards_file,
            serde_json::to_string(&board).map_err(std::io::Error::other)?,
        )?;
        Ok(DemoServerFiles {
            awards_file,
            org_file: dir.join("org.json"),
            default_org: demo_org(),
        })
    }
}

#[async_trait]
impl OfficeBackend for DemoBackend {
    fn name(&self) -> &str {
        "demo"
    }

    fn capabilities(&self) -> &BackendCapabilities {
        &self.capabilities
    }

    fn messages(&self) -> &BackendMessages {
        &self.messages
    }

    async fn snapshot(&self) -> Result<OfficeSnapshot, BackendError> {
        let mut s = self.inner.snapshot().await?;
        for a in s.desks.iter_mut().flat_map(|d| d.agents.iter_mut()) {
            let (subagents_running, model, effort, stats) = demo_enrichment(&a.id, self.start);
            a.subagents_running = subagents_running;
            a.model = Some(model.into());
            a.effort = Some(effort.into());
            a.stats = Some(stats);
        }
        for (i, d) in s.desks.iter_mut().enumerate() {
            let i = i as i64;
            d.changes = (!d.agents.is_empty()).then(|| DeskChanges {
                files: i % 4 + 1,
                added: 12 + i * 37,
                deleted: i * 9,
            });
        }
        Ok(s)
    }

    async fn read_screen(&self, handle: &str) -> Result<Vec<String>, BackendError> {
        self.inner.read_screen(handle).await
    }

    async fn send_prompt(&self, handle: &str, text: &str) -> Result<(), BackendError> {
        self.inner.send_prompt(handle, text).await
    }

    async fn retry_prompt(&self, request_id: &str) -> Result<(), BackendError> {
        self.inner.retry_prompt(request_id).await
    }

    fn blocked_handle(&self, request_id: &str) -> Option<String> {
        self.inner.blocked_handle(request_id)
    }

    async fn send_keys(&self, handle: &str, input: KeyInput) -> Result<(), BackendError> {
        self.inner.send_keys(handle, input).await
    }

    async fn focus(&self, handle: &str) -> Result<(), BackendError> {
        self.inner.focus(handle).await
    }

    async fn hire(&self, spec: HireSpec) -> Result<HireResult, BackendError> {
        self.inner.hire(spec).await
    }

    async fn set_board(&self, desk_id: &str, update: BoardUpdate) -> Result<(), BackendError> {
        self.inner.set_board(desk_id, update).await
    }

    async fn find_session(
        &self,
        desk: &OfficeDesk,
        agent: &OfficeAgent,
    ) -> Result<Option<String>, BackendError> {
        self.inner.find_session(desk, agent).await
    }

    fn cached_session(&self, agent_id: &str) -> Option<String> {
        self.inner.cached_session(agent_id)
    }

    async fn search_conversations(
        &self,
        query: &str,
    ) -> Result<Vec<ConversationHit>, BackendError> {
        self.inner.search_conversations(query).await
    }

    async fn usage(&self) -> Result<Option<UsageSnapshot>, BackendError> {
        self.inner.usage().await
    }

    async fn add_repo(&self, repo_path: &str) -> Result<(), BackendError> {
        self.inner.add_repo(repo_path).await
    }

    async fn stop_agent(&self, agent_id: &str) -> Result<(), BackendError> {
        self.inner.stop_agent(agent_id).await
    }

    async fn remove_worktree(&self, desk_id: &str) -> Result<(), BackendError> {
        self.inner.remove_worktree(desk_id).await
    }

    fn hook(&self, agent_id: &str, token: &str, payload: &Value) -> bool {
        self.inner.hook(agent_id, token, payload)
    }

    async fn dispose(&self) {
        self.inner.dispose().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use od_core::model::CharacterState;

    const EPOCH: i64 = 1_790_856_000_000;

    fn demo_in(dir: &Path) -> DemoBackend {
        DemoBackend::new(DemoOptions {
            tmp_dir: dir.to_path_buf(),
            epoch: Some(EPOCH),
            verify: None,
            windows: false,
        })
        .unwrap()
    }

    fn env(pairs: &[(&str, &str)]) -> EnvMap {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn agent<'a>(s: &'a OfficeSnapshot, id: &str) -> &'a OfficeAgent {
        s.desks
            .iter()
            .flat_map(|d| &d.agents)
            .find(|a| a.id == id)
            .unwrap()
    }

    #[test]
    fn only_offers_what_the_demo_can_fake() {
        let tmp = tempfile::tempdir().unwrap();
        let b = demo_in(tmp.path());
        assert_eq!(b.name(), "demo");
        assert_eq!(
            serde_json::to_value(b.capabilities()).unwrap(),
            json!({
                "usage": true, "search": false, "board": false, "hire": false, "changes": false,
                "transcripts": false, "focus": false, "repos": false, "stop": false, "remove": false
            })
        );
        assert_eq!(b.messages().hire_disabled, "데모 모드에서는 만들 수 없어요");
        assert_eq!(b.messages().no_session, NO_SESSION);
    }

    #[tokio::test]
    async fn fills_model_effort_stats_and_change_counts_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let s = demo_in(tmp.path()).snapshot().await.unwrap();
        let p1 = agent(&s, "p1:leaf");
        assert_eq!(p1.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(p1.effort.as_deref(), Some("xhigh"));
        assert_eq!(p1.subagents_running, 2);
        assert!(p1.stats.as_ref().unwrap().instructions > 0);
        for (i, d) in s.desks.iter().enumerate() {
            if d.agents.is_empty() {
                assert_eq!(d.changes, None, "{}", d.name);
            } else {
                let c = d.changes.as_ref().unwrap();
                assert!(c.files > 0);
                assert_eq!(
                    (c.files, c.added, c.deleted),
                    (i as i64 % 4 + 1, 12 + i as i64 * 37, i as i64 * 9)
                );
            }
        }
        assert_eq!(s.desks.len(), 9);
        let deps = s.desks.iter().find(|d| d.name == "deps-bump").unwrap();
        assert_eq!(deps.changes, None);
    }

    #[tokio::test]
    async fn refuses_stop_and_remove() {
        let tmp = tempfile::tempdir().unwrap();
        let b = demo_in(tmp.path());
        let e = b.stop_agent("p1:leaf").await.unwrap_err();
        assert_eq!(e.code.as_deref(), Some("unsupported"));
        let e = b.remove_worktree("r::/p").await.unwrap_err();
        assert_eq!(e.code.as_deref(), Some("unsupported"));
    }

    #[tokio::test]
    async fn serves_demo_usage_and_a_demo_screen() {
        let tmp = tempfile::tempdir().unwrap();
        let b = demo_in(tmp.path());
        let u = b.usage().await.unwrap().unwrap();
        assert_eq!(u.providers[0].provider, "claude");
        assert!(!b.read_screen("demo_p1").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn fixed_clock_is_deterministic() {
        let tmp = tempfile::tempdir().unwrap();
        let b = demo_in(tmp.path());
        assert_eq!(b.start(), EPOCH);
        let a = b.snapshot().await.unwrap();
        let c = b.snapshot().await.unwrap();
        assert_eq!(a.desks, c.desks);
        assert_eq!(
            agent(&a, "p1:leaf")
                .stats
                .as_ref()
                .unwrap()
                .hired_at
                .as_deref(),
            Some("2026-08-22T12:00:00.000Z")
        );
    }

    #[tokio::test]
    async fn updated_at_follows_the_fixed_epoch() {
        let tmp = tempfile::tempdir().unwrap();
        let b = demo_in(tmp.path());
        assert_eq!(b.snapshot().await.unwrap().updated_at, EPOCH);
        assert_eq!(b.usage().await.unwrap().unwrap().updated_at, EPOCH);
    }

    #[tokio::test]
    async fn tick_zero_states() {
        let tmp = tempfile::tempdir().unwrap();
        let b = demo_in(tmp.path());
        let s = b.snapshot().await.unwrap();
        let p2 = agent(&s, "p2:leaf");
        assert_eq!(p2.state, CharacterState::Waiting);
        assert_eq!(p2.raw_state, "waiting");
        let screen = b.read_screen("demo_p2").await.unwrap();
        assert!(screen[0].starts_with("(demo)"));
        assert!(screen.iter().any(|l| l == "❯ 1. Redis"));
        let p4 = b.read_screen("demo_p4").await.unwrap();
        assert_eq!(p4.last().unwrap(), "  ⏵⏵ auto mode on");
        // p5 waits too at tick 1 only; at tick 0 it works.
        assert_eq!(
            b.read_screen("demo_p5").await.unwrap()[0],
            "(demo) ⏺ 작업 중입니다…"
        );
    }

    #[tokio::test]
    async fn search_finds_the_first_agent_of_a_kind() {
        let tmp = tempfile::tempdir().unwrap();
        let b = demo_in(tmp.path());
        let s = b.snapshot().await.unwrap();
        let desk = s
            .desks
            .iter()
            .find(|d| d.path == "/demo/api-server/rate-limit")
            .unwrap();
        let want = tmp.path().join("office-desks-demo").join("p5.jsonl");
        for id in ["p5:leaf", "p6:leaf"] {
            let a = desk.agents.iter().find(|a| a.id == id).unwrap();
            assert_eq!(a.prompt.as_deref(), Some("Demo task for feat/rate-limit"));
            let got = b.find_session(desk, a).await.unwrap();
            assert_eq!(got.as_deref(), Some(want.to_str().unwrap()), "{id}");
        }
        let text = std::fs::read_to_string(&want).unwrap();
        assert!(text.ends_with('\n'));
        assert_eq!(text.lines().count(), 6);
        assert!(text
            .lines()
            .next()
            .unwrap()
            .starts_with(r#"{"type":"ai-title""#));
    }

    #[test]
    fn transcripts_carry_the_question_only_for_p5_and_p2() {
        let tmp = tempfile::tempdir().unwrap();
        let _ = demo_in(tmp.path());
        let dir = tmp.path().join("office-desks-demo");
        for (pane, lines) in [("p1", 5), ("p2", 6), ("p5", 6), ("p10", 5)] {
            let text = std::fs::read_to_string(dir.join(format!("{pane}.jsonl"))).unwrap();
            assert_eq!(text.lines().count(), lines, "{pane}");
        }
        let first: Value = serde_json::from_str(
            std::fs::read_to_string(dir.join("p1.jsonl"))
                .unwrap()
                .lines()
                .nth(2)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(first["timestamp"], "2026-10-01T11:31:00.000Z");
    }

    #[test]
    fn server_files() {
        let tmp = tempfile::tempdir().unwrap();
        let f = demo_in(tmp.path()).server_files().unwrap();
        assert_eq!(
            f.awards_file,
            tmp.path().join("office-desks-demo").join("awards.json")
        );
        assert_eq!(
            f.org_file,
            tmp.path().join("office-desks-demo").join("org.json")
        );
        let board: AwardBoard =
            serde_json::from_str(&std::fs::read_to_string(&f.awards_file).unwrap()).unwrap();
        assert!(board.leader.is_none());
        let scores: Vec<i64> = board.hall.iter().map(|a| a.score).collect();
        assert_eq!(scores, [450, 368, 250, 321]);
        assert_eq!(f.default_org.departments.len(), 3);
        let raw = std::fs::read_to_string(&f.awards_file).unwrap();
        assert!(raw.starts_with(r#"{"leader":null,"hall":[{"date":""#));
    }

    #[test]
    fn parse_epoch_takes_plain_digits_only() {
        assert_eq!(parse_epoch(Some("1790856000000")), Some(1_790_856_000_000));
        for bad in ["", "0", "1e12", " 1", "-5", "+5", "99999999999999999999"] {
            assert_eq!(parse_epoch(Some(bad)), None, "{bad:?}");
        }
        assert_eq!(parse_epoch(None), None);
    }

    #[test]
    fn os_tmpdir_follows_node() {
        let unix = |e: &EnvMap| os_tmpdir_for(e, false);
        assert_eq!(unix(&env(&[("TMPDIR", "/x/")])), PathBuf::from("/x"));
        assert_eq!(unix(&env(&[("TMPDIR", "/")])), PathBuf::from("/"));
        assert_eq!(
            unix(&env(&[("TMPDIR", ""), ("TMP", "/t")])),
            PathBuf::from("/t")
        );
        assert_eq!(unix(&env(&[("TEMP", "/e")])), PathBuf::from("/e"));
        assert_eq!(unix(&env(&[])), PathBuf::from("/tmp"));
        let win = |e: &EnvMap| os_tmpdir_for(e, true);
        assert_eq!(win(&env(&[("TEMP", "C:\\t\\")])), PathBuf::from("C:\\t"));
        assert_eq!(win(&env(&[("TEMP", "C:\\")])), PathBuf::from("C:\\"));
        assert_eq!(win(&env(&[("TMP", "D:\\x")])), PathBuf::from("D:\\x"));
        assert_eq!(
            win(&env(&[("SystemRoot", "C:\\Windows")])),
            PathBuf::from("C:\\Windows\\temp")
        );
        assert_eq!(
            win(&env(&[("windir", "D:\\W")])),
            PathBuf::from("D:\\W\\temp")
        );
        assert_eq!(win(&env(&[])), std::env::temp_dir());
    }

    #[test]
    fn options_read_the_env() {
        let o = DemoOptions::from_env(&env(&[("TMPDIR", "/s/"), (DEMO_EPOCH_ENV, "123")]), None);
        assert_eq!(o.epoch, Some(123));
        if !cfg!(windows) {
            assert_eq!(o.tmp_dir, PathBuf::from("/s"));
        }
        assert_eq!(
            DemoOptions::from_env(&env(&[(DEMO_EPOCH_ENV, "0")]), None).epoch,
            None
        );
    }

    #[test]
    fn enrichment_falls_back_outside_the_tables() {
        let (n, model, effort, st) = demo_enrichment("p10:leaf", EPOCH);
        assert_eq!((n, model, effort), (0, "claude-opus-5-5", "medium"));
        assert_eq!(
            (
                st.instructions,
                st.instructions_today,
                st.tool_calls,
                st.tool_calls_today,
                st.subagents
            ),
            (10, 1, 50, 5, 0)
        );
        assert_eq!(st.hired_at.as_deref(), Some("2026-09-30T12:00:00.000Z"));
        // No digits means 1.
        assert_eq!(demo_enrichment("x", EPOCH).3.instructions, 142);
    }

    #[test]
    fn worktree_ps_rotates_every_eight_seconds() {
        let ps = worktree_ps(EPOCH, EPOCH + 8000);
        let p1 = &ps["worktrees"][0]["agents"][0];
        assert_eq!(p1["toolName"], "Bash");
        assert_eq!(p1["stateStartedAt"], EPOCH + 8000);
        assert_eq!(ps["worktrees"][0]["status"], "working");
        let faq = &ps["worktrees"][7]["agents"][0];
        assert_eq!(faq["stateStartedAt"], EPOCH - 20 * 60_000);
        assert_eq!(
            faq["lastAssistantMessage"],
            "docs/faq-rewrite 작업을 끝냈습니다. 테스트 통과."
        );
        assert_eq!(
            ps["worktrees"][1]["parentWorktreeId"],
            "demo-shop-web::/demo/shop-web/shop-web"
        );
        assert_eq!(ps["worktrees"][1]["comment"], "결제 플로우 플랜 승인 대기");
        // Before the start the tick is negative; the state index stays in range.
        let early = worktree_ps(EPOCH, EPOCH - 1);
        assert_eq!(early["worktrees"][0]["agents"][0]["state"], "done");
    }
}
