//! Where Office Desks keeps its files (port of `bridge/src/home.ts`).

use std::collections::HashMap;
use std::path::PathBuf;

use crate::jsstr;

/// The user's home directory, as Node's `os.homedir()` finds it: `HOME` on Unix, `USERPROFILE` on Windows.
fn os_home() -> PathBuf {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// `OFFICE_DESKS_HOME` (trimmed) lets tests and trials use a fresh home; else `~/.office-desks`.
pub fn office_home(env: &HashMap<String, String>) -> PathBuf {
    match env.get("OFFICE_DESKS_HOME").map(|v| jsstr::trim(v)) {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => os_home().join(".office-desks"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn honors_office_desks_home_else_default() {
        let env = HashMap::from([("OFFICE_DESKS_HOME".to_string(), "/tmp/od".to_string())]);
        assert_eq!(office_home(&env), PathBuf::from("/tmp/od"));
        assert_eq!(
            office_home(&HashMap::new()),
            os_home().join(".office-desks")
        );
    }

    #[test]
    fn blank_value_falls_back_and_value_is_trimmed() {
        let blank = HashMap::from([("OFFICE_DESKS_HOME".to_string(), "  \t".to_string())]);
        assert_eq!(office_home(&blank), os_home().join(".office-desks"));
        let padded = HashMap::from([("OFFICE_DESKS_HOME".to_string(), " /x/y \n".to_string())]);
        assert_eq!(office_home(&padded), PathBuf::from("/x/y"));
    }
}
