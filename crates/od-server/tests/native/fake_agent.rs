//! The fake `claude`: this same test binary, copied to `<scratch>/bin/claude` (`claude.exe` on
//! Windows). `main` runs [`run`] when the executable's file stem is `claude`.
//!
//! Protocol (the contract fixtures and later `/term` tests depend on it):
//! 1. stdin goes raw (`cfmakeraw` / `ENABLE_VIRTUAL_TERMINAL_INPUT`);
//! 2. one JSON line `{"pid","hookUrl","args","cwd"}` is appended to `$OD_FAKE_AGENT_OUT/agents.jsonl`;
//! 3. `FAKE AGENT READY\r\n` is written, then a Claude-style composer ([`COMPOSER`]: a `❯` line
//!    between two rules of 16 `─`), so `composerState` reads the screen as `ready`;
//! 4. stdin bytes accumulate into a line; on `\r` the bracketed-paste markers are stripped and
//!    `query` writes `ESC [ c`, `exit` writes `bye\r\n` and exits 3, `menu` clears the screen
//!    and draws an unframed `❯ 1. Yes` (a dialog: `composerState` reads `menu`), `flood` writes
//!    5 MiB of `x` in 64 KiB writes and then `\r\nflood done\r\n` ([`FLOOD_DONE`]), anything else
//!    writes `got:<line>\r\n`. A read that starts with `ESC [ ?` is first echoed as
//!    `in:<{:?}>\r\n`.
//!
//! EOF or a read error exits 0.

use std::io::{Read, Write};
use std::path::PathBuf;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLine {
    pub pid: u32,
    pub hook_url: Option<String>,
    pub args: Vec<String>,
    pub cwd: String,
}

/// Claude's composer as `screen.ts` recognizes it: `❯` framed by rules of at least 8 `─`.
pub const COMPOSER: &str = "────────────────\r\n❯ \r\n────────────────\r\n";
/// The line `flood` prints after its 5 MiB.
pub const FLOOD_DONE: &str = "flood done";
/// A dialog: clear the screen, then an unframed `❯` option.
pub const MENU: &str = "\x1b[2J\x1b[H❯ 1. Yes\r\n";

pub fn run() -> ! {
    raw::enable();
    record();
    let mut out = std::io::stdout();
    let _ = out.write_all(b"FAKE AGENT READY\r\n");
    let _ = out.write_all(COMPOSER.as_bytes());
    let _ = out.flush();
    let mut line: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = match std::io::stdin().read(&mut buf) {
            Ok(0) | Err(_) => std::process::exit(0),
            Ok(n) => n,
        };
        let chunk = &buf[..n];
        if chunk.starts_with(b"\x1b[?") {
            let s = format!("in:{:?}\r\n", String::from_utf8_lossy(chunk));
            let _ = out.write_all(s.as_bytes());
        }
        for &b in chunk {
            if b != b'\r' {
                line.push(b);
                continue;
            }
            let text = String::from_utf8_lossy(&line)
                .replace("\x1b[200~", "")
                .replace("\x1b[201~", "");
            line.clear();
            match text.as_str() {
                "query" => {
                    let _ = out.write_all(b"\x1b[c");
                }
                "flood" => {
                    let chunk = vec![b'x'; 64 * 1024];
                    for _ in 0..80 {
                        let _ = out.write_all(&chunk);
                    }
                    let _ = out.write_all(format!("\r\n{FLOOD_DONE}\r\n").as_bytes());
                }
                "menu" => {
                    let _ = out.write_all(MENU.as_bytes());
                }
                "exit" => {
                    let _ = out.write_all(b"bye\r\n");
                    let _ = out.flush();
                    std::process::exit(3);
                }
                _ => {
                    let _ = out.write_all(format!("got:{text}\r\n").as_bytes());
                }
            }
        }
        let _ = out.flush();
    }
}

/// Append this process to `$OD_FAKE_AGENT_OUT/agents.jsonl` (nothing when the variable is unset).
fn record() {
    let Some(dir) = std::env::var_os("OD_FAKE_AGENT_OUT").map(PathBuf::from) else {
        return;
    };
    let line = AgentLine {
        pid: std::process::id(),
        hook_url: std::env::var("OFFICE_DESKS_HOOK_URL").ok(),
        args: std::env::args().skip(1).collect(),
        cwd: std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    };
    let mut text = serde_json::to_string(&line).expect("agent line");
    text.push('\n');
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("agents.jsonl"))
    {
        let _ = f.write_all(text.as_bytes());
    }
}

/// Raw stdin, as R1's `tests/pty_host.rs` does it. Harmless when stdin is a pipe.
mod raw {
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
}
