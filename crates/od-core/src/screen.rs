//! Port of bridge/src/screen.ts: reading Claude Code's composer off the rendered screen.

use crate::jsstr::{is_js_space, trim, trim_end};
use crate::model::{ComposerState, ScreenSupport};

/// Claude Code versions whose screens are covered by test/fixtures/screens (major.minor).
pub const TESTED_CLAUDE_VERSIONS: [&str; 1] = ["2.1"];

pub fn screen_support(agent_type: &str, version: Option<&str>) -> ScreenSupport {
    let Some(version) = version.filter(|v| !v.is_empty()) else {
        return ScreenSupport::Unknown;
    };
    if agent_type != "claude" {
        return ScreenSupport::Unknown;
    }
    match major_minor(version) {
        Some(mm) if TESTED_CLAUDE_VERSIONS.contains(&mm) => ScreenSupport::Tested,
        _ => ScreenSupport::Untested,
    }
}

/// `/^(\d+\.\d+)/` with ASCII digits.
fn major_minor(v: &str) -> Option<&str> {
    let b = v.as_bytes();
    let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let major = digits(0);
    if major == 0 || b.get(major) != Some(&b'.') {
        return None;
    }
    let minor = digits(major + 1);
    (minor > 0).then(|| &v[..major + 1 + minor])
}

/// `/^\s*[─━]{8,}/`
fn is_rule(row: &str) -> bool {
    row.trim_start_matches(is_js_space)
        .chars()
        .take_while(|c| matches!(c, '─' | '━'))
        .take(8)
        .count()
        == 8
}

/// `/^\s*❯(\s|$)/`
fn is_prompt(row: &str) -> bool {
    match row.trim_start_matches(is_js_space).strip_prefix('❯') {
        Some(rest) => rest.chars().next().is_none_or(is_js_space),
        None => false,
    }
}

/// Is the agent's input box on screen? Claude Code draws its composer as a `❯` line framed
/// by horizontal rules. Dialogs such as /usage, /config or a permission prompt replace it
/// and swallow typed text, so the web UI must not send a message then.
pub fn composer_state<S: AsRef<str>>(lines: &[S], agent_type: &str) -> ComposerState {
    if agent_type != "claude" {
        return ComposerState::Unknown;
    }
    let rows: Vec<&str> = lines.iter().map(|l| trim_end(l.as_ref())).collect();
    let rule_at = |i: Option<usize>| i.and_then(|i| rows.get(i)).is_some_and(|r| is_rule(r));
    for i in (0..rows.len()).rev() {
        if !is_prompt(rows[i]) {
            continue;
        }
        // Multi-line drafts: walk down past continuation lines to the closing rule.
        let mut below = i + 1;
        while below < rows.len() && !is_rule(rows[below]) && below - i < 12 {
            below += 1;
        }
        if rule_at(i.checked_sub(1)) && rule_at(Some(below)) {
            return ComposerState::Ready;
        }
    }
    if rows.iter().any(|r| !trim(r).is_empty()) {
        ComposerState::Menu
    } else {
        ComposerState::Unknown
    }
}
