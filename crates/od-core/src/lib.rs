//! od-core: the Office Desks core in Rust, a port of the Node core in `bridge/src` (everything
//! but the TUI). It holds the wire types (`model`), the native backend that runs agents in its
//! own PTYs with git worktrees and Claude hooks (`backend`, `native`), and the helpers the
//! server needs: transcripts, stats, awards, org chart, uploads, slash commands and answers.
//!
//! The async parts (`backend::NativeBackend`, `native::pty_host::PtyHost::dispose`) need a
//! tokio runtime with the time driver enabled (`enable_time` or `enable_all`). Many other APIs
//! are sync and do disk or process IO; call those from `spawn_blocking`.
//!
//! `crates/od-core/PARITY.md` lists what is ported, every deliberate difference from TS, and
//! what the server (R2) must do with this crate.

pub mod answer;
pub mod awards;
pub mod backend;
pub mod commands;
pub mod conversation;
mod fsio;
pub mod git;
pub mod git_info;
pub mod hire;
pub mod home;
#[doc(hidden)]
pub mod jsstr;
pub mod jsval;
pub mod keys;
pub mod local_image;
pub mod model;
pub mod native;
pub mod org;
pub mod screen;
pub mod security;
pub mod state_mapper;
pub mod stats;
pub mod subagents;
pub mod transcript;
pub mod uploads;
