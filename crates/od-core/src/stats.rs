//! An agent's work record, as the office tycoon sees it. Port of `bridge/src/stats.ts`.
//! `now` is injected (its time zone defines "today"); callers pass `chrono::Local::now()`.

use crate::model::{AgentStats, ConversationMessage, MessageRole};
use crate::transcript::SubagentCall;
use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone};

/// `new Date(iso)` for the formats transcripts contain: RFC 3339 with an offset, date-time
/// without offset (local time, like JS) and date-only (UTC, like JS).
fn local_date<Tz: TimeZone>(iso: &str, tz: &Tz) -> Option<NaiveDate> {
    if let Ok(d) = DateTime::parse_from_rfc3339(iso) {
        return Some(d.with_timezone(tz).date_naive());
    }
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(iso, f) {
            return Some(tz.from_local_datetime(&n).earliest()?.date_naive());
        }
    }
    let d = NaiveDate::parse_from_str(iso, "%Y-%m-%d").ok()?;
    let utc = d.and_hms_opt(0, 0, 0)?.and_utc();
    Some(utc.with_timezone(tz).date_naive())
}

pub fn agent_stats<Tz: TimeZone>(
    messages: &[ConversationMessage],
    calls: &[SubagentCall],
    now: &DateTime<Tz>,
) -> AgentStats {
    let tz = now.timezone();
    let today = now.date_naive();
    let same_day = |iso: &str| local_date(iso, &tz) == Some(today);
    let mut s = AgentStats {
        instructions: 0,
        instructions_today: 0,
        tool_calls: 0,
        tool_calls_today: 0,
        subagents: calls.len() as i64,
        hired_at: None,
    };
    for m in messages {
        // `!hiredAt && m.ts`: an empty ts is falsy and does not count.
        if s.hired_at.is_none() {
            if let Some(ts) = m.ts.as_deref().filter(|t| !t.is_empty()) {
                s.hired_at = Some(ts.to_string());
            }
        }
        let today_hit =
            m.ts.as_deref()
                .is_some_and(|t| !t.is_empty() && same_day(t));
        match m.role {
            MessageRole::User => {
                s.instructions += 1;
                s.instructions_today += i64::from(today_hit);
            }
            MessageRole::Tool => {
                s.tool_calls += 1;
                s.tool_calls_today += i64::from(today_hit);
            }
            _ => {}
        }
    }
    s
}
