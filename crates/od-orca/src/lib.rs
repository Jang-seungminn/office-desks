//! The Orca and demo backends of office-desks, ported from `bridge/src`.
//!
//! Task 2 of R3 brings the Orca CLI runner, Task 3 usage, the session resolver and the
//! transcript verifier, Task 4 [`OrcaBackend`], Task 5 [`DemoBackend`].

mod backend;
mod cli;
mod demo;
#[cfg(test)]
mod fake;
mod sessions;
mod usage;
mod verify;

pub use backend::{
    join_lines_for_cmd, orca_hire_args, OrcaBackend, OrcaOptions, BLOCKED_TTL_MS, NOT_WRITABLE,
    TERMINALS_MAX_AGE_MS,
};
pub use cli::{
    probe_orca, resolve_orca_command, OrcaCli, OrcaRunner, ORCA_TIMEOUT, PROBE_TIMEOUT,
    UNSAFE_FOR_CMD,
};
pub use demo::{demo_org, DemoBackend, DemoOptions, DemoServerFiles, DEMO_EPOCH_ENV};
pub use sessions::{search_key, SearchKey, SessionResolver, SessionVerifier};
pub use usage::to_usage;
pub use verify::transcript_verifier;
