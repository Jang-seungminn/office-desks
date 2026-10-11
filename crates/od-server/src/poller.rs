//! Port of `poller.ts`: poll the backend's snapshot, enrich it, and announce it only when the
//! office actually changed (`updatedAt` is ignored in the comparison).

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use od_core::backend::BackendError;
use od_core::model::{OfficeDesk, OfficeSnapshot};
use serde::Serialize;
use tokio::sync::{broadcast, watch, Notify};
use tokio::task::JoinHandle;

/// Where snapshots come from (`backend.snapshot()`).
pub type SourceFn =
    Arc<dyn Fn() -> BoxFuture<'static, Result<OfficeSnapshot, BackendError>> + Send + Sync>;

/// Adds what the backend does not know (changes, transcripts, awards) before change detection.
pub type EnrichFn = Arc<dyn for<'a> Fn(&'a mut OfficeSnapshot) -> BoxFuture<'a, ()> + Send + Sync>;

/// Change notifications kept for a slow listener before it lags.
const CHANGE_BUFFER: usize = 16;

struct State {
    snapshot: Arc<OfficeSnapshot>,
    last_key: String,
}

pub struct Poller {
    source: SourceFn,
    enrich: EnrichFn,
    interval: Duration,
    idle_interval: Duration,
    state: Mutex<State>,
    /// Refresh bookkeeping, see [`Gens`].
    gens: Mutex<Gens>,
    /// The generation of the last finished poll; `refresh` waits on it.
    completed: watch::Sender<u64>,
    idle: AtomicBool,
    wake: Notify,
    changes: broadcast::Sender<Arc<OfficeSnapshot>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// `JSON.stringify({ desks, error })`.
#[derive(Serialize)]
struct Key<'a> {
    desks: &'a [OfficeDesk],
    error: &'a Option<String>,
}

/// Generations: every `refresh` call bumps `requested`. A poll records `requested` when it
/// starts and, once done, publishes it as `completed`. A call that arrives while a poll runs
/// (so possibly after its source ran) leaves `requested` ahead, and the poll task loops once
/// more: a `refresh` is never satisfied by a poll whose source ran before the call.
#[derive(Default)]
struct Gens {
    requested: u64,
    running: bool,
}

/// Ends the poll task's run, even by panic, so waiters wake and later refreshes start a new one.
struct EndRun(Arc<Poller>);

impl Drop for EndRun {
    fn drop(&mut self) {
        let mut g = lock(&self.0.gens);
        if g.running {
            g.running = false;
            self.0.completed.send_replace(g.requested);
        }
    }
}

impl Poller {
    pub fn new(
        source: SourceFn,
        enrich: EnrichFn,
        interval: Duration,
        idle_interval: Duration,
    ) -> Arc<Poller> {
        Arc::new(Poller {
            source,
            enrich,
            interval,
            idle_interval,
            state: Mutex::new(State {
                snapshot: Arc::new(OfficeSnapshot {
                    desks: Vec::new(),
                    updated_at: 0,
                    error: None,
                }),
                last_key: String::new(),
            }),
            gens: Mutex::new(Gens::default()),
            completed: watch::channel(0).0,
            idle: AtomicBool::new(false),
            wake: Notify::new(),
            changes: broadcast::channel(CHANGE_BUFFER).0,
            task: Mutex::new(None),
        })
    }

    /// The last polled snapshot (`{desks: [], updatedAt: 0, error: null}` before the first).
    pub fn current(&self) -> Arc<OfficeSnapshot> {
        Arc::clone(&lock(&self.state).snapshot)
    }

    pub fn is_idle(&self) -> bool {
        self.idle.load(Ordering::SeqCst)
    }

    /// Slow down while nobody watches; leaving idle polls at once.
    pub fn set_idle(&self, idle: bool) {
        let was = self.idle.swap(idle, Ordering::SeqCst);
        if was && !idle {
            self.wake.notify_one();
        }
    }

    /// Every snapshot whose `{desks, error}` differs from the previous one.
    pub fn on_change(&self) -> broadcast::Receiver<Arc<OfficeSnapshot>> {
        self.changes.subscribe()
    }

    /// Poll now and return once a poll that started after this call has finished. Concurrent
    /// callers share polls. The poll runs in its own task, so it completes even if every caller
    /// stops waiting.
    pub async fn refresh(self: &Arc<Self>) {
        let (target, mut done) = {
            let mut g = lock(&self.gens);
            g.requested += 1;
            if !g.running {
                g.running = true;
                let me = Arc::clone(self);
                tokio::spawn(async move {
                    let end = EndRun(Arc::clone(&me));
                    loop {
                        let gen = lock(&me.gens).requested;
                        me.poll().await;
                        me.completed.send_replace(gen);
                        let mut g = lock(&me.gens);
                        if g.requested == gen {
                            g.running = false;
                            break;
                        }
                    }
                    drop(end);
                });
            }
            (g.requested, self.completed.subscribe())
        };
        let _ = done.wait_for(|c| *c >= target).await;
    }

    /// `void poller.refresh()`.
    pub fn refresh_detached(self: &Arc<Self>) {
        let me = Arc::clone(self);
        tokio::spawn(async move { me.refresh().await });
    }

    /// The loop: refresh, then wait the (idle) interval or until woken by `set_idle(false)`.
    pub fn start(self: &Arc<Self>) {
        let mut task = lock(&self.task);
        if task.as_ref().is_some_and(|t| !t.is_finished()) {
            return;
        }
        let me = Arc::clone(self);
        *task = Some(tokio::spawn(async move {
            loop {
                me.refresh().await;
                let wait = if me.is_idle() {
                    me.idle_interval
                } else {
                    me.interval
                };
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = me.wake.notified() => {}
                }
            }
        }));
    }

    /// End the loop. A poll already running still completes.
    pub fn stop(&self) {
        if let Some(t) = lock(&self.task).take() {
            t.abort();
        }
    }

    async fn poll(&self) {
        let next = match (self.source)().await {
            Ok(mut s) => {
                // An enrichment failure never loses the poll.
                let _ = AssertUnwindSafe((self.enrich)(&mut s)).catch_unwind().await;
                s
            }
            Err(e) => {
                // Keep the last known office on screen and surface the error.
                let cur = self.current();
                OfficeSnapshot {
                    desks: cur.desks.clone(),
                    updated_at: now_ms(),
                    error: Some(e.message),
                }
            }
        };
        let key = serde_json::to_string(&Key {
            desks: &next.desks,
            error: &next.error,
        })
        .expect("snapshots always serialize");
        let next = Arc::new(next);
        let changed = {
            let mut st = lock(&self.state);
            st.snapshot = Arc::clone(&next);
            if st.last_key != key {
                st.last_key = key;
                true
            } else {
                false
            }
        };
        if changed {
            let _ = self.changes.send(next);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn desk(id: &str) -> OfficeDesk {
        serde_json::from_value(serde_json::json!({
            "id": id, "repoId": "r", "isMain": true, "parentId": null, "name": id, "repo": "repo",
            "branch": "main", "path": "/x", "status": "", "workspaceStatus": null, "comment": "",
            "preview": "", "isActive": false, "unread": false, "lastActivityAt": null,
            "changes": null, "pr": null, "agents": []
        }))
        .unwrap()
    }

    fn office(n: usize) -> OfficeSnapshot {
        OfficeSnapshot {
            desks: (0..n).map(|i| desk(&format!("d{i}"))).collect(),
            updated_at: now_ms(),
            error: None,
        }
    }

    fn no_enrich() -> EnrichFn {
        Arc::new(|_s| Box::pin(async {}))
    }

    fn counting_source(polls: Arc<AtomicUsize>) -> SourceFn {
        Arc::new(move || {
            polls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(office(1)) })
        })
    }

    fn drain(rx: &mut broadcast::Receiver<Arc<OfficeSnapshot>>) -> Vec<String> {
        let mut seen = Vec::new();
        while let Ok(s) = rx.try_recv() {
            seen.push(
                s.error
                    .clone()
                    .unwrap_or_else(|| format!("desks:{}", s.desks.len())),
            );
        }
        seen
    }

    #[tokio::test]
    async fn notifies_only_on_change_and_keeps_last_desks_on_error() {
        let fail = Arc::new(AtomicBool::new(false));
        let f = Arc::clone(&fail);
        let source: SourceFn = Arc::new(move || {
            let fail = f.load(Ordering::SeqCst);
            Box::pin(async move {
                if fail {
                    Err(BackendError::plain("orca down"))
                } else {
                    Ok(office(1))
                }
            })
        });
        let poller = Poller::new(
            source,
            no_enrich(),
            Duration::from_millis(1500),
            Duration::from_secs(10),
        );
        let mut rx = poller.on_change();
        poller.refresh().await;
        poller.refresh().await;
        assert_eq!(drain(&mut rx), ["desks:1"]);

        fail.store(true, Ordering::SeqCst);
        poller.refresh().await;
        assert_eq!(drain(&mut rx), ["orca down"]);
        assert_eq!(poller.current().desks.len(), 1);
        assert!(poller.current().updated_at > 0);
    }

    #[tokio::test]
    async fn enriches_before_change_detection_and_shares_an_in_flight_poll() {
        let polls = Arc::new(AtomicUsize::new(0));
        let enrich: EnrichFn = Arc::new(|s| {
            Box::pin(async move {
                s.desks[0].name = "enriched".into();
            })
        });
        let poller = Poller::new(
            counting_source(Arc::clone(&polls)),
            enrich,
            Duration::from_millis(1500),
            Duration::from_secs(10),
        );
        tokio::join!(poller.refresh(), poller.refresh());
        assert_eq!(polls.load(Ordering::SeqCst), 1);
        assert_eq!(poller.current().desks[0].name, "enriched");
    }

    #[tokio::test]
    async fn a_panicking_enrichment_is_swallowed() {
        let enrich: EnrichFn = Arc::new(|s| {
            Box::pin(async move {
                s.desks[0].name = "half".into();
                panic!("enrich failed");
            })
        });
        let poller = Poller::new(
            counting_source(Arc::new(AtomicUsize::new(0))),
            enrich,
            Duration::from_millis(1500),
            Duration::from_secs(10),
        );
        poller.refresh().await;
        assert_eq!(poller.current().desks[0].name, "half");
        assert!(poller.current().error.is_none());
    }

    #[tokio::test]
    async fn leaving_idle_polls_at_once() {
        let polls = Arc::new(AtomicUsize::new(0));
        let poller = Poller::new(
            counting_source(Arc::clone(&polls)),
            no_enrich(),
            Duration::from_secs(10),
            Duration::from_secs(10),
        );
        poller.set_idle(true);
        poller.start();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while polls.load(Ordering::SeqCst) < 1 {
            assert!(tokio::time::Instant::now() < deadline, "first poll");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        // Let the loop settle into its 10 s idle sleep.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(polls.load(Ordering::SeqCst), 1);
        poller.set_idle(false);
        assert!(!poller.is_idle());
        let deadline = tokio::time::Instant::now() + Duration::from_millis(100);
        while polls.load(Ordering::SeqCst) < 2 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "set_idle(false) did not poll within 100 ms"
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        // Idle again only sets the flag.
        poller.set_idle(true);
        assert!(poller.is_idle());
        poller.stop();
    }

    #[tokio::test]
    async fn stop_ends_the_loop() {
        let polls = Arc::new(AtomicUsize::new(0));
        let poller = Poller::new(
            counting_source(Arc::clone(&polls)),
            no_enrich(),
            Duration::from_millis(5),
            Duration::from_millis(5),
        );
        poller.start();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(polls.load(Ordering::SeqCst) >= 2);
        poller.stop();
        // Let an in-flight poll finish.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let n = polls.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(polls.load(Ordering::SeqCst), n);
        assert!(lock(&poller.task).is_none());
    }

    #[tokio::test]
    async fn refresh_during_a_poll_waits_for_a_later_poll() {
        let polls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Notify::new());
        let (p, g) = (Arc::clone(&polls), Arc::clone(&gate));
        let source: SourceFn = Arc::new(move || {
            let n = p.fetch_add(1, Ordering::SeqCst) + 1;
            let g = Arc::clone(&g);
            Box::pin(async move {
                if n == 1 {
                    g.notified().await;
                }
                Ok(office(n))
            })
        });
        let poller = Poller::new(
            source,
            no_enrich(),
            Duration::from_secs(60),
            Duration::from_secs(60),
        );
        let first = tokio::spawn({
            let p = Arc::clone(&poller);
            async move { p.refresh().await }
        });
        while polls.load(Ordering::SeqCst) < 1 {
            tokio::task::yield_now().await;
        }
        // The first poll's source has run and is held at the gate.
        let second = tokio::spawn({
            let p = Arc::clone(&poller);
            async move { p.refresh().await }
        });
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        assert!(!second.is_finished());
        gate.notify_one();
        tokio::time::timeout(Duration::from_secs(5), async {
            first.await.unwrap();
            second.await.unwrap();
        })
        .await
        .expect("both refreshes return");
        assert_eq!(polls.load(Ordering::SeqCst), 2);
        // The second caller saw the second poll's result.
        assert_eq!(poller.current().desks.len(), 2);
    }
}
