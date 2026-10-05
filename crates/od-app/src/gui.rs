//! The Tauri shell around a started [`Core`]: the main window on `/app/` (the only one with
//! IPC), the office window on `/`, the navigation policy, the IPC commands, the macOS menu, and
//! dispose on exit.
//!
//! The wiring ([`configure`], [`setup_main`]) and the commands are generic over the runtime so
//! the `app` trials run the production ACL on Tauri's `MockRuntime`.

use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::CapabilityBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, RunEvent, Runtime, State, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::core::Core;
use crate::nav::{self, Nav};

/// The main window's label (the app UI).
pub const MAIN: &str = "main";

/// The office window's label (the web office). No capability names it: it has no IPC.
pub const OFFICE: &str = "office";

/// The app's IPC commands. build.rs declares the same names in the app manifest, which makes
/// Tauri require a permission for each (and Task 5's `host.ts` calls them by these names).
pub const COMMANDS: [&str; 3] = ["term_config", "pick_folder", "open_office"];

/// The permissions the `app-ui` capability grants: one `allow-*` per command, nothing else (no
/// `core:*`, no `dialog:*`, no `opener:*`).
pub const PERMISSIONS: [&str; 3] = [
    "allow-term-config",
    "allow-pick-folder",
    "allow-open-office",
];

/// The IPC capability: our commands, for window `main`, from `http://127.0.0.1:<port>` only.
///
/// The pattern is origin-wide because Tauri matches the request's `Origin` (no path); see
/// [`nav::app_remote_pattern`]. `main` never leaves `/app/` ([`nav::main_nav`]), and both server
/// CSPs send `frame-ancestors 'none'`, so the office page cannot run inside `main` either.
pub fn capability(port: u16) -> CapabilityBuilder {
    PERMISSIONS.iter().fold(
        CapabilityBuilder::new("app-ui")
            .remote(nav::app_remote_pattern(port))
            .local(false)
            .window(MAIN),
        |c, p| c.permission(*p),
    )
}

/// `term_config`'s answer: the server port and the `/term` token (IPC is its only channel).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermConfig {
    pub port: u16,
    pub token: String,
}

/// The `/term` token for the app UI. Only window `main` on our origin may call it.
#[tauri::command]
pub fn term_config(core: State<'_, Arc<Core>>) -> TermConfig {
    TermConfig {
        port: core.port,
        token: core.token().to_string(),
    }
}

/// The native folder picker. Async with the callback API, so no runtime worker blocks on it.
#[tauri::command]
pub async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("프로젝트 폴더 고르기")
        .pick_folder(move |p| {
            let _ = tx.send(p);
        });
    let Ok(Some(path)) = rx.await else {
        return Ok(None);
    };
    Ok(Some(
        path.into_path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned(),
    ))
}

/// Show the office window (create it on first use). Async: a sync command runs on the main
/// thread, and creating a window there can deadlock on Windows.
#[tauri::command]
pub async fn open_office<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    show_office(&app).map_err(|e| e.to_string())
}

fn show_office<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(OFFICE) {
        w.unminimize()?;
        w.show()?;
        return w.set_focus();
    }
    let port = app.state::<Arc<Core>>().port;
    let (nav_handle, new_handle) = (app.clone(), app.clone());
    WebviewWindowBuilder::new(app, OFFICE, WebviewUrl::External(nav::office_url(port)))
        .title("🏢 사무실 — Gongbang")
        .inner_size(1280.0, 820.0)
        .on_navigation(move |u| route(&nav_handle, nav::office_nav(u, port), u))
        .on_new_window(move |u, _| {
            route(&new_handle, nav::new_window(&u), &u);
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

/// Carry out a [`Nav`] decision: `true` lets the webview load the URL. `External` hands it to
/// the OS browser (`open` / `ShellExecuteW`, argv only) and keeps the window where it is.
fn route<R: Runtime>(handle: &AppHandle<R>, nav: Nav, url: &Url) -> bool {
    match nav {
        Nav::Allow => true,
        Nav::External => {
            if let Err(e) = handle.opener().open_url(url.as_str(), None::<&str>) {
                eprintln!("[gongbang] open {url}: {e}");
            }
            false
        }
        Nav::Deny => false,
    }
}

/// Plugins, commands and the managed core: everything `run` adds to the builder that does not
/// need the app to exist yet.
///
/// The opener plugin's injected click script is off: it would send `_blank` links to
/// `plugin:opener|open_url`, which no window may call. Those clicks reach `on_new_window`
/// instead, and [`route`] opens them.
pub fn configure<R: Runtime>(builder: tauri::Builder<R>, core: Arc<Core>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            term_config,
            pick_folder,
            open_office
        ])
        .manage(core)
}

/// Grant the IPC capability for `port`, then build the main window on `/app/` with the
/// navigation policy.
pub fn setup_main<R: Runtime, M: Manager<R>>(
    app: &M,
    port: u16,
) -> tauri::Result<WebviewWindow<R>> {
    app.add_capability(capability(port))?;
    let (nav_handle, new_handle) = (app.app_handle().clone(), app.app_handle().clone());
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(nav::app_url(port)))
        .title("Gongbang")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .on_navigation(move |u| route(&nav_handle, nav::main_nav(u, port), u))
        .on_new_window(move |u, _| {
            route(&new_handle, nav::new_window(&u), &u);
            NewWindowResponse::Deny
        })
        .build()
}

/// The macOS menu, replacing Tauri's default so ⌘W reaches the page (no Close Window item).
/// Edit keeps ⌘C/⌘V/⌘X/⌘A/⌘Z working in the webview; Quit is ⌘Q.
#[cfg(target_os = "macos")]
fn build_menu(app: &AppHandle<tauri::Wry>) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, PredefinedMenuItem as Item, Submenu};
    let gongbang = Submenu::with_items(
        app,
        "Gongbang",
        true,
        &[
            &Item::about(app, None, None)?,
            &Item::separator(app)?,
            &Item::hide(app, None)?,
            &Item::hide_others(app, None)?,
            &Item::separator(app)?,
            &Item::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "편집",
        true,
        &[
            &Item::undo(app, None)?,
            &Item::redo(app, None)?,
            &Item::separator(app)?,
            &Item::cut(app, None)?,
            &Item::copy(app, None)?,
            &Item::paste(app, None)?,
            &Item::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "윈도우",
        true,
        &[&Item::minimize(app, None)?, &Item::fullscreen(app, None)?],
    )?;
    Menu::with_items(app, &[&gongbang, &edit, &window])
}

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
    let builder = configure(tauri::Builder::default(), Arc::clone(&core));
    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_menu);
    let app = builder
        .setup(move |app| {
            #[cfg(unix)]
            {
                let h = app.handle().clone();
                exit_on_signal(tauri::async_runtime::handle().inner(), move || h.exit(0))?;
            }
            setup_main(app, port)?;
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
    fn commands_match_permissions() {
        assert_eq!(COMMANDS.len(), PERMISSIONS.len());
        for (cmd, perm) in COMMANDS.iter().zip(PERMISSIONS) {
            assert_eq!(perm, format!("allow-{}", cmd.replace('_', "-")));
        }
    }

    /// The app manifest is what makes Tauri check our commands against the ACL at all.
    #[test]
    fn build_rs_declares_every_command() {
        let build = include_str!("../build.rs");
        for cmd in COMMANDS {
            assert!(
                build.contains(&format!("\"{cmd}\"")),
                "build.rs lacks {cmd}"
            );
        }
    }

    /// tauri-plugin-dialog's injected script replaces `window.alert` / `window.confirm` in every
    /// window with `plugin:dialog|message` / `|confirm` calls, which no window may make: `alert`
    /// would do nothing, and `confirm` returns a (truthy) Promise, so `if (!confirm(..))` guards
    /// would pass. No page may rely on them.
    #[test]
    fn no_page_uses_alert_or_confirm() {
        fn scan(dir: &std::path::Path, hits: &mut Vec<String>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return; // app/src arrives in Task 5
            };
            for e in entries.flatten() {
                let path = e.path();
                let name = e.file_name().to_string_lossy().into_owned();
                if path.is_dir() {
                    if name != "node_modules" && name != "dist" {
                        scan(&path, hits);
                    }
                    continue;
                }
                let code = [".ts", ".tsx", ".js", ".mjs", ".html"]
                    .iter()
                    .any(|x| name.ends_with(x));
                if !code {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap_or_default();
                for f in ["alert(", "confirm("] {
                    let mut rest = text.as_str();
                    while let Some(i) = rest.find(f) {
                        // A bare call or `window.` / `globalThis.` / `self.`; not `x.confirm(`.
                        let head = &rest[..i];
                        let global = ["window.", "globalThis.", "self."]
                            .iter()
                            .any(|g| head.ends_with(g));
                        let bare = !head
                            .chars()
                            .next_back()
                            .is_some_and(|c| c.is_alphanumeric() || "_$.".contains(c));
                        if global || bare {
                            hits.push(format!("{}: {f}", path.display()));
                        }
                        rest = &rest[i + f.len()..];
                    }
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut hits = Vec::new();
        scan(&root.join("web/src"), &mut hits);
        scan(&root.join("app/src"), &mut hits);
        assert!(root.join("web/src").is_dir(), "web/src not found");
        assert!(hits.is_empty(), "native dialogs: {hits:?}");
    }

    #[test]
    fn term_config_serializes_camel_case() {
        let v = serde_json::to_value(TermConfig {
            port: 1,
            token: "t".into(),
        })
        .expect("json");
        assert_eq!(v, serde_json::json!({"port": 1, "token": "t"}));
    }

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
