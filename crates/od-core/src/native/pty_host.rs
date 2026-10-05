//! Agent processes in pseudo-terminals, each mirrored into a headless screen we can read
//! (port of `bridge/src/native/ptyHost.ts`).
//!
//! Every PTY has three plain threads (portable-pty reads and writes block):
//! - a **reader** feeds the output into the [`vt100`] parser and fans the raw bytes out to the
//!   `on_data` subscribers; terminal queries the parser sees (DA1, DA2, DSR, DECRQM) are answered here;
//! - a **writer** drains a queue of input (`write` and query replies), so a child that stops
//!   reading can never block the reader;
//! - a **waiter** waits for the child, reaps it, removes the session and fires `on_exit`.
//!
//! Locks never nest except `term → subs` (reader, attach) and `term → master` (resize); every
//! lock recovers from poisoning, so one panicking subscriber cannot cascade.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::backend::BackendError;
use crate::native::env::{resolve_windows_command, win32_is_absolute, EnvMap, ResolvedCommand};

/// Default PTY width.
pub const COLS: u16 = 120;
/// Default PTY height.
pub const ROWS: u16 = 40;
/// Widest size `resize` accepts (the screen allocates rows × cols cells).
pub const MAX_COLS: u16 = 1000;
/// Tallest size `resize` accepts.
pub const MAX_ROWS: u16 = 500;
/// Lines of history kept per agent.
pub const SCROLLBACK: usize = 1000;
/// `write` to a PTY that is gone.
pub const GONE: &str = "이 에이전트 터미널은 이미 종료됐어요";

/// After this long, `dispose` force-kills survivors (SIGKILL on unix).
const DISPOSE_FORCE_AFTER: Duration = Duration::from_millis(1500);
/// `dispose` never waits longer than this in total.
const DISPOSE_WAIT: Duration = Duration::from_secs(2);
/// After the child exits, how long the waiter lets the reader drain the remaining output before
/// the exit event. Unix readers see EOF at once; a ConPTY reader only after the console closes.
const DRAIN: Duration = Duration::from_millis(200);
/// Further grace after the exit event before a reader without EOF has its screen freed
/// (about 2 s after the exit in total).
const LINGER: Duration = Duration::from_millis(1800);
const READ_BUF: usize = 64 * 1024;

fn lock<T: ?Sized>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---------------------------------------------------------------------------------------------
// Spawning (Windows .cmd shims)

/// Characters cmd.exe interprets even inside quotes. A `.cmd` shim that forwards `%*`
/// re-parses its arguments, so these could break out and run commands (BatBadBut).
/// Same set as `unsafeForCmdShim` in `bridge/src/orcaCli.ts`.
pub fn unsafe_for_cmd_shim(arg: &str) -> bool {
    arg.chars().any(|c| {
        matches!(
            c,
            '"' | '%' | '&' | '|' | '<' | '>' | '^' | '!' | '\r' | '\n' | '`'
        )
    })
}

/// Whether portable-pty's Windows quoting (`append_quoted`) wraps `arg` in quotes.
fn quoted_on_windows(arg: &str) -> bool {
    arg.is_empty()
        || arg
            .chars()
            .any(|c| matches!(c, ' ' | '\t' | '\n' | '\x0b' | '"'))
}

/// The cmd.exe to run shims with: `%ComSpec%` when it is an absolute path, else
/// `%SystemRoot%\System32\cmd.exe`, else plain `cmd.exe` (a PATH search, the last resort: a
/// `cmd.exe` in the agent's cwd or PATH must not win). Keys are matched case-insensitively.
pub fn windows_cmd_exe(env: &EnvMap) -> String {
    let get = |k: &str| {
        env.iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(k))
            .map(|(_, v)| v.as_str())
            .filter(|v| win32_is_absolute(v))
    };
    if let Some(c) = get("ComSpec") {
        return c.to_string();
    }
    if let Some(root) = get("SystemRoot") {
        return format!("{}\\System32\\cmd.exe", root.trim_end_matches(['\\', '/']));
    }
    "cmd.exe".to_string()
}

/// The argv to spawn (program first). Port of `resolveSpawn`.
///
/// Off Windows: `[file, ...args]`. On Windows a `.cmd`/`.bat` shim must run through cmd.exe,
/// and arguments cmd could reinterpret are refused (`unsafe_for_cmd`). TS hands node-pty one
/// finished command line, `cmd.exe /d /s /c "<shim> <args>"`; portable-pty has no raw
/// command-line API and quotes each argv element itself (MSVC rules, `"` → `\"`, which cmd does
/// not understand), so the outer quote pair cannot be produced. Instead the parts go as separate
/// elements: `cmd.exe /d /s /c <shim> <args...>`, each element with a space (or empty) quoted by
/// portable-pty. With `/s`, cmd strips a leading and the last quote only when the text after
/// `/c` *starts* with a quote, so when the shim path itself needs quotes it is preceded by
/// `call` (whose `%` re-expansion and `^` doubling are moot: both are refused).
/// The produced command line is [`windows_command_line`].
pub fn resolve_spawn(
    file: &str,
    args: &[String],
    windows: bool,
    resolve_win: &dyn Fn(&str) -> ResolvedCommand,
    cmd_exe: &str,
) -> Result<Vec<String>, BackendError> {
    if !windows {
        return Ok(std::iter::once(file.to_string())
            .chain(args.iter().cloned())
            .collect());
    }
    let r = resolve_win(file);
    if !r.via_cmd {
        return Ok(std::iter::once(r.file)
            .chain(args.iter().cloned())
            .collect());
    }
    if std::iter::once(&r.file)
        .chain(args)
        .any(|a| unsafe_for_cmd_shim(a))
    {
        return Err(BackendError::with_code(
            format!("{file}.cmd로는 이 인자를 안전하게 넘길 수 없어요"),
            "unsafe_for_cmd",
        ));
    }
    let mut argv: Vec<String> = [cmd_exe, "/d", "/s", "/c"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if quoted_on_windows(&r.file) {
        argv.push("call".to_string());
    }
    argv.push(r.file);
    argv.extend(args.iter().cloned());
    Ok(argv)
}

/// The Windows command line portable-pty builds from `argv` (its `cmdline`/`append_quoted`,
/// minus the PATH search of `argv[0]`). Pure, so the quoting is testable on any host.
pub fn windows_command_line(argv: &[String]) -> String {
    let mut out = String::new();
    for (i, arg) in argv.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        if !quoted_on_windows(arg) {
            out.push_str(arg);
            continue;
        }
        out.push('"');
        let chars: Vec<char> = arg.chars().collect();
        let mut j = 0;
        while j < chars.len() {
            let mut backslashes = 0;
            while j < chars.len() && chars[j] == '\\' {
                j += 1;
                backslashes += 1;
            }
            if j == chars.len() {
                out.extend(std::iter::repeat_n('\\', backslashes * 2));
                break;
            } else if chars[j] == '"' {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
            } else {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(chars[j]);
            }
            j += 1;
        }
        out.push('"');
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Subscriptions

type DataFn = dyn Fn(&[u8]) + Send + Sync;
type ExitFn = dyn Fn(&str, u32) + Send + Sync;

struct Registry<F: ?Sized> {
    next: u64,
    items: BTreeMap<u64, Arc<F>>,
}

type Shared<F> = Arc<Mutex<Registry<F>>>;

fn registry<F: ?Sized>() -> Shared<F> {
    Arc::new(Mutex::new(Registry {
        next: 0,
        items: BTreeMap::new(),
    }))
}

fn subscribe<F: ?Sized + Send + Sync + 'static>(reg: &Shared<F>, f: Arc<F>) -> Subscription {
    let key = {
        let mut r = lock(reg);
        r.next += 1;
        let key = r.next;
        r.items.insert(key, f);
        key
    };
    let weak = Arc::downgrade(reg);
    Subscription {
        off: Some(Box::new(move || {
            if let Some(reg) = weak.upgrade() {
                lock(&reg).items.remove(&key);
            }
        })),
    }
}

fn listeners<F: ?Sized>(reg: &Shared<F>) -> Vec<Arc<F>> {
    lock(reg).items.values().cloned().collect()
}

/// A registered `on_data`/`on_exit` callback. `unsubscribe()` (or dropping it) removes the
/// callback; it holds only a weak reference, so it never keeps a session or the host alive.
/// A delivery already running on the reader thread may still finish after it returns.
#[must_use = "dropping a Subscription unsubscribes at once"]
pub struct Subscription {
    off: Option<Box<dyn FnOnce() + Send + Sync>>,
}

impl Subscription {
    /// A subscription that runs `off` once, on `unsubscribe()` or drop. For other
    /// implementations of the same callbacks (test doubles of the host).
    pub fn new(off: impl FnOnce() + Send + Sync + 'static) -> Self {
        Self {
            off: Some(Box::new(off)),
        }
    }

    pub fn unsubscribe(mut self) {
        if let Some(off) = self.off.take() {
            off();
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(off) = self.off.take() {
            off();
        }
    }
}

impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Subscription")
    }
}

// ---------------------------------------------------------------------------------------------
// The headless screen

/// Modes xterm keeps that vt100 does not track; replayed by `serialize`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ExtraModes {
    /// `?1004`: focus in/out reports.
    focus: bool,
    /// `?7` DECAWM (on by default). vt100 always wraps; this only travels to attached terminals.
    autowrap: bool,
    /// `4` IRM. vt100 does not insert; this only travels to attached terminals.
    insert: bool,
}

impl Default for ExtraModes {
    fn default() -> Self {
        Self {
            focus: false,
            autowrap: true,
            insert: false,
        }
    }
}

/// A switch vt100 can't make from a callback (its setters are private): done by feeding it a
/// sequence it does handle, right after the one that asked for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Inject {
    /// DECSTR: cursor visible again (and IRM off, DECAWM on, focus reporting off in `ExtraModes`).
    ShowCursor,
    /// `?1047h`/`?1047l`: the alternate screen, as vt100's `?47`.
    AltOn,
    AltOff,
}

/// What vt100 leaves to us: answering queries (DA1, DA2, DSR, DECRQM), DECSTR, `?1047` and a
/// few modes.
#[derive(Default)]
struct Hooks {
    replies: Vec<u8>,
    inject: Vec<Inject>,
    modes: ExtraModes,
}

fn first_param(params: &[&[u16]]) -> u16 {
    params.first().and_then(|p| p.first()).copied().unwrap_or(0)
}

fn has_param(params: &[&[u16]], v: u16) -> bool {
    params.iter().any(|p| p.first() == Some(&v))
}

/// DECRQM state: 1 set, 2 reset.
fn mode_state(on: bool) -> u8 {
    if on {
        1
    } else {
        2
    }
}

impl Hooks {
    /// DECRQM answer for a DEC private mode: the ones vt100 or `ExtraModes` track, else 0.
    fn dec_mode(&self, screen: &vt100::Screen, mode: u16) -> u8 {
        match mode {
            1 => mode_state(screen.application_cursor()),
            7 => mode_state(self.modes.autowrap),
            25 => mode_state(!screen.hide_cursor()),
            47 | 1047 | 1049 => mode_state(screen.alternate_screen()),
            1004 => mode_state(self.modes.focus),
            2004 => mode_state(screen.bracketed_paste()),
            _ => 0,
        }
    }
}

impl vt100::Callbacks for Hooks {
    fn unhandled_csi(
        &mut self,
        screen: &mut vt100::Screen,
        i1: Option<u8>,
        i2: Option<u8>,
        params: &[&[u16]],
        c: char,
    ) {
        match (i1, i2, c) {
            // DECRQM: `CSI ? Ps $ p` (DEC private) and `CSI Ps $ p` (ANSI), answered as
            // xterm.js 6 does for the modes we track; everything else is "not recognized" (0).
            (Some(b'?'), Some(b'$'), 'p') => {
                let mode = first_param(params);
                let reply = format!("\x1b[?{mode};{}$y", self.dec_mode(screen, mode));
                self.replies.extend_from_slice(reply.as_bytes());
                return;
            }
            (Some(b'$'), None, 'p') => {
                let mode = first_param(params);
                let state = match mode {
                    4 => mode_state(self.modes.insert),
                    _ => 0,
                };
                let reply = format!("\x1b[{mode};{state}$y");
                self.replies.extend_from_slice(reply.as_bytes());
                return;
            }
            // DA2: `CSI > c` / `CSI > 0 c`, xterm.js's fixed answer. Like xterm.js, only the
            // first parameter counts (`CSI > 0 ; 1 c` is answered too).
            (Some(b'>'), None, 'c') if first_param(params) == 0 => {
                self.replies.extend_from_slice(b"\x1b[>0;276;0c");
                return;
            }
            _ => {}
        }
        match (i1, c) {
            // DA1: `CSI c` / `CSI 0 c`, answered as xterm.js does (VT100 with advanced video).
            // xterm.js's `sendDeviceAttributesPrimary` checks only the first parameter.
            (None, 'c') if first_param(params) == 0 => {
                self.replies.extend_from_slice(b"\x1b[?1;2c");
            }
            (None, 'n') => match first_param(params) {
                // DSR cursor position, 1-based, at the moment of the query.
                6 => {
                    let (row, col) = screen.cursor_position();
                    let reply = format!("\x1b[{};{}R", row + 1, col + 1);
                    self.replies.extend_from_slice(reply.as_bytes());
                }
                5 => self.replies.extend_from_slice(b"\x1b[0n"),
                _ => {}
            },
            (None, 'h' | 'l') if has_param(params, 4) => self.modes.insert = c == 'h',
            // DECSTR (soft reset), as xterm: IRM off, DECAWM on, focus reporting off, cursor shown.
            (Some(b'!'), 'p') => {
                self.modes.insert = false;
                self.modes.autowrap = true;
                self.modes.focus = false;
                self.inject.push(Inject::ShowCursor);
            }
            // vt100 calls this once per param it doesn't handle, with all params: set, don't toggle.
            (Some(b'?'), 'h' | 'l') => {
                let on = c == 'h';
                if has_param(params, 1004) {
                    self.modes.focus = on;
                }
                if has_param(params, 7) {
                    self.modes.autowrap = on;
                }
                if has_param(params, 1047) {
                    let want = if on { Inject::AltOn } else { Inject::AltOff };
                    if self.inject.last() != Some(&want) {
                        self.inject.push(want);
                    }
                }
            }
            _ => {}
        }
    }
}

/// Input modes an attached keyboard must encode for (xterm's `bracketedPasteMode` and
/// `applicationCursorKeysMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TermModes {
    pub bracketed_paste: bool,
    pub application_cursor: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TermSize {
    pub cols: u16,
    pub rows: u16,
}

/// A row as xterm's `translateToString(trim)`: empty cells read as spaces, the second half of a
/// wide char is skipped, and `trim` drops trailing cells that were never written (erased cells),
/// while explicitly written spaces stay.
pub fn row_text(screen: &vt100::Screen, row: u16, trim: bool) -> String {
    let (_, cols) = screen.size();
    let width = |c: &vt100::Cell| if c.is_wide() { 2 } else { 1 };
    let end = if trim {
        (0..cols)
            .filter_map(|col| {
                let c = screen.cell(row, col)?;
                c.has_contents().then(|| col + width(c))
            })
            .next_back()
            .unwrap_or(0)
            .min(cols)
    } else {
        cols
    };
    let mut out = String::new();
    let mut col = 0;
    while col < end {
        let Some(c) = screen.cell(row, col) else {
            break;
        };
        if c.is_wide_continuation() {
            col += 1;
            continue;
        }
        if c.has_contents() {
            out.push_str(c.contents());
        } else {
            out.push(' ');
        }
        col += width(c);
    }
    out
}

/// The parser plus our hooks. Every accessor leaves the scrollback view at 0.
struct Term {
    parser: vt100::Parser<Hooks>,
    /// Where we are in an escape sequence, carried across reads.
    esc: EscState,
}

/// A deliberately small escape-sequence tracker, run alongside the parser to find the bytes
/// after which vt100 may have dispatched something we act on: a CSI final `p` (DECSTR) or
/// `h`/`l` (`?1047`, modes), or `c` right after ESC (RIS). The chunk is cut right after those,
/// so an injected sequence lands exactly where the parser is back in its ground state, however
/// the sequence was split over reads. Plain text is never cut. Strings (OSC, DCS) are treated as
/// ground; if the tracker ever misses a cut, injections wait for the next cut or for a chunk
/// that ends in ground (see `Term::process`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum EscState {
    #[default]
    Ground,
    Esc,
    Csi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cut {
    Csi,
    Ris,
}

impl EscState {
    fn step(&mut self, b: u8) -> Option<Cut> {
        let (next, cut) = match (*self, b) {
            (_, 0x1b) => (EscState::Esc, None),
            (EscState::Ground, _) => (EscState::Ground, None),
            (EscState::Esc, b'[') => (EscState::Csi, None),
            (EscState::Esc, b'c') => (EscState::Ground, Some(Cut::Ris)),
            (EscState::Esc, _) => (EscState::Ground, None),
            // parameters and intermediates
            (EscState::Csi, 0x20..=0x3F) => (EscState::Csi, None),
            (EscState::Csi, b'p' | b'h' | b'l') => (EscState::Ground, Some(Cut::Csi)),
            (EscState::Csi, 0x40..=0x7E) => (EscState::Ground, None),
            // CAN / SUB abort; other C0 controls execute inside a CSI without ending it
            (EscState::Csi, 0x18 | 0x1a) => (EscState::Ground, None),
            (EscState::Csi, 0x00..=0x1F) => (EscState::Csi, None),
            (EscState::Csi, _) => (EscState::Ground, None),
        };
        *self = next;
        cut
    }
}

impl Term {
    fn new(rows: u16, cols: u16) -> Self {
        Self {
            parser: vt100::Parser::new_with_callbacks(rows, cols, SCROLLBACK, Hooks::default()),
            esc: EscState::Ground,
        }
    }

    /// Parse output; returns the replies to the queries it contained, in order.
    fn process(&mut self, data: &[u8]) -> Vec<u8> {
        let mut start = 0;
        for (i, &b) in data.iter().enumerate() {
            let Some(cut) = self.esc.step(b) else {
                continue;
            };
            self.parser.process(&data[start..=i]);
            start = i + 1;
            if cut == Cut::Ris {
                self.parser.callbacks_mut().modes = ExtraModes::default();
            }
            self.inject();
        }
        self.parser.process(&data[start..]);
        if self.esc == EscState::Ground {
            self.inject();
        }
        std::mem::take(&mut self.parser.callbacks_mut().replies)
    }

    /// Feed vt100 what the callbacks asked for. Only called where the parser is in ground state.
    fn inject(&mut self) {
        for inject in std::mem::take(&mut self.parser.callbacks_mut().inject) {
            self.parser.process(match inject {
                Inject::ShowCursor => b"\x1b[?25h",
                Inject::AltOn => b"\x1b[?47h",
                Inject::AltOff => b"\x1b[?47l",
            });
        }
    }

    fn screen(&mut self) -> &vt100::Screen {
        self.parser.screen_mut().set_scrollback(0);
        self.parser.screen()
    }

    fn size(&self) -> TermSize {
        let (rows, cols) = self.parser.screen().size();
        TermSize { cols, rows }
    }

    fn screen_lines(&mut self) -> Vec<String> {
        let screen = self.screen();
        let (rows, _) = screen.size();
        (0..rows).map(|r| row_text(screen, r, true)).collect()
    }

    fn scrollback_len(&mut self) -> usize {
        scrollback_len(self.parser.screen_mut())
    }

    /// History (oldest first) followed by the screen, each line as in `screen_lines`.
    fn scroll_lines(&mut self) -> Vec<String> {
        let n = self.scrollback_len();
        let screen = self.parser.screen_mut();
        let mut out = Vec::with_capacity(n + usize::from(screen.size().0));
        for j in 0..n {
            screen.set_scrollback(n - j);
            out.push(row_text(screen, 0, true));
        }
        out.extend(self.screen_lines());
        out
    }

    fn view<R>(&mut self, scroll: usize, f: impl FnOnce(&vt100::Screen) -> R) -> R {
        self.parser.screen_mut().set_scrollback(scroll);
        let r = catch_unwind(AssertUnwindSafe(|| f(self.parser.screen())));
        self.parser.screen_mut().set_scrollback(0);
        r.unwrap_or_else(|p| std::panic::resume_unwind(p))
    }

    /// Escape sequences that repaint a fresh terminal of the same size: history (pushed into its
    /// scrollback), then the screen, cursor and input modes, then the modes vt100 doesn't track.
    /// On the alternate screen the normal screen (with its history) goes first, then
    /// `?1049h` and the alternate screen, so the terminal shows the right thing after `?1049l`.
    fn serialize(&mut self) -> String {
        let screen = self.parser.screen_mut();
        screen.set_scrollback(0);
        let mut out = Vec::new();
        if screen.alternate_screen() {
            let (rows, cols) = screen.size();
            let mut normal = vt100::Parser::new(rows, cols, SCROLLBACK);
            *normal.screen_mut() = screen.clone();
            normal.process(b"\x1b[?47l"); // back to the normal grid, untouched since we left it
            out.extend(serialize_screen(normal.screen_mut()));
            // Default SGR first: `?1049h` saves it with the cursor, and `?1049l` must not bring
            // back the alternate screen's attributes.
            out.extend_from_slice(b"\x1b[m\x1b[?1049h");
            out.extend(screen.state_formatted());
        } else {
            out.extend(serialize_screen(screen));
        }
        let m = self.parser.callbacks().modes;
        if m.focus {
            out.extend_from_slice(b"\x1b[?1004h");
        }
        if !m.autowrap {
            out.extend_from_slice(b"\x1b[?7l");
        }
        if m.insert {
            out.extend_from_slice(b"\x1b[4h");
        }
        String::from_utf8_lossy(&out).into_owned()
    }
}

fn scrollback_len(screen: &mut vt100::Screen) -> usize {
    screen.set_scrollback(usize::MAX);
    let n = screen.scrollback();
    screen.set_scrollback(0);
    n
}

/// The active grid of `screen`: history, then `state_formatted`.
fn serialize_screen(screen: &mut vt100::Screen) -> Vec<u8> {
    let n = scrollback_len(screen);
    let (rows, cols) = screen.size();
    let mut out = Vec::new();
    if n > 0 {
        // History rows are printed from the top, one per line, then blank lines scroll the
        // last of them off the screen; the screen itself is repainted after that.
        out.extend_from_slice(b"\x1b[m\x1b[H\x1b[2J");
        for j in 0..n {
            screen.set_scrollback(n - j);
            if let Some(row) = screen.rows_formatted(0, cols).next() {
                out.extend_from_slice(&row);
            }
            out.extend_from_slice(b"\x1b[m\r\n");
        }
        for _ in 1..rows {
            out.extend_from_slice(b"\r\n");
        }
        screen.set_scrollback(0);
    }
    out.extend(screen.state_formatted());
    out
}

/// How many leading bytes of `buf` end on a UTF-8 character boundary (an incomplete trailing
/// sequence is held back for the next read, so every chunk subscribers see decodes cleanly).
fn utf8_complete_len(buf: &[u8]) -> usize {
    let len = buf.len();
    for back in 1..=len.min(4) {
        let b = buf[len - back];
        if b & 0xC0 == 0x80 {
            continue; // continuation byte
        }
        let need = match b {
            0x00..=0x7F => 1,
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => 1, // invalid lead: let it through
        };
        return if back < need { len - back } else { len };
    }
    len
}

// ---------------------------------------------------------------------------------------------
// Sessions

struct Proc {
    exited: bool,
    pid: Option<u32>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

struct Session {
    seq: u64,
    term: Mutex<Term>,
    subs: Shared<DataFn>,
    /// Live `ReplyMute` guards; replies go out only while there are none.
    mutes: AtomicUsize,
    input: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    proc: Mutex<Proc>,
}

impl Session {
    fn send(&self, data: Vec<u8>) -> bool {
        lock(&self.input)
            .as_ref()
            .is_some_and(|tx| tx.send(data).is_ok())
    }

    /// Output (or `feed`): parse, answer queries, then hand the bytes to subscribers outside
    /// the locks (the subscriber list is taken under the screen lock, so `attach` is atomic).
    ///
    /// A panic inside the parser must not kill the reader (the agent would freeze with a full
    /// PTY buffer): the screen is replaced by a blank one of the same size and reading goes on.
    fn output(&self, chunk: &[u8], broadcast: bool) {
        let (replies, subs) = {
            let mut term = lock(&self.term);
            let replies = match catch_unwind(AssertUnwindSafe(|| term.process(chunk))) {
                Ok(r) => r,
                Err(_) => {
                    let TermSize { cols, rows } = term.size();
                    *term = Term::new(rows, cols);
                    Vec::new()
                }
            };
            let subs = if broadcast {
                listeners(&self.subs)
            } else {
                Vec::new()
            };
            (replies, subs)
        };
        if !replies.is_empty() && self.mutes.load(Ordering::SeqCst) == 0 {
            self.send(replies);
        }
        for f in subs {
            let _ = catch_unwind(AssertUnwindSafe(|| f(chunk)));
        }
    }

    /// Signal the child unless it has already exited. The waiter marks `exited` before it reaps,
    /// under this lock, so a pid is never signalled after it could have been reused.
    fn signal(&self, force: bool) {
        let mut p = lock(&self.proc);
        if p.exited {
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = p.pid {
            let sig = if force { libc::SIGKILL } else { libc::SIGHUP };
            // SAFETY: plain syscall; `pid` is our unreaped child.
            unsafe { libc::kill(pid as libc::pid_t, sig) };
            return;
        }
        let _ = force;
        let _ = p.killer.kill();
    }

    /// Stop input and close the PTY (on Windows this closes the ConPTY, ending the reader).
    fn close(&self) {
        let tx = lock(&self.input).take();
        drop(tx);
        let master = lock(&self.master).take();
        drop(master);
    }
}

/// Block until the child has exited, without reaping it.
#[cfg(unix)]
fn wait_exited_unreaped(pid: u32) {
    loop {
        // SAFETY: zeroed siginfo_t is a valid out-parameter for waitid.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let r = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if r == 0 || std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return;
        }
    }
}

/// Keeps the headless terminal from answering queries while it lives (see
/// [`PtyHost::mute_replies`]).
#[must_use = "dropping the ReplyMute turns replies back on"]
pub struct ReplyMute {
    session: Weak<Session>,
}

impl Drop for ReplyMute {
    fn drop(&mut self) {
        if let Some(s) = self.session.upgrade() {
            s.mutes.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

impl std::fmt::Debug for ReplyMute {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ReplyMute")
    }
}

/// What to run in a PTY.
#[derive(Debug, Clone, Default)]
pub struct PtyOptions {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// The complete environment (the parent's is not inherited).
    pub env: EnvMap,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

struct Inner {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    exits: Shared<ExitFn>,
    live: tokio::sync::watch::Sender<usize>,
    /// Sessions already out of the map whose exit listeners are still running. They count as
    /// live, so `dispose` returns only after every exit event has been delivered.
    exiting: AtomicUsize,
    seq: AtomicU64,
}

impl Inner {
    fn publish_count(&self) {
        let n = {
            let map = lock(&self.sessions);
            map.len() + self.exiting.load(Ordering::SeqCst)
        };
        self.live.send_replace(n);
    }
}

/// Agent processes in pseudo-terminals, each mirrored into a headless screen.
///
/// Dropping the host sends every remaining child SIGHUP (TerminateProcess on Windows) without
/// waiting; `dispose().await` kills and reaps them.
pub struct PtyHost {
    inner: Arc<Inner>,
}

impl Default for PtyHost {
    fn default() -> Self {
        Self::new()
    }
}

/// node-pty throws a plain `Error` when it can't create the PTY or process.
fn spawn_error(e: impl std::fmt::Display) -> BackendError {
    BackendError::plain(e.to_string())
}

impl PtyHost {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions: Mutex::new(HashMap::new()),
                exits: registry(),
                live: tokio::sync::watch::channel(0).0,
                exiting: AtomicUsize::new(0),
                seq: AtomicU64::new(0),
            }),
        }
    }

    fn get(&self, id: &str) -> Option<Arc<Session>> {
        lock(&self.inner.sessions).get(id).cloned()
    }

    fn all(&self) -> Vec<Arc<Session>> {
        lock(&self.inner.sessions).values().cloned().collect()
    }

    /// Start `opts.file` in a new PTY under `id`. Fails for an id that is still live (TS would
    /// silently orphan the old process), for arguments a Windows .cmd shim can't carry safely
    /// (`unsafe_for_cmd`), and when the PTY or process can't be created.
    pub fn spawn(&self, id: &str, opts: PtyOptions) -> Result<(), BackendError> {
        if self.has(id) {
            return Err(BackendError::new(format!(
                "이미 실행 중인 에이전트 터미널이에요: {id}"
            )));
        }
        let cols = opts.cols.unwrap_or(COLS);
        let rows = opts.rows.unwrap_or(ROWS);
        let argv = resolve_spawn(
            &opts.file,
            &opts.args,
            cfg!(windows),
            &|f| resolve_windows_command(f, &opts.env, &|p| Path::new(p).exists()),
            &windows_cmd_exe(&opts.env),
        )?;
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(spawn_error)?;
        let mut cmd = CommandBuilder::from_argv(argv.into_iter().map(OsString::from).collect());
        cmd.env_clear();
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }
        if !cfg!(windows) {
            cmd.env("TERM", "xterm-256color"); // node-pty sets TERM from its `name`
        }
        cmd.cwd(&opts.cwd);
        let mut child = pair.slave.spawn_command(cmd).map_err(spawn_error)?;
        drop(pair.slave); // or the reader never sees EOF
        let master = pair.master;
        let io = master
            .try_clone_reader()
            .and_then(|r| Ok((r, master.take_writer()?)));
        let (reader, writer) = match io {
            Ok(io) => io,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(spawn_error(e));
            }
        };

        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
        let session = Arc::new(Session {
            seq: self.inner.seq.fetch_add(1, Ordering::SeqCst),
            term: Mutex::new(Term::new(rows, cols)),
            subs: registry(),
            mutes: AtomicUsize::new(0),
            input: Mutex::new(Some(input_tx)),
            master: Mutex::new(Some(master)),
            proc: Mutex::new(Proc {
                exited: false,
                pid: child.process_id(),
                killer: child.clone_killer(),
            }),
        });
        let raced = {
            let mut map = lock(&self.inner.sessions);
            if map.contains_key(id) {
                true // another spawn took this id while ours started
            } else {
                map.insert(id.to_string(), session.clone());
                false
            }
        };
        if raced {
            session.close();
            let _ = child.kill();
            let _ = child.wait();
            return Err(BackendError::new(format!(
                "이미 실행 중인 에이전트 터미널이에요: {id}"
            )));
        }
        self.inner.publish_count();

        // Writer and reader start before we return: ConPTY asks for the cursor position at
        // startup (PSEUDOCONSOLE_INHERIT_CURSOR) and waits for our answer. The waiter starts
        // first and gets the child only once everything runs, so on any failure here we still
        // own the child and reap it ourselves.
        let (child_tx, child_rx) = mpsc::channel::<Box<dyn Child + Send + Sync>>();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let started = {
            let s = session.clone();
            let weak = Arc::downgrade(&self.inner);
            let wid = id.to_string();
            thread::Builder::new()
                .name(format!("pty-wait-{id}"))
                .spawn(move || {
                    if let Ok(child) = child_rx.recv() {
                        waiter(child, s, weak, wid, done_rx);
                    }
                })
        }
        .and_then(|_| {
            thread::Builder::new()
                .name(format!("pty-write-{id}"))
                .spawn(move || writer_loop(writer, input_rx))
        })
        .and_then(|_| {
            let s = session.clone();
            thread::Builder::new()
                .name(format!("pty-read-{id}"))
                .spawn(move || reader_loop(reader, s, done_tx))
        });
        if let Err(e) = started {
            lock(&self.inner.sessions).remove(id);
            self.inner.publish_count();
            session.close();
            lock(&session.proc).exited = true;
            let _ = child.kill();
            let _ = child.wait();
            return Err(spawn_error(e)); // dropping child_tx ends the waiter, if it started
        }
        if let Err(mpsc::SendError(mut child)) = child_tx.send(child) {
            // The waiter is gone (it can't be before recv, but never leave a child unreaped).
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    pub fn has(&self, id: &str) -> bool {
        lock(&self.inner.sessions).contains_key(id)
    }

    /// Queue input for the process. `terminal_not_writable` once the PTY is gone.
    pub fn write(&self, id: &str, data: impl AsRef<[u8]>) -> Result<(), BackendError> {
        let gone = || BackendError::with_code(GONE, "terminal_not_writable");
        let s = self.get(id).ok_or_else(gone)?;
        if s.send(data.as_ref().to_vec()) {
            Ok(())
        } else {
            Err(gone())
        }
    }

    /// The visible screen, one string per row (`rows` of them), each as xterm's
    /// `translateToString(true)`. Empty for an unknown id.
    pub fn screen_lines(&self, id: &str) -> Vec<String> {
        self.get(id)
            .map(|s| lock(&s.term).screen_lines())
            .unwrap_or_default()
    }

    /// History (oldest first, up to [`SCROLLBACK`] lines) followed by the screen.
    pub fn scroll_lines(&self, id: &str) -> Vec<String> {
        self.get(id)
            .map(|s| lock(&s.term).scroll_lines())
            .unwrap_or_default()
    }

    /// Lines of history above the screen (xterm's `baseY`, the TUI's max scroll).
    pub fn scrollback_len(&self, id: &str) -> usize {
        self.get(id)
            .map(|s| lock(&s.term).scrollback_len())
            .unwrap_or(0)
    }

    /// Read the screen as it looks scrolled back `scroll` lines (0 = live; clamped), for drawing
    /// and selection. Runs under the screen lock: keep `f` short, and never call back into the
    /// host from it (the lock is not re-entrant; `f` would deadlock its own thread). Everything
    /// needed is on `&Screen`: `size()`, `cell(row, col)`, `row_wrapped(row)`,
    /// `cursor_position()`, `hide_cursor()`, `alternate_screen()`, and [`row_text`].
    pub fn with_screen<R>(
        &self,
        id: &str,
        scroll: usize,
        f: impl FnOnce(&vt100::Screen) -> R,
    ) -> Option<R> {
        let s = self.get(id)?;
        let mut term = lock(&s.term);
        Some(term.view(scroll, f))
    }

    /// Live output of one agent; `None` for an unknown id.
    #[must_use = "dropping the Subscription unsubscribes"]
    pub fn on_data(
        &self,
        id: &str,
        f: impl Fn(&[u8]) + Send + Sync + 'static,
    ) -> Option<Subscription> {
        let s = self.get(id)?;
        Some(subscribe(&s.subs, Arc::new(f) as Arc<DataFn>))
    }

    /// `serialize` and `on_data` in one step, so no output falls between the snapshot and the
    /// stream or appears in both. `f` may run (on the reader thread) before this returns: queue
    /// what it gets and send the snapshot first.
    #[must_use = "dropping the Subscription unsubscribes"]
    pub fn attach(
        &self,
        id: &str,
        f: impl Fn(&[u8]) + Send + Sync + 'static,
    ) -> Option<(String, Subscription)> {
        let s = self.get(id)?;
        let mut term = lock(&s.term);
        let snapshot = term.serialize();
        let sub = subscribe(&s.subs, Arc::new(f) as Arc<DataFn>);
        Some((snapshot, sub))
    }

    /// Resize the PTY and the screen. Ignored for unknown ids, sizes under 2, more than
    /// [`MAX_COLS`] × [`MAX_ROWS`] (the screen allocates every cell), the current size, and when
    /// the PTY refuses (the process exited and its exit event is on the way).
    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        let Some(s) = self.get(id) else {
            return;
        };
        if !(2..=MAX_COLS).contains(&cols) || !(2..=MAX_ROWS).contains(&rows) {
            return;
        }
        let mut term = lock(&s.term);
        if term.size() == (TermSize { cols, rows }) {
            return;
        }
        let ok = lock(&s.master).as_ref().is_some_and(|m| {
            m.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .is_ok()
        });
        if ok {
            term.parser.screen_mut().set_size(rows, cols);
        }
    }

    /// Whether the agent hid its cursor (DECTCEM; reset by RIS and DECSTR).
    pub fn cursor_hidden(&self, id: &str) -> bool {
        self.get(id)
            .is_some_and(|s| lock(&s.term).parser.screen().hide_cursor())
    }

    /// The input modes the agent asked for.
    pub fn modes(&self, id: &str) -> Option<TermModes> {
        let s = self.get(id)?;
        let term = lock(&s.term);
        let screen = term.parser.screen();
        Some(TermModes {
            bracketed_paste: screen.bracketed_paste(),
            application_cursor: screen.application_cursor(),
        })
    }

    /// Live PTY ids, oldest first.
    pub fn ids(&self) -> Vec<String> {
        let map = lock(&self.inner.sessions);
        let mut v: Vec<(u64, String)> = map.iter().map(|(k, s)| (s.seq, k.clone())).collect();
        v.sort();
        v.into_iter().map(|(_, k)| k).collect()
    }

    pub fn size(&self, id: &str) -> Option<TermSize> {
        self.get(id).map(|s| lock(&s.term).size())
    }

    /// The process id of the agent (None once it is gone).
    pub fn pid(&self, id: &str) -> Option<u32> {
        self.get(id).and_then(|s| lock(&s.proc).pid)
    }

    /// The current screen as escape sequences, to repaint a real terminal losslessly
    /// (empty for an unknown id). See [`PtyHost::attach`] for a gap-free attach.
    pub fn serialize(&self, id: &str) -> String {
        self.get(id)
            .map(|s| lock(&s.term).serialize())
            .unwrap_or_default()
    }

    /// While a real terminal is attached it answers the agent's terminal queries itself;
    /// the headless copy must stay quiet or the agent gets every answer twice. Replies stay off
    /// until every guard is dropped (two attached terminals each hold one). `None` for an
    /// unknown id.
    pub fn mute_replies(&self, id: &str) -> Option<ReplyMute> {
        let s = self.get(id)?;
        s.mutes.fetch_add(1, Ordering::SeqCst);
        Some(ReplyMute {
            session: Arc::downgrade(&s),
        })
    }

    /// Feed bytes to the headless screen as if the process printed them (not passed to
    /// `on_data`; queries in it are answered). For tests.
    #[doc(hidden)]
    pub fn feed(&self, id: &str, data: impl AsRef<[u8]>) {
        if let Some(s) = self.get(id) {
            s.output(data.as_ref(), false);
        }
    }

    /// Like [`PtyHost::feed`], but also delivered to `on_data`/`attach` subscribers, exactly as
    /// output the process printed. For tests (a deterministic flood).
    #[doc(hidden)]
    pub fn feed_output(&self, id: &str, data: impl AsRef<[u8]>) {
        if let Some(s) = self.get(id) {
            s.output(data.as_ref(), true);
        }
    }

    /// Called with `(id, exit_code)` on the waiter thread after a PTY's process exited and it
    /// was removed. A process killed by a signal (unix) reports 1, as portable-pty maps it;
    /// node-pty reported 0 plus the signal. Agents are only told apart by exit, not by code.
    pub fn on_exit(&self, f: impl Fn(&str, u32) + Send + Sync + 'static) -> Subscription {
        subscribe(&self.inner.exits, Arc::new(f) as Arc<ExitFn>)
    }

    /// Hang up the agent (SIGHUP, as node-pty; TerminateProcess on Windows).
    pub fn kill(&self, id: &str) {
        if let Some(s) = self.get(id) {
            s.signal(false);
        }
    }

    /// Kill every agent and wait (at most 2 s) until all have exited and been reaped.
    /// Survivors of the hang-up are force-killed after 1.5 s.
    /// Needs a tokio runtime with the time driver enabled (it panics without one); a sync
    /// caller can `block_on` it on a small current-thread runtime built with `enable_time()`.
    pub async fn dispose(&self) {
        let sessions = self.all();
        if sessions.is_empty() {
            return;
        }
        let mut live = self.inner.live.subscribe();
        for s in &sessions {
            s.signal(false);
        }
        let all_gone = tokio::time::timeout(DISPOSE_FORCE_AFTER, live.wait_for(|n| *n == 0))
            .await
            .is_ok_and(|r| r.is_ok());
        if !all_gone {
            for s in self.all() {
                s.signal(true);
            }
            let rest = DISPOSE_WAIT - DISPOSE_FORCE_AFTER;
            let _ = tokio::time::timeout(rest, live.wait_for(|n| *n == 0))
                .await
                .is_ok_and(|r| r.is_ok());
        }
    }
}

impl Drop for PtyHost {
    fn drop(&mut self) {
        for s in self.all() {
            s.signal(false);
            s.close();
        }
    }
}

fn writer_loop(mut writer: Box<dyn Write + Send>, rx: mpsc::Receiver<Vec<u8>>) {
    for data in rx {
        if writer
            .write_all(&data)
            .and_then(|_| writer.flush())
            .is_err()
        {
            break;
        }
    }
}

fn reader_loop(mut reader: Box<dyn Read + Send>, session: Arc<Session>, _done: mpsc::Sender<()>) {
    let mut buf = vec![0u8; READ_BUF];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        pending.extend_from_slice(&buf[..n]);
        let cut = utf8_complete_len(&pending);
        if cut == 0 {
            continue;
        }
        let chunk: Vec<u8> = pending.drain(..cut).collect();
        session.output(&chunk, true);
    }
    if !pending.is_empty() {
        session.output(&pending, true);
    }
    // `_done` drops here: the waiter stops waiting for the drain.
}

fn waiter(
    mut child: Box<dyn Child + Send + Sync>,
    session: Arc<Session>,
    host: Weak<Inner>,
    id: String,
    drained: mpsc::Receiver<()>,
) {
    #[cfg(unix)]
    if let Some(pid) = child.process_id() {
        wait_exited_unreaped(pid);
    }
    // Unix: still a zombie here, so its pid can't be reused while we flip the flag.
    // Windows: the killer holds a process handle, which pins the process object.
    #[cfg(unix)]
    {
        lock(&session.proc).exited = true;
    }
    let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
    {
        let mut p = lock(&session.proc);
        p.exited = true;
        p.pid = None;
    }
    // Let the reader take in the last output before we report the exit.
    let drain_timed_out = matches!(
        drained.recv_timeout(DRAIN),
        Err(mpsc::RecvTimeoutError::Timeout)
    );
    let Some(inner) = host.upgrade() else {
        session.close();
        return;
    };
    let removed = {
        let mut map = lock(&inner.sessions);
        if map.get(&id).is_some_and(|s| Arc::ptr_eq(s, &session)) {
            map.remove(&id);
            inner.exiting.fetch_add(1, Ordering::SeqCst);
            true
        } else {
            false
        }
    };
    session.close();
    if removed {
        for f in listeners(&inner.exits) {
            let _ = catch_unwind(AssertUnwindSafe(|| f(&id, code)));
        }
        inner.exiting.fetch_sub(1, Ordering::SeqCst);
    }
    inner.publish_count();
    drop(inner);
    // Unix: still no EOF well after the exit means something else (a surviving grandchild)
    // holds the PTY slave. The reader thread and its master fd stay until that process exits or
    // closes it; free the screen, its history and the subscribers so only those remain. The
    // extra grace lets a reader still parsing a large final burst finish it for attached
    // terminals. (On Windows the first timeout is normal: the reader ends once `close` shut the
    // ConPTY.)
    if cfg!(unix)
        && drain_timed_out
        && matches!(
            drained.recv_timeout(LINGER),
            Err(mpsc::RecvTimeoutError::Timeout)
        )
    {
        *lock(&session.term) = Term::new(1, 1);
        lock(&session.subs).items.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(rows: u16, cols: u16) -> Term {
        Term::new(rows, cols)
    }

    // --- screen text ---

    #[test]
    fn screen_lines_match_translate_to_string_trim() {
        let mut t = term(4, 10);
        // explicit trailing spaces stay; erased tail is trimmed; wide chars take one string slot
        t.process("ab  \r\n".as_bytes());
        t.process("한글x\r\n".as_bytes());
        t.process("✅ok\x1b[K".as_bytes());
        t.process(b"\r\n\x1b[5Cz");
        let lines = t.screen_lines();
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0], "ab  ");
        assert_eq!(lines[1], "한글x");
        assert_eq!(lines[2], "✅ok");
        assert_eq!(lines[3], "     z"); // skipped (never written) cells read as spaces
    }

    #[test]
    fn erased_trailing_cells_are_trimmed() {
        let mut t = term(2, 10);
        t.process(b"hello world\x1b[1;6H\x1b[K");
        assert_eq!(t.screen_lines()[0], "hello");
    }

    #[test]
    fn row_text_untrimmed_is_full_width() {
        let mut t = term(2, 6);
        t.process("a한".as_bytes());
        let s = t.screen();
        assert_eq!(row_text(s, 0, false), "a한   ");
    }

    #[test]
    fn scroll_lines_returns_history_then_screen() {
        let mut t = term(3, 10);
        for i in 0..6 {
            t.process(format!("line{i}\r\n").as_bytes());
        }
        assert_eq!(t.scrollback_len(), 4);
        let all = t.scroll_lines();
        assert_eq!(
            all[..6],
            ["line0", "line1", "line2", "line3", "line4", "line5"]
        );
        assert_eq!(all.len(), 7);
        // and the live view is untouched
        assert_eq!(t.screen_lines(), ["line4", "line5", ""]);
        let first = t.view(4, |s| row_text(s, 0, true));
        assert_eq!(first, "line0");
        assert_eq!(t.screen_lines()[0], "line4");
    }

    // --- query responder ---

    #[test]
    fn answers_device_attributes_and_status_reports() {
        let mut t = term(5, 20);
        assert_eq!(t.process(b"\x1b[c"), b"\x1b[?1;2c");
        assert_eq!(t.process(b"\x1b[0c"), b"\x1b[?1;2c");
        assert_eq!(t.process(b"\x1b[5n"), b"\x1b[0n");
        assert_eq!(t.process(b"\x1b[3;7H\x1b[6n"), b"\x1b[3;7R");
        // cursor read at the moment of the query, not after the whole chunk
        assert_eq!(t.process(b"\x1b[1;1H\x1b[6nabc"), b"\x1b[1;1R");
        // two queries in one chunk, answered in order
        assert_eq!(t.process(b"\x1b[5n\x1b[c"), b"\x1b[0n\x1b[?1;2c");
    }

    #[test]
    fn answers_secondary_device_attributes_like_xterm_js() {
        let mut t = term(5, 20);
        assert_eq!(t.process(b"\x1b[>c"), b"\x1b[>0;276;0c");
        assert_eq!(t.process(b"\x1b[>0c"), b"\x1b[>0;276;0c");
        assert!(t.process(b"\x1b[>1c").is_empty());
        assert_eq!(t.process(b"\x1b[c\x1b[>c"), b"\x1b[?1;2c\x1b[>0;276;0c");
    }

    // Probed with @xterm/headless 6.0.0: DA1 and DA2 look at the first parameter only.
    #[test]
    fn device_attributes_check_only_the_first_param_like_xterm_js() {
        let mut t = term(5, 20);
        assert_eq!(t.process(b"\x1b[>0;1c"), b"\x1b[>0;276;0c");
        assert!(t.process(b"\x1b[>1c").is_empty());
        assert_eq!(t.process(b"\x1b[0;1c"), b"\x1b[?1;2c");
        assert!(t.process(b"\x1b[1c").is_empty());
    }

    #[test]
    fn decstr_turns_focus_reporting_off() {
        let mut t = term(5, 20);
        t.process(b"\x1b[?1004h");
        assert_eq!(t.process(b"\x1b[?1004$p"), b"\x1b[?1004;1$y");
        t.process(b"\x1b[!p");
        assert_eq!(t.process(b"\x1b[?1004$p"), b"\x1b[?1004;2$y");
        assert!(!t.serialize().contains("\x1b[?1004h"));
    }

    /// Expected replies probed from @xterm/headless 6 (`node -e`), defaults then all set.
    #[test]
    fn answers_mode_requests_for_the_modes_it_tracks() {
        let mut t = term(5, 20);
        let ask = |t: &mut Term, q: &str| String::from_utf8(t.process(q.as_bytes())).unwrap();
        let defaults = [
            ("\x1b[?2004$p", "\x1b[?2004;2$y"),
            ("\x1b[?1$p", "\x1b[?1;2$y"),
            ("\x1b[?25$p", "\x1b[?25;1$y"),
            ("\x1b[?1004$p", "\x1b[?1004;2$y"),
            ("\x1b[?7$p", "\x1b[?7;1$y"),
            ("\x1b[4$p", "\x1b[4;2$y"),
            ("\x1b[?1049$p", "\x1b[?1049;2$y"),
            ("\x1b[?47$p", "\x1b[?47;2$y"),
            ("\x1b[?1047$p", "\x1b[?1047;2$y"),
            // not tracked: "not recognized"
            ("\x1b[?9999$p", "\x1b[?9999;0$y"),
            ("\x1b[?2026$p", "\x1b[?2026;0$y"),
            ("\x1b[20$p", "\x1b[20;0$y"),
            ("\x1b[$p", "\x1b[0;0$y"),
            ("\x1b[?$p", "\x1b[?0;0$y"),
            // only the first mode is answered, as in xterm.js
            ("\x1b[?2004;1$p", "\x1b[?2004;2$y"),
        ];
        for (q, want) in defaults {
            assert_eq!(ask(&mut t, q), want, "{q:?}");
        }
        t.process(b"\x1b[?2004h\x1b[?1h\x1b[?25l\x1b[?1004h\x1b[?7l\x1b[4h\x1b[?1049h");
        let set = [
            ("\x1b[?2004$p", "\x1b[?2004;1$y"),
            ("\x1b[?1$p", "\x1b[?1;1$y"),
            ("\x1b[?25$p", "\x1b[?25;2$y"),
            ("\x1b[?1004$p", "\x1b[?1004;1$y"),
            ("\x1b[?7$p", "\x1b[?7;2$y"),
            ("\x1b[4$p", "\x1b[4;1$y"),
            ("\x1b[?1049$p", "\x1b[?1049;1$y"),
            ("\x1b[?47$p", "\x1b[?47;1$y"),
            ("\x1b[?1047$p", "\x1b[?1047;1$y"),
        ];
        for (q, want) in set {
            assert_eq!(ask(&mut t, q), want, "{q:?}");
        }
        // A switch and a query in one chunk: the query sees the switch.
        let mut t = term(5, 20);
        assert_eq!(ask(&mut t, "\x1b[?1047h\x1b[?1049$p"), "\x1b[?1049;1$y");
        assert_eq!(ask(&mut t, "\x1b[?25l\x1b[!p\x1b[?25$p"), "\x1b[?25;1$y");
        // `CSI ? Ps p` without `$` is not DECRQM.
        assert!(t.process(b"\x1b[?2004p").is_empty());
        // split across reads
        assert!(t.process(b"\x1b[?20").is_empty());
        assert!(t.process(b"04$").is_empty());
        assert_eq!(t.process(b"p"), b"\x1b[?2004;2$y");
    }

    #[test]
    fn ignores_queries_it_does_not_implement() {
        let mut t = term(5, 20);
        assert!(t.process(b"\x1b[>1c").is_empty()); // DA2 with a parameter
        assert!(t.process(b"\x1b[?6n").is_empty()); // DECXCPR
        assert!(t.process(b"\x1b[1c").is_empty());
        assert!(t.process(b"\x1b[7n").is_empty());
        assert!(t.process(b"plain c and 6n").is_empty());
    }

    #[test]
    fn answers_queries_split_across_reads() {
        let mut t = term(5, 20);
        t.process(b"ab");
        assert!(t.process(b"\x1b").is_empty());
        assert!(t.process(b"[").is_empty());
        assert!(t.process(b"6").is_empty());
        assert_eq!(t.process(b"n"), b"\x1b[1;3R");
        assert!(t.process(b"\x1b[").is_empty());
        assert_eq!(t.process(b"c"), b"\x1b[?1;2c");
    }

    // --- cursor visibility and modes ---

    #[test]
    fn follows_dectcem_among_other_modes_and_resets() {
        let mut t = term(4, 20);
        let hidden = |t: &mut Term| t.parser.screen().hide_cursor();
        assert!(!hidden(&mut t));
        t.process(b"\x1b[?25l");
        assert!(hidden(&mut t));
        t.process(b"\x1b[?2004;25h");
        assert!(!hidden(&mut t));
        assert!(t.parser.screen().bracketed_paste());
        t.process(b"\x1b[?1;25l");
        assert!(hidden(&mut t));
        assert!(!t.parser.screen().application_cursor());
        t.process(b"\x1bc"); // RIS
        assert!(!hidden(&mut t));
        t.process(b"\x1b[?25l\x1b[!p"); // DECSTR
        assert!(!hidden(&mut t));
        t.process(b"\x1b[!p\x1b[?25l"); // a hide after DECSTR in the same chunk wins
        assert!(hidden(&mut t));
        t.process(b"\x1b[?1h");
        assert!(t.parser.screen().application_cursor());
    }

    // --- serialize ---

    fn snapshot(p: &mut vt100::Parser<impl vt100::Callbacks>) -> (Vec<String>, (u16, u16), bool) {
        let screen = p.screen_mut();
        screen.set_scrollback(0);
        let (rows, _) = screen.size();
        let lines = (0..rows).map(|r| row_text(screen, r, false)).collect();
        (lines, screen.cursor_position(), screen.hide_cursor())
    }

    #[test]
    fn serialize_replays_into_an_identical_screen() {
        let mut t = term(5, 20);
        for i in 0..8 {
            t.process(format!("\x1b[3{}mrow {i} 한✅\x1b[m\r\n", i % 8).as_bytes());
        }
        t.process(b"\x1b[1mbold\x1b[m tail\x1b[2;4H\x1b[?25l\x1b[?2004h\x1b[?1h");
        let s = t.serialize();
        let mut fresh = vt100::Parser::new(5, 20, SCROLLBACK);
        fresh.process(s.as_bytes());

        assert_eq!(snapshot(&mut fresh), snapshot(&mut t.parser));
        // per-cell attributes survive too
        assert_eq!(
            fresh.screen().contents_formatted(),
            t.parser.screen().contents_formatted()
        );
        assert!(fresh.screen().bracketed_paste());
        assert!(fresh.screen().application_cursor());
        // and so does the history
        let mut replay = term(5, 20);
        replay.process(s.as_bytes());
        assert_eq!(replay.scroll_lines(), t.scroll_lines());
    }

    #[test]
    fn serialize_replays_the_alternate_screen() {
        let mut t = term(4, 12);
        t.process(b"normal\r\n\x1b[?1049h\x1b[2;2Hfull screen");
        let s = t.serialize();
        let mut fresh = vt100::Parser::new(4, 12, SCROLLBACK);
        fresh.process(s.as_bytes());
        assert!(fresh.screen().alternate_screen());
        assert_eq!(snapshot(&mut fresh), snapshot(&mut t.parser));
    }

    #[test]
    fn decstr_split_across_reads_does_not_corrupt_what_follows() {
        let mut t = term(3, 20);
        t.process(b"\x1b[?25l");
        t.process(b"\x1b[!");
        t.process(b"p\x1b[3");
        t.process(b"1mRED");
        assert!(!t.parser.screen().hide_cursor());
        assert_eq!(t.screen_lines()[0], "RED");
        let cell = t.parser.screen().cell(0, 0).unwrap();
        assert_eq!(cell.fgcolor(), vt100::Color::Idx(1));
        // and a split RIS resets the tracked modes
        t.process(b"\x1b[?1004h\x1b[?7l\x1b[4h");
        assert_ne!(t.parser.callbacks().modes, ExtraModes::default());
        t.process(b"\x1b");
        t.process(b"c");
        assert_eq!(t.parser.callbacks().modes, ExtraModes::default());
    }

    #[test]
    fn tracks_modes_vt100_ignores_and_replays_them() {
        let mut t = term(3, 20);
        t.process(b"\x1b[?1004;7l\x1b[?1004h\x1b[4h");
        let m = t.parser.callbacks().modes;
        assert_eq!(
            m,
            ExtraModes {
                focus: true,
                autowrap: false,
                insert: true
            }
        );
        let s = t.serialize();
        assert!(s.ends_with("\x1b[?1004h\x1b[?7l\x1b[4h"), "{s:?}");
        let mut replay = term(3, 20);
        replay.process(s.as_bytes());
        assert_eq!(replay.parser.callbacks().modes, m);
        // DECSTR: insert off, autowrap on, focus reporting off (xterm's soft reset)
        t.process(b"\x1b[!p");
        assert_eq!(t.parser.callbacks().modes, ExtraModes::default());
        assert!(!t.serialize().contains("\x1b[?1004h"));
    }

    #[test]
    fn serialize_on_the_alternate_screen_keeps_the_normal_screen_underneath() {
        let mut t = term(4, 12);
        for i in 0..6 {
            t.process(format!("hist{i}\r\n").as_bytes());
        }
        t.process(b"prompt$ \x1b[?1049h\x1b[2;2H\x1b[31mfull\x1b[m screen");
        let s = t.serialize();
        let mut fresh = term(4, 12);
        fresh.process(s.as_bytes());
        assert!(fresh.parser.screen().alternate_screen());
        assert_eq!(snapshot(&mut fresh.parser), snapshot(&mut t.parser));
        assert_eq!(
            fresh.parser.screen().contents_formatted(),
            t.parser.screen().contents_formatted()
        );
        // leaving the alternate screen shows the same normal screen and history on both
        t.process(b"\x1b[?1049l");
        fresh.process(b"\x1b[?1049l");
        assert!(!fresh.parser.screen().alternate_screen());
        assert_eq!(snapshot(&mut fresh.parser), snapshot(&mut t.parser));
        assert_eq!(fresh.scroll_lines(), t.scroll_lines());
        assert!(t.screen_lines().iter().any(|l| l == "prompt$ "));
    }

    #[test]
    fn handles_the_1047_alternate_screen_vt100_ignores() {
        let mut t = term(3, 10);
        t.process(b"normal");
        t.process(b"\x1b[?1047h");
        assert!(t.parser.screen().alternate_screen());
        t.process(b"alt");
        assert_eq!(t.screen_lines()[0], "alt");
        t.process(b"\x1b[?10");
        t.process(b"47l");
        assert!(!t.parser.screen().alternate_screen());
        assert_eq!(t.screen_lines()[0], "normal");
    }

    #[test]
    fn windows_cmd_exe_prefers_an_absolute_comspec() {
        let env = |pairs: &[(&str, &str)]| -> EnvMap {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        assert_eq!(
            windows_cmd_exe(&env(&[
                ("ComSpec", "C:\\WINDOWS\\system32\\cmd.exe"),
                ("SystemRoot", "C:\\Other")
            ])),
            "C:\\WINDOWS\\system32\\cmd.exe"
        );
        assert_eq!(
            windows_cmd_exe(&env(&[("COMSPEC", "D:\\x\\cmd.exe")])),
            "D:\\x\\cmd.exe"
        );
        assert_eq!(
            windows_cmd_exe(&env(&[
                ("ComSpec", "cmd.exe"),
                ("SystemRoot", "C:\\WINDOWS\\")
            ])),
            "C:\\WINDOWS\\System32\\cmd.exe"
        );
        assert_eq!(
            windows_cmd_exe(&env(&[("SYSTEMROOT", "C:\\Windows")])),
            "C:\\Windows\\System32\\cmd.exe"
        );
        assert_eq!(windows_cmd_exe(&env(&[("ComSpec", "")])), "cmd.exe");
        let r = resolve_spawn(
            "claude",
            &sv(&["x"]),
            true,
            &shim("C:\\npm\\claude.cmd"),
            &windows_cmd_exe(&env(&[("ComSpec", "C:\\Program Files\\cmd.exe")])),
        )
        .unwrap();
        assert_eq!(
            windows_command_line(&r),
            "\"C:\\Program Files\\cmd.exe\" /d /s /c C:\\npm\\claude.cmd x"
        );
    }

    fn cuts(data: &[u8]) -> Vec<(usize, Cut)> {
        let mut st = EscState::default();
        data.iter()
            .enumerate()
            .filter_map(|(i, &b)| st.step(b).map(|c| (i, c)))
            .collect()
    }

    #[test]
    fn cuts_only_after_csi_finals_and_ris_never_in_text() {
        assert!(cuts(b"help, hello, clap: plain text with p h l c").is_empty());
        assert!(cuts(b"\x1b]0;title with h and p\x07ok").is_empty());
        assert!(cuts(b"\x1b[31mred\x1b[c\x1b[6n").is_empty());
        assert_eq!(cuts(b"a\x1b[!pb"), [(4, Cut::Csi)]);
        assert_eq!(
            cuts(b"\x1b[?1047h\x1b[?7l"),
            [(7, Cut::Csi), (12, Cut::Csi)]
        );
        assert_eq!(cuts(b"x\x1bcy"), [(2, Cut::Ris)]);
        // ESC restarts, CAN aborts, C0 inside a CSI doesn't end it
        assert_eq!(cuts(b"\x1b[?\x1b[!p"), [(6, Cut::Csi)]);
        assert!(cuts(b"\x1b[?10\x1847h").is_empty());
        assert_eq!(cuts(b"\x1b[?10\r47h"), [(8, Cut::Csi)]);
    }

    #[test]
    fn sequences_split_mid_params_are_still_acted_on() {
        let mut t = term(3, 10);
        t.process(b"\x1b[?25l\x1b[3");
        t.process(b"1m\x1b[");
        t.process(b"!");
        t.process(b"pX\x1b[?1");
        assert!(!t.parser.screen().hide_cursor());
        t.process(b"04");
        t.process(b"7hALT\x1b[?10");
        assert!(t.parser.screen().alternate_screen());
        assert_eq!(t.screen_lines()[0], "ALT");
        t.process(b"47l");
        assert!(!t.parser.screen().alternate_screen());
        assert_eq!(t.screen_lines()[0], "X");
        assert_eq!(
            t.parser.screen().cell(0, 0).unwrap().fgcolor(),
            vt100::Color::Idx(1)
        );
    }

    #[test]
    fn leaving_a_replayed_alternate_screen_does_not_keep_its_attributes() {
        let mut t = term(3, 10);
        t.process(b"norm\x1b[?1049h\x1b[1mBOLD");
        let s = t.serialize();
        let mut fresh = term(3, 10);
        fresh.process(s.as_bytes());
        for x in [&mut t, &mut fresh] {
            x.process(b"\x1b[?1049lx");
        }
        let (row, col) = fresh.parser.screen().cursor_position();
        let cell = fresh.parser.screen().cell(row, col - 1).unwrap();
        assert_eq!(cell.contents(), "x");
        assert!(!cell.bold());
        assert_eq!(snapshot(&mut fresh.parser), snapshot(&mut t.parser));
        assert_eq!(
            fresh.parser.screen().contents_formatted(),
            t.parser.screen().contents_formatted()
        );
    }

    // --- utf-8 chunking ---

    #[test]
    fn holds_back_an_incomplete_utf8_tail() {
        let s = "a한".as_bytes(); // 'a' + 3 bytes
        assert_eq!(utf8_complete_len(s), 4);
        assert_eq!(utf8_complete_len(&s[..3]), 1);
        assert_eq!(utf8_complete_len(&s[..2]), 1);
        assert_eq!(utf8_complete_len(b""), 0);
        let e = "✅".as_bytes();
        assert_eq!(utf8_complete_len(&e[..2]), 0);
        assert_eq!(utf8_complete_len(&[0xFF]), 1);
        assert_eq!(utf8_complete_len("😀".as_bytes()), 4);
        assert_eq!(utf8_complete_len(&"😀".as_bytes()[..3]), 0);
    }

    // --- spawn resolution (port of the resolveSpawn tests) ---

    fn sv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    fn shim(file: &'static str) -> impl Fn(&str) -> ResolvedCommand {
        move |_| ResolvedCommand {
            file: file.to_string(),
            via_cmd: true,
        }
    }

    #[test]
    fn non_windows_spawns_as_is() {
        let r = resolve_spawn("claude", &sv(&["x"]), false, &shim("unused"), "cmd.exe").unwrap();
        assert_eq!(r, sv(&["claude", "x"]));
    }

    #[test]
    fn windows_exe_spawns_directly() {
        let exe = |_: &str| ResolvedCommand {
            file: "C:\\c\\claude.exe".into(),
            via_cmd: false,
        };
        let r = resolve_spawn("claude", &sv(&["x"]), true, &exe, "cmd.exe").unwrap();
        assert_eq!(r, sv(&["C:\\c\\claude.exe", "x"]));
        assert_eq!(windows_command_line(&r), "C:\\c\\claude.exe x");
    }

    #[test]
    fn windows_cmd_shim_runs_through_cmd() {
        let r = resolve_spawn(
            "claude",
            &sv(&["--session-id", "u"]),
            true,
            &shim("C:\\npm\\claude.cmd"),
            "cmd.exe",
        )
        .unwrap();
        assert_eq!(
            r,
            sv(&[
                "cmd.exe",
                "/d",
                "/s",
                "/c",
                "C:\\npm\\claude.cmd",
                "--session-id",
                "u"
            ])
        );
        // After cmd's /s handling (nothing to strip) this runs exactly what TS's
        // `/d /s /c "C:\npm\claude.cmd --session-id u"` runs.
        assert_eq!(
            windows_command_line(&r),
            "cmd.exe /d /s /c C:\\npm\\claude.cmd --session-id u"
        );
        let r = resolve_spawn(
            "claude",
            &sv(&["--x", ""]),
            true,
            &shim("C:\\npm\\claude.cmd"),
            "cmd.exe",
        )
        .unwrap();
        assert_eq!(
            windows_command_line(&r),
            "cmd.exe /d /s /c C:\\npm\\claude.cmd --x \"\""
        );
    }

    #[test]
    fn windows_cmd_shim_refuses_what_cmd_would_reinterpret() {
        for bad in [
            "a&b", "50%", "a|b", "<x", "x>", "^", "hi!", "q\"", "a\rb", "a\nb", "`",
        ] {
            let e = resolve_spawn(
                "claude",
                &sv(&[bad]),
                true,
                &shim("C:\\npm\\claude.cmd"),
                "cmd.exe",
            )
            .unwrap_err();
            assert_eq!(e.code.as_deref(), Some("unsafe_for_cmd"), "{bad:?}");
            assert_eq!(
                e.message,
                "claude.cmd로는 이 인자를 안전하게 넘길 수 없어요"
            );
        }
        // the shim path itself is checked too
        let e = resolve_spawn(
            "claude",
            &[],
            true,
            &shim("C:\\100%\\claude.cmd"),
            "cmd.exe",
        )
        .unwrap_err();
        assert_eq!(e.code.as_deref(), Some("unsafe_for_cmd"));
        // .exe targets are not cmd's business
        let exe = |_: &str| ResolvedCommand {
            file: "C:\\c\\claude.exe".into(),
            via_cmd: false,
        };
        assert!(resolve_spawn("claude", &sv(&["a&b"]), true, &exe, "cmd.exe").is_ok());
    }

    #[test]
    fn windows_cmd_shim_with_spaces_keeps_parts_whole() {
        let args = sv(&[
            "--session-id",
            "u",
            "--settings",
            "C:\\Users\\First Last\\.office-desks\\agents\\a.json",
        ]);
        let r = resolve_spawn(
            "claude",
            &args,
            true,
            &shim("C:\\Users\\First Last\\npm\\claude.cmd"),
            "cmd.exe",
        )
        .unwrap();
        // The text after /c must not start with a quote, or /s would strip it: `call` leads.
        assert_eq!(
            windows_command_line(&r),
            "cmd.exe /d /s /c call \"C:\\Users\\First Last\\npm\\claude.cmd\" --session-id u \
             --settings \"C:\\Users\\First Last\\.office-desks\\agents\\a.json\""
        );
        // A trailing backslash in a quoted part is doubled, so it can't escape the closing quote.
        let r = resolve_spawn(
            "claude",
            &sv(&["C:\\a b\\"]),
            true,
            &shim("C:\\npm\\claude.cmd"),
            "cmd.exe",
        )
        .unwrap();
        assert_eq!(
            windows_command_line(&r),
            "cmd.exe /d /s /c C:\\npm\\claude.cmd \"C:\\a b\\\\\""
        );
    }

    #[test]
    fn windows_command_line_follows_msvc_quoting() {
        assert_eq!(
            windows_command_line(&sv(&["a", "b c", "", "d\\e"])),
            "a \"b c\" \"\" d\\e"
        );
        assert_eq!(
            windows_command_line(&sv(&["x", "say \"hi\""])),
            "x \"say \\\"hi\\\"\""
        );
        assert_eq!(
            windows_command_line(&sv(&["x", "a\\\\\"b"])),
            "x \"a\\\\\\\\\\\"b\""
        );
    }

    #[test]
    fn unsafe_for_cmd_shim_matches_ts_set() {
        for c in ['"', '%', '&', '|', '<', '>', '^', '!', '\r', '\n', '`'] {
            assert!(unsafe_for_cmd_shim(&format!("a{c}b")), "{c:?}");
        }
        assert!(!unsafe_for_cmd_shim("C:\\Users\\First Last\\x.json"));
        assert!(!unsafe_for_cmd_shim("--flag=value,(x);'y'"));
    }

    #[test]
    fn host_and_subscriptions_can_be_shared_across_threads() {
        fn send_sync<T: Send + Sync>() {}
        send_sync::<PtyHost>();
        send_sync::<Subscription>();
    }

    // --- subscriptions ---

    #[test]
    fn subscriptions_unsubscribe_explicitly_and_on_drop() {
        let reg: Shared<DataFn> = registry();
        let a = subscribe(&reg, Arc::new(|_: &[u8]| {}) as Arc<DataFn>);
        let b = subscribe(&reg, Arc::new(|_: &[u8]| {}) as Arc<DataFn>);
        assert_eq!(listeners(&reg).len(), 2);
        a.unsubscribe();
        assert_eq!(listeners(&reg).len(), 1);
        drop(b);
        assert!(listeners(&reg).is_empty());
        // outliving the registry is fine
        let c = subscribe(&reg, Arc::new(|_: &[u8]| {}) as Arc<DataFn>);
        drop(reg);
        c.unsubscribe();
    }
}
