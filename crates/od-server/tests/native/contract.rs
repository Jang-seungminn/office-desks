//! Contract replay: run `tests/contract/steps.json` against the Rust server and compare every
//! recorded step with the fixtures the Node bridge produced (`npm run contract:record`, see
//! `bridge/scripts/contract-record.ts`). The step format, the normalizer and the template rules
//! here mirror the recorder exactly; `normalize-cases.json` pins the normalizer on both sides.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use futures_util::StreamExt;
use libtest_mimic::{Failed, Trial};
use od_core::backend::OfficeBackend;
use od_core::native::env::{find_command, process_env, EnvMap};
use od_server::js::encode_uri_component;
use od_server::{MemAssets, ServerConfig};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::support::{Client, Resp};

/// Groups not replayed yet. Each later task removes its group once its routes exist; removing
/// a group whose earlier groups are still skipped fails on the first missing capture.
pub const SKIP: &[&str] = &["read", "media", "input"];

/// `wsReject` steps also require the natively observed handshake answer to be 403 (on since the
/// `/ws` arm exists, Task 3). When off, a rejected upgrade is reported NOT VERIFIED, never passed.
pub const ASSERT_WS_403: bool = true;

const GROUPS: [&str; 7] = ["guard", "empty", "manage", "hook", "read", "media", "input"];
const HEADER_ALLOWLIST: [&str; 7] = [
    "content-type",
    "cache-control",
    "x-frame-options",
    "x-content-type-options",
    "referrer-policy",
    "cross-origin-resource-policy",
    "content-security-policy",
];
const TIMESTAMP_KEYS: [&str; 4] = ["updatedAt", "since", "lastActivityAt", "resetsAt"];
/// Built-ins that are only used to build requests. `PORT`/`HOST` are covered by the port rule;
/// `REPO`/`NOTREPO` are native-form paths (backslashes on Windows) that the `ROOT` rule covers.
const NOT_NORMALIZED: [&str; 4] = ["PORT", "HOST", "REPO", "NOTREPO"];
const WAIT_FOR_TIMEOUT: Duration = Duration::from_secs(20);
const WAIT_FOR_EVERY: Duration = Duration::from_millis(200);
const WS_TIMEOUT: Duration = Duration::from_secs(10);
const AGENT_EXE: &str = if cfg!(windows) {
    "claude.exe"
} else {
    "claude"
};

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn contract_dir() -> PathBuf {
    manifest_dir().join("tests").join("contract")
}

fn repo_root() -> PathBuf {
    manifest_dir().join("..").join("..")
}

pub fn trials(root: &Path) -> Vec<Trial> {
    let sub = |name: &str| root.join(name);
    let fake = sub("fake_agent_protocol");
    let contract_root = sub("contract");
    let preflight_root = sub("preflight_refuses_other_agents");
    let terminal_root = sub("terminal_matches_fixture");
    vec![
        Trial::test("normalize_cases", normalize_cases),
        Trial::test("harness_units", harness_units),
        Trial::test("preflight_refuses_other_agents", move || {
            preflight_refuses_other_agents(&preflight_root)
        }),
        Trial::test("fake_agent_protocol", move || fake_agent_protocol(&fake)),
        Trial::test("terminal_matches_fixture", move || {
            terminal_matches_fixture(&terminal_root)
        }),
        Trial::test("contract", move || contract(&contract_root)),
    ]
}

// ---------------------------------------------------------------------------------------------
// Normalizer (identical rules in bridge/scripts/contract-record.ts)
// ---------------------------------------------------------------------------------------------

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The forms `ROOT` is matched in: canonical with `/`, with `\`, and macOS's `/var` alias of
/// `/private/var`.
fn root_forms(root: &str) -> Vec<String> {
    let mut forms = vec![root.to_string(), root.replace('/', "\\")];
    if let Some(rest) = root.strip_prefix("/private/") {
        forms.push(format!("/{rest}"));
    }
    forms.dedup();
    forms
}

pub struct Normalizer {
    /// (pattern, placeholder), longest pattern first.
    reps: Vec<(String, String)>,
    port: Option<String>,
}

impl Normalizer {
    pub fn new(vars: &BTreeMap<String, String>) -> Self {
        let mut reps: Vec<(String, String)> = Vec::new();
        for (name, value) in vars {
            if value.is_empty() || NOT_NORMALIZED.contains(&name.as_str()) {
                continue;
            }
            let forms = if name == "ROOT" {
                root_forms(value)
            } else {
                vec![value.clone()]
            };
            for f in forms {
                let enc = encode_uri_component(&f);
                if enc != f {
                    reps.push((enc, format!("${{{name}|uri}}")));
                }
                reps.push((f, format!("${{{name}}}")));
            }
        }
        reps.sort_by(|a, b| {
            utf16_len(&b.0)
                .cmp(&utf16_len(&a.0))
                .then_with(|| a.0.cmp(&b.0))
                .then_with(|| a.1.cmp(&b.1))
        });
        reps.dedup_by(|later, first| later.0 == first.0);
        let port = vars.get("PORT").filter(|p| !p.is_empty()).cloned();
        Normalizer { reps, port }
    }

    pub fn string(&self, s: &str) -> String {
        let mut out = s.to_string();
        for (pattern, placeholder) in &self.reps {
            if out.contains(pattern.as_str()) {
                out = out.replace(pattern.as_str(), placeholder);
            }
        }
        if let Some(port) = &self.port {
            out = port_rule(&out, port);
        }
        if out.contains("${ROOT}") {
            out = out.replace('\\', "/");
        }
        out
    }

    pub fn value(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.string(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.value(x)).collect()),
            Value::Object(m) => {
                let mut out = Map::new();
                for (k, val) in m {
                    let nv = if TIMESTAMP_KEYS.contains(&k.as_str()) && val.is_number() {
                        json!(0)
                    } else if k == "fileId" && val.is_string() {
                        json!("${FILE_ID}")
                    } else {
                        self.value(val)
                    };
                    out.insert(self.string(k), nv);
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }
}

/// `127.0.0.1:<port>` and `localhost:<port>` (not followed by another digit) → `…:${PORT}`.
fn port_rule(s: &str, port: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    'outer: while i < s.len() {
        for prefix in ["127.0.0.1:", "localhost:"] {
            let rest = &s[i..];
            if let Some(after) = rest.strip_prefix(prefix).and_then(|r| r.strip_prefix(port)) {
                if !after.as_bytes().first().is_some_and(u8::is_ascii_digit) {
                    out.push_str(prefix);
                    out.push_str("${PORT}");
                    i += prefix.len() + port.len();
                    continue 'outer;
                }
            }
        }
        let c = s[i..].chars().next().expect("char boundary");
        out.push(c);
        i += c.len_utf8();
    }
    out
}

pub fn normalize(v: &Value, vars: &BTreeMap<String, String>) -> Value {
    Normalizer::new(vars).value(v)
}

static UUID_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").unwrap()
});
static TOKEN_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new("[0-9A-Za-z]+").unwrap());

/// Id shapes in captured values: lowercase UUIDs become `${UUID}`, then every alphanumeric run
/// that is 8 or more lowercase hex digits becomes `${HEX<n>}`. Uppercase hex is left alone, so a
/// format change shows.
pub fn mask_ids(s: &str) -> String {
    let s = UUID_RE.replace_all(s, regex::NoExpand("${UUID}"));
    TOKEN_RE
        .replace_all(&s, |c: &regex::Captures| {
            let t = &c[0];
            if t.len() >= 8
                && t.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                format!("${{HEX{}}}", t.len())
            } else {
                t.to_string()
            }
        })
        .into_owned()
}

fn mask_value(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(mask_ids(s)),
        Value::Array(a) => Value::Array(a.iter().map(mask_value).collect()),
        Value::Object(m) => {
            Value::Object(m.iter().map(|(k, x)| (k.clone(), mask_value(x))).collect())
        }
        other => other.clone(),
    }
}

/// The `captured` record of a step: each value normalized with the variables known before the
/// step plus the step's *other* captures, then id-masked. Pins shapes like
/// `${REPO_ID}::${ROOT}/repo` or `pty_${UUID}`.
pub fn captured_block(
    before: &BTreeMap<String, String>,
    captured: &BTreeMap<String, String>,
) -> Value {
    let mut out = Map::new();
    for (var, value) in captured {
        let mut vars = before.clone();
        for (k, v) in captured {
            if k != var {
                vars.insert(k.clone(), v.clone());
            }
        }
        let s = Normalizer::new(&vars).string(value);
        out.insert(var.clone(), Value::String(mask_ids(&s)));
    }
    Value::Object(out)
}

// ---------------------------------------------------------------------------------------------
// Templates, segments, recording and comparison
// ---------------------------------------------------------------------------------------------

/// `${NAME}` → the value, `${NAME|uri}` → its `encodeURIComponent`. Anything else that starts
/// with `${` stays literal; an unknown NAME is an error.
pub fn expand(s: &str, vars: &BTreeMap<String, String>) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = s;
    while let Some(at) = rest.find("${") {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 2..];
        let parsed = tail.find('}').and_then(|end| {
            let inner = &tail[..end];
            let (name, uri) = match inner.strip_suffix("|uri") {
                Some(n) => (n, true),
                None => (inner, false),
            };
            let valid = name
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            valid.then_some((name, uri, end))
        });
        match parsed {
            Some((name, uri, end)) => {
                let v = vars
                    .get(name)
                    .ok_or_else(|| format!("unknown template variable {name} in {s:?}"))?;
                out.push_str(&if uri {
                    encode_uri_component(v)
                } else {
                    v.clone()
                });
                rest = &tail[end + 1..];
            }
            None => {
                out.push_str("${");
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// Template expansion inside the string values of a JSON body (keys stay as they are).
pub fn expand_json(v: &Value, vars: &BTreeMap<String, String>) -> Result<Value, String> {
    Ok(match v {
        Value::String(s) => Value::String(expand(s, vars)?),
        Value::Array(a) => Value::Array(
            a.iter()
                .map(|x| expand_json(x, vars))
                .collect::<Result<_, _>>()?,
        ),
        Value::Object(m) => {
            let mut out = Map::new();
            for (k, x) in m {
                out.insert(k.clone(), expand_json(x, vars)?);
            }
            Value::Object(out)
        }
        other => other.clone(),
    })
}

/// Follow `segments`: object keys, array indexes, or `{"where": {k: v}}` (the first array element
/// whose fields equal those values).
pub fn resolve<'a>(v: &'a Value, segments: &[Value]) -> Option<&'a Value> {
    let mut cur = v;
    for seg in segments {
        cur = match seg {
            Value::String(k) => cur.as_object()?.get(k)?,
            Value::Number(n) => cur.as_array()?.get(usize::try_from(n.as_u64()?).ok()?)?,
            Value::Object(o) if o.contains_key("contains") => {
                let text = o["contains"].as_str()?;
                cur.as_array()?
                    .iter()
                    .find(|el| el.as_str().is_some_and(|s| s.contains(text)))?
            }
            Value::Object(o) => {
                let want = o.get("where")?.as_object()?;
                cur.as_array()?.iter().find(|el| {
                    want.iter()
                        .all(|(k, x)| el.as_object().and_then(|e| e.get(k)) == Some(x))
                })?
            }
            _ => return None,
        };
    }
    Some(cur)
}

/// `waitFor`: every segment exists, the value is not null, and it equals `equals` if given.
pub fn resolves(v: &Value, segments: &[Value], equals: Option<&Value>) -> bool {
    match resolve(v, segments) {
        Some(x) if !x.is_null() => equals.is_none_or(|e| e == x),
        _ => false,
    }
}

/// The recorded body: empty first, then by content type.
pub fn classify(content_type: &str, body: &[u8]) -> Value {
    if body.is_empty() {
        json!({ "empty": true })
    } else if content_type.starts_with("application/json") {
        match serde_json::from_slice::<Value>(body) {
            Ok(v) => json!({ "json": v }),
            Err(_) => json!({ "invalidJson": String::from_utf8_lossy(body) }),
        }
    } else if content_type.starts_with("text/") {
        json!({ "text": String::from_utf8_lossy(body) })
    } else {
        let hex: String = Sha256::digest(body)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        json!({ "sha256": hex, "len": body.len() })
    }
}

fn record_resp(r: &Resp) -> Value {
    let mut headers = Map::new();
    for name in HEADER_ALLOWLIST {
        let values: Vec<String> = r
            .headers
            .get_all(name)
            .iter()
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
            .collect();
        if !values.is_empty() {
            headers.insert(name.to_string(), Value::String(values.join(", ")));
        }
    }
    let ct = r.header("content-type").unwrap_or("");
    json!({
        "status": r.status.as_u16(),
        "headers": headers,
        "body": classify(ct, &r.body),
    })
}

/// What `compare: "status"` looks at: the status, the body kind and the JSON keys present.
fn status_shape(rec: &Value) -> Value {
    let body = rec.get("body").and_then(Value::as_object);
    let kinds: Vec<&String> = body.map(|b| b.keys().collect()).unwrap_or_default();
    let keys: Vec<&String> = body
        .and_then(|b| b.get("json"))
        .and_then(Value::as_object)
        .map(|o| o.keys().collect())
        .unwrap_or_default();
    json!({ "status": rec.get("status"), "body": kinds, "jsonKeys": keys })
}

pub fn same(expected: &Value, actual: &Value, compare: &str) -> bool {
    if compare == "status" {
        status_shape(expected) == status_shape(actual)
    } else {
        expected == actual
    }
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).expect("json")
}

fn unified(expected: &Value, actual: &Value) -> String {
    let (e, a) = (pretty(expected), pretty(actual));
    similar::TextDiff::from_lines(&e, &a)
        .unified_diff()
        .header("expected (Node fixture)", "actual (Rust)")
        .to_string()
}

// ---------------------------------------------------------------------------------------------
// Steps and fixtures
// ---------------------------------------------------------------------------------------------

struct StepsFile {
    setup: Value,
    steps: Vec<Value>,
}

fn s<'a>(step: &'a Value, key: &str) -> Option<&'a str> {
    step.get(key).and_then(Value::as_str)
}

fn load_steps() -> StepsFile {
    let path = contract_dir().join("steps.json");
    let text = std::fs::read_to_string(&path).expect("steps.json");
    let doc: Value = serde_json::from_str(&text).expect("steps.json is JSON");
    assert_eq!(doc["version"], json!(1), "steps.json version");
    let steps = doc["steps"].as_array().expect("steps[]").clone();
    let mut names = std::collections::HashSet::new();
    let mut last_group = 0;
    for st in &steps {
        let name = s(st, "name").expect("step name");
        assert!(names.insert(name.to_string()), "duplicate step {name}");
        let g = s(st, "group").expect("step group");
        let gi = GROUPS
            .iter()
            .position(|x| *x == g)
            .unwrap_or_else(|| panic!("unknown group {g}"));
        assert!(gi >= last_group, "step {name}: groups out of order");
        last_group = gi;
    }
    StepsFile {
        setup: doc["setup"].clone(),
        steps,
    }
}

fn load_fixture(group: &str) -> Map<String, Value> {
    let path = contract_dir()
        .join("fixtures")
        .join(format!("{group}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. Record the fixtures on macOS with `npm run contract:record`.",
            path.display()
        )
    });
    match serde_json::from_str(&text).expect("fixture JSON") {
        Value::Object(m) => m,
        _ => panic!("{}: not an object", path.display()),
    }
}

// ---------------------------------------------------------------------------------------------
// The scratch world
// ---------------------------------------------------------------------------------------------

struct World {
    /// Canonical, native form.
    root: PathBuf,
    /// `ROOT`: canonical with `/`.
    root_slash: String,
    env: EnvMap,
    upload_dir: PathBuf,
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn write_file(path: &Path, bytes: &[u8]) {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).expect("mkdir");
    }
    std::fs::write(path, bytes).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}

#[cfg(unix)]
fn private_dir(p: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700)).expect("chmod 0700");
}

#[cfg(not(unix))]
fn private_dir(_: &Path) {}

fn git(git: &Path, cwd: &Path, env: &EnvMap, extra: &[(&str, &str)], args: &[&str]) {
    let out = std::process::Command::new(git)
        .args(args)
        .current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .envs(env)
        .envs(extra.iter().copied())
        .output()
        .unwrap_or_else(|e| panic!("git {args:?}: {e}"));
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// The folder that puts git on the scratch PATH. On unix, a symlink `<ROOT>/gitbin/git` to the
/// real git, so whatever else lives next to git (a Homebrew `bin` with `claude` or `codex`) stays
/// off the PATH. On Windows, git's own folder (`Git\cmd` holds only git's launchers).
fn git_bin_dir(root: &Path, git_exe: &Path) -> PathBuf {
    #[cfg(unix)]
    {
        let dir = root.join("gitbin");
        std::fs::create_dir_all(&dir).expect("gitbin");
        std::os::unix::fs::symlink(git_exe, dir.join("git")).expect("git symlink");
        dir
    }
    #[cfg(not(unix))]
    {
        let _ = root;
        git_exe.parent().expect("git dir").to_path_buf()
    }
}

/// The agent binary inside a sub-root: a copy of this test binary.
fn install_agent(root: &Path) -> PathBuf {
    let bin = root.join("bin").join(AGENT_EXE);
    std::fs::create_dir_all(root.join("bin")).expect("bin dir");
    std::fs::copy(std::env::current_exe().expect("current exe"), &bin).expect("copy fake agent");
    bin
}

fn build_world(root: &Path, setup: &Value) -> World {
    std::fs::create_dir_all(root).expect("trial root");
    let root = dunce::canonicalize(root).expect("canonical root");
    let root_slash = path_str(&root).replace('\\', "/");
    for d in ["out", "tmp", "home", "office", "claude"] {
        std::fs::create_dir_all(root.join(d)).expect("scratch dir");
    }
    std::fs::write(root.join("gitconfig"), "").expect("gitconfig");
    install_agent(&root);

    let git_exe = find_command("git", &process_env()).expect("git on the PATH");
    let git_dir = git_bin_dir(&root, &git_exe);
    let mut env = EnvMap::new();
    let path = std::env::join_paths([root.join("bin"), git_dir]).expect("PATH");
    env.insert("PATH".into(), path.to_string_lossy().into_owned());
    if cfg!(windows) {
        let pe = process_env();
        for k in ["SystemRoot", "ComSpec", "PATHEXT"] {
            if let Some(v) = pe.get(k) {
                env.insert(k.into(), v.clone());
            }
        }
    }
    let home = path_str(&root.join("home"));
    let tmp = path_str(&root.join("tmp"));
    for (k, v) in [
        ("HOME", home.clone()),
        ("USERPROFILE", home),
        ("TMPDIR", tmp.clone()),
        ("TMP", tmp.clone()),
        ("TEMP", tmp),
        ("CLAUDE_CONFIG_DIR", path_str(&root.join("claude"))),
        ("OFFICE_DESKS_HOME", path_str(&root.join("office"))),
        ("OFFICE_DESKS_BACKEND", "native".into()),
        ("OD_FAKE_AGENT_OUT", path_str(&root.join("out"))),
        ("GIT_CONFIG_GLOBAL", path_str(&root.join("gitconfig"))),
        ("GIT_CONFIG_NOSYSTEM", "1".into()),
        ("LANG", "C.UTF-8".into()),
    ] {
        env.insert(k.into(), v);
    }

    // The repo: committed with a fixed identity and date, then changed.
    let repo = root.join("repo");
    let rs = &setup["repo"];
    for (f, text) in rs["files"].as_object().expect("repo.files") {
        write_file(&repo.join(f), text.as_str().expect("text").as_bytes());
    }
    git(&git_exe, &repo, &env, &[], &["init", "-q", "-b", "main"]);
    git(
        &git_exe,
        &repo,
        &env,
        &[],
        &["config", "core.autocrlf", "false"],
    );
    git(&git_exe, &repo, &env, &[], &["add", "-A"]);
    let c = &rs["commit"];
    let (name, email, date) = (
        c["name"].as_str().expect("name"),
        c["email"].as_str().expect("email"),
        c["date"].as_str().expect("date"),
    );
    let who = [
        ("GIT_AUTHOR_NAME", name),
        ("GIT_AUTHOR_EMAIL", email),
        ("GIT_AUTHOR_DATE", date),
        ("GIT_COMMITTER_NAME", name),
        ("GIT_COMMITTER_EMAIL", email),
        ("GIT_COMMITTER_DATE", date),
    ];
    let msg = c["message"].as_str().expect("message");
    git(&git_exe, &repo, &env, &who, &["commit", "-q", "-m", msg]);
    for (f, text) in rs["after"].as_object().expect("repo.after") {
        write_file(&repo.join(f), text.as_str().expect("text").as_bytes());
    }

    for (f, text) in setup["files"].as_object().expect("files") {
        write_file(&root.join(f), text.as_str().expect("text").as_bytes());
    }
    for d in setup["dirs"].as_array().expect("dirs") {
        std::fs::create_dir_all(root.join(d.as_str().expect("dir"))).expect("dir");
    }
    let ours = root.join("tmp").join("office-desks-contract");
    let upload_dir = ours.join("uploads");
    std::fs::create_dir_all(&upload_dir).expect("upload dir");
    private_dir(&ours);
    private_dir(&upload_dir);
    for (f, b64) in setup["uploads"].as_object().expect("uploads") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.as_str().expect("base64"))
            .expect("upload base64");
        write_file(&upload_dir.join(f), &bytes);
    }

    World {
        root,
        root_slash,
        env,
        upload_dir,
    }
}

fn preflight_message(name: &str, at: &str) -> String {
    format!("contract: {name} found on the scratch PATH at {at}; refusing to record")
}

/// No agent but our fake `claude` may resolve on the scratch PATH.
fn preflight(env: &EnvMap, root: &Path) -> Result<(), String> {
    let ours = dunce::canonicalize(root.join("bin").join(AGENT_EXE)).expect("fake agent");
    for name in od_core::hire::KNOWN_AGENTS {
        let found = find_command(name, env);
        let at = found
            .as_ref()
            .map(|p| path_str(p))
            .unwrap_or_else(|| "<nowhere>".into());
        let ok = if name == "claude" {
            found.and_then(|p| dunce::canonicalize(p).ok()).as_ref() == Some(&ours)
        } else {
            found.is_none()
        };
        if !ok {
            return Err(preflight_message(name, &at));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Fake-agent PIDs
// ---------------------------------------------------------------------------------------------

fn agent_lines(out: &Path) -> Vec<Value> {
    std::fs::read_to_string(out.join("agents.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn agent_pids(out: &Path) -> Vec<u32> {
    agent_lines(out)
        .iter()
        .filter_map(|l| l["pid"].as_u64().and_then(|p| u32::try_from(p).ok()))
        .collect()
}

/// The executable a live process runs, or None (gone, or not ours to inspect).
#[cfg(target_os = "macos")]
fn pid_exe(pid: u32) -> Option<PathBuf> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: proc_pidpath writes at most `buf.len()` bytes into our buffer.
    let n = unsafe {
        libc::proc_pidpath(
            pid as libc::c_int,
            buf.as_mut_ptr().cast(),
            buf.len() as u32,
        )
    };
    (n > 0).then(|| PathBuf::from(String::from_utf8_lossy(&buf[..n as usize]).into_owned()))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn pid_exe(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(windows)]
fn pid_exe(pid: u32) -> Option<PathBuf> {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: query calls on a handle we open and close here, into our own buffer.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut code = 0u32;
        let alive = GetExitCodeProcess(h, &mut code) != 0 && code == STILL_ACTIVE as u32;
        let mut buf = vec![0u16; 32768];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len) != 0;
        CloseHandle(h);
        (alive && ok).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }
}

/// `pid` is alive and runs our fake agent `exe` (never act on a recycled pid).
fn is_our_agent(pid: u32, exe: &Path) -> bool {
    pid_exe(pid)
        .and_then(|p| dunce::canonicalize(p).ok())
        .is_some_and(|p| p == exe)
}

#[cfg(unix)]
fn kill_pid(pid: u32) {
    // SAFETY: kill(2) on a fake agent this trial started (its pid came from its own line).
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    // SAFETY: terminate a fake agent this trial started, through a handle we close here.
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !h.is_null() {
            TerminateProcess(h, 1);
            CloseHandle(h);
        }
    }
}

/// Kills this trial's own fake agents (the pids in its own `agents.jsonl` whose executable is
/// still its own `bin/claude`) if the trial panics.
struct PidGuard {
    out: PathBuf,
    exe: PathBuf,
}

impl Drop for PidGuard {
    fn drop(&mut self) {
        if std::thread::panicking() {
            for pid in agent_pids(&self.out) {
                if is_our_agent(pid, &self.exe) {
                    kill_pid(pid);
                }
            }
        }
    }
}

/// Windows: desk ids, paths and repo ids use `/` (PLAN Review Focus 4).
fn backslash_desks(v: &Value) -> Vec<String> {
    let mut bad = Vec::new();
    for d in v["desks"].as_array().into_iter().flatten() {
        for k in ["id", "path", "repoId"] {
            if let Some(x) = d[k].as_str().filter(|x| x.contains('\\')) {
                bad.push(format!("desk {k} {x:?} contains a backslash"));
            }
        }
    }
    bad
}

// ---------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------

type Queue = Arc<Mutex<Vec<(Instant, Value)>>>;

struct Ctx {
    client: Client,
    port: u16,
    root: PathBuf,
    out: PathBuf,
    vars: BTreeMap<String, String>,
    sockets: HashMap<String, (Queue, tokio::task::JoinHandle<()>)>,
    started: HashMap<String, Instant>,
    /// What the current step captured.
    captured: BTreeMap<String, String>,
    /// Checks that fail the run without a fixture (Windows desk paths).
    problems: Vec<String>,
}

/// How a `wsReject` handshake ended.
#[derive(Debug, PartialEq)]
enum Handshake {
    /// The connection closed without a byte (what Node does: `socket.destroy()`).
    Destroyed,
    Status(u16),
}

enum Outcome {
    Recorded(Value),
    Unrecorded,
    WsReject(Handshake),
}

impl Ctx {
    fn str_field(&self, step: &Value, key: &str) -> Result<String, String> {
        let raw = s(step, key).ok_or_else(|| format!("missing {key}"))?;
        expand(raw, &self.vars)
    }

    fn capture(&mut self, step: &Value, from: &Value) -> Result<(), String> {
        let Some(cap) = step.get("capture").and_then(Value::as_object) else {
            return Ok(());
        };
        for (var, segs) in cap {
            let segs = segs.as_array().ok_or("capture segments")?;
            let v = resolve(from, segs)
                .and_then(Value::as_str)
                .ok_or_else(|| format!("capture {var}: {segs:?} is not a string"))?;
            self.vars.insert(var.clone(), v.to_string());
            self.captured.insert(var.clone(), v.to_string());
        }
        Ok(())
    }

    async fn run(&mut self, step: &Value) -> Result<Outcome, String> {
        let kind = s(step, "kind").ok_or("missing kind")?;
        match kind {
            "http" => self.http(step).await.map(Outcome::Recorded),
            "waitFor" => self.wait_for(step).await.map(|_| Outcome::Unrecorded),
            "sleep" => {
                let ms = step["ms"].as_u64().ok_or("sleep ms")?;
                tokio::time::sleep(Duration::from_millis(ms)).await;
                Ok(Outcome::Unrecorded)
            }
            "wsOpen" => self.ws_open(step).await.map(Outcome::Recorded),
            "wsExpect" => self.ws_expect(step).await.map(Outcome::Recorded),
            "wsReject" => self.ws_reject(step).await.map(Outcome::WsReject),
            "agentInfo" => self.agent_info().await.map(|_| Outcome::Unrecorded),
            "seedTranscript" => self.seed_transcript(step).map(|_| Outcome::Unrecorded),
            "writeFile" => {
                let path = PathBuf::from(self.str_field(step, "path")?);
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(s(step, "base64").ok_or("base64")?)
                    .map_err(|e| e.to_string())?;
                write_file(&path, &bytes);
                Ok(Outcome::Unrecorded)
            }
            other => Err(format!("unknown step kind {other}")),
        }
    }

    async fn http(&mut self, step: &Value) -> Result<Value, String> {
        let method = s(step, "method").ok_or("method")?.to_string();
        let path = self.str_field(step, "path")?;
        let mut headers: Vec<(String, String)> = Vec::new();
        let mut has_ct = false;
        if let Some(h) = step.get("headers").and_then(Value::as_object) {
            for (k, v) in h {
                if k.eq_ignore_ascii_case("content-type") {
                    has_ct = true;
                }
                if let Some(v) = v.as_str() {
                    headers.push((k.clone(), expand(v, &self.vars)?));
                }
            }
        }
        let body: Option<Vec<u8>> = if let Some(b) = step.get("body") {
            Some(serde_json::to_vec(&expand_json(b, &self.vars)?).map_err(|e| e.to_string())?)
        } else if let Some(r) = s(step, "bodyRaw") {
            Some(expand(r, &self.vars)?.into_bytes())
        } else if let Some(r) = step.get("bodyRepeat") {
            let ch = r["char"].as_str().ok_or("bodyRepeat.char")?;
            let n = r["count"].as_u64().ok_or("bodyRepeat.count")? as usize;
            let text = format!(
                "{}{}{}",
                r["prefix"].as_str().unwrap_or(""),
                ch.repeat(n),
                r["suffix"].as_str().unwrap_or("")
            );
            Some(text.into_bytes())
        } else {
            None
        };
        if body.is_some() && !has_ct {
            headers.push(("content-type".into(), "application/json".into()));
        }
        let hs: Vec<(&str, &str)> = headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let resp = self.client.request(&method, &path, &hs, body).await;
        let rec = record_resp(&resp);
        if cfg!(windows) {
            self.problems.extend(
                backslash_desks(&rec["body"]["json"])
                    .into_iter()
                    .map(|p| format!("{path}: {p}")),
            );
        }
        if step.get("capture").is_some() {
            let body = rec["body"]["json"].clone();
            self.capture(step, &body)?;
        }
        Ok(rec)
    }

    async fn wait_for(&mut self, step: &Value) -> Result<(), String> {
        let segs = step["path"].as_array().ok_or("waitFor path")?.clone();
        let equals = step.get("equals");
        let url = match s(step, "url") {
            Some(u) => expand(u, &self.vars)?,
            None => "/api/snapshot".to_string(),
        };
        let deadline = Instant::now() + WAIT_FOR_TIMEOUT;
        loop {
            let r = self.client.get(&url).await;
            let snap: Value = serde_json::from_slice(&r.body).unwrap_or(Value::Null);
            if resolves(&snap, &segs, equals) {
                if cfg!(windows) {
                    self.problems.extend(
                        backslash_desks(&snap)
                            .into_iter()
                            .map(|p| format!("{url}: {p}")),
                    );
                }
                return self.capture(step, &snap);
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "waitFor {url} {segs:?} did not resolve in {WAIT_FOR_TIMEOUT:?}; last answer:\n{}",
                    pretty(&snap)
                ));
            }
            tokio::time::sleep(WAIT_FOR_EVERY).await;
        }
    }

    async fn ws_open(&mut self, step: &Value) -> Result<Value, String> {
        let id = s(step, "id").ok_or("wsOpen id")?.to_string();
        let count = step["count"].as_u64().ok_or("wsOpen count")? as usize;
        let url = format!("ws://127.0.0.1:{}/ws", self.port);
        let (ws, _) = tokio::time::timeout(WS_TIMEOUT, tokio_tungstenite::connect_async(url))
            .await
            .map_err(|_| "wsOpen: connect timed out".to_string())?
            .map_err(|e| format!("wsOpen: {e}"))?;
        let queue: Queue = Arc::default();
        let q = Arc::clone(&queue);
        let task = tokio::spawn(async move {
            let (_tx, mut rx) = ws.split();
            while let Some(Ok(msg)) = rx.next().await {
                if let tokio_tungstenite::tungstenite::Message::Text(t) = msg {
                    let v = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
                    q.lock().unwrap().push((Instant::now(), v));
                }
            }
        });
        self.sockets.insert(id, (Arc::clone(&queue), task));
        let deadline = Instant::now() + WS_TIMEOUT;
        loop {
            {
                let q = queue.lock().unwrap();
                if q.len() >= count {
                    let msgs: Vec<Value> = q[..count].iter().map(|(_, v)| v.clone()).collect();
                    return Ok(json!({ "messages": msgs }));
                }
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "wsOpen: fewer than {count} messages in {WS_TIMEOUT:?}"
                ));
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn ws_expect(&mut self, step: &Value) -> Result<Value, String> {
        let id = s(step, "id").ok_or("wsExpect id")?;
        let ty = s(step, "type").ok_or("wsExpect type")?;
        let after = s(step, "after").ok_or("wsExpect after")?;
        let since = *self
            .started
            .get(after)
            .ok_or_else(|| format!("wsExpect: step {after} has not run"))?;
        let queue = Arc::clone(&self.sockets.get(id).ok_or("wsExpect: no such socket")?.0);
        let deadline = Instant::now() + WS_TIMEOUT;
        loop {
            let hit = queue
                .lock()
                .unwrap()
                .iter()
                .find(|(t, v)| *t >= since && v["type"] == ty)
                .map(|(_, v)| v.clone());
            if let Some(v) = hit {
                return Ok(json!({ "messages": [v] }));
            }
            if Instant::now() >= deadline {
                return Err(format!("wsExpect: no {ty} message after {after}"));
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// A raw upgrade request; how the server ended the handshake.
    async fn ws_reject(&mut self, step: &Value) -> Result<Handshake, String> {
        let path = self.str_field(step, "path")?;
        let mut req = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n",
            self.port
        );
        if let Some(h) = step.get("headers").and_then(Value::as_object) {
            for (k, v) in h {
                if let Some(v) = v.as_str() {
                    req.push_str(&format!("{k}: {}\r\n", expand(v, &self.vars)?));
                }
            }
        }
        req.push_str("\r\n");
        let io = async {
            let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", self.port)).await?;
            sock.write_all(req.as_bytes()).await?;
            let mut got = Vec::new();
            let mut buf = [0u8; 1024];
            loop {
                let n = sock.read(&mut buf).await?;
                if n == 0 || got.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                got.extend_from_slice(&buf[..n]);
                if got.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            Ok::<_, std::io::Error>(got)
        };
        let got = tokio::time::timeout(WS_TIMEOUT, io)
            .await
            .map_err(|_| "wsReject: no answer".to_string())?
            .map_err(|e| format!("wsReject: {e}"))?;
        if got.is_empty() {
            return Ok(Handshake::Destroyed);
        }
        let head = String::from_utf8_lossy(&got);
        let status = head
            .split(' ')
            .nth(1)
            .and_then(|c| c.parse().ok())
            .ok_or_else(|| format!("wsReject: unreadable answer {head:?}"))?;
        Ok(Handshake::Status(status))
    }

    async fn agent_info(&mut self) -> Result<(), String> {
        let agent = self.vars.get("AGENT").ok_or("agentInfo needs AGENT")?;
        let needle = encode_uri_component(agent);
        let deadline = Instant::now() + WS_TIMEOUT;
        let line = loop {
            let hit = agent_lines(&self.out).into_iter().find(|l| {
                l["hookUrl"]
                    .as_str()
                    .is_some_and(|u| u.contains(needle.as_str()))
            });
            if let Some(l) = hit {
                break l;
            }
            if Instant::now() >= deadline {
                return Err(format!("agentInfo: no agents.jsonl line for {agent}"));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        let url = line["hookUrl"].as_str().unwrap_or("");
        let token = url
            .split_once('?')
            .map(|(_, q)| q)
            .unwrap_or("")
            .split('&')
            .find_map(|kv| kv.strip_prefix("token="))
            .ok_or("agentInfo: hookUrl has no token")?;
        let args: Vec<&str> = line["args"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let sid = args
            .iter()
            .position(|a| *a == "--session-id")
            .and_then(|i| args.get(i + 1))
            .ok_or("agentInfo: no --session-id")?;
        let (token, sid) = (token.to_string(), sid.to_string());
        for (k, v) in [("TOKEN", token), ("SID", sid)] {
            self.vars.insert(k.into(), v.clone());
            self.captured.insert(k.into(), v);
        }
        Ok(())
    }

    fn seed_transcript(&mut self, step: &Value) -> Result<(), String> {
        let sid = self.vars.get("SID").ok_or("seedTranscript needs SID")?;
        let src = repo_root()
            .join("bridge")
            .join("test")
            .join("fixtures")
            .join("claude-rich.jsonl");
        let mut text = std::fs::read_to_string(&src)
            .map_err(|e| format!("{}: {e}", src.display()))?
            .replace("\r\n", "\n");
        if !text.ends_with('\n') {
            text.push('\n');
        }
        for line in step["append"].as_array().into_iter().flatten() {
            text.push_str(&expand(line.as_str().ok_or("append line")?, &self.vars)?);
            text.push('\n');
        }
        let dest = self
            .root
            .join("claude")
            .join("projects")
            .join("scratch")
            .join(format!("{sid}.jsonl"));
        write_file(&dest, text.as_bytes());
        Ok(())
    }
}

#[derive(Default)]
struct Tally {
    passed: usize,
    unverified: Vec<String>,
    failures: Vec<String>,
}

async fn run_steps(ctx: &mut Ctx, steps: &[Value], tally: &mut Tally) -> Result<(), String> {
    let mut fixtures: HashMap<String, Map<String, Value>> = HashMap::new();
    for step in steps {
        let name = s(step, "name").expect("name");
        let group = s(step, "group").expect("group");
        let fixture = fixtures
            .entry(group.to_string())
            .or_insert_with(|| load_fixture(group));
        ctx.started.insert(name.to_string(), Instant::now());
        let before = ctx.vars.clone();
        ctx.captured.clear();
        let outcome = ctx
            .run(step)
            .await
            .map_err(|e| format!("step {name}: {e}"))?;
        for p in ctx.problems.drain(..) {
            println!("  FAIL {name}: {p}");
            tally.failures.push(format!("{name}: {p}"));
        }
        let captured = (!ctx.captured.is_empty()).then(|| captured_block(&before, &ctx.captured));
        let compare = s(step, "compare").unwrap_or("full");
        let actual = match (outcome, captured) {
            (Outcome::Unrecorded, None) => {
                println!("  ok   {name}");
                continue;
            }
            (Outcome::Unrecorded, Some(c)) => {
                // Already normalized: the captured block is not normalized again.
                compare_step(name, fixture, json!({ "captured": c }), compare, tally)?;
                continue;
            }
            (Outcome::Recorded(v), Some(c)) => {
                let mut v = normalize(&v, &ctx.vars);
                v["captured"] = c;
                compare_step(name, fixture, v, compare, tally)?;
                continue;
            }
            (Outcome::Recorded(v), None) => v,
            (Outcome::WsReject(h), _) => {
                if h == Handshake::Status(101) {
                    tally
                        .failures
                        .push(format!("{name}: the server accepted the upgrade (101)"));
                    println!("  FAIL {name}: accepted (101)");
                    continue;
                }
                if !ASSERT_WS_403 {
                    let note = format!(
                        "{name}: NOT VERIFIED (ASSERT_WS_403=false; observed {h:?}, not counted as a pass)"
                    );
                    println!("  ---- {note}");
                    tally.unverified.push(note);
                    continue;
                }
                if h != Handshake::Status(403) {
                    tally
                        .failures
                        .push(format!("{name}: expected a native 403, observed {h:?}"));
                    println!("  FAIL {name}: observed {h:?}");
                    continue;
                }
                json!({ "rejected": true })
            }
        };
        let actual = normalize(&actual, &ctx.vars);
        compare_step(name, fixture, actual, compare, tally)?;
    }
    // Every fully run group's fixture holds exactly its recording steps: stale entries fail.
    for (group, fixture) in &fixtures {
        let want: std::collections::BTreeSet<&str> = steps
            .iter()
            .filter(|st| s(st, "group") == Some(group.as_str()) && records(st))
            .filter_map(|st| s(st, "name"))
            .collect();
        let have: std::collections::BTreeSet<&str> = fixture.keys().map(String::as_str).collect();
        if want != have {
            tally.failures.push(format!(
                "{group}.json keys differ from its recording steps: only in the fixture {:?}, only in steps.json {:?}",
                have.difference(&want).collect::<Vec<_>>(),
                want.difference(&have).collect::<Vec<_>>()
            ));
        }
    }
    Ok(())
}

/// Steps that leave a fixture entry: requests, WebSocket steps and anything that captures.
fn records(step: &Value) -> bool {
    matches!(
        s(step, "kind"),
        Some("http" | "wsOpen" | "wsExpect" | "wsReject" | "agentInfo")
    ) || step.get("capture").is_some()
}

fn compare_step(
    name: &str,
    fixture: &Map<String, Value>,
    actual: Value,
    compare: &str,
    tally: &mut Tally,
) -> Result<(), String> {
    let Some(expected) = fixture.get(name) else {
        return Err(format!(
            "step {name}: no fixture entry (re-record with `npm run contract:record`)"
        ));
    };
    if same(expected, &actual, compare) {
        tally.passed += 1;
        println!("  ok   {name}");
    } else {
        println!("  FAIL {name}");
        tally.failures.push(format!(
            "{name} (compare: {compare})\n--- expected\n{}\n--- actual\n{}\n--- diff\n{}",
            pretty(expected),
            pretty(&actual),
            unified(expected, &actual)
        ));
    }
    Ok(())
}

fn contract(sub: &Path) -> Result<(), Failed> {
    let file = load_steps();
    let world = build_world(sub, &file.setup);
    let out = world.root.join("out");
    let exe = dunce::canonicalize(world.root.join("bin").join(AGENT_EXE)).expect("fake agent");
    let _guard = PidGuard {
        out: out.clone(),
        exe: exe.clone(),
    };
    preflight(&world.env, &world.root).map_err(Failed::from)?;

    let skipped: Vec<&str> = GROUPS
        .iter()
        .copied()
        .filter(|g| SKIP.contains(g))
        .collect();
    let steps: Vec<Value> = file
        .steps
        .iter()
        .filter(|st| !SKIP.contains(&s(st, "group").unwrap_or("")))
        .cloned()
        .collect();

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let mut tally = Tally::default();
    let result: Result<(), String> = rt.block_on(async {
        let bound = od_server::bind(0).await.expect("bind");
        assert_ne!(bound.port, 4317, "never the real port");
        let port = bound.port;
        let backend: Arc<dyn OfficeBackend> =
            Arc::new(od_server::native_backend(&world.env, port).await);
        let mut cfg = ServerConfig::from_env(&world.env);
        cfg.commands_home = world.root.join("home");
        cfg.upload_dir = world.upload_dir.clone();
        cfg.org_file = world.root.join("office").join("org.json");
        cfg.awards_file = world.root.join("office").join("awards.json");
        cfg.assets = Arc::new(MemAssets(HashMap::new()));
        let handle = od_server::serve(bound, backend, cfg).await;

        let mut vars = BTreeMap::new();
        vars.insert("ROOT".to_string(), world.root_slash.clone());
        vars.insert("REPO".to_string(), path_str(&world.root.join("repo")));
        vars.insert("NOTREPO".to_string(), path_str(&world.root.join("home")));
        vars.insert("PORT".to_string(), port.to_string());
        vars.insert("HOST".to_string(), format!("127.0.0.1:{port}"));
        let mut ctx = Ctx {
            client: Client::new(port),
            port,
            root: world.root.clone(),
            out: out.clone(),
            vars,
            sockets: HashMap::new(),
            started: HashMap::new(),
            captured: BTreeMap::new(),
            problems: Vec::new(),
        };
        let result = run_steps(&mut ctx, &steps, &mut tally).await;
        for (_, (_, task)) in ctx.sockets.drain() {
            task.abort();
        }
        handle.shutdown().await;
        let pids = agent_pids(&out);
        let deadline = Instant::now() + Duration::from_secs(3);
        while pids.iter().any(|p| is_our_agent(*p, &exe)) {
            if Instant::now() >= deadline {
                panic!("fake agents still alive after shutdown: {pids:?}");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        result
    });
    println!(
        "contract: {} passed, {} not verified, {} failed; skipped groups: {}",
        tally.passed,
        tally.unverified.len(),
        tally.failures.len(),
        if skipped.is_empty() {
            "none".to_string()
        } else {
            skipped.join(", ")
        }
    );
    result.map_err(Failed::from)?;
    if SKIP.is_empty() && !tally.unverified.is_empty() {
        tally.failures.push(format!(
            "nothing is skipped, so nothing may stay unverified: {:?}",
            tally.unverified
        ));
    }
    if tally.failures.is_empty() {
        Ok(())
    } else {
        Err(tally.failures.join("\n\n").into())
    }
}

// ---------------------------------------------------------------------------------------------
// Self-tests of the harness
// ---------------------------------------------------------------------------------------------

fn vars_of(v: &Value) -> BTreeMap<String, String> {
    v.as_object()
        .map(|m| {
            m.iter()
                .map(|(k, x)| (k.clone(), x.as_str().unwrap_or("").to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_cases() -> Result<(), Failed> {
    let text = std::fs::read_to_string(contract_dir().join("normalize-cases.json"))?;
    let cases: Vec<Value> = serde_json::from_str(&text)?;
    let mut bad = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        let mut got = normalize(&c["input"], &vars_of(&c["vars"]));
        if c["mask"] == json!(true) {
            got = mask_value(&got);
        }
        if got != c["output"] {
            bad.push(format!(
                "case {i}: expected {} got {}",
                c["output"],
                serde_json::to_string(&got)?
            ));
        }
    }
    if cases.len() < 8 {
        bad.push(format!("only {} cases", cases.len()));
    }
    if bad.is_empty() {
        Ok(())
    } else {
        Err(bad.join("\n").into())
    }
}

fn harness_units() -> Result<(), Failed> {
    // Segments, including `where`.
    let snap = json!({ "desks": [
        { "id": "m", "isMain": true, "name": "repo", "agents": [] },
        { "id": "w", "isMain": false, "name": "feat1", "agents": [{ "id": "a", "model": null }], "comment": "null" }
    ] });
    let seg = |v: Value| v.as_array().unwrap().clone();
    assert_eq!(
        resolve(&snap, &seg(json!(["desks", 0, "id"]))),
        Some(&json!("m"))
    );
    assert_eq!(
        resolve(
            &snap,
            &seg(json!(["desks", {"where": {"name": "feat1"}}, "agents", 0, "id"]))
        ),
        Some(&json!("a"))
    );
    assert_eq!(
        resolve(
            &snap,
            &seg(json!(["desks", {"where": {"isMain": true}}, "id"]))
        ),
        Some(&json!("m"))
    );
    assert_eq!(
        resolve(&snap, &seg(json!(["desks", {"where": {"name": "x"}}]))),
        None
    );
    assert_eq!(resolve(&snap, &seg(json!(["desks", 5]))), None);
    assert_eq!(resolve(&snap, &seg(json!(["desks", "0"]))), None);
    // `resolves`: null is unresolved; `equals` is deep equality.
    let model = seg(json!(["desks", {"where": {"name": "feat1"}}, "agents", 0, "model"]));
    assert!(!resolves(&snap, &model, None));
    let comment = seg(json!(["desks", 1, "comment"]));
    assert!(resolves(&snap, &comment, None));
    assert!(resolves(&snap, &comment, Some(&json!("null"))));
    assert!(!resolves(&snap, &comment, Some(&Value::Null)));
    assert!(resolves(
        &snap,
        &seg(json!(["desks", 1, "agents"])),
        Some(&json!([{ "id": "a", "model": null }]))
    ));
    assert!(resolves(&snap, &seg(json!(["desks", 0, "agents"])), None));

    // `contains` picks the first string element containing the text.
    let screen = json!({ "lines": ["FAKE AGENT READY", "got:hello", "got:hello again"] });
    assert_eq!(
        resolve(&screen, &seg(json!(["lines", {"contains": "got:hello"}]))),
        Some(&json!("got:hello"))
    );
    assert_eq!(
        resolve(&screen, &seg(json!(["lines", {"contains": "got:x"}]))),
        None
    );

    // Id masks and the captured block.
    assert_eq!(
        mask_ids("pty_6f1c2d3e-aaaa-4bbb-8ccc-0123456789ab and 6f1c2d3e-aaaa-4bbb-8ccc-0123456789ab:main"),
        "pty_${UUID} and ${UUID}:main"
    );
    assert_eq!(
        mask_ids("0123456789abcdef0123456789abcdef feat1 1234567 deadBEEF00 a1b2c3d4"),
        "${HEX32} feat1 1234567 deadBEEF00 ${HEX8}"
    );
    let mut before = BTreeMap::new();
    before.insert("ROOT".to_string(), "/r/odc".to_string());
    let mut cap = BTreeMap::new();
    cap.insert(
        "MAIN_DESK".to_string(),
        "0a1b2c3d4e5f::/r/odc/repo".to_string(),
    );
    cap.insert("REPO_ID".to_string(), "0a1b2c3d4e5f".to_string());
    assert_eq!(
        captured_block(&before, &cap),
        json!({ "MAIN_DESK": "${REPO_ID}::${ROOT}/repo", "REPO_ID": "${HEX12}" })
    );

    // Templates.
    let mut vars = BTreeMap::new();
    vars.insert("AGENT".to_string(), "u-1:main".to_string());
    vars.insert("ROOT".to_string(), "/r o".to_string());
    assert_eq!(
        expand("/hook/${AGENT|uri}?p=${ROOT|uri}%2Fx&a=${AGENT}", &vars).unwrap(),
        "/hook/u-1%3Amain?p=%2Fr%20o%2Fx&a=u-1:main"
    );
    assert_eq!(
        expand("cost: ${ 1 } $5 ${", &vars).unwrap(),
        "cost: ${ 1 } $5 ${"
    );
    assert!(expand("${NOPE}", &vars).is_err());
    assert_eq!(
        expand_json(
            &json!({ "path": "${ROOT}/a", "n": 1, "k${ROOT}": ["${AGENT}"] }),
            &vars
        )
        .unwrap(),
        json!({ "path": "/r o/a", "n": 1, "k${ROOT}": ["u-1:main"] })
    );

    // Body classification: empty first.
    assert_eq!(classify("application/json", b""), json!({ "empty": true }));
    assert_eq!(
        classify("application/json", b"{\"a\":1}"),
        json!({ "json": { "a": 1 } })
    );
    assert_eq!(
        classify("text/plain; charset=utf-8", "hé".as_bytes()),
        json!({ "text": "hé" })
    );
    assert_eq!(
        classify("image/png", b"abc"),
        json!({ "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "len": 3 })
    );

    // `compare: "status"`: status, body kind and JSON keys only.
    let a = json!({ "status": 400, "headers": {}, "body": { "json": { "error": "Unexpected token" } } });
    let b = json!({ "status": 400, "headers": { "x": "y" }, "body": { "json": { "error": "expected value" } } });
    let c =
        json!({ "status": 400, "headers": {}, "body": { "json": { "error": "x", "code": "c" } } });
    let d = json!({ "status": 502, "headers": {}, "body": { "json": { "error": "x" } } });
    assert!(same(&a, &b, "status"));
    assert!(!same(&a, &b, "full"));
    assert!(!same(&a, &c, "status"));
    assert!(!same(&a, &d, "status"));

    // The port rule only touches loopback URLs.
    assert_eq!(
        port_rule(
            "127.0.0.1:4318/x localhost:4318 4318 127.0.0.1:43180",
            "4318"
        ),
        "127.0.0.1:${PORT}/x localhost:${PORT} 4318 127.0.0.1:43180"
    );
    Ok(())
}

/// Only our fake `claude` may resolve: another agent on the scratch PATH stops the run.
fn preflight_refuses_other_agents(sub: &Path) -> Result<(), Failed> {
    std::fs::create_dir_all(sub)?;
    let sub = dunce::canonicalize(sub)?;
    install_agent(&sub);
    let mut env = EnvMap::new();
    env.insert("PATH".into(), path_str(&sub.join("bin")));
    if cfg!(windows) {
        env.insert("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into());
    }
    preflight(&env, &sub).map_err(Failed::from)?;

    let codex = sub
        .join("bin")
        .join(if cfg!(windows) { "codex.exe" } else { "codex" });
    std::fs::copy(sub.join("bin").join(AGENT_EXE), &codex)?;
    let err = preflight(&env, &sub).expect_err("a codex on the PATH must stop the run");
    let want = preflight_message("codex", &path_str(&codex));
    if err != want {
        return Err(format!("got {err:?}, want {want:?}").into());
    }
    std::fs::remove_file(&codex)?;

    // A `claude` that is not ours (another folder earlier on the PATH) stops it too.
    let other = sub.join("other");
    std::fs::create_dir_all(&other)?;
    std::fs::copy(sub.join("bin").join(AGENT_EXE), other.join(AGENT_EXE))?;
    let path = std::env::join_paths([other.clone(), sub.join("bin")])?;
    env.insert("PATH".into(), path.to_string_lossy().into_owned());
    let err = preflight(&env, &sub).expect_err("a foreign claude must stop the run");
    if !err.starts_with("contract: claude found on the scratch PATH at ") {
        return Err(format!("got {err:?}").into());
    }
    Ok(())
}

/// The fake agent's first screen through the real `PtyHost` (ConPTY on Windows) matches what
/// the Node bridge recorded for `read-terminal`: the same lines, 40 rows.
fn terminal_matches_fixture(sub: &Path) -> Result<(), Failed> {
    use od_core::native::pty_host::{PtyHost, PtyOptions};

    let fixture = load_fixture("read");
    let want: Vec<String> = fixture["read-terminal"]["body"]["json"]["lines"]
        .as_array()
        .ok_or("read-terminal lines")?
        .iter()
        .map(|l| l.as_str().unwrap_or("").to_string())
        .collect();
    if want.len() != 40 {
        return Err(format!("read-terminal has {} lines, expected 40", want.len()).into());
    }
    std::fs::create_dir_all(sub)?;
    let sub = dunce::canonicalize(sub)?;
    let bin = install_agent(&sub);
    let exe = dunce::canonicalize(&bin)?;
    let out = sub.join("out");
    let _guard = PidGuard {
        out: out.clone(),
        exe: exe.clone(),
    };
    let mut env = process_env();
    env.insert("OD_FAKE_AGENT_OUT".into(), path_str(&out));
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async {
        let host = PtyHost::new();
        host.spawn(
            "t1",
            PtyOptions {
                file: path_str(&bin),
                args: vec!["--session-id".into(), "s-1".into()],
                cwd: sub.clone(),
                env,
                cols: None,
                rows: None,
            },
        )
        .map_err(|e| e.message)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut got = host.screen_lines("t1");
        while got != want && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
            got = host.screen_lines("t1");
        }
        // The pid check the guards rely on: ours while it runs, not after.
        let pid = host.pid("t1").ok_or("no pid")?;
        if !is_our_agent(pid, &exe) {
            return Err(format!(
                "pid {pid} not recognized as our fake agent ({:?})",
                pid_exe(pid)
            ));
        }
        host.dispose().await;
        if is_our_agent(pid, &exe) {
            return Err(format!("pid {pid} still our agent after dispose"));
        }
        if got == want {
            Ok(())
        } else {
            Err(format!(
                "PtyHost screen differs from the Node fixture\n{}",
                similar::TextDiff::from_lines(&want.join("\n"), &got.join("\n"))
                    .unified_diff()
                    .header("Node read-terminal", "PtyHost")
            ))
        }
    })
    .map_err(Failed::from)
}

/// The fake agent's protocol over plain pipes (raw mode is a no-op there).
fn fake_agent_protocol(sub: &Path) -> Result<(), Failed> {
    use std::io::{Read, Write};
    use std::process::{Child, Command, Stdio};

    struct KillOnDrop(Child);
    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            // Our own child, by handle; reaped by wait.
            if let Ok(None) = self.0.try_wait() {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }

    std::fs::create_dir_all(sub)?;
    let sub = dunce::canonicalize(sub)?;
    let bin = install_agent(&sub);
    let out = sub.join("out");
    let hook = "http://127.0.0.1:1/hook/a%3Amain?token=t0";
    let mut child = KillOnDrop(
        Command::new(&bin)
            .args(["--session-id", "s-1", "--settings", "x.json"])
            .env("OD_FAKE_AGENT_OUT", &out)
            .env("OFFICE_DESKS_HOOK_URL", hook)
            .current_dir(&sub)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?,
    );
    let mut stdin = child.0.stdin.take().expect("stdin");
    let mut stdout = child.0.stdout.take().expect("stdout");
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let reader = std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        while let Ok(n) = stdout.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut seen: Vec<u8> = Vec::new();
    let mut wait_for = |want: &str| -> Result<(), Failed> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !String::from_utf8_lossy(&seen).contains(want) {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(b) => seen.extend(b),
                Err(_) => {
                    return Err(format!(
                        "fake agent: no {want:?}; output so far {:?}",
                        String::from_utf8_lossy(&seen)
                    )
                    .into())
                }
            }
        }
        Ok(())
    };
    wait_for(&format!(
        "FAKE AGENT READY\r\n{}",
        crate::fake_agent::COMPOSER
    ))?;
    stdin.write_all(b"\x1b[?1;2c")?;
    stdin.flush()?;
    wait_for("in:\"\\u{1b}[?1;2c\"\r\n")?;
    stdin.write_all(b"\r")?;
    stdin.flush()?;
    wait_for("got:\x1b[?1;2c\r\n")?;
    stdin.write_all(b"hello\r\x1b[200~pasted\x1b[201~\rquery\rmenu\rexit\r")?;
    stdin.flush()?;
    let status = child.0.wait()?;
    drop(stdin);
    reader.join().expect("reader");
    for b in rx.try_iter() {
        seen.extend(b);
    }
    let all = String::from_utf8_lossy(&seen).into_owned();
    let expected = format!(
        "FAKE AGENT READY\r\n{}in:\"\\u{{1b}}[?1;2c\"\r\ngot:\x1b[?1;2c\r\ngot:hello\r\ngot:pasted\r\n\x1b[c{}bye\r\n",
        crate::fake_agent::COMPOSER,
        crate::fake_agent::MENU
    );
    if all != expected {
        return Err(format!("fake agent output {all:?}, expected {expected:?}").into());
    }
    if status.code() != Some(3) {
        return Err(format!("fake agent exit {status:?}, expected 3").into());
    }
    let lines = agent_lines(&out);
    let [line] = lines.as_slice() else {
        return Err(format!("agents.jsonl: {lines:?}").into());
    };
    let cwd = dunce::canonicalize(line["cwd"].as_str().unwrap_or(""))?;
    let want = json!({
        "pid": child.0.id(),
        "hookUrl": hook,
        "args": ["--session-id", "s-1", "--settings", "x.json"],
        "cwd": line["cwd"],
    });
    if *line != want || cwd != sub {
        return Err(format!(
            "agents.jsonl line {line}, expected {want} in {}",
            sub.display()
        )
        .into());
    }
    // The key order the recorder and later tasks read.
    let raw = std::fs::read_to_string(out.join("agents.jsonl"))?;
    if !raw.starts_with("{\"pid\":") {
        return Err(format!("agents.jsonl key order: {raw}").into());
    }
    Ok(())
}
