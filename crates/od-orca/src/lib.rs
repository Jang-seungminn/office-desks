//! The Orca and demo backends of office-desks, ported from `bridge/src`.
//!
//! Task 2 of R3 brings the Orca CLI runner, Task 3 usage, the session resolver and the
//! transcript verifier; the backends follow in later tasks.

pub mod cli;
#[cfg(test)]
mod fake;
pub mod sessions;
pub mod usage;
pub mod verify;

pub use cli::{probe_orca, resolve_orca_command, OrcaCli, OrcaRunner, ORCA_TIMEOUT, PROBE_TIMEOUT};
pub use sessions::{search_key, SearchKey, SessionResolver, SessionVerifier};
pub use usage::to_usage;
pub use verify::transcript_verifier;
