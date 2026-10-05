//! Port of bridge/src/keys.ts: raw bytes for each key the web panel may press.

use crate::model::TerminalKey;
use regex::Regex;
use std::sync::OnceLock;

impl TerminalKey {
    pub const ALL: [TerminalKey; 24] = [
        TerminalKey::Up,
        TerminalKey::Down,
        TerminalKey::Right,
        TerminalKey::Left,
        TerminalKey::Enter,
        TerminalKey::Esc,
        TerminalKey::Tab,
        TerminalKey::ShiftTab,
        TerminalKey::Space,
        TerminalKey::CtrlC,
        TerminalKey::CtrlU,
        TerminalKey::CtrlEnter,
        TerminalKey::Backspace,
        TerminalKey::N1,
        TerminalKey::N2,
        TerminalKey::N3,
        TerminalKey::N4,
        TerminalKey::N5,
        TerminalKey::N6,
        TerminalKey::N7,
        TerminalKey::N8,
        TerminalKey::N9,
        TerminalKey::Y,
        TerminalKey::N,
    ];

    /// The wire name (`"shift-tab"`, `"1"`, ...).
    pub fn name(self) -> &'static str {
        KEY_BYTES[self.index()].1
    }

    /// The bytes typed into the terminal.
    pub fn bytes(self) -> &'static str {
        KEY_BYTES[self.index()].2
    }

    fn index(self) -> usize {
        Self::ALL.iter().position(|k| *k == self).expect("in ALL")
    }
}

/// `(key, wire name, bytes)` for every key, in `TerminalKey::ALL` order.
pub const KEY_BYTES: [(TerminalKey, &str, &str); 24] = [
    (TerminalKey::Up, "up", "\x1b[A"),
    (TerminalKey::Down, "down", "\x1b[B"),
    (TerminalKey::Right, "right", "\x1b[C"),
    (TerminalKey::Left, "left", "\x1b[D"),
    (TerminalKey::Enter, "enter", "\r"),
    (TerminalKey::Esc, "esc", "\x1b"),
    (TerminalKey::Tab, "tab", "\t"),
    (TerminalKey::ShiftTab, "shift-tab", "\x1b[Z"),
    (TerminalKey::Space, "space", " "),
    (TerminalKey::CtrlC, "ctrl-c", "\x03"),
    (TerminalKey::CtrlU, "ctrl-u", "\x15"),
    // Ctrl+Enter in the CSI-u keyboard encoding Claude Code understands ("ctrl+enter to send now").
    (TerminalKey::CtrlEnter, "ctrl-enter", "\x1b[13;5u"),
    (TerminalKey::Backspace, "backspace", "\x7f"),
    (TerminalKey::N1, "1", "1"),
    (TerminalKey::N2, "2", "2"),
    (TerminalKey::N3, "3", "3"),
    (TerminalKey::N4, "4", "4"),
    (TerminalKey::N5, "5", "5"),
    (TerminalKey::N6, "6", "6"),
    (TerminalKey::N7, "7", "7"),
    (TerminalKey::N8, "8", "8"),
    (TerminalKey::N9, "9", "9"),
    (TerminalKey::Y, "y", "y"),
    (TerminalKey::N, "n", "n"),
];

/// Bytes for a key name, or `None` for anything that is not a known key.
pub fn key_bytes(key: &str) -> Option<&'static str> {
    KEY_BYTES
        .iter()
        .find(|(_, name, _)| *name == key)
        .map(|(_, _, b)| *b)
}

/// One printable character (no control characters, no escape sequences).
pub fn char_bytes(ch: &str) -> Option<char> {
    static PRINTABLE: OnceLock<Regex> = OnceLock::new();
    let re = PRINTABLE.get_or_init(|| Regex::new(r"^[\p{L}\p{N}\p{P}\p{S} ]$").expect("regex"));
    let mut chars = ch.chars();
    let first = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    re.is_match(ch).then_some(first)
}
