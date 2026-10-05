//! Gongbang (공방), the Office Desks desktop app: od-core and od-server in-process on a random
//! loopback port, with a Tauri 2 window on the server's own `/app/` page.
//!
//! `core` and `nav` are pure Rust (no Tauri types) and tested with `cargo test`; `gui` is the
//! Tauri shell around a started [`Core`].

pub mod assets;
pub mod core;
pub mod gui;
pub mod nav;

pub use assets::AppDist;
pub use core::{app_config, hook_relay_requested, start, Core};
