//! Employee of the day. Port of `bridge/src/awards.ts`.
//!
//! Whoever did the most work today (instructions handled weigh 10, each tool call 1). The leader
//! is tracked through the day; when the date changes it goes into the hall of fame. Kept in a
//! small file so restarts don't lose it. "Today" is the local date of the injected `now`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, TimeZone};
use serde_json::Value;

use crate::fsio;
use crate::home::office_home;
use crate::model::{Award, AwardBoard, OfficeDesk};

const HALL_MAX: usize = 90;

/// `YYYY-MM-DD` in the zone of `d` (the TS `localDate`).
pub fn local_date<Tz: TimeZone>(d: &DateTime<Tz>) -> String {
    let n = d.naive_local();
    format!("{}-{:02}-{:02}", n.year(), n.month(), n.day())
}

/// `<home>/.office-desks/awards.json` for an explicit home, else `<office home>/awards.json`.
pub fn awards_file(home: Option<&Path>, env: &HashMap<String, String>) -> PathBuf {
    match home {
        Some(h) => h.join(".office-desks").join("awards.json"),
        None => office_home(env).join("awards.json"),
    }
}

/// Today's best candidate among the agents in the office (none if nobody worked today).
/// Ties go to whoever came first.
pub fn best_today(desks: &[OfficeDesk], date: &str) -> Option<Award> {
    let mut best: Option<Award> = None;
    for desk in desks {
        for a in &desk.agents {
            let Some(s) = a.stats.as_ref() else { continue };
            if s.instructions_today == 0 {
                continue;
            }
            let score = s.instructions_today * 10 + s.tool_calls_today;
            if best.as_ref().is_some_and(|b| score <= b.score) {
                continue;
            }
            best = Some(Award {
                date: date.to_string(),
                agent_id: a.id.clone(),
                desk_id: desk.id.clone(),
                name: a
                    .terminal_title
                    .clone()
                    .unwrap_or_else(|| desk.name.clone()),
                repo: if desk.repo.is_empty() {
                    desk.name.clone()
                } else {
                    desk.repo.clone()
                },
                repo_id: desk.repo_id.clone(),
                agent_type: a.agent_type.clone(),
                instructions: s.instructions_today,
                tool_calls: s.tool_calls_today,
                score,
            });
        }
    }
    best
}

pub struct AwardBook {
    file: PathBuf,
    board: AwardBoard,
    loaded: bool,
}

impl AwardBook {
    pub fn new(file: impl Into<PathBuf>) -> Self {
        Self {
            file: file.into(),
            board: AwardBoard {
                leader: None,
                hall: Vec::new(),
            },
            loaded: false,
        }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    /// Read the file; a missing or broken one is a first run. Entries that are not awards are
    /// dropped (the TS code would keep arbitrary JSON and break later).
    pub fn load(&mut self) {
        if let Some(raw) = std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        {
            let award = |v: &Value| serde_json::from_value::<Award>(v.clone()).ok();
            self.board = AwardBoard {
                leader: raw.get("leader").and_then(award),
                hall: raw
                    .get("hall")
                    .and_then(Value::as_array)
                    .map(|h| h.iter().take(HALL_MAX).filter_map(award).collect())
                    .unwrap_or_default(),
            };
        }
        self.loaded = true;
    }

    pub fn current(&self) -> &AwardBoard {
        &self.board
    }

    /// Fold in the office as it is now. Returns true when the board changed (worth saving and
    /// broadcasting). A leader from an earlier day is crowned into the hall first. Does nothing
    /// before [`load`](Self::load).
    pub fn update<Tz: TimeZone>(&mut self, desks: &[OfficeDesk], now: &DateTime<Tz>) -> bool {
        if !self.loaded {
            return false;
        }
        let date = local_date(now);
        let mut changed = false;
        if let Some(leader) = self.board.leader.as_ref().filter(|l| l.date != date) {
            if !self.board.hall.iter().any(|h| h.date == leader.date) {
                self.board.hall.insert(0, leader.clone());
                self.board.hall.truncate(HALL_MAX);
            }
            self.board.leader = None;
            changed = true;
        }
        let best = best_today(desks, &date);
        let cur = self.board.leader.as_ref();
        // The leader only gets replaced by a higher score (agents that close don't lose their
        // lead), or refreshed when the same agent keeps working.
        if let Some(best) = best {
            if cur.is_none_or(|c| {
                best.score > c.score || (best.agent_id == c.agent_id && best.score != c.score)
            }) {
                self.board.leader = Some(best);
                changed = true;
            }
        }
        changed
    }

    pub fn save(&self) -> std::io::Result<()> {
        let body = serde_json::to_string_pretty(&self.board).map_err(std::io::Error::other)?;
        fsio::save_atomic(&self.file, &body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AgentStats, CharacterState, OfficeAgent};
    use chrono::{FixedOffset, NaiveDate, Utc};

    pub(crate) fn agent(id: &str, instructions_today: i64, tool_calls_today: i64) -> OfficeAgent {
        OfficeAgent {
            id: id.into(),
            terminal_handle: None,
            agent_type: "claude".into(),
            terminal_title: Some(format!("{id} 작업")),
            subagents_running: 0,
            model: None,
            effort: None,
            stats: Some(AgentStats {
                instructions: 50,
                instructions_today,
                tool_calls: 100,
                tool_calls_today,
                subagents: 0,
                hired_at: None,
            }),
            state: CharacterState::Done,
            raw_state: "done".into(),
            activity: String::new(),
            prompt: None,
            last_message: None,
            since: None,
        }
    }

    pub(crate) fn desk(agents: Vec<OfficeAgent>) -> OfficeDesk {
        OfficeDesk {
            id: "r::/w".into(),
            repo_id: "r".into(),
            is_main: true,
            parent_id: None,
            name: "w".into(),
            repo: "web".into(),
            branch: "main".into(),
            path: "/w".into(),
            status: "active".into(),
            workspace_status: None,
            comment: String::new(),
            preview: String::new(),
            is_active: false,
            unread: false,
            last_activity_at: None,
            changes: None,
            pr: None,
            agents,
        }
    }

    fn at(y: i32, m: u32, d: u32, h: u32) -> DateTime<Utc> {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, 0, 0)
            .unwrap()
            .and_utc()
    }

    // awards.test.ts: scores instructions x10 + tool calls and skips idle agents
    #[test]
    fn scores_instructions_x10_plus_tool_calls_and_skips_idle_agents() {
        let best = best_today(
            &[desk(vec![
                agent("a", 3, 5),
                agent("b", 2, 40),
                agent("c", 0, 900),
            ])],
            "2026-10-03",
        )
        .unwrap();
        assert_eq!(best.agent_id, "b");
        assert_eq!(best.score, 60);
        assert_eq!(best.name, "b 작업");
        assert_eq!(best.repo, "web");
        assert!(best_today(&[desk(vec![agent("c", 0, 900)])], "2026-10-03").is_none());
    }

    #[test]
    fn name_repo_and_tie_fallbacks() {
        let mut a = agent("a", 1, 0);
        a.terminal_title = None;
        a.stats = Some(AgentStats {
            instructions: 0,
            instructions_today: 1,
            tool_calls: 0,
            tool_calls_today: 0,
            subagents: 0,
            hired_at: None,
        });
        let mut d = desk(vec![a, agent("b", 1, 0)]);
        d.repo = String::new();
        let best = best_today(&[d.clone()], "d").unwrap();
        // Same score: the first agent keeps the lead; no title falls back to the desk name.
        assert_eq!(
            (
                best.agent_id.as_str(),
                best.name.as_str(),
                best.repo.as_str()
            ),
            ("a", "w", "w")
        );
        // An agent without stats is skipped.
        d.agents[0].stats = None;
        assert_eq!(best_today(&[d], "d").unwrap().agent_id, "b");
    }

    // awards.test.ts: keeps the day leader and crowns it when the date changes
    #[test]
    fn keeps_the_day_leader_and_crowns_it_when_the_date_changes() {
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("awards.json");
        let mut book = AwardBook::new(&file);
        // Not loaded yet: nothing happens.
        assert!(!book.update(&[desk(vec![agent("a", 3, 5)])], &at(2026, 10, 3, 10)));
        book.load();
        let day1 = at(2026, 10, 3, 10);
        assert!(book.update(&[desk(vec![agent("a", 3, 5)])], &day1));
        // a closes its terminal; a weaker agent doesn't steal the lead
        assert!(!book.update(&[desk(vec![agent("b", 1, 1)])], &day1));
        assert_eq!(book.current().leader.as_ref().unwrap().agent_id, "a");
        let day2 = at(2026, 10, 4, 9);
        assert!(book.update(&[desk(vec![])], &day2));
        let hall: Vec<_> = book
            .current()
            .hall
            .iter()
            .map(|h| (h.date.as_str(), h.agent_id.as_str()))
            .collect();
        assert_eq!(hall, vec![("2026-10-03", "a")]);
        assert!(book.current().leader.is_none());
        book.save().unwrap();
        let mut again = AwardBook::new(book.file());
        again.load();
        assert_eq!(again.current().hall.len(), 1);
        assert_eq!(again.current(), book.current());
    }

    #[test]
    fn same_agent_refreshes_and_a_stronger_one_replaces() {
        let mut book = AwardBook::new("/nowhere/awards.json");
        book.load();
        let now = at(2026, 10, 3, 10);
        assert!(book.update(&[desk(vec![agent("a", 3, 5)])], &now));
        assert!(!book.update(&[desk(vec![agent("a", 3, 5)])], &now));
        // The same agent with a lower score still refreshes (stats can be recounted).
        assert!(book.update(&[desk(vec![agent("a", 3, 2)])], &now));
        assert_eq!(book.current().leader.as_ref().unwrap().score, 32);
        assert!(book.update(&[desk(vec![agent("b", 4, 0)])], &now));
        assert_eq!(book.current().leader.as_ref().unwrap().agent_id, "b");
    }

    #[test]
    fn hall_is_capped_and_never_holds_a_date_twice() {
        let mut book = AwardBook::new("/nowhere/awards.json");
        book.load();
        let aw = |date: &str| Award {
            date: date.into(),
            ..best_today(&[desk(vec![agent("a", 1, 0)])], date).unwrap()
        };
        book.board.hall = (0..90).map(|i| aw(&format!("2020-01-{i:03}"))).collect();
        book.board.leader = Some(aw("2026-10-02"));
        assert!(book.update(&[], &at(2026, 10, 3, 1)));
        assert_eq!(book.current().hall.len(), 90);
        assert_eq!(book.current().hall[0].date, "2026-10-02");
        // A leader whose date is already in the hall is dropped, not duplicated.
        book.board.leader = Some(aw("2026-10-02"));
        assert!(book.update(&[], &at(2026, 10, 3, 1)));
        assert_eq!(
            book.current()
                .hall
                .iter()
                .filter(|h| h.date == "2026-10-02")
                .count(),
            1
        );
    }

    #[test]
    fn local_date_uses_the_zone_of_now() {
        let utc = at(2026, 10, 3, 23);
        assert_eq!(local_date(&utc), "2026-10-03");
        let seoul = utc.with_timezone(&FixedOffset::east_opt(9 * 3600).unwrap());
        assert_eq!(local_date(&seoul), "2026-10-04");
        let la = utc.with_timezone(&FixedOffset::west_opt(7 * 3600).unwrap());
        assert_eq!(local_date(&la), "2026-10-03");
    }

    #[test]
    fn load_survives_missing_broken_and_odd_files() {
        let t = tempfile::tempdir().unwrap();
        let file = t.path().join("a.json");
        let mut book = AwardBook::new(&file);
        book.load();
        assert!(book.current().leader.is_none() && book.current().hall.is_empty());
        std::fs::write(&file, "nope").unwrap();
        book.load();
        assert!(book.current().hall.is_empty());
        std::fs::write(&file, r#"{"leader":null,"hall":"x"}"#).unwrap();
        book.load();
        assert!(book.current().hall.is_empty());
        std::fs::write(&file, "null").unwrap();
        book.load();
        assert!(book.current().leader.is_none());
    }

    #[test]
    fn award_files_live_under_the_office_home() {
        let env = HashMap::from([("OFFICE_DESKS_HOME".to_string(), "/x".to_string())]);
        assert_eq!(
            awards_file(None, &env),
            PathBuf::from("/x").join("awards.json")
        );
        assert_eq!(
            awards_file(Some(Path::new("/h")), &env),
            PathBuf::from("/h")
                .join(".office-desks")
                .join("awards.json")
        );
    }
}
