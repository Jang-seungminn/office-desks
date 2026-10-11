//! Where Office Desks keeps its files (port of `bridge/src/home.ts`).

use std::collections::HashMap;
use std::path::PathBuf;

use crate::jsstr;

/// The user's home directory: `HOME` on Unix / `USERPROFILE` on Windows when set to an
/// absolute path, else the platform's home lookup. If neither yields an absolute path (a
/// stripped-down environment), falls back to the system temp dir so the result is never empty
/// or relative.
pub fn os_home() -> PathBuf {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let from_env = std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute());
    #[allow(deprecated)] // fine on rustc >= 1.85; deprecation was lifted
    let home = from_env.or_else(|| std::env::home_dir().filter(|p| p.is_absolute()));
    home.unwrap_or_else(std::env::temp_dir)
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
