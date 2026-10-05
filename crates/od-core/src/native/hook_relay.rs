//! Claude Code hook -> Office Desks bridge. Claude runs `<exe> hook-relay` for each hook event with
//! the event JSON on stdin; we POST it to the bridge that spawned the agent. It must never block or
//! fail the agent, so every error is swallowed and the exit code is always 0.
//! Port of `bridge/hook-relay.mjs`.

use std::io::Read;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// Env var holding the bridge URL for this agent.
pub const HOOK_URL_ENV: &str = "OFFICE_DESKS_HOOK_URL";
/// Whatever happens (stdin never closes, a slow bridge), give the agent back its hook in 3 s.
pub const OVERALL_TIMEOUT: Duration = Duration::from_secs(3);
pub const POST_TIMEOUT: Duration = Duration::from_secs(2);

/// Run against the process's real stdin and environment. Always returns 0.
pub fn run() -> i32 {
    let url = std::env::var(HOOK_URL_ENV).ok();
    run_with(
        std::io::stdin(),
        url.as_deref(),
        POST_TIMEOUT,
        OVERALL_TIMEOUT,
    )
}

/// Blocking relay with everything injectable. Reads `stdin` to the end, POSTs it as JSON to `url`
/// (skipped when absent or empty), and returns 0 no matter what, including when `overall` elapses
/// first (the worker thread is then abandoned; the caller is expected to exit the process).
pub fn run_with<R: Read + Send + 'static>(
    mut stdin: R,
    url: Option<&str>,
    post_timeout: Duration,
    overall: Duration,
) -> i32 {
    let url = url.filter(|u| !u.is_empty()).map(str::to_owned);
    let (tx, rx) = mpsc::channel::<()>();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdin.read_to_end(&mut buf);
        if let Some(url) = url {
            let body = String::from_utf8_lossy(&buf).into_owned();
            let agent = ureq::AgentBuilder::new().timeout(post_timeout).build();
            let _ = agent
                .post(&url)
                .set("content-type", "application/json")
                .send_string(&body);
        }
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(overall);
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::time::Instant;

    const T: Duration = Duration::from_secs(2);

    /// A reader that blocks until dropped-sender, like a stdin that never closes.
    struct Never(mpsc::Receiver<()>);
    impl Read for Never {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            let _ = self.0.recv();
            Ok(0)
        }
    }

    #[test]
    fn posts_the_hook_json_to_the_url() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let srv = thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let (mut len, mut head, mut line) = (0usize, String::new(), String::new());
            loop {
                line.clear();
                r.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                head.push_str(&line);
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0u8; len];
            r.read_exact(&mut body).unwrap();
            s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                .unwrap();
            (head, String::from_utf8(body).unwrap())
        });
        let url = format!("http://127.0.0.1:{port}/hook/a?token=t");
        let code = run_with(
            std::io::Cursor::new(br#"{"hook_event_name":"Stop"}"#.to_vec()),
            Some(&url),
            T,
            Duration::from_secs(5),
        );
        let (head, body) = srv.join().unwrap();
        assert_eq!(code, 0);
        assert!(head.starts_with("POST /hook/a?token=t HTTP/1.1"), "{head}");
        assert!(head
            .to_ascii_lowercase()
            .contains("content-type: application/json"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"hook_event_name":"Stop"})
        );
    }

    #[test]
    fn never_fails_the_agent_without_url_or_with_unreachable_bridge() {
        let input = || std::io::Cursor::new(b"{}".to_vec());
        assert_eq!(run_with(input(), None, T, T), 0);
        assert_eq!(run_with(input(), Some(""), T, T), 0);
        // Bind then drop to get a port nothing listens on.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let url = format!("http://127.0.0.1:{port}/hook/a?token=t");
        assert_eq!(run_with(input(), Some(&url), T, T), 0);
        assert_eq!(run_with(input(), Some("not a url"), T, T), 0);
        assert_eq!(run_with(input(), Some("https://127.0.0.1:1/x"), T, T), 0);
    }

    #[test]
    fn a_server_that_never_answers_hits_the_post_timeout() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/h", l.local_addr().unwrap().port());
        let t = Instant::now();
        let code = run_with(
            std::io::Cursor::new(b"{}".to_vec()),
            Some(&url),
            Duration::from_millis(300),
            Duration::from_secs(5),
        );
        assert_eq!(code, 0);
        assert!(t.elapsed() < Duration::from_secs(3));
        drop(l);
    }

    #[test]
    fn exits_0_on_its_own_when_stdin_never_closes() {
        let (tx, rx) = mpsc::channel();
        let t = Instant::now();
        let code = run_with(Never(rx), None, T, Duration::from_millis(300));
        assert_eq!(code, 0);
        assert!(t.elapsed() < Duration::from_secs(2));
        drop(tx); // let the abandoned worker finish
    }

    #[test]
    fn real_timeouts_match_the_script() {
        assert_eq!(OVERALL_TIMEOUT, Duration::from_secs(3));
        assert_eq!(POST_TIMEOUT, Duration::from_secs(2));
    }
}
