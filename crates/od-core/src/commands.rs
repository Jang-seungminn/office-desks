//! Slash commands an agent's TUI accepts. Port of `bridge/src/commands.ts`.
//!
//! The agent's built-ins plus user/project/plugin commands and skills found on disk, used for
//! `/` autocomplete in the web compose box. The home folder is injectable; file access is
//! synchronous (use `spawn_blocking` from async code).

use std::collections::{HashMap, HashSet};
use std::fs::FileType;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::jsstr;
use crate::model::{SlashCommand, SlashSource};
use crate::state_mapper::locale_cmp;

const CLAUDE_BUILTINS: [(&str, &str); 24] = [
    ("add-dir", "Add a working directory"),
    ("agents", "Manage subagents"),
    ("clear", "Clear conversation history"),
    ("compact", "Compact the conversation"),
    ("config", "Open settings"),
    ("context", "Show context usage"),
    ("cost", "Show token cost"),
    ("doctor", "Check installation health"),
    ("exit", "Exit Claude Code"),
    ("export", "Export the conversation"),
    ("help", "Show help"),
    ("hooks", "Manage hooks"),
    ("init", "Create a CLAUDE.md for this project"),
    ("mcp", "Manage MCP servers"),
    ("memory", "Edit memory files"),
    ("model", "Choose the model"),
    ("permissions", "Manage tool permissions"),
    ("plugin", "Manage plugins"),
    ("resume", "Resume a previous conversation"),
    ("review", "Review a pull request"),
    ("rewind", "Rewind the conversation or code"),
    ("status", "Show status"),
    ("usage", "Show plan usage limits"),
    ("vim", "Toggle vim mode"),
];

const CODEX_BUILTINS: [(&str, &str); 12] = [
    ("model", "Choose model and reasoning effort"),
    ("approvals", "Choose what Codex can do without asking"),
    ("new", "Start a new chat"),
    ("init", "Create an AGENTS.md"),
    ("compact", "Summarize the conversation"),
    ("diff", "Show git diff"),
    ("mention", "Mention a file"),
    ("status", "Show session status"),
    ("mcp", "List MCP tools"),
    ("review", "Review current changes"),
    ("logout", "Log out"),
    ("quit", "Exit Codex"),
];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FrontMatter {
    pub name: Option<String>,
    pub description: Option<String>,
}

/// JS-compatible pieces for the regexes below: `\s` is `S`, `\S` is `NS`, `.` is `DOT`.
const S: &str = r"(?:[\s--\x{85}]|\x{FEFF})";
const NS: &str = r"(?:[^\s\x{FEFF}]|\x{85})";
const DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

fn re(cell: &'static OnceLock<Regex>, pattern: String) -> &'static Regex {
    cell.get_or_init(|| Regex::new(&pattern).expect("regex"))
}

/// `text.split(/\r?\n/)`
fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

/// `value.replace(/^(['"])(.*)\1$/, '$2')`
fn unquote(value: &str) -> String {
    let mut chars = value.chars();
    if let (Some(q @ ('\'' | '"')), Some(last)) = (chars.next(), value.chars().next_back()) {
        if value.chars().count() >= 2 && last == q {
            let inner = &value[q.len_utf8()..value.len() - q.len_utf8()];
            if !inner.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
                return inner.to_string();
            }
        }
    }
    value.to_string()
}

/// Pull `name` and `description` out of a Markdown file's YAML front matter (or its first line).
pub fn front_matter(text: &str) -> FrontMatter {
    static BLOCK: OnceLock<Regex> = OnceLock::new();
    static KV: OnceLock<Regex> = OnceLock::new();
    static FOLD: OnceLock<Regex> = OnceLock::new();
    static CONT: OnceLock<Regex> = OnceLock::new();
    static HASHES: OnceLock<Regex> = OnceLock::new();
    let mut out = FrontMatter::default();
    if let Some(m) = re(&BLOCK, r"(?s)^---\r?\n(.*?)\r?\n---".to_string()).captures(text) {
        let lines = split_lines(m.get(1).map_or("", |g| g.as_str()));
        let kv = re(&KV, format!(r"^(name|description):{S}*({DOT}*)$"));
        let fold = re(&FOLD, r"^[>|][-+]?$".to_string());
        let cont = re(&CONT, format!(r"^{S}+{NS}"));
        let mut i = 0;
        while i < lines.len() {
            if let Some(c) = kv.captures(lines[i]) {
                let mut value = jsstr::trim(&c[2]).to_string();
                if fold.is_match(&value) {
                    // Folded/literal block: take the indented lines that follow.
                    let mut block = Vec::new();
                    while i + 1 < lines.len() && cont.is_match(lines[i + 1]) {
                        i += 1;
                        block.push(jsstr::trim(lines[i]));
                    }
                    value = block.join(" ");
                }
                let value = unquote(&value);
                if &c[1] == "name" {
                    out.name = Some(value);
                } else {
                    out.description = Some(value);
                }
            }
            i += 1;
        }
    } else if let Some(first) = split_lines(text)
        .into_iter()
        .find(|l| !jsstr::trim(l).is_empty())
    {
        let hashes = re(&HASHES, format!(r"^#+{S}*"));
        out.description = Some(jsstr::trim(&hashes.replace(first, "")).to_string());
    }
    out
}

/// Entries of a folder as (name, file type), sorted by name. A missing folder is empty.
fn safe_readdir(dir: &Path) -> Vec<(String, FileType)> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut v: Vec<_> = rd
        .flatten()
        .filter_map(|e| {
            Some((
                e.file_name().to_string_lossy().into_owned(),
                e.file_type().ok()?,
            ))
        })
        .collect();
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v
}

/// The first 4000 characters of a file (UTF-16 units), or "" if it can't be read.
fn read_head(file: &Path) -> String {
    match std::fs::read(file) {
        Ok(b) => jsstr::slice_utf16(&String::from_utf8_lossy(&b), 4000).to_string(),
        Err(_) => String::new(),
    }
}

/// `commands/foo.md` is foo, `commands/git/push.md` is git:push.
fn scan_commands(dir: &Path, source: SlashSource, prefix: &str) -> Vec<SlashCommand> {
    let mut out = Vec::new();
    for (name, ty) in safe_readdir(dir) {
        let full = dir.join(&name);
        if ty.is_dir() {
            out.extend(scan_commands(&full, source, &format!("{prefix}{name}:")));
        } else if let Some(stem) = name.strip_suffix(".md") {
            let fm = front_matter(&read_head(&full));
            out.push(SlashCommand {
                name: format!("{prefix}{stem}"),
                description: fm.description.unwrap_or_default(),
                source,
            });
        }
    }
    out
}

/// `skills/<dir>/SKILL.md` is its front-matter name (or the dir name).
fn scan_skills(dir: &Path, source: SlashSource, prefix: &str) -> Vec<SlashCommand> {
    let mut out = Vec::new();
    for (name, ty) in safe_readdir(dir) {
        if !ty.is_dir() && !ty.is_symlink() {
            continue;
        }
        let text = read_head(&dir.join(&name).join("SKILL.md"));
        if text.is_empty() {
            continue;
        }
        let fm = front_matter(&text);
        let shown = fm.name.filter(|n| !n.is_empty()).unwrap_or(name);
        out.push(SlashCommand {
            name: format!("{prefix}{shown}"),
            description: fm.description.unwrap_or_default(),
            source,
        });
    }
    out
}

/// A JSON object whose entries keep file order (JS `Object.entries` order for plain keys).
struct Ordered(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Ordered;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Ordered, A::Error> {
                let mut v: Vec<(String, Value)> = Vec::new();
                while let Some((k, val)) = m.next_entry::<String, Value>()? {
                    // Duplicate keys: last value wins, position of the first (like a JS object).
                    match v.iter_mut().find(|(ek, _)| *ek == k) {
                        Some(e) => e.1 = val,
                        None => v.push((k, val)),
                    }
                }
                Ok(Ordered(v))
            }
        }
        d.deserialize_map(V)
    }
}

#[derive(Deserialize)]
struct Installed {
    plugins: Option<Ordered>,
}

struct Plugin {
    name: String,
    dir: PathBuf,
}

/// Installed Claude plugins that are not switched off in settings. Anything malformed means
/// none, like the TS `catch`.
fn enabled_plugins(home: &Path) -> Vec<Plugin> {
    let read = || -> Option<Vec<Plugin>> {
        let text =
            std::fs::read_to_string(home.join(".claude/plugins/installed_plugins.json")).ok()?;
        let installed: Installed = serde_json::from_str(&text).ok()?;
        // No settings: treat installed as enabled.
        let enabled: HashMap<String, Value> =
            std::fs::read_to_string(home.join(".claude/settings.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|s| s.get("enabledPlugins").and_then(Value::as_object).cloned())
                .map(|m| m.into_iter().collect())
                .unwrap_or_default();
        let mut out = Vec::new();
        for (id, entries) in installed.plugins.map_or_else(Vec::new, |o| o.0) {
            if enabled.get(&id) == Some(&Value::Bool(false)) {
                continue;
            }
            let last = match &entries {
                Value::Array(a) => a.last(),
                Value::String(_) => None,
                // `.at` is not a function: the TS throws and the whole list is empty.
                _ => return None,
            };
            let install = last
                .and_then(|l| l.get("installPath"))
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty());
            if let Some(dir) = install {
                out.push(Plugin {
                    name: id.split('@').next().unwrap_or("").to_string(),
                    dir: PathBuf::from(dir),
                });
            }
        }
        Some(out)
    };
    read().unwrap_or_default()
}

/// First one wins per name; sorted like `localeCompare`.
fn dedupe(list: Vec<SlashCommand>) -> Vec<SlashCommand> {
    let mut seen = HashSet::new();
    let mut out: Vec<_> = list
        .into_iter()
        .filter(|c| seen.insert(c.name.clone()))
        .collect();
    out.sort_by(|a, b| locale_cmp(&a.name, &b.name));
    out
}

fn builtins(list: &[(&str, &str)]) -> Vec<SlashCommand> {
    list.iter()
        .map(|(name, description)| SlashCommand {
            name: (*name).into(),
            description: (*description).into(),
            source: SlashSource::Builtin,
        })
        .collect()
}

/// The commands `agent_type` accepts in `project_path`, with `home` standing in for `~`.
/// Unknown agent types have none.
pub fn list_commands(agent_type: &str, project_path: &Path, home: &Path) -> Vec<SlashCommand> {
    if agent_type == "codex" {
        let mut all = builtins(&CODEX_BUILTINS);
        all.extend(
            scan_commands(&home.join(".codex/prompts"), SlashSource::User, "")
                .into_iter()
                .map(|c| SlashCommand {
                    name: format!("prompts:{}", c.name),
                    ..c
                }),
        );
        return dedupe(all);
    }
    if agent_type != "claude" {
        return Vec::new();
    }
    let mut all = builtins(&CLAUDE_BUILTINS);
    let project = project_path.join(".claude");
    let user = home.join(".claude");
    all.extend(scan_commands(
        &project.join("commands"),
        SlashSource::Project,
        "",
    ));
    all.extend(scan_skills(
        &project.join("skills"),
        SlashSource::Project,
        "",
    ));
    all.extend(scan_commands(&user.join("commands"), SlashSource::User, ""));
    all.extend(scan_skills(&user.join("skills"), SlashSource::User, ""));
    for p in enabled_plugins(home) {
        let prefix = format!("{}:", p.name);
        all.extend(scan_commands(
            &p.dir.join("commands"),
            SlashSource::Plugin,
            &prefix,
        ));
        all.extend(scan_skills(
            &p.dir.join("skills"),
            SlashSource::Plugin,
            &prefix,
        ));
    }
    dedupe(all)
}

type Clock = Box<dyn Fn() -> i64 + Send + Sync>;
type Cache = Mutex<HashMap<String, (i64, Arc<Vec<SlashCommand>>)>>;

/// Small TTL cache so typing `/` doesn't rescan the disk every keystroke.
pub struct CommandCatalog {
    ttl_ms: i64,
    home: PathBuf,
    clock: Clock,
    cache: Cache,
}

impl CommandCatalog {
    /// 30 s TTL over the user's real home.
    pub fn new() -> Self {
        Self::with(30_000, crate::home::os_home(), Box::new(system_ms))
    }

    /// Everything injected, for tests.
    pub fn with(ttl_ms: i64, home: PathBuf, clock: Clock) -> Self {
        Self {
            ttl_ms,
            home,
            clock,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn get(&self, agent_type: &str, project_path: &Path) -> Arc<Vec<SlashCommand>> {
        let key = format!("{agent_type}|{}", project_path.display());
        let now = (self.clock)();
        {
            let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((at, list)) = cache.get(&key) {
                if now - at < self.ttl_ms {
                    return list.clone();
                }
            }
        }
        // Scan outside the lock so one slow folder doesn't hold up other agents.
        let list = Arc::new(list_commands(agent_type, project_path, &self.home));
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, (now, list.clone()));
        list
    }
}

impl Default for CommandCatalog {
    fn default() -> Self {
        Self::new()
    }
}

fn system_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    fn write(file: impl AsRef<Path>, text: &str) {
        let file = file.as_ref();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }

    fn fm(name: Option<&str>, description: Option<&str>) -> FrontMatter {
        FrontMatter {
            name: name.map(Into::into),
            description: description.map(Into::into),
        }
    }

    // commands.test.ts: frontMatter reads plain, quoted and folded descriptions
    #[test]
    fn front_matter_reads_plain_quoted_and_folded_descriptions() {
        assert_eq!(
            front_matter("---\nname: browse\ndescription: \"Fast browser\"\n---\n"),
            fm(Some("browse"), Some("Fast browser"))
        );
        assert_eq!(
            front_matter("---\nname: x\ndescription: >-\n  line one\n  line two\nother: 1\n---"),
            fm(Some("x"), Some("line one line two"))
        );
        assert_eq!(
            front_matter("# Deploy the app\n\nsteps"),
            fm(None, Some("Deploy the app"))
        );
    }

    #[test]
    fn front_matter_edge_cases() {
        // CRLF, single quotes, literal block, later key wins, empty value is kept as empty.
        assert_eq!(
            front_matter("---\r\nname: 'a b'\r\ndescription: |\r\n  x\r\n  y\r\n---\r\n"),
            fm(Some("a b"), Some("x y"))
        );
        assert_eq!(
            front_matter("---\nname: a\nname: b\n---"),
            fm(Some("b"), None)
        );
        assert_eq!(front_matter("---\nname:\n---"), fm(Some(""), None));
        // Quotes only strip when they match, and a lone quote stays.
        assert_eq!(front_matter("---\nname: \"a'\n---"), fm(Some("\"a'"), None));
        assert_eq!(front_matter("---\nname: \"\n---"), fm(Some("\""), None));
        // `---\n---` has no body line, so it is not front matter: the first line is the description.
        assert_eq!(front_matter("---\n---\nx"), fm(None, Some("---")));
        // First non-blank line, heading marks stripped.
        assert_eq!(
            front_matter("\n  \n##   Title  \nbody"),
            fm(None, Some("Title"))
        );
        assert_eq!(front_matter(""), FrontMatter::default());
        assert_eq!(front_matter("   \n\n"), FrontMatter::default());
        // A key that is not name/description is ignored; indentation matters for the key.
        assert_eq!(
            front_matter("---\n  name: no\nother: 1\n---"),
            FrontMatter::default()
        );
        // Folded block with no indented lines is an empty value.
        assert_eq!(
            front_matter("---\ndescription: >\nname: n\n---"),
            fm(Some("n"), Some(""))
        );
    }

    // commands.test.ts: merges Claude built-ins, user/project commands and skills, and enabled plugin skills
    #[test]
    fn merges_claude_builtins_user_project_commands_and_skills_and_enabled_plugin_skills() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let (home, proj) = (home.path(), proj.path());
        write(
            home.join(".claude/commands/git/push.md"),
            "---\ndescription: Push it\n---",
        );
        write(
            home.join(".claude/skills/browse/SKILL.md"),
            "---\nname: browse\ndescription: Browser\n---",
        );
        write(
            proj.join(".claude/skills/deploy/SKILL.md"),
            "---\nname: deploy\ndescription: Ship\n---",
        );
        let plugin_dir = home.join("plugins/sp");
        write(
            plugin_dir.join("skills/brainstorming/SKILL.md"),
            "---\nname: brainstorming\ndescription: Think\n---",
        );
        write(
            home.join("plugins/off/skills/hidden/SKILL.md"),
            "---\nname: hidden\n---",
        );
        write(
            home.join(".claude/plugins/installed_plugins.json"),
            &serde_json::json!({ "plugins": {
                "superpowers@x": [{ "installPath": plugin_dir }],
                "off@x": [{ "installPath": home.join("plugins/off") }],
            } })
            .to_string(),
        );
        write(
            home.join(".claude/settings.json"),
            r#"{"enabledPlugins":{"off@x":false}}"#,
        );

        let list = list_commands("claude", proj, home);
        let names: Vec<&str> = list.iter().map(|c| c.name.as_str()).collect();
        for want in [
            "compact",
            "config",
            "git:push",
            "browse",
            "deploy",
            "superpowers:brainstorming",
        ] {
            assert!(names.contains(&want), "missing {want}: {names:?}");
        }
        assert!(!names.contains(&"off:hidden"));
        let deploy = list.iter().find(|c| c.name == "deploy").unwrap();
        assert_eq!(
            (deploy.source, deploy.description.as_str()),
            (SlashSource::Project, "Ship")
        );
        let push = list.iter().find(|c| c.name == "git:push").unwrap();
        assert_eq!(
            (push.source, push.description.as_str()),
            (SlashSource::User, "Push it")
        );
        let think = list
            .iter()
            .find(|c| c.name == "superpowers:brainstorming")
            .unwrap();
        assert_eq!(think.source, SlashSource::Plugin);
        // Sorted, and no name twice.
        let mut sorted = list.clone();
        sorted.sort_by(|a, b| locale_cmp(&a.name, &b.name));
        assert_eq!(sorted, list);
        assert_eq!(names.iter().collect::<HashSet<_>>().len(), names.len());
    }

    // commands.test.ts: gives Codex its built-ins and prompts
    #[test]
    fn gives_codex_its_builtins_and_prompts() {
        let home = tempfile::tempdir().unwrap();
        write(
            home.path().join(".codex/prompts/fix.md"),
            "Fix the failing test",
        );
        let list = list_commands("codex", Path::new("/nowhere"), home.path());
        let names: Vec<&str> = list.iter().map(|c| c.name.as_str()).collect();
        for want in ["model", "approvals", "prompts:fix"] {
            assert!(names.contains(&want));
        }
        let fix = list.iter().find(|c| c.name == "prompts:fix").unwrap();
        assert_eq!(
            (fix.source, fix.description.as_str()),
            (SlashSource::User, "Fix the failing test")
        );
        assert_eq!(list.len(), CODEX_BUILTINS.len() + 1);
    }

    #[test]
    fn unknown_agents_have_no_commands_and_a_missing_home_only_builtins() {
        let home = tempfile::tempdir().unwrap();
        assert!(list_commands("gemini", Path::new("/x"), home.path()).is_empty());
        let list = list_commands("claude", Path::new("/nowhere"), &home.path().join("none"));
        assert_eq!(list.len(), CLAUDE_BUILTINS.len());
        assert!(list.iter().all(|c| c.source == SlashSource::Builtin));
    }

    #[test]
    fn earlier_sources_win_and_skills_fall_back_to_the_dir_name() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        // Project commands shadow user ones, and built-ins (listed first) shadow both.
        write(proj.path().join(".claude/commands/same.md"), "from project");
        write(home.path().join(".claude/commands/same.md"), "from user");
        write(proj.path().join(".claude/commands/help.md"), "mine");
        write(
            home.path().join(".claude/skills/dirname/SKILL.md"),
            "---\ndescription: d\n---",
        );
        write(home.path().join(".claude/skills/empty/SKILL.md"), "");
        write(
            home.path().join(".claude/skills/not-a-skill/README.md"),
            "x",
        );
        write(home.path().join(".claude/commands/notes.txt"), "skip");
        let list = list_commands("claude", proj.path(), home.path());
        let same = list.iter().find(|c| c.name == "same").unwrap();
        assert_eq!(
            (same.source, same.description.as_str()),
            (SlashSource::Project, "from project")
        );
        let help = list.iter().find(|c| c.name == "help").unwrap();
        assert_eq!(help.source, SlashSource::Builtin);
        assert!(list
            .iter()
            .any(|c| c.name == "dirname" && c.description == "d"));
        assert!(!list
            .iter()
            .any(|c| c.name == "empty" || c.name == "not-a-skill" || c.name == "notes"));
    }

    #[test]
    fn malformed_plugin_files_mean_no_plugins() {
        let home = tempfile::tempdir().unwrap();
        let plug = home.path().join("p");
        write(plug.join("skills/s/SKILL.md"), "---\nname: s\n---");
        let installed = home.path().join(".claude/plugins/installed_plugins.json");
        let plugins = |json: &str| {
            write(&installed, json);
            enabled_plugins(home.path()).len()
        };
        let p = serde_json::to_string(&plug.to_string_lossy()).unwrap();
        assert_eq!(
            plugins(&format!(
                r#"{{"plugins":{{"a@m":[{{"installPath":{p}}}]}}}}"#
            )),
            1
        );
        assert_eq!(plugins("{ nope"), 0);
        assert_eq!(plugins("null"), 0);
        assert_eq!(plugins("{}"), 0);
        assert_eq!(plugins(r#"{"plugins":[1]}"#), 0);
        // One entry that is not an array poisons the whole list (the TS throws inside its try).
        assert_eq!(
            plugins(&format!(
                r#"{{"plugins":{{"a@m":[{{"installPath":{p}}}],"b@m":{{}}}}}}"#
            )),
            0
        );
        // Strings, empty lists and missing paths are skipped; the last install wins.
        assert_eq!(
            plugins(&format!(
                r#"{{"plugins":{{"a@m":"x","b@m":[],"c@m":[{{}}],"d@m":[{{"installPath":"/old"}},{{"installPath":{p}}}]}}}}"#
            )),
            1
        );
        // Only an explicit false disables.
        write(
            home.path().join(".claude/settings.json"),
            r#"{"enabledPlugins":{"d@m":0}}"#,
        );
        let one = format!(r#"{{"plugins":{{"d@m":[{{"installPath":{p}}}]}}}}"#);
        assert_eq!(plugins(&one), 1);
        write(home.path().join(".claude/settings.json"), "garbage");
        assert_eq!(plugins(&one), 1);
        // The plugin name is the id before '@', and plugins keep file order.
        write(home.path().join(".claude/settings.json"), "{}");
        write(
            &installed,
            &format!(
                r#"{{"plugins":{{"z@m":[{{"installPath":{p}}}],"a@m":[{{"installPath":{p}}}]}}}}"#
            ),
        );
        let names: Vec<_> = enabled_plugins(home.path())
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, ["z", "a"]);
    }

    #[test]
    fn catalog_caches_for_the_ttl() {
        let home = tempfile::tempdir().unwrap();
        let now = Arc::new(AtomicI64::new(1_000));
        let clock = now.clone();
        let cat = CommandCatalog::with(
            30_000,
            home.path().to_path_buf(),
            Box::new(move || clock.load(Ordering::SeqCst)),
        );
        let proj = Path::new("/nowhere");
        write(home.path().join(".codex/prompts/a.md"), "A");
        let first = cat.get("codex", proj);
        assert!(first.iter().any(|c| c.name == "prompts:a"));
        write(home.path().join(".codex/prompts/b.md"), "B");
        now.store(30_999, Ordering::SeqCst);
        assert!(Arc::ptr_eq(&first, &cat.get("codex", proj)));
        assert!(!cat.get("codex", proj).iter().any(|c| c.name == "prompts:b"));
        // Another agent or project is its own entry.
        assert!(cat
            .get("claude", proj)
            .iter()
            .all(|c| c.name != "prompts:a"));
        now.store(31_000, Ordering::SeqCst);
        assert!(cat.get("codex", proj).iter().any(|c| c.name == "prompts:b"));
    }
}
