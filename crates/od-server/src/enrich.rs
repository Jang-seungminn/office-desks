//! What only git and the transcripts know, added to each poll before change detection: a port of
//! `cachedChanges`, `enrichFromTranscripts` and `updateAwards` in `server.ts`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::Local;
use futures_util::future::join_all;
use od_core::awards::AwardBook;
use od_core::backend::OfficeBackend;
use od_core::git::SystemGit;
use od_core::git_info::change_summary;
use od_core::model::{AgentStats, DeskChanges, OfficeSnapshot, SubagentStatus};
use od_core::stats::agent_stats;
use od_core::transcript::{read_transcript, ReadOptions};

use crate::hub::{Hub, ServerMessageJson};
use crate::poller::now_ms;

/// git change counts are refreshed in the background at most this often per worktree.
const CHANGES_TTL_MS: i64 = 10_000;

struct ChangeEntry {
    at: i64,
    value: Option<DeskChanges>,
    busy: bool,
}

type ChangeCache = Arc<Mutex<HashMap<String, ChangeEntry>>>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) struct Enricher {
    pub backend: Arc<dyn OfficeBackend>,
    pub awards: Arc<Mutex<AwardBook>>,
    pub hub: Arc<Hub>,
    changes: ChangeCache,
}

/// What a transcript adds to one agent.
struct FromTranscript {
    subagents_running: i64,
    model: Option<String>,
    effort: Option<String>,
    stats: AgentStats,
}

impl Enricher {
    pub fn new(
        backend: Arc<dyn OfficeBackend>,
        awards: Arc<Mutex<AwardBook>>,
        hub: Arc<Hub>,
    ) -> Enricher {
        Enricher {
            backend,
            awards,
            hub,
            changes: Arc::default(),
        }
    }

    /// The poller's enrich step: transcripts (with changes), then the awards.
    pub async fn enrich(&self, s: &mut OfficeSnapshot) {
        self.enrich_from_transcripts(s).await;
        self.update_awards(s);
    }

    /// `cachedChanges`: the last known counts (null on the first poll), refreshed in the
    /// background when missing or older than the TTL and not already refreshing.
    fn cached_changes(&self, path: &str) -> Option<DeskChanges> {
        let mut cache = lock(&self.changes);
        let stale = match cache.get(path) {
            None => true,
            Some(hit) => now_ms() - hit.at > CHANGES_TTL_MS && !hit.busy,
        };
        if stale {
            let entry = cache.entry(path.to_string()).or_insert(ChangeEntry {
                at: 0,
                value: None,
                busy: false,
            });
            entry.busy = true;
            let changes = Arc::clone(&self.changes);
            let path = path.to_string();
            tokio::task::spawn_blocking(move || {
                let value = change_summary(&path, &SystemGit).ok().map(|c| DeskChanges {
                    files: c.files.len() as i64,
                    added: c.added,
                    deleted: c.deleted,
                });
                if let Some(e) = lock(&changes).get_mut(&path) {
                    e.value = value;
                    e.at = now_ms();
                    e.busy = false;
                }
            });
        }
        cache.get(path).and_then(|e| e.value.clone())
    }

    /// `enrichFromTranscripts`: running subagents, model, effort and stats for every Claude or
    /// Codex agent whose session file is already known. Never blocks the poll on a search.
    async fn enrich_from_transcripts(&self, s: &mut OfficeSnapshot) {
        let caps = self.backend.capabilities();
        if caps.changes {
            for d in &mut s.desks {
                d.changes = self.cached_changes(&d.path);
            }
        }
        if !caps.transcripts {
            return;
        }
        let mut jobs = Vec::new();
        for (di, desk) in s.desks.iter().enumerate() {
            for (ai, agent) in desk.agents.iter().enumerate() {
                if agent.agent_type != "claude" && agent.agent_type != "codex" {
                    continue;
                }
                // Refresh the session lookup in the background; use what is cached now.
                let backend = Arc::clone(&self.backend);
                let (d, a) = (desk.clone(), agent.clone());
                tokio::spawn(async move {
                    let _ = backend.find_session(&d, &a).await;
                });
                let file = self.backend.cached_session(&agent.id);
                jobs.push(async move {
                    let file = file?;
                    let found = tokio::task::spawn_blocking(move || {
                        let t = read_transcript(Path::new(&file), ReadOptions::default()).ok()?;
                        Some(FromTranscript {
                            subagents_running: t
                                .calls
                                .iter()
                                .filter(|c| c.status == SubagentStatus::Running)
                                .count() as i64,
                            stats: agent_stats(&t.messages, &t.calls, &Local::now()),
                            model: t.model,
                            effort: t.effort,
                        })
                    })
                    .await
                    .ok()
                    .flatten()?;
                    Some((di, ai, found))
                });
            }
        }
        for (di, ai, t) in join_all(jobs).await.into_iter().flatten() {
            let agent = &mut s.desks[di].agents[ai];
            agent.subagents_running = t.subagents_running;
            agent.model = t.model;
            agent.effort = t.effort;
            agent.stats = Some(t.stats);
        }
    }

    /// `updateAwards`: fold the office into the board; on a change, save it in the background
    /// and broadcast the raw board.
    fn update_awards(&self, s: &OfficeSnapshot) {
        let board = {
            let mut book = lock(&self.awards);
            if !book.update(&s.desks, &Local::now()) {
                return;
            }
            book.current().clone()
        };
        let awards = Arc::clone(&self.awards);
        tokio::task::spawn_blocking(move || {
            let _ = lock(&awards).save();
        });
        self.hub.send(&ServerMessageJson::Awards { awards: board });
    }
}
