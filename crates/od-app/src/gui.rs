//! The Tauri shell around a started [`Core`]: the main window on `/app/`, and dispose on exit.

use std::sync::Arc;

use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::core::Core;
use crate::nav;

/// The main window's label (the app UI).
pub const MAIN: &str = "main";

/// Build and run the Tauri app around a started core. Returns only if Tauri returns.
pub fn run(core: Core) {
    let core = Arc::new(core);
    let port = core.port;
    let app = tauri::Builder::default()
        .manage(Arc::clone(&core))
        .setup(move |app| {
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
    app.run(move |app, ev| match ev {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { .. },
            ..
        } if label == MAIN => app.exit(0),
        // Dropping the handle does not dispose the agents (PARITY "R4: call shutdown()").
        RunEvent::Exit => tauri::async_runtime::block_on(core.shutdown()),
        _ => {}
    });
}
