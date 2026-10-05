//! The Orca and demo backends of office-desks, ported from `bridge/src`.
//!
//! Task 2 of R3 brings the Orca CLI runner, Task 3 usage, the session resolver and the
//! transcript verifier, Task 4 [`OrcaBackend`], Task 5 [`DemoBackend`].

pub mod backend;
pub mod cli;
pub mod demo;
#[cfg(test)]
mod fake;
pub mod sessions;
pub mod usage;
pub mod verify;

pub use backend::{
    join_lines_for_cmd, orca_hire_args, OrcaBackend, OrcaOptions, BLOCKED_TTL_MS, NOT_WRITABLE,
    TERMINALS_MAX_AGE_MS,
};
pub use cli::{probe_orca, resolve_orca_command, OrcaCli, OrcaRunner, ORCA_TIMEOUT, PROBE_TIMEOUT};
pub use demo::{demo_org, DemoBackend, DemoOptions, DemoServerFiles, DEMO_EPOCH_ENV};
pub use sessions::{search_key, SearchKey, SessionResolver, SessionVerifier};
pub use usage::to_usage;
pub use verify::transcript_verifier;
