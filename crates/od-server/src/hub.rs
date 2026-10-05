//! The `/ws` broadcast: every message is serialized once and fanned out to all web clients.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::extract::ws::Utf8Bytes;

use od_core::awards::RawBoard;
use od_core::model::{BackendInfo, OfficeSnapshot, OrgChart, UsageSnapshot};
use serde::Serialize;
use tokio::sync::broadcast;

/// The `ServerMessage` shapes of `model.ts`, as the server sends them. Not
/// `od_core::model::ServerMessage`: TS sends `awards.current`, the raw board, not a typed one.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ServerMessageJson {
    Backend { backend: BackendInfo },
    Snapshot { snapshot: Arc<OfficeSnapshot> },
    Usage { usage: UsageSnapshot },
    Org { org: OrgChart },
    Awards { awards: RawBoard },
}

impl ServerMessageJson {
    /// The text frame: `JSON.stringify(msg)`. Cheap to clone (shared bytes), so a broadcast is
    /// serialized once and never copied per client.
    pub fn to_text(&self) -> Utf8Bytes {
        serde_json::to_string(self)
            .expect("server messages always serialize")
            .into()
    }
}

pub struct Hub {
    tx: broadcast::Sender<Utf8Bytes>,
    clients: AtomicUsize,
}

impl Hub {
    /// `capacity` is `ServerConfig::ws_buffer`: a client further behind than that lags.
    pub fn new(capacity: usize) -> Hub {
        Hub {
            tx: broadcast::channel(capacity.max(1)).0,
            clients: AtomicUsize::new(0),
        }
    }

    /// Send to every connected client (nobody connected is fine).
    pub fn send(&self, msg: &ServerMessageJson) {
        let _ = self.tx.send(msg.to_text());
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Utf8Bytes> {
        self.tx.subscribe()
    }

    /// Connected `/ws` clients (`wss.clients.size`).
    pub fn clients(&self) -> usize {
        self.clients.load(Ordering::SeqCst)
    }

    pub(crate) fn connected(&self) -> usize {
        self.clients.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub(crate) fn disconnected(&self) -> usize {
        self.clients.fetch_sub(1, Ordering::SeqCst) - 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_tagged_like_model_ts() {
        let m = ServerMessageJson::Org {
            org: OrgChart {
                departments: Vec::new(),
            },
        };
        assert_eq!(
            m.to_text().as_str(),
            r#"{"type":"org","org":{"departments":[]}}"#
        );
        let m = ServerMessageJson::Awards {
            awards: RawBoard {
                leader: None,
                hall: vec![serde_json::json!({"date": "2026-10-05", "extra": 1})],
            },
        };
        assert_eq!(
            m.to_text().as_str(),
            r#"{"type":"awards","awards":{"leader":null,"hall":[{"date":"2026-10-05","extra":1}]}}"#
        );
        let m = ServerMessageJson::Snapshot {
            snapshot: Arc::new(OfficeSnapshot {
                desks: Vec::new(),
                updated_at: 5,
                error: None,
            }),
        };
        assert_eq!(
            m.to_text().as_str(),
            r#"{"type":"snapshot","snapshot":{"desks":[],"updatedAt":5,"error":null}}"#
        );
    }

    #[test]
    fn counts_clients() {
        let h = Hub::new(2);
        assert_eq!(h.connected(), 1);
        assert_eq!(h.connected(), 2);
        assert_eq!(h.disconnected(), 1);
        assert_eq!(h.clients(), 1);
    }
}
