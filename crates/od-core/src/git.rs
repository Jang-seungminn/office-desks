//! Running `git` with a timeout. Port of `runGit` / `GitRunner` in `bridge/src/gitInfo.ts`.
//!
//! Sync on purpose: it blocks on a child process, so async callers (like `NativeBackend`) wrap
//! calls in `spawn_blocking`.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// `execFile` options of `runGit`.
pub const GIT_TIMEOUT: Duration = Duration::from_millis(8000);
pub const GIT_MAX_BUFFER: usize = 4 * 1024 * 1024;

/// A failed git run. `stdout` is kept like the TS does: `diff --no-index` exits 1 exactly when
/// it has output.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct GitError {
    pub message: String,
    pub stdout: String,
}

/// Runs `git -C <cwd> <args...>` and returns stdout. Object-safe, so `&dyn GitRunner` works.
pub trait GitRunner: Send + Sync {
    fn run(&self, cwd: &str, args: &[&str]) -> Result<String, GitError>;
}

/// Spawns the real `git` (argv, no shell) with `GIT_TIMEOUT` and `GIT_MAX_BUFFER`.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemGit;

impl GitRunner for SystemGit {
    fn run(&self, cwd: &str, args: &[&str]) -> Result<String, GitError> {
        run_git_with("git", cwd, args, GIT_TIMEOUT, GIT_MAX_BUFFER)
    }
}

fn fail(message: String, stdout: Vec<u8>) -> GitError {
    GitError {
        message,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
    }
}

type Shared = Arc<Mutex<Vec<u8>>>;

/// Reads into a shared buffer so a caller can snapshot partial output without joining.
fn read_capped<R: Read + Send + 'static>(
    mut r: R,
    max: usize,
    overflow: Arc<AtomicBool>,
) -> (thread::JoinHandle<()>, Shared) {
    let shared: Shared = Arc::new(Mutex::new(Vec::new()));
    let sink = shared.clone();
    let h = thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut buf = sink.lock().unwrap();
                    if buf.len() + n > max {
                        // Like Node: keep what fits under the cap, then report overflow.
                        let room = max - buf.len();
                        buf.extend_from_slice(&chunk[..room]);
                        overflow.store(true, Ordering::SeqCst);
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
            }
        }
    });
    (h, shared)
}

pub(crate) fn run_git_with(
    program: &str,
    cwd: &str,
    args: &[&str],
    timeout: Duration,
    max_buffer: usize,
) -> Result<String, GitError> {
    let mut cmd = Command::new(program);
    cmd.arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let described = format!("{program} -C {cwd} {}", args.join(" "));
    let mut child = cmd
        .spawn()
        .map_err(|e| fail(format!("spawn {program} failed: {e}"), Vec::new()))?;
    let out_over = Arc::new(AtomicBool::new(false));
    let err_over = Arc::new(AtomicBool::new(false));
    let (out, out_buf) = read_capped(child.stdout.take().unwrap(), max_buffer, out_over.clone());
    let (err, err_buf) = read_capped(child.stderr.take().unwrap(), max_buffer, err_over.clone());
    let overflowed = || {
        if out_over.load(Ordering::SeqCst) {
            Some(format!("{described}: stdout maxBuffer length exceeded"))
        } else if err_over.load(Ordering::SeqCst) {
            Some(format!("{described}: stderr maxBuffer length exceeded"))
        } else {
            None
        }
    };

    let start = Instant::now();
    let mut reason: Option<String> = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(e) => {
                reason = Some(format!("Command failed: {described}\n{e}"));
                break None;
            }
        }
        if let Some(msg) = overflowed() {
            reason = Some(msg);
            break None;
        }
        if start.elapsed() >= timeout {
            reason = Some(format!("Command failed: {described}\ntimed out"));
            break None;
        }
        thread::sleep(Duration::from_millis(5));
    };
    if reason.is_none() {
        // The child exited normally: let the readers drain so an overflow they hit is seen.
        let _ = out.join();
        let _ = err.join();
        reason = overflowed();
    }
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if let Some(msg) = reason {
        // Don't join the readers: a grandchild (e.g. a git alias or hook) may still hold the
        // pipes open. The threads end on their own when the pipes close.
        let partial = out_buf.lock().unwrap().clone();
        return Err(fail(msg, partial));
    }
    let stdout = out_buf.lock().unwrap().clone();
    let stderr = err_buf.lock().unwrap().clone();
    if status.is_some_and(|s| s.success()) {
        return Ok(String::from_utf8_lossy(&stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&stderr);
    Err(fail(
        format!("Command failed: {described}\n{}", stderr.trim_end()),
        stdout,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonexistent_program_is_an_error() {
        assert!(run_git_with("od-no-such-program", ".", &[], GIT_TIMEOUT, 10).is_err());
    }

    #[test]
    fn git_version_runs() {
        let out = SystemGit.run(".", &["--version"]).unwrap();
        assert!(out.starts_with("git version"));
    }

    #[test]
    fn non_zero_exit_keeps_stdout() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("f.txt"), "hello\n").unwrap();
        let cwd = t.path().to_str().unwrap();
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        let e = SystemGit
            .run(
                cwd,
                &["diff", "--no-color", "--no-index", "--", null, "f.txt"],
            )
            .unwrap_err();
        assert!(e.stdout.contains("+hello"), "{}", e.stdout);
    }

    #[test]
    fn max_buffer_is_enforced() {
        let e = run_git_with("git", ".", &["--version"], GIT_TIMEOUT, 3).unwrap_err();
        assert!(e.message.contains("maxBuffer"));
    }

    #[test]
    fn overflow_error_keeps_partial_stdout_up_to_cap() {
        let e = run_git_with("git", ".", &["--version"], GIT_TIMEOUT, 7).unwrap_err();
        assert!(e.message.contains("maxBuffer"));
        assert_eq!(e.stdout, "git ver");
    }

    #[test]
    fn timeout_kills_a_long_running_child() {
        // A git alias that sleeps stands in for a hung git.
        let sleeper = if cfg!(windows) {
            "!ping -n 6 127.0.0.1 >NUL"
        } else {
            "!sleep 5"
        };
        let alias = format!("alias.od-sleep={sleeper}");
        let start = Instant::now();
        let e = run_git_with(
            "git",
            ".",
            &["-c", &alias, "od-sleep"],
            Duration::from_millis(300),
            1024,
        )
        .unwrap_err();
        assert!(e.message.contains("timed out"), "{}", e.message);
        assert!(start.elapsed() < Duration::from_secs(10));
    }
}
