//! The `native` test binary (libtest-mimic, `harness = false`): the contract replay against the
//! Node fixtures, the `/term` trials (`term.rs`), and the fake agent.
//!
//! Started as `claude` (a copy in a trial's `bin/`), this binary *is* the fake agent. Otherwise it
//! points the process-wide `HOME`/`TMPDIR`/`CLAUDE_CONFIG_DIR`/`OFFICE_DESKS_HOME`/git config at
//! a fresh scratch root (a safety net only; every trial passes its own env map) and runs the
//! trials. Each trial gets its own sub-root `<process root>/<trial name>`.

#[path = "../support/mod.rs"]
mod support;

mod contract;
mod fake_agent;
mod home;
mod term;

use std::path::{Path, PathBuf};

fn main() {
    let exe = std::env::current_exe().expect("current exe");
    if exe.file_stem().and_then(|s| s.to_str()) == Some("claude") {
        fake_agent::run();
    }

    // Parse first: bad arguments exit the process, which must not leave a scratch root behind.
    let args = libtest_mimic::Arguments::from_args();

    // Still single-threaded here: set_var is sound (edition 2021).
    let scratch = tempfile::Builder::new()
        .prefix("od-server-native-")
        .tempdir()
        .expect("scratch root");
    let root = dunce::canonicalize(scratch.path()).expect("canonical scratch root");
    scrub_process_env(&root);

    let mut trials = contract::trials(&root);
    trials.extend(term::trials(&root));
    trials.extend(home::trials(&root));
    let conclusion = libtest_mimic::run(&args, trials);
    drop(scratch);
    conclusion.exit();
}

/// Point every home, temp and git-config variable of this process at `root`.
fn scrub_process_env(root: &Path) {
    let home = root.join("home");
    let tmp = root.join("tmp");
    for d in [&home, &tmp] {
        std::fs::create_dir_all(d).expect("scratch dir");
    }
    let gitconfig: PathBuf = root.join("gitconfig");
    std::fs::write(&gitconfig, "").expect("scratch gitconfig");
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    std::env::set_var("GIT_CONFIG_GLOBAL", &gitconfig);
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    std::env::set_var("CLAUDE_CONFIG_DIR", root.join("claude"));
    std::env::set_var("OFFICE_DESKS_HOME", root.join("office"));
    for k in ["TMPDIR", "TMP", "TEMP"] {
        std::env::set_var(k, &tmp);
    }
}
