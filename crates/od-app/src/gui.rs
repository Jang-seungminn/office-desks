//! The Tauri shell around a started [`Core`]: the main window on `/app/`, and dispose on exit.

use std::sync::Arc;

use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::core::Core;
use crate::nav;

/// The main window's label (the app UI).
pub const MAIN: &str = "main";

/// What the run loop does with an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Nothing,
    /// Quit the app (`AppHandle::exit(0)`), which ends in [`RunEvent::Exit`].
    Quit,
    /// Dispose the core: `block_on(core.shutdown())`.
    Shutdown,
}

/// The run loop's policy: closing the main window quits; `Exit` (the one shutdown path for
/// ⌘Q, the last window, a signal, a Windows log-off) disposes the agents.
pub fn on_event(ev: &RunEvent) -> Action {
    match ev {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { .. },
            ..
        } if label == MAIN => Action::Quit,
        // Dropping the handle does not dispose the agents (PARITY "R4: call shutdown()").
        RunEvent::Exit => Action::Shutdown,
        _ => Action::Nothing,
    }
}

/// On SIGINT, SIGTERM or SIGHUP, call `exit` once (the GUI passes `AppHandle::exit(0)`, so a
/// signal takes the same `RunEvent::Exit` path as ⌘Q). The handlers are installed before this
/// returns, so a signal right after it is not lost to the default action.
#[cfg(unix)]
pub fn exit_on_signal(
    rt: &tokio::runtime::Handle,
    exit: impl FnOnce() + Send + 'static,
) -> std::io::Result<()> {
    use tokio::signal::unix::{signal, SignalKind};
    let _in_rt = rt.enter();
    let mut int = signal(SignalKind::interrupt())?;
    let mut term = signal(SignalKind::terminate())?;
    let mut hup = signal(SignalKind::hangup())?;
    rt.spawn(async move {
        tokio::select! {
            _ = int.recv() => {}
            _ = term.recv() => {}
            _ = hup.recv() => {}
        }
        exit();
    });
    Ok(())
}

/// Build and run the Tauri app around a started core. Returns only if Tauri returns.
///
/// Disposal runs on `RunEvent::Exit` only. There is deliberately no panic hook: a `block_on`
/// inside a panic hook can deadlock (the panicking thread may hold what the shutdown needs). If
/// the process dies anyway, the OS closes the PTY masters and the agents get SIGHUP / their
/// console closes.
pub fn run(core: Core) {
    let core = Arc::new(core);
    let port = core.port;
    let app = tauri::Builder::default()
        .manage(Arc::clone(&core))
        .setup(move |app| {
            #[cfg(unix)]
            {
                let h = app.handle().clone();
                exit_on_signal(tauri::async_runtime::handle().inner(), move || h.exit(0))?;
            }
            WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(nav::app_url(port)))
                .title("Gongbang")
                .inner_size(1280.0, 820.0)
                .min_inner_size(720.0, 480.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[gongbang] {e}");
            tauri::async_runtime::block_on(core.shutdown());
            std::process::exit(1);
        }
    };
    app.run(move |app, ev| match on_event(&ev) {
        Action::Quit => app.exit(0),
        Action::Shutdown => tauri::async_runtime::block_on(core.shutdown()),
        Action::Nothing => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_disposes_and_others_do_nothing() {
        assert_eq!(on_event(&RunEvent::Exit), Action::Shutdown);
        assert_eq!(on_event(&RunEvent::Ready), Action::Nothing);
        assert_eq!(on_event(&RunEvent::MainEventsCleared), Action::Nothing);
    }

    #[cfg(unix)]
    #[test]
    fn a_signal_calls_exit_once() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let (tx, rx) = std::sync::mpsc::channel();
        exit_on_signal(rt.handle(), move || tx.send(()).expect("send")).expect("handlers");
        // SAFETY: SIGHUP to ourselves; tokio's handler (installed above) catches it.
        unsafe { libc::kill(libc::getpid(), libc::SIGHUP) };
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .expect("exit called after SIGHUP");
        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(200))
            .is_err());
    }
}
