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
//! or [`MAX_QUEUED_BYTES`] behind is closed with 1013 `slow consumer` (it must reattach for a
//! fresh snapshot); on shutdown the socket is closed with 1001.
//!
//! Client to server: Binary frames are raw input. Text frames are JSON:
//! `{"type":"input","data":"…"}` writes the UTF-8 bytes, `{"type":"resize","cols":c,"rows":r}`
//! (cols 1..=1000, rows 1..=500; anything else is ignored) resizes; anything else is ignored.
//! Client messages and frames are capped at 1 MiB. A write that fails (the terminal is gone)
//! ends the session like an exit with `code: null`.
//!
//! While attached, the session holds a [`ReplyMute`](od_core::native::pty_host::ReplyMute), so
//! the client's terminal answers the agent's queries instead of the headless screen. The mute
//! and both subscriptions are dropped together when the session ends, however it ends.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use axum::extract::{FromRequestParts, Request, WebSocketUpgrade};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use od_core::native::pty_host::{PtyHost, MAX_COLS, MAX_ROWS};
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
/// A slow consumer is, by definition, not reading: give it longer to take in the 1013. Also
/// the cap on the exit path (late output plus the exit message).
const SLOW_CLOSE_TIMEOUT: Duration = Duration::from_secs(10);
/// After the exit event, how long late output (a ConPTY reader drains after the exit) may still
/// arrive before the exit message goes out.
const LATE_OUTPUT_WAIT: Duration = Duration::from_secs(2);
/// Output queued for one client, in bytes, before it counts as a slow consumer (next to the
/// `term_buffer` chunk count).
pub(crate) const MAX_QUEUED_BYTES: usize = 8 << 20;
/// The largest message (and frame) a client may send.
const MAX_CLIENT_MESSAGE: usize = 1 << 20;

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
        Ok(up) => up
            .max_message_size(MAX_CLIENT_MESSAGE)
            .max_frame_size(MAX_CLIENT_MESSAGE)
            .on_upgrade(move |socket| session(st, socket, pty, id)),
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
    /// The client fell `term_buffer` chunks or `MAX_QUEUED_BYTES` behind.
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

        let (outbox, mut inbox) = outbox(st.cfg.term_buffer, MAX_QUEUED_BYTES);
        let budget = Arc::clone(&outbox.budget);
        let Some((snapshot, _data_sub)) = pty.attach(&id, move |chunk| outbox.push(chunk)) else {
            send_exit(&mut socket, None).await;
            close(&mut socket, NORMAL, "", CLOSE_TIMEOUT, &st).await;
            return;
        };

        let link = Link {
            pty: &pty,
            id: &id,
            rx: &mut inbox,
        };
        // A send to a client that does not read can wait forever: a stop or an overflow ends
        // the whole feed (tungstenite keeps a half-written frame and finishes it first).
        tokio::select! {
            end = link.feed(&mut socket, snapshot, &mut exit_rx) => end,
            _ = budget.behind.notified() => End::SlowConsumer,
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

/// Send the exit message; false when the client is gone or does not take it within
/// [`SLOW_CLOSE_TIMEOUT`].
async fn send_exit(socket: &mut WebSocket, code: Option<u32>) -> bool {
    let text = serde_json::to_string(&ExitMessage { kind: "exit", code })
        .expect("the exit message serializes");
    let send = socket.send(Message::Text(text.into()));
    matches!(
        tokio::time::timeout(SLOW_CLOSE_TIMEOUT, send).await,
        Ok(Ok(()))
    )
}

/// What the output queue of one client shares between the reader thread and the socket task.
struct Budget {
    /// Bytes pushed and not yet taken.
    bytes: AtomicUsize,
    max_bytes: usize,
    /// Set once the client fell behind; nothing more is queued.
    full: AtomicBool,
    behind: Notify,
}

/// The reader thread's end: never blocks.
struct Outbox {
    tx: mpsc::Sender<Vec<u8>>,
    budget: Arc<Budget>,
}

/// The socket task's end.
struct Inbox {
    rx: mpsc::Receiver<Vec<u8>>,
    budget: Arc<Budget>,
}

/// A queue of at most `chunks` chunks and `max_bytes` bytes.
fn outbox(chunks: usize, max_bytes: usize) -> (Outbox, Inbox) {
    let (tx, rx) = mpsc::channel(chunks.max(1));
    let budget = Arc::new(Budget {
        bytes: AtomicUsize::new(0),
        max_bytes,
        full: AtomicBool::new(false),
        behind: Notify::new(),
    });
    (
        Outbox {
            tx,
            budget: Arc::clone(&budget),
        },
        Inbox { rx, budget },
    )
}

impl Budget {
    fn overflow(&self) {
        self.full.store(true, Ordering::SeqCst);
        self.behind.notify_one();
    }

    fn is_full(&self) -> bool {
        self.full.load(Ordering::SeqCst)
    }
}

impl Outbox {
    /// Queue a chunk; past either bound, mark the client as behind (and drop the chunk).
    fn push(&self, chunk: &[u8]) {
        let b = &self.budget;
        if b.is_full() {
            return;
        }
        let n = chunk.len();
        if b.bytes.fetch_add(n, Ordering::SeqCst) + n > b.max_bytes {
            b.overflow();
            return;
        }
        match self.tx.try_send(chunk.to_vec()) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => b.overflow(),
            Err(mpsc::error::TrySendError::Closed(_)) => {
                b.bytes.fetch_sub(n, Ordering::SeqCst);
            }
        }
    }
}

impl Inbox {
    fn took(&self, chunk: Option<Vec<u8>>) -> Option<Vec<u8>> {
        if let Some(c) = &chunk {
            self.budget.bytes.fetch_sub(c.len(), Ordering::SeqCst);
        }
        chunk
    }

    async fn recv(&mut self) -> Option<Vec<u8>> {
        let chunk = self.rx.recv().await;
        self.took(chunk)
    }
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
    rx: &'a mut Inbox,
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
                let dim = |k: &str, max: u16| {
                    v[k].as_u64()
                        .and_then(|n| u16::try_from(n).ok())
                        .filter(|n| (1..=max).contains(n))
                };
                if let (Some(cols), Some(rows)) = (dim("cols", MAX_COLS), dim("rows", MAX_ROWS)) {
                    self.pty.resize(self.id, cols, rows);
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// The output still queued or still arriving (until the session is freed, at most
    /// [`LATE_OUTPUT_WAIT`]), then the exit message; all within [`SLOW_CLOSE_TIMEOUT`].
    async fn exit(&mut self, socket: &mut WebSocket, code: Option<u32>) -> End {
        let rx = &mut *self.rx;
        let finish = async move {
            let late = tokio::time::Instant::now() + LATE_OUTPUT_WAIT;
            while let Ok(Some(chunk)) = tokio::time::timeout_at(late, rx.recv()).await {
                if socket.send(Message::Binary(chunk.into())).await.is_err() {
                    return End::Gone;
                }
            }
            if send_exit(socket, code).await {
                End::Exited
            } else {
                End::Gone
            }
        };
        tokio::time::timeout(SLOW_CLOSE_TIMEOUT, finish)
            .await
            .unwrap_or(End::Gone)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_outbox_counts_chunks() {
        let (out, mut inbox) = outbox(2, 1 << 20);
        out.push(b"a");
        out.push(b"b");
        assert!(!out.budget.is_full());
        out.push(b"c");
        assert!(out.budget.is_full());
        // Once behind, nothing more is queued.
        out.push(b"d");
        assert_eq!(inbox.recv().await.as_deref(), Some(&b"a"[..]));
        assert_eq!(inbox.recv().await.as_deref(), Some(&b"b"[..]));
        out.push(b"e");
        drop(out);
        assert_eq!(inbox.recv().await, None);
        // The overflow left a wake-up for the session.
        tokio::time::timeout(Duration::from_secs(1), inbox.budget.behind.notified())
            .await
            .expect("notified");
    }

    #[tokio::test]
    async fn the_outbox_counts_bytes_and_frees_them_on_recv() {
        let (out, mut inbox) = outbox(100, 10);
        out.push(b"123456");
        assert_eq!(out.budget.bytes.load(Ordering::SeqCst), 6);
        assert_eq!(inbox.recv().await.as_deref(), Some(&b"123456"[..]));
        assert_eq!(out.budget.bytes.load(Ordering::SeqCst), 0);
        out.push(b"123456");
        out.push(b"7890");
        assert!(!out.budget.is_full(), "exactly the budget is fine");
        out.push(b"x");
        assert!(out.budget.is_full());
    }

    #[test]
    fn a_closed_outbox_gives_its_bytes_back() {
        let (out, inbox) = outbox(4, 10);
        drop(inbox);
        out.push(b"12345678");
        out.push(b"12345678");
        assert!(!out.budget.is_full());
        assert_eq!(out.budget.bytes.load(Ordering::SeqCst), 0);
    }
}
