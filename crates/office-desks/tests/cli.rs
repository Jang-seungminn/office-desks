//! Black-box tests of the `office-desks` binary. Every child runs with a scratch environment
//! (`env_clear` plus scratch homes) and a free port, never 4317.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const EXE: &str = env!("CARGO_BIN_EXE_office-desks");

fn command(dir: &Path) -> Command {
    let mut cmd = Command::new(EXE);
    cmd.env_clear();
    // Winsock can't initialise without SystemRoot; keep the few variables Windows needs.
    for key in ["SystemRoot", "ComSpec", "PATHEXT"] {
        if let Some(v) = std::env::var_os(key) {
            cmd.env(key, v);
        }
    }
    let home = dir.join("home");
    let tmp = dir.join("tmp");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&tmp).unwrap();
    cmd.env("OFFICE_DESKS_HOME", dir.join("office-desks"))
        .env("OFFICE_DESKS_BACKEND", "native")
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("CLAUDE_CONFIG_DIR", dir.join("claude"))
        .env("TMPDIR", &tmp)
        .env("TMP", &tmp)
        .env("TEMP", &tmp)
        .env("GIT_CONFIG_GLOBAL", dir.join("gitconfig"))
        .env("GIT_CONFIG_NOSYSTEM", "1");
    cmd
}

fn free_port() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    assert_ne!(port, 4317);
    port
}

struct Output {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run(cmd: &mut Command) -> Output {
    let out = cmd.stdin(Stdio::null()).output().unwrap();
    Output {
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

/// Kills its own child on drop (a panicking test must not leave a server behind).
struct Guard(Child);
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn wait_exit(child: &mut Child, within: Duration) -> Option<std::process::ExitStatus> {
    let start = Instant::now();
    while start.elapsed() < within {
        if let Some(s) = child.try_wait().unwrap() {
            return Some(s);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

#[test]
fn help_exits_zero() {
    let dir = tempfile::tempdir().unwrap();
    let out = run(command(dir.path()).arg("--help"));
    assert_eq!(out.code, Some(0));
    assert!(out.stdout.contains("--port <n>"));
    assert!(out
        .stdout
        .contains("Rust build: the terminal app arrives later"));
}

#[test]
fn bad_port_exits_one() {
    let dir = tempfile::tempdir().unwrap();
    let out = run(command(dir.path()).args(["--port", "0x"]));
    assert_eq!(out.code, Some(1));
    assert_eq!(
        out.stderr.trim(),
        "--port needs a number between 1 and 65535"
    );
}

#[test]
fn bad_backend_exits_one() {
    let dir = tempfile::tempdir().unwrap();
    let out = run(command(dir.path()).args(["--backend", "nope"]));
    assert_eq!(out.code, Some(1));
    assert_eq!(
        out.stderr.trim(),
        "--backend needs one of: orca, native, demo"
    );
}

#[test]
fn demo_and_orca_are_not_in_the_rust_build() {
    let dir = tempfile::tempdir().unwrap();
    for (args, kind) in [
        (vec!["--backend", "demo"], "demo"),
        (vec!["--demo"], "demo"),
        (vec!["--backend", "orca"], "orca"),
    ] {
        let out = run(command(dir.path()).args(&args));
        assert_eq!(out.code, Some(1), "{args:?}");
        assert_eq!(
            out.stderr.trim(),
            format!("office-desks: the {kind} backend is not in the Rust build yet; use the Node bridge (npx office-desks) for it")
        );
    }
}

#[test]
fn hook_relay_posts_stdin() {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        sock.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut req = Vec::new();
        let mut buf = [0u8; 1024];
        // Read until the headers and the 15-byte body are in.
        while !String::from_utf8_lossy(&req).contains("{\"hello\":\"hi\"}") {
            let n = sock.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            req.extend_from_slice(&buf[..n]);
        }
        let _ =
            sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        String::from_utf8_lossy(&req).into_owned()
    });
    let mut child = Guard(
        command(dir.path())
            .arg("hook-relay")
            .env(
                "OFFICE_DESKS_HOOK_URL",
                format!("http://127.0.0.1:{port}/hook/a?token=t"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut stdin = child.0.stdin.take().unwrap();
    stdin.write_all(b"{\"hello\":\"hi\"}").unwrap();
    drop(stdin);
    let status = wait_exit(&mut child.0, Duration::from_secs(10)).expect("hook-relay exits");
    assert_eq!(status.code(), Some(0));
    let req = server.join().unwrap();
    assert!(req.starts_with("POST /hook/a?token=t HTTP/1.1"), "{req}");
    assert!(req
        .to_ascii_lowercase()
        .contains("content-type: application/json"));
    assert!(req.ends_with("{\"hello\":\"hi\"}"));
}

/// Spawn the server on `port`; returns once the `bridge on` line was printed.
fn start_server(dir: &Path, port: u16) -> Guard {
    assert_ne!(port, 4317);
    let mut child = Guard(
        command(dir)
            .args(["--port", &port.to_string(), "--no-tui"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let stdout = child.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let _ = tx.send(line);
        }
    });
    let line = rx
        .recv_timeout(Duration::from_secs(15))
        .expect("bridge on line");
    assert_eq!(
        line,
        format!("[office-desks] bridge on http://127.0.0.1:{port} (native backend)")
    );
    child
}

fn get(port: u16, path: &str) -> (u16, String) {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(5))
        .build();
    match agent.get(&format!("http://127.0.0.1:{port}{path}")).call() {
        Ok(r) => (r.status(), r.into_string().unwrap()),
        Err(ureq::Error::Status(code, r)) => (code, r.into_string().unwrap_or_default()),
        Err(e) => panic!("GET {path}: {e}"),
    }
}

#[test]
fn serves_and_shuts_down() {
    let dir = tempfile::tempdir().unwrap();
    let port = free_port();
    let mut child = start_server(dir.path(), port);
    let (status, body) = get(port, "/api/snapshot");
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"desks\""), "{body}");
    // Static files: the web UI if it was built, else the no-dist text. Either way 200.
    assert_eq!(get(port, "/").0, 200);

    #[cfg(unix)]
    {
        // SAFETY: signalling the child this test spawned.
        let rc = unsafe { libc::kill(child.0.id() as i32, libc::SIGINT) };
        assert_eq!(rc, 0);
        let status = wait_exit(&mut child.0, Duration::from_secs(5)).expect("exits after SIGINT");
        assert_eq!(status.code(), Some(0));
    }
    #[cfg(windows)]
    {
        // Smoke test only: kill() is TerminateProcess and says nothing about graceful shutdown.
        child.0.kill().unwrap();
        assert!(wait_exit(&mut child.0, Duration::from_secs(5)).is_some());
    }
}

#[cfg(unix)]
#[test]
fn sigterm_shuts_down_gracefully() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = start_server(dir.path(), free_port());
    // SAFETY: signalling the child this test spawned.
    assert_eq!(unsafe { libc::kill(child.0.id() as i32, libc::SIGTERM) }, 0);
    let status = wait_exit(&mut child.0, Duration::from_secs(5)).expect("exits after SIGTERM");
    assert_eq!(status.code(), Some(0));
}

#[test]
fn busy_port_exits_one() {
    let dir = tempfile::tempdir().unwrap();
    let held = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = held.local_addr().unwrap().port();
    assert_ne!(port, 4317);
    let out = run(command(dir.path()).args(["--port", &port.to_string()]));
    assert_eq!(out.code, Some(1));
    assert!(out.stderr.starts_with("[office-desks] "), "{}", out.stderr);
}
