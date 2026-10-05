//! `/ws`: the web office's live feed (the `wss.on('connection')` handler of `server.ts`).
//!
//! On connect a client gets `backend`, `snapshot`, `usage` (only when known), `org` and
//! `awards`, then every hub message. Client messages are ignored.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, Utf8Bytes, WebSocket};
use axum::extract::{FromRequestParts, Request, WebSocketUpgrade};
use axum::response::{IntoResponse, Response};
use od_core::model::BackendInfo;
use tokio::sync::broadcast::{self, error::RecvError};

use crate::app::AppState;
use crate::hub::ServerMessageJson;

/// Complete the handshake (the request already passed the path and guard checks). A request
/// that is not a valid WebSocket handshake gets axum's rejection (405 or 400).
pub(crate) async fn upgrade(st: Arc<AppState>, req: Request) -> Response {
    let (mut parts, _body) = req.into_parts();
    match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(up) => up.on_upgrade(move |socket| client(st, socket)),
        Err(rejection) => rejection.into_response(),
    }
}

async fn send(socket: &mut WebSocket, text: Utf8Bytes) -> bool {
    socket.send(Message::Text(text)).await.is_ok()
}

async fn send_msg(socket: &mut WebSocket, msg: ServerMessageJson) -> bool {
    send(socket, msg.to_text()).await
}

/// What a client must know to be current: `snapshot`, `org`, `awards` and `usage` (when known).
/// Sent again after the client lagged behind the hub and missed messages.
async fn resend_state(st: &AppState, socket: &mut WebSocket) -> bool {
    send_msg(
        socket,
        ServerMessageJson::Snapshot {
            snapshot: st.poller.current(),
        },
    )
    .await
        && send_msg(socket, ServerMessageJson::Org { org: st.org() }).await
        && send_msg(
            socket,
            ServerMessageJson::Awards {
                awards: st.awards_board(),
            },
        )
        .await
        && match st.usage() {
            Some(usage) => send_msg(socket, ServerMessageJson::Usage { usage }).await,
            None => true,
        }
}

async fn initial(st: &AppState, socket: &mut WebSocket) -> bool {
    let backend = ServerMessageJson::Backend {
        backend: BackendInfo {
            name: st.backend.name().to_string(),
            capabilities: st.backend.capabilities().clone(),
        },
    };
    if !send_msg(socket, backend).await {
        return false;
    }
    let snapshot = ServerMessageJson::Snapshot {
        snapshot: st.poller.current(),
    };
    if !send_msg(socket, snapshot).await {
        return false;
    }
    if let Some(usage) = st.usage() {
        if !send_msg(socket, ServerMessageJson::Usage { usage }).await {
            return false;
        }
    }
    send_msg(socket, ServerMessageJson::Org { org: st.org() }).await
        && send_msg(
            socket,
            ServerMessageJson::Awards {
                awards: st.awards_board(),
            },
        )
        .await
}

/// How long a closing handshake may take on shutdown before the socket is just dropped.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);

async fn client(st: Arc<AppState>, mut socket: WebSocket) {
    // Subscribe before reading the state, so nothing broadcast in between is missed.
    let mut rx = st.hub.subscribe();
    st.hub.connected();
    st.poller.set_idle(false);
    let stopping = {
        let feed = feed(&st, &mut socket, &mut rx);
        // Upgraded connections outlive axum's graceful shutdown, and a send to a client that
        // does not read can wait forever: the stop signal ends the whole feed.
        tokio::select! {
            _ = feed => false,
            _ = st.stopped() => true,
        }
    };
    if stopping {
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, socket.send(Message::Close(None))).await;
    }
    let left = st.hub.disconnected();
    st.poller.set_idle(!st.cfg.tui_active && left == 0);
}

/// The initial messages, then hub messages until the client goes away.
async fn feed(st: &AppState, socket: &mut WebSocket, rx: &mut broadcast::Receiver<Utf8Bytes>) {
    if !initial(st, socket).await {
        return;
    }
    loop {
        tokio::select! {
            msg = rx.recv() => {
                let ok = match msg {
                    Ok(text) => send(socket, text).await,
                    Err(RecvError::Lagged(_)) => {
                        // Skip whatever is still queued: the resent state supersedes it.
                        *rx = rx.resubscribe();
                        resend_state(st, socket).await
                    }
                    Err(RecvError::Closed) => false,
                };
                if !ok {
                    return;
                }
            }
            incoming = socket.recv() => match incoming {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(_)) => {}
            },
        }
    }
}
