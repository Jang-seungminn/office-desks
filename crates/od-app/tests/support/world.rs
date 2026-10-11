//! The scratch world for od-app's trials and the E2E harness (both include this file with
//! `#[path]`): scratch homes, a scratch PATH whose only agent is the fake `claude` (a copy of the
//! running binary), a committed repo, a preflight, and the fake agents' PIDs.
//!
//! Modeled on od-server's `tests/native/contract.rs` (`build_world`, `preflight`, `PidGuard`).

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use od_core::native::env::{find_command, process_env, EnvMap};
use od_server::{Assets, MemAssets, ServerConfig};

pub const AGENT_EXE: &str = if cfg!(windows) {
    "claude.exe"
} else {
    "claude"
};

pub struct World {
    /// Canonical, native form.
    pub root: PathBuf,
    pub env: EnvMap,
    pub repo: PathBuf,
    /// `OD_FAKE_AGENT_OUT`: the fake agents append to `agents.jsonl` here.
    pub out: PathBuf,
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// The folder that puts git on the scratch PATH. On unix, a symlink `<root>/gitbin/git` to the
/// real git, so whatever else lives next to git (a Homebrew `bin` with `claude`) stays off the
/// PATH. On Windows, git's own folder (`Git\cmd` holds only git's launchers).
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

fn git(git_exe: &Path, cwd: &Path, env: &EnvMap, args: &[&str]) {
    let out = std::process::Command::new(git_exe)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .output()
        .unwrap_or_else(|e| panic!("git {args:?}: {e}"));
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A fresh world under `root` (created if missing).
pub fn build(root: &Path) -> World {
    std::fs::create_dir_all(root).expect("world root");
    let root = dunce::canonicalize(root).expect("canonical root");
    for d in ["bin", "home", "office", "claude", "tmp", "out", "server"] {
        std::fs::create_dir_all(root.join(d)).expect("scratch dir");
    }
    std::fs::write(root.join("gitconfig"), "").expect("gitconfig");
    std::fs::copy(
        std::env::current_exe().expect("current exe"),
        root.join("bin").join(AGENT_EXE),
    )
    .expect("copy fake agent");

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
    let out = root.join("out");
    for (k, v) in [
        ("HOME", home.clone()),
        ("USERPROFILE", home),
        ("TMPDIR", tmp.clone()),
        ("TMP", tmp.clone()),
        ("TEMP", tmp),
        ("CLAUDE_CONFIG_DIR", path_str(&root.join("claude"))),
        ("OFFICE_DESKS_HOME", path_str(&root.join("office"))),
        ("OD_FAKE_AGENT_OUT", path_str(&out)),
        ("GIT_CONFIG_GLOBAL", path_str(&root.join("gitconfig"))),
        ("GIT_CONFIG_NOSYSTEM", "1".into()),
        ("LANG", "C.UTF-8".into()),
    ] {
        env.insert(k.into(), v);
    }

    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).expect("repo dir");
    std::fs::write(repo.join("README.md"), "gongbang\n").expect("README");
    git(&git_exe, &repo, &env, &["init", "-q", "-b", "main"]);
    git(&git_exe, &repo, &env, &["add", "-A"]);
    git(
        &git_exe,
        &repo,
        &env,
        &[
            "-c",
            "user.name=Gongbang",
            "-c",
            "user.email=gongbang@example.invalid",
            "commit",
            "-q",
            "-m",
            "init",
        ],
    );

    World {
        root,
        env,
        repo,
        out,
    }
}

/// No agent but our fake `claude` may resolve on the scratch PATH.
pub fn preflight(world: &World) -> Result<(), String> {
    let ours =
        dunce::canonicalize(world.root.join("bin").join(AGENT_EXE)).map_err(|e| e.to_string())?;
    for name in od_core::hire::KNOWN_AGENTS {
        let found = find_command(name, &world.env);
        let ok = if name == "claude" {
            found.as_ref().and_then(|p| dunce::canonicalize(p).ok()) == Some(ours.clone())
        } else {
            found.is_none()
        };
        if !ok {
            let at = found
                .as_ref()
                .map(|p| path_str(p))
                .unwrap_or_else(|| "<nowhere>".into());
            return Err(format!(
                "{name} found on the scratch PATH at {at}; refusing"
            ));
        }
    }
    Ok(())
}

/// `ServerConfig::from_env(&world.env)` with every path under `root/server` and the given UIs.
pub fn scratch_config(world: &World, web: MemAssets, app: Option<Arc<dyn Assets>>) -> ServerConfig {
    let dir = world.root.join("server");
    let mut cfg = ServerConfig::from_env(&world.env);
    cfg.upload_dir = dir.join("uploads");
    cfg.commands_home = dir.join("home");
    cfg.org_file = dir.join("org.json");
    cfg.awards_file = dir.join("awards.json");
    cfg.assets = Arc::new(web);
    cfg.app_assets = app;
    cfg
}

/// The `pid` of each line of `out/agents.jsonl` (empty if the file is missing).
pub fn agent_pids(out: &Path) -> Vec<u32> {
    std::fs::read_to_string(out.join("agents.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
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
pub fn is_our_agent(pid: u32, exe: &Path) -> bool {
    pid_exe(pid)
        .and_then(|p| dunce::canonicalize(p).ok())
        .is_some_and(|p| p == exe)
}

#[cfg(unix)]
fn kill_pid(pid: u32) {
    // SAFETY: kill(2) on a fake agent this world started (its pid came from its own line).
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    // SAFETY: terminate a fake agent this world started, through a handle we close here.
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !h.is_null() {
            TerminateProcess(h, 1);
            CloseHandle(h);
        }
    }
}

/// Kills this world's own fake agents (the PIDs in its own `agents.jsonl` whose executable is
/// still its own `bin/claude`) on failure only: when the trial panics. A passing run must have
/// disposed them through `Core::shutdown`, so a guard that always killed would hide a leak.
pub struct PidGuard {
    pub out: PathBuf,
    pub exe: PathBuf,
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
