//! PtyHost against real PTYs (port of bridge/test/ptyHost.test.ts).
//!
//! The program in the PTY is this test binary itself, re-run with `OD_TEST_ECHO=<mode>` and
//! filtered to the `echo_program` test, which then acts as a tiny echo program.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use od_core::native::env::process_env;
use od_core::native::pty_host::{
    PtyHost, PtyOptions, TermModes, TermSize, GONE, MAX_COLS, MAX_ROWS,
};

const ECHO_ENV: &str = "OD_TEST_ECHO";

/// The echo program. A no-op in a normal test run.
#[test]
fn echo_program() {
    let Ok(mode) = std::env::var(ECHO_ENV) else {
        return;
    };
    let mut out = std::io::stdout();
    let say = |out: &mut std::io::Stdout, s: &str| {
        let _ = out.write_all(s.as_bytes());
        let _ = out.flush();
    };
    match mode.as_str() {
        // Cooked input: one `got:<line>` per line.
        "line" => {
            say(&mut out, "ready\r\n");
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                say(&mut out, &format!("got:{}\r\n", line.trim()));
            }
        }
        "exit" => {
            say(&mut out, "bye\r\n");
            std::process::exit(3);
        }
        // Raw input: every read printed escaped as `in:"..."`.
        "raw" => {
            raw::enable();
            say(&mut out, "ready\r\n");
            raw::echo_bytes(&mut out);
        }
        // Ask for the cursor position after "ab" and print the reply the terminal sent.
        #[cfg(unix)]
        "dsr" => {
            raw::enable();
            say(&mut out, "\r\nab\x1b[6n"); // own line: libtest printed its header
            let mut got = Vec::new();
            let mut b = [0u8; 1];
            while !got.ends_with(b"R") {
                match std::io::Read::read(&mut std::io::stdin(), &mut b) {
                    Ok(1) => got.push(b[0]),
                    _ => break,
                }
            }
            say(
                &mut out,
                &format!("\r\nreply:{:?}\r\n", String::from_utf8_lossy(&got)),
            );
            raw::echo_bytes(&mut out);
        }
        // Survives a hang-up: only a force kill takes it down.
        #[cfg(unix)]
        "stubborn" => {
            // SAFETY: setting a signal disposition in our own process.
            unsafe { libc::signal(libc::SIGHUP, libc::SIG_IGN) };
            say(&mut out, "ready\r\n");
            loop {
                std::thread::park();
            }
        }
        _ => {}
    }
    std::process::exit(0);
}

mod raw {
    use std::io::{Read, Write};

    /// Windows: no line input, echo or processing; VT sequences arrive as bytes.
    #[cfg(windows)]
    pub fn enable() {
        use windows_sys::Win32::System::Console::{
            GetStdHandle, SetConsoleMode, ENABLE_VIRTUAL_TERMINAL_INPUT, STD_INPUT_HANDLE,
        };
        // SAFETY: console mode calls on our own stdin handle.
        unsafe {
            SetConsoleMode(
                GetStdHandle(STD_INPUT_HANDLE),
                ENABLE_VIRTUAL_TERMINAL_INPUT,
            );
        }
    }

    #[cfg(unix)]
    pub fn enable() {
        // SAFETY: termios calls on our own stdin.
        unsafe {
            let mut t: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(0, &mut t) == 0 {
                libc::cfmakeraw(&mut t);
                libc::tcsetattr(0, libc::TCSANOW, &t);
            }
        }
    }

    pub fn echo_bytes(out: &mut std::io::Stdout) {
        let mut buf = [0u8; 256];
        loop {
            match std::io::stdin().read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    let s = format!("in:{:?}\r\n", String::from_utf8_lossy(&buf[..n]));
                    let _ = out.write_all(s.as_bytes());
                    let _ = out.flush();
                }
            }
        }
    }
}

fn echo(mode: &str) -> PtyOptions {
    let mut env = process_env();
    env.insert(ECHO_ENV.into(), mode.into());
    PtyOptions {
        file: std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        args: ["--exact", "echo_program", "--nocapture", "--test-threads=1"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        cwd: std::env::current_dir().unwrap(),
        env,
        cols: None,
        rows: None,
    }
}

async fn until(what: &str, mut cond: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    while !cond() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn shows(host: &PtyHost, id: &str, text: &str) -> bool {
    host.screen_lines(id).iter().any(|l| l.contains(text))
}

type Exits = Arc<Mutex<Vec<(String, u32)>>>;

fn record_exits(host: &PtyHost) -> (Exits, od_core::native::pty_host::Subscription) {
    let exits: Exits = Arc::default();
    let e = exits.clone();
    let sub = host.on_exit(move |id, code| e.lock().unwrap().push((id.to_string(), code)));
    (exits, sub)
}

fn exited(exits: &Exits, id: &str) -> Option<u32> {
    exits
        .lock()
        .unwrap()
        .iter()
        .find(|(i, _)| i == id)
        .map(|(_, c)| *c)
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks existence. A reaped child is gone (ESRCH); a zombie is not.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[tokio::test]
async fn runs_a_program_renders_its_screen_takes_input_and_reports_exit() {
    let host = PtyHost::new();
    let (exits, _sub) = record_exits(&host);
    host.spawn("a1", echo("line")).unwrap();
    until("ready", || shows(&host, "a1", "ready")).await;
    host.write("a1", "hello\r").unwrap();
    until("got:hello", || shows(&host, "a1", "got:hello")).await;
    let pid = host.pid("a1").unwrap();
    host.kill("a1");
    until("exit", || exited(&exits, "a1").is_some()).await;
    assert!(!host.has("a1"));
    let e = host.write("a1", "x").unwrap_err();
    assert_eq!(e.code.as_deref(), Some("terminal_not_writable"));
    assert_eq!(e.message, GONE);
    assert!(host.screen_lines("a1").is_empty());
    assert!(host.ids().is_empty());
    #[cfg(unix)]
    assert!(!pid_alive(pid), "the killed child must be reaped");
    let _ = pid;
    host.dispose().await;
}

#[tokio::test]
async fn reports_the_exit_code_and_refuses_writes_after_a_natural_exit() {
    let host = PtyHost::new();
    let (exits, sub) = record_exits(&host);
    host.spawn("e1", echo("exit")).unwrap();
    until("exit", || exited(&exits, "e1").is_some()).await;
    assert_eq!(exited(&exits, "e1"), Some(3));
    assert_eq!(
        host.write("e1", "x").unwrap_err().code.as_deref(),
        Some("terminal_not_writable")
    );
    assert_eq!(host.size("e1"), None);
    assert_eq!(host.serialize("e1"), "");
    sub.unsubscribe();
    host.dispose().await;
}

#[tokio::test]
async fn streams_output_to_subscribers_until_unsubscribed_resizes_and_serializes() {
    let host = PtyHost::new();
    host.spawn("a2", echo("line")).unwrap();
    let seen = Arc::new(Mutex::new(Vec::<u8>::new()));
    let s = seen.clone();
    let off = host
        .on_data("a2", move |d| s.lock().unwrap().extend_from_slice(d))
        .unwrap();
    until("ready", || shows(&host, "a2", "ready")).await;
    host.write("a2", "hi\r").unwrap();
    let text =
        |seen: &Arc<Mutex<Vec<u8>>>| String::from_utf8_lossy(&seen.lock().unwrap()).into_owned();
    until("got:hi streamed", || text(&seen).contains("got:hi")).await;
    off.unsubscribe();
    host.write("a2", "again\r").unwrap();
    until("got:again", || shows(&host, "a2", "got:again")).await;
    assert!(!text(&seen).contains("got:again"));

    assert_eq!(
        host.size("a2"),
        Some(TermSize {
            cols: 120,
            rows: 40
        })
    );
    assert_eq!(host.screen_lines("a2").len(), 40);
    host.resize("a2", 80, 20);
    assert_eq!(host.size("a2"), Some(TermSize { cols: 80, rows: 20 }));
    assert_eq!(host.screen_lines("a2").len(), 20);
    host.resize("a2", 80, 20); // same size: no-op
    host.resize("a2", 1, 20); // too small: ignored
    assert_eq!(host.size("a2"), Some(TermSize { cols: 80, rows: 20 }));
    // too large (the screen allocates every cell): ignored; the limits themselves are fine
    host.resize("a2", 5000, 20);
    host.resize("a2", 80, 501);
    host.resize("a2", u16::MAX, u16::MAX);
    assert_eq!(host.size("a2"), Some(TermSize { cols: 80, rows: 20 }));
    host.resize("a2", MAX_COLS, MAX_ROWS);
    assert_eq!(
        host.size("a2"),
        Some(TermSize {
            cols: MAX_COLS,
            rows: MAX_ROWS
        })
    );
    host.resize("a2", 80, 20);
    assert_eq!(host.size("a2"), Some(TermSize { cols: 80, rows: 20 }));
    host.resize("nope", 10, 10);

    let snap = host.serialize("a2");
    assert!(snap.contains("got:hi"));
    assert_eq!(host.serialize("nope"), "");
    assert!(host.on_data("nope", |_| {}).is_none());
    assert_eq!(host.ids(), ["a2"]);
    assert_eq!(host.modes("a2"), Some(TermModes::default()));
    assert_eq!(host.modes("nope"), None);
    let mute = host.mute_replies("a2").unwrap();
    drop(mute);
    host.dispose().await;
}

#[tokio::test]
async fn serialize_replays_the_live_screen_into_a_fresh_parser() {
    let host = PtyHost::new();
    host.spawn("s1", echo("line")).unwrap();
    until("ready", || shows(&host, "s1", "ready")).await;
    for w in ["one", "two 한글 ✅", "three"] {
        host.write("s1", format!("{w}\r")).unwrap();
    }
    until("got:three", || shows(&host, "s1", "got:three")).await;
    // Retried: output landing between the snapshot and the reads (a ConPTY repaint) is a race
    // of the test, not a replay mismatch.
    until("replay matches the screen", || {
        let snap = host.serialize("s1");
        let mut fresh = vt100::Parser::new(40, 120, 1000);
        fresh.process(snap.as_bytes());
        let replayed: Vec<String> = (0..40)
            .map(|r| od_core::native::pty_host::row_text(fresh.screen(), r, true))
            .collect();
        let cursor = host.with_screen("s1", 0, |s| s.cursor_position());
        replayed == host.screen_lines("s1") && cursor == Some(fresh.screen().cursor_position())
    })
    .await;
    host.dispose().await;
}

#[tokio::test]
async fn attach_hands_over_a_snapshot_and_then_the_stream() {
    let host = PtyHost::new();
    host.spawn("t1", echo("line")).unwrap();
    until("ready", || shows(&host, "t1", "ready")).await;
    let seen = Arc::new(Mutex::new(Vec::<u8>::new()));
    let s = seen.clone();
    let (snap, sub) = host
        .attach("t1", move |d| s.lock().unwrap().extend_from_slice(d))
        .unwrap();
    assert!(snap.contains("ready"));
    host.write("t1", "x1\r").unwrap();
    until("got:x1 streamed", || {
        String::from_utf8_lossy(&seen.lock().unwrap()).contains("got:x1")
    })
    .await;
    assert!(!String::from_utf8_lossy(&seen.lock().unwrap()).contains("ready"));
    drop(sub);
    assert!(host.attach("nope", |_| {}).is_none());
    host.dispose().await;
}

#[tokio::test]
async fn exposes_cursor_visibility_scrollback_and_screen_cells() {
    let host = PtyHost::new();
    host.spawn("c1", echo("line")).unwrap();
    until("ready", || shows(&host, "c1", "ready")).await;
    // ConPTY may start with a blank line or a clear: find the row rather than assume row 0.
    let lines = host.screen_lines("c1");
    let y = lines.iter().position(|l| l.contains("ready")).unwrap();
    let x = lines[y].find("ready").unwrap();
    let ch = host
        .with_screen("c1", 0, |s| {
            s.cell(y as u16, x as u16).unwrap().contents().to_string()
        })
        .unwrap();
    assert_eq!(ch, "r");

    // ConPTY hides the cursor while it repaints: wait for it to show again.
    until("cursor shown", || !host.cursor_hidden("c1")).await;
    host.feed("c1", "\x1b[?25l");
    assert!(host.cursor_hidden("c1"));
    host.feed("c1", "\x1b[?2004h\x1b[?1h");
    assert_eq!(
        host.modes("c1"),
        Some(TermModes {
            bracketed_paste: true,
            application_cursor: true
        })
    );
    assert!(!host.cursor_hidden("nope"));

    host.feed("c1", "\x1b[2J\x1b[H");
    for i in 0..50 {
        host.feed("c1", format!("hist{i}\r\n"));
    }
    assert!(host.scrollback_len("c1") >= 11);
    let all = host.scroll_lines("c1");
    assert!(all.iter().any(|l| l == "hist0"));
    assert_eq!(all.len(), host.scrollback_len("c1") + 40);
    assert!(host.with_screen("nope", 0, |_| ()).is_none());
    host.dispose().await;
}

#[tokio::test]
async fn refuses_a_second_spawn_under_a_live_id() {
    let host = PtyHost::new();
    host.spawn("d1", echo("line")).unwrap();
    assert!(host.spawn("d1", echo("line")).is_err());
    assert_eq!(host.ids(), ["d1"]);
    host.dispose().await;
}

#[tokio::test]
async fn dispose_kills_and_reaps_every_child() {
    let host = PtyHost::new();
    let (exits, _sub) = record_exits(&host);
    host.spawn("k1", echo("line")).unwrap();
    host.spawn("k2", echo("line")).unwrap();
    until("both ready", || {
        shows(&host, "k1", "ready") && shows(&host, "k2", "ready")
    })
    .await;
    let pids = [host.pid("k1").unwrap(), host.pid("k2").unwrap()];
    host.dispose().await;
    assert!(host.ids().is_empty());
    assert!(exited(&exits, "k1").is_some() && exited(&exits, "k2").is_some());
    #[cfg(unix)]
    for pid in pids {
        assert!(!pid_alive(pid), "pid {pid} left behind");
    }
    let _ = pids;
    host.dispose().await; // nothing left: returns at once
}

/// SIGKILLs a child we spawned if the test panics, so a failed assertion can't leave a process
/// that ignores SIGHUP behind. Disarmed on success: by then the child was reaped and its pid
/// could belong to someone else.
#[cfg(unix)]
struct KillOnPanic(u32);

#[cfg(unix)]
impl Drop for KillOnPanic {
    fn drop(&mut self) {
        if std::thread::panicking() {
            // SAFETY: plain kill(2) on the pid of our own (not yet reaped) child.
            unsafe { libc::kill(self.0 as libc::pid_t, libc::SIGKILL) };
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn dispose_force_kills_a_child_that_ignores_the_hangup() {
    let host = PtyHost::new();
    host.spawn("h1", echo("stubborn")).unwrap();
    let pid = host.pid("h1").unwrap();
    // Declared after `host`, so it drops (and kills) first.
    let _guard = KillOnPanic(pid);
    until("ready", || shows(&host, "h1", "ready")).await;
    host.kill("h1"); // SIGHUP: ignored
    let started = Instant::now();
    host.dispose().await;
    assert!(started.elapsed() <= Duration::from_millis(2500));
    assert!(!host.has("h1"));
    assert!(!pid_alive(pid));
}

/// The echo program asks for the cursor position (raw mode, no newline) and prints our answer.
/// Unix only: under ConPTY, conhost answers a program's own DSR itself, so it never reaches us.
#[cfg(unix)]
#[tokio::test]
async fn answers_the_cursor_position_query_of_the_program() {
    let host = PtyHost::new();
    host.spawn("q1", echo("dsr")).unwrap();
    until("reply", || shows(&host, "q1", "reply:")).await;
    let lines = host.screen_lines("q1");
    let row = lines.iter().position(|l| l == "ab").expect("the 'ab' row") + 1;
    let reply = lines.iter().find(|l| l.starts_with("reply:")).unwrap();
    assert_eq!(reply, &format!("reply:\"\\u{{1b}}[{row};3R\""));
    host.dispose().await;
}

/// A status query fed to the screen is answered on the program's input. Raw input on both
/// platforms (termios on unix, console VT input mode on Windows), so it needs no newline.
/// Windows caveat: the reply passes through conhost's input parser; if a ConPTY build swallows
/// it, this is the test to cfg-gate.
#[tokio::test]
async fn answers_a_status_query_on_the_program_input() {
    let host = PtyHost::new();
    host.spawn("r1", echo("raw")).unwrap();
    until("ready", || shows(&host, "r1", "ready")).await;
    host.feed("r1", "\x1b[5n");
    until("DSR reply", || {
        host.screen_lines("r1")
            .join("\n")
            .contains("in:\"\\u{1b}[0n\"")
    })
    .await;
    host.dispose().await;
}

/// Replies go to the program only while no terminal has them muted.
#[tokio::test]
async fn forwards_query_replies_only_while_unmuted() {
    let host = PtyHost::new();
    host.spawn("m1", echo("raw")).unwrap();
    until("ready", || shows(&host, "m1", "ready")).await;
    let first = host.mute_replies("m1").unwrap();
    let second = host.mute_replies("m1").unwrap();
    assert!(host.mute_replies("nope").is_none());
    host.feed("m1", "\x1b[c");
    // Input is one FIFO queue: once "z" arrived, a reply sent before it would have too.
    host.write("m1", "z").unwrap();
    until("z", || shows(&host, "m1", "in:\"z\"")).await;
    drop(first); // one terminal detached; the other still answers for itself
    host.feed("m1", "\x1b[c");
    host.write("m1", "y").unwrap();
    until("y", || shows(&host, "m1", "in:\"y\"")).await;
    assert!(!host.screen_lines("m1").join("\n").contains("?1;2c"));

    drop(second);
    host.feed("m1", "\x1b[c");
    until("DA reply", || {
        host.screen_lines("m1")
            .join("\n")
            .contains("in:\"\\u{1b}[?1;2c\"")
    })
    .await;
    host.dispose().await;
}

#[tokio::test]
async fn exit_subscriptions_stop_after_unsubscribe() {
    let host = PtyHost::new();
    let (exits, sub) = record_exits(&host);
    sub.unsubscribe();
    let (later, _keep) = record_exits(&host);
    host.spawn("u1", echo("exit")).unwrap();
    until("exit", || exited(&later, "u1").is_some()).await;
    assert!(exits.lock().unwrap().is_empty());
    host.dispose().await;
}
