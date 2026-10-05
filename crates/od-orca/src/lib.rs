//! The Orca and demo backends of office-desks, ported from `bridge/src`.
//!
//! Task 2 of R3 brings the Orca CLI runner; the backends follow in later tasks.

pub mod cli;
#[cfg(test)]
mod fake;

pub use cli::{probe_orca, resolve_orca_command, OrcaCli, OrcaRunner, ORCA_TIMEOUT, PROBE_TIMEOUT};
