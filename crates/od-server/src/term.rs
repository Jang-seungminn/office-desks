//! `/term/<agent id>`: a live terminal for the desktop app (R4). New in R2; `server.ts` has no
//! counterpart.
//!
//! `GET /term/<encodeURIComponent(agentId)>?token=<term_token>` with `Upgrade: websocket`.
//! Checks, in order: the origin guard (403 `forbidden origin`, done by the caller), an upgrade
//! (400 `websocket upgrade required`), the token (403 `forbidden`), the id (400 `bad path`) and a
//! live native terminal (404 `unknown terminal`).
//!
//! Server to client: first a Binary frame with the serialized screen, then Binary frames with
//! the raw output in order. When the agent exits, the queued output, then Text
//! `{"type":"exit","code":<u32|null>}`, then Close 1000. A client that falls `term_buffer` chunks
//! behind is closed with 1013 `slow consumer` (it must reattach for a fresh snapshot); on
//! shutdown the socket is closed with 1001.
//!
//! Client to server: Binary frames are raw input. Text frames are JSON:
//! `{"type":"input","data":"…"}` writes the UTF-8 bytes, `{"type":"resize","cols":c,"rows":r}`
//! (each 1..=65535) resizes; anything else is ignored. A write that fails (the terminal is
//! gone) ends the session like an exit with `code: null`.
//!
//! While attached, the session holds a [`ReplyMute`](od_core::native::pty_host::ReplyMute), so
//! the client's terminal answers the agent's queries instead of the headless screen. The mute
//! and both subscriptions are dropped together when the session ends, however it ends.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use axum::extract::{FromRequestParts, Request, WebSocketUpgrade};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use od_core::native::pty_host::PtyHost;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Notify};

use crate::app::{lock, AppState};
use crate::js;
use crate::reqs::{json, RequestUrl};

pub(crate) const PREFIX: &str = "/term/";

/// Close codes.
const NORMAL: u16 = 1000;
const GOING_AWAY: u16 = 1001;
const TRY_AGAIN_LATER: u16 = 1013;
/// How long a closing frame may wait for a client before the socket is just dropped.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
/// How long to wait for the exit event of an agent already seen gone.
const EXIT_WAIT: Duration = Duration::from_secs(5);
/// A slow consumer is, by definition, not reading: give it longer to take in the 1013.
const SLOW_CLOSE_TIMEOUT: Duration = Duration::from_secs(10);

fn error(status: StatusCode, message: &str) -> Response {
    json(status, &json!({ "error": message }))
}

/// A `/term/…` request without an upgrade (the normal chain's `/term/` arm, any method).
pub(crate) fn upgrade_required() -> Response {
    error(StatusCode::BAD_REQUEST, "websocket upgrade required")
}

/// A refused `/term` request: its status and error text.
type Refusal = (StatusCode, &'static str);

/// Checks 3–5: the token, the id and a live native terminal. Returns the host and the PTY id.
fn check(st: &AppState, url: &RequestUrl) -> Result<(Arc<PtyHost>, String), Refusal> {
    let token = url.get("token").unwrap_or("");
    if !od_core::security::same_token(&st.term_token, token) {
        return Err((StatusCode::FORBIDDEN, "forbidden"));
    }
    let raw = url.pathname.strip_prefix(PREFIX).unwrap_or("");
    let Some(agent_id) = js::decode_uri_component(raw) else {
        return Err((StatusCode::BAD_REQUEST, "bad path"));
    };
    let unknown = || (StatusCode::NOT_FOUND, "unknown terminal");
    let native = st.backend.as_native().ok_or_else(unknown)?;
    let id = native.terminal_of(&agent_id).ok_or_else(unknown)?;
    Ok((Arc::clone(native.pty()), id))
}

/// An upgrade request on `/term/…` that passed the guard.
pub(crate) async fn upgrade(st: Arc<AppState>, req: Request, url: RequestUrl) -> Response {
    let (pty, id) = match check(&st, &url) {
        Ok(found) => found,
        Err((status, message)) => {
            // Like every other refused upgrade: answer, then close.
            let mut res = error(status, message);
            res.headers_mut()
                .insert(header::CONNECTION, HeaderValue::from_static("close"));
            return res;
        }
    };
    let (mut parts, _body) = req.into_parts();
    match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(up) => up.on_upgrade(move |socket| session(st, socket, pty, id)),
        Err(rejection) => rejection.into_response(),
    }
}

#[derive(Serialize)]
struct ExitMessage {
    #[serde(rename = "type")]
    kind: &'static str,
    code: Option<u32>,
}

/// How a session ended.
enum End {
    /// The exit message went out (or could not): close with 1000.
    Exited,
    /// The client fell `term_buffer` chunks behind.
    SlowConsumer,
    /// The server is stopping.
    Stopping,
    /// The client went away (Close frame, EOF or a socket error).
    Gone,
}

async fn session(st: Arc<AppState>, mut socket: WebSocket, pty: Arc<PtyHost>, id: String) {
    let end = {
        // Every guard lives in this block and is dropped before the closing handshake.
        let Some(_mute) = pty.mute_replies(&id) else {
            send_exit(&mut socket, None).await;
            close(&mut socket, NORMAL, "", CLOSE_TIMEOUT, &st).await;
            return;
        };

        let (exit_tx, mut exit_rx) = oneshot::channel::<u32>();
        let exit_tx = Mutex::new(Some(exit_tx));
        let want = id.clone();
        let _exit_sub = pty.on_exit(move |gone, code| {
            if gone == want {
                if let Some(tx) = lock(&exit_tx).take() {
                    let _ = tx.send(code);
                }
            }
        });

        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(st.cfg.term_buffer.max(1));
        let behind = Arc::new(Notify::new());
        let full = Arc::new(AtomicBool::new(false));
        let push = {
            let (behind, full) = (Arc::clone(&behind), Arc::clone(&full));
            move |chunk: &[u8]| {
                if full.load(Ordering::SeqCst) {
                    return;
                }
                if let Err(mpsc::error::TrySendError::Full(_)) = tx.try_send(chunk.to_vec()) {
                    full.store(true, Ordering::SeqCst);
                    behind.notify_one();
                }
            }
        };
        let Some((snapshot, _data_sub)) = pty.attach(&id, push) else {
            send_exit(&mut socket, None).await;
            close(&mut socket, NORMAL, "", CLOSE_TIMEOUT, &st).await;
            return;
        };

        let link = Link {
            pty: &pty,
            id: &id,
            rx: &mut rx,
        };
        // A send to a client that does not read can wait forever: a stop or an overflow ends
        // the whole feed (tungstenite keeps a half-written frame and finishes it first).
        tokio::select! {
            end = link.feed(&mut socket, snapshot, &mut exit_rx) => end,
            _ = behind.notified() => End::SlowConsumer,
            _ = st.stopped() => End::Stopping,
        }
    };
    match end {
        End::Exited => close(&mut socket, NORMAL, "", CLOSE_TIMEOUT, &st).await,
        End::SlowConsumer => {
            close(
                &mut socket,
                TRY_AGAIN_LATER,
                "slow consumer",
                SLOW_CLOSE_TIMEOUT,
                &st,
            )
            .await
        }
        End::Stopping => {
            let frame = Message::Close(Some(CloseFrame {
                code: GOING_AWAY,
                reason: "".into(),
            }));
            let _ = tokio::time::timeout(CLOSE_TIMEOUT, socket.send(frame)).await;
        }
        End::Gone => {}
    }
}

/// Send a Close frame, waiting at most `wait` (and never past shutdown).
async fn close(socket: &mut WebSocket, code: u16, reason: &str, wait: Duration, st: &AppState) {
    let frame = Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }));
    tokio::select! {
        _ = tokio::time::timeout(wait, socket.send(frame)) => {}
        _ = st.stopped() => {}
    }
}

async fn send_exit(socket: &mut WebSocket, code: Option<u32>) -> bool {
    let text = serde_json::to_string(&ExitMessage { kind: "exit", code })
        .expect("the exit message serializes");
    socket.send(Message::Text(text.into())).await.is_ok()
}

/// The agent's exit code, once its exit event arrives. `None` if it doesn't within
/// [`EXIT_WAIT`] or the host is gone.
async fn exit_code(exit_rx: &mut oneshot::Receiver<u32>) -> Option<u32> {
    match tokio::time::timeout(EXIT_WAIT, exit_rx).await {
        Ok(Ok(code)) => Some(code),
        _ => None,
    }
}

struct Link<'a> {
    pty: &'a PtyHost,
    id: &'a str,
    rx: &'a mut mpsc::Receiver<Vec<u8>>,
}

impl Link<'_> {
    /// The snapshot, then output and input until the agent exits or the client goes away.
    async fn feed(
        mut self,
        socket: &mut WebSocket,
        snapshot: String,
        exit_rx: &mut oneshot::Receiver<u32>,
    ) -> End {
        if socket
            .send(Message::Binary(snapshot.into_bytes().into()))
            .await
            .is_err()
        {
            return End::Gone;
        }
        // Gone already. It was live at `attach`, after `on_exit` was subscribed, so its exit
        // event is on the way.
        if !self.pty.has(self.id) {
            let code = exit_code(exit_rx).await;
            return self.exit(socket, code).await;
        }
        loop {
            tokio::select! {
                chunk = self.rx.recv() => match chunk {
                    Some(chunk) => {
                        if socket.send(Message::Binary(chunk.into())).await.is_err() {
                            return End::Gone;
                        }
                    }
                    // The session was freed (its subscribers with it): the agent exited, and its
                    // exit event comes right after.
                    None => {
                        let code = exit_code(exit_rx).await;
                        return self.exit(socket, code).await;
                    }
                },
                code = &mut *exit_rx => return self.exit(socket, code.ok()).await,
                incoming = socket.recv() => match incoming {
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return End::Gone,
                    Some(Ok(Message::Binary(bytes))) => {
                        if self.pty.write(self.id, &bytes).is_err() {
                            return self.exit(socket, None).await;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        if self.command(text.as_str()).is_err() {
                            return self.exit(socket, None).await;
                        }
                    }
                    Some(Ok(_)) => {}
                },
            }
        }
    }

    /// A Text frame from the client. `Err` when the terminal can no longer be written to.
    fn command(&self, text: &str) -> Result<(), ()> {
        let Ok(v) = serde_json::from_str::<Value>(text) else {
            return Ok(());
        };
        match v["type"].as_str() {
            Some("input") => {
                if let Some(data) = v["data"].as_str() {
                    return self.pty.write(self.id, data.as_bytes()).map_err(|_| ());
                }
            }
            Some("resize") => {
                let dim = |k: &str| v[k].as_u64().and_then(|n| u16::try_from(n).ok());
                if let (Some(cols @ 1..), Some(rows @ 1..)) = (dim("cols"), dim("rows")) {
                    self.pty.resize(self.id, cols, rows);
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// The output still queued, then the exit message.
    async fn exit(&mut self, socket: &mut WebSocket, code: Option<u32>) -> End {
        while let Ok(chunk) = self.rx.try_recv() {
            if socket.send(Message::Binary(chunk.into())).await.is_err() {
                return End::Gone;
            }
        }
        if send_exit(socket, code).await {
            End::Exited
        } else {
            End::Gone
        }
    }
}
