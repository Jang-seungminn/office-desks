//! The environment a spawned agent gets (port of `bridge/src/native/env.ts`).
//!
//! If the bridge itself runs inside Claude Code or Orca, their per-session markers must not
//! leak: a child that inherits CLAUDE_CODE_CHILD_SESSION stops saving its transcript, and
//! ORCA_* would route its hooks into Orca. User settings such as CLAUDE_CODE_USE_BEDROCK or
//! CLAUDE_CODE_OAUTH_TOKEN must pass through untouched.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::nodepath::{win32_has_ext, win32_is_absolute, win32_join};

pub type EnvMap = HashMap<String, String>;

const SESSION_MARKERS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
];

fn dropped(key: &str, value: &str) -> bool {
    if SESSION_MARKERS.contains(&key)
        || key.starts_with("CLAUDE_CODE_MESSAGING_")
        || key.starts_with("ORCA_")
    {
        return true;
    }
    // Orca points Codex at its own runtime home; a user's own CODEX_HOME stays.
    key == "CODEX_HOME" && value.contains("codex-runtime-home")
}

/// The current process environment (non-Unicode entries are skipped).
pub fn process_env() -> EnvMap {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

/// `base` minus session markers and Orca variables, then `extra` on top.
pub fn agent_env(base: &EnvMap, extra: &EnvMap) -> EnvMap {
    let mut env: EnvMap = base
        .iter()
        .filter(|(k, v)| !dropped(k, v))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    env.extend(extra.iter().map(|(k, v)| (k.clone(), v.clone())));
    env
}

/// A Windows command resolved to a file; `via_cmd` when it is a `.cmd`/`.bat` shim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCommand {
    pub file: String,
    pub via_cmd: bool,
}

/// On Windows find the real file behind a bare command name, preferring a native .exe.
/// `exists` is injectable so this runs on any host.
pub fn resolve_windows_command(
    command: &str,
    env: &EnvMap,
    exists: &dyn Fn(&str) -> bool,
) -> ResolvedCommand {
    let is_shim = |f: &str| {
        let l = f.to_ascii_lowercase();
        l.ends_with(".cmd") || l.ends_with(".bat")
    };
    if win32_has_ext(command) {
        return ResolvedCommand {
            file: command.to_string(),
            via_cmd: is_shim(command),
        };
    }
    let dirs: Vec<&str> = if win32_is_absolute(command) {
        vec![""]
    } else {
        env.get("PATH")
            .or_else(|| env.get("Path"))
            .map(|s| s.as_str())
            .unwrap_or("")
            .split(';')
            .filter(|d| !d.is_empty())
            .collect()
    };
    for ext in [".exe", ".com", ".cmd", ".bat"] {
        for d in &dirs {
            let f = if d.is_empty() {
                format!("{command}{ext}")
            } else {
                win32_join(d, &format!("{command}{ext}"))
            };
            if exists(&f) {
                let via_cmd = is_shim(&f);
                return ResolvedCommand { file: f, via_cmd };
            }
        }
    }
    ResolvedCommand {
        file: command.to_string(),
        via_cmd: true,
    }
}

#[cfg(unix)]
fn is_executable_file(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

/// POSIX lookup: where `cmd` would run from on the agent's PATH, or None.
pub fn find_command_unix(cmd: &str, env: &EnvMap) -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = if cmd.contains('/') {
        vec![PathBuf::new()]
    } else {
        std::env::split_paths(env.get("PATH").map(|s| s.as_str()).unwrap_or(""))
            .filter(|d| !d.as_os_str().is_empty())
            .collect()
    };
    for d in dirs {
        let f = if d.as_os_str().is_empty() {
            PathBuf::from(cmd)
        } else {
            d.join(cmd)
        };
        if is_executable_file(&f) {
            return Some(f);
        }
    }
    None
}

/// Windows lookup: the resolved file if it is absolute and exists.
pub fn find_command_windows(cmd: &str, env: &EnvMap) -> Option<PathBuf> {
    let r = resolve_windows_command(cmd, env, &|p| Path::new(p).exists());
    (win32_is_absolute(&r.file) && Path::new(&r.file).exists()).then(|| PathBuf::from(r.file))
}

/// Where `cmd` would run from on the agent's PATH, or None. A PTY spawn doesn't fail for a
/// missing command on macOS (the child just exits 1), so we look first.
pub fn find_command(cmd: &str, env: &EnvMap) -> Option<PathBuf> {
    if cfg!(windows) {
        find_command_windows(cmd, env)
    } else {
        find_command_unix(cmd, env)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pairs: &[(&str, &str)]) -> EnvMap {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn drops_session_markers_and_orca_vars_but_keeps_user_auth_and_config() {
        let base = m(&[
            ("PATH", "/bin"),
            ("HOME", "/h"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_ENTRYPOINT", "cli"),
            ("CLAUDE_CODE_SESSION_ID", "s"),
            ("CLAUDE_CODE_CHILD_SESSION", "1"),
            ("CLAUDE_CODE_SESSION_ATTENDED", "1"),
            ("CLAUDE_CODE_BRIDGE_SESSION_ID", "b"),
            ("CLAUDE_CODE_EXECPATH", "/x"),
            ("CLAUDE_CODE_MESSAGING_SOCKET", "/s"),
            ("CLAUDE_CODE_MESSAGING_TOKEN", "t"),
            ("CLAUDE_PID", "9"),
            ("CLAUDE_EFFORT", "high"),
            ("ORCA_AGENT_HOOK_TOKEN", "secret"),
            ("ORCA_TERMINAL_HANDLE", "term_1"),
            (
                "CODEX_HOME",
                "/Users/me/Library/Application Support/orca/codex-runtime-home/home",
            ),
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
            ("CLAUDE_CODE_OAUTH_TOKEN", "oauth"),
            ("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "8000"),
            ("ANTHROPIC_API_KEY", "key"),
        ]);
        let env = agent_env(
            &base,
            &m(&[("OFFICE_DESKS_HOOK_URL", "http://127.0.0.1:1/hook/a?token=t")]),
        );
        assert_eq!(
            env,
            m(&[
                ("PATH", "/bin"),
                ("HOME", "/h"),
                ("CLAUDE_CODE_USE_BEDROCK", "1"),
                ("CLAUDE_CODE_OAUTH_TOKEN", "oauth"),
                ("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "8000"),
                ("ANTHROPIC_API_KEY", "key"),
                ("OFFICE_DESKS_HOOK_URL", "http://127.0.0.1:1/hook/a?token=t"),
            ])
        );
    }

    #[test]
    fn keeps_a_codex_home_the_user_chose() {
        let env = agent_env(&m(&[("CODEX_HOME", "/Users/me/.codex")]), &EnvMap::new());
        assert_eq!(env["CODEX_HOME"], "/Users/me/.codex");
    }

    #[test]
    fn extra_overrides_base() {
        let env = agent_env(&m(&[("A", "1")]), &m(&[("A", "2")]));
        assert_eq!(env["A"], "2");
    }

    #[cfg(unix)]
    #[test]
    fn finds_an_executable_file_on_path_else_none() {
        use std::os::unix::fs::PermissionsExt;
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let set = |p: &Path, mode| {
            std::fs::write(p, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
        };
        set(&a.path().join("claude"), 0o644); // not executable: skipped
        set(&b.path().join("claude"), 0o755);
        std::fs::create_dir(a.path().join("codex")).unwrap(); // a folder is not a command
        let path = std::env::join_paths([a.path(), b.path()]).unwrap();
        let env = m(&[("PATH", path.to_str().unwrap())]);
        assert_eq!(
            find_command_unix("claude", &env),
            Some(b.path().join("claude"))
        );
        assert_eq!(find_command_unix("codex", &env), None);
        assert_eq!(find_command_unix("gemini", &env), None);
        // A command containing '/' is used as-is.
        let abs = b.path().join("claude");
        assert_eq!(
            find_command_unix(abs.to_str().unwrap(), &EnvMap::new()),
            Some(abs)
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolves_a_windows_command_to_an_existing_file() {
        let a = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("claude.cmd"), "@echo off\r\n").unwrap();
        let env = m(&[("PATH", a.path().to_str().unwrap())]);
        assert_eq!(
            find_command("claude", &env),
            Some(PathBuf::from(win32_join(
                a.path().to_str().unwrap(),
                "claude.cmd"
            )))
        );
        assert_eq!(find_command("codex", &env), None);
    }

    #[test]
    fn resolve_windows_command_prefers_exe_then_shims() {
        let env = m(&[("Path", r"C:\a;C:\b")]);
        let has = |set: &'static [&'static str]| move |p: &str| set.contains(&p);
        let r = resolve_windows_command("orca", &env, &has(&[r"C:\a\orca.cmd", r"C:\b\orca.exe"]));
        assert_eq!(
            r,
            ResolvedCommand {
                file: r"C:\b\orca.exe".into(),
                via_cmd: false
            }
        );
        let r = resolve_windows_command("orca", &env, &has(&[r"C:\a\orca.cmd"]));
        assert_eq!(
            r,
            ResolvedCommand {
                file: r"C:\a\orca.cmd".into(),
                via_cmd: true
            }
        );
        // Nothing found: the bare name, via cmd.
        let r = resolve_windows_command("orca", &env, &has(&[]));
        assert_eq!(
            r,
            ResolvedCommand {
                file: "orca".into(),
                via_cmd: true
            }
        );
        // An explicit extension is used as-is.
        let r = resolve_windows_command(r"C:\x\orca.BAT", &env, &has(&[]));
        assert!(r.via_cmd && r.file == r"C:\x\orca.BAT");
        let r = resolve_windows_command("orca.exe", &env, &has(&[]));
        assert!(!r.via_cmd);
        // An absolute extensionless command is tried directly.
        let r = resolve_windows_command(r"C:\x\orca", &env, &has(&[r"C:\x\orca.com"]));
        assert_eq!(r.file, r"C:\x\orca.com");
    }
}
