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

/// Node's `os.tmpdir()` over an env map: `TMPDIR`, `TMP`, `TEMP`, then `/tmp` on unix;
/// `TEMP`, `TMP`, then `<SystemRoot|windir>\temp` on Windows; a trailing separator is stripped.
/// The one difference: with nothing set on Windows, `std::env::temp_dir()`.
pub fn os_tmpdir(env: &HashMap<String, String>) -> PathBuf {
    os_tmpdir_for(env, cfg!(windows))
}

fn os_tmpdir_for(env: &HashMap<String, String>, windows: bool) -> PathBuf {
    let first = |keys: &[&str]| {
        keys.iter()
            .filter_map(|k| env.get(*k))
            .find(|v| !v.is_empty())
            .cloned()
    };
    if windows {
        // Node: TEMP, TMP, then `<SystemRoot or windir>\temp`.
        let mut p = first(&["TEMP", "TMP"])
            .or_else(|| first(&["SystemRoot", "windir"]).map(|r| format!("{r}\\temp")))
            .unwrap_or_else(|| std::env::temp_dir().to_string_lossy().into_owned());
        if p.len() > 1 && p.ends_with('\\') && !p.ends_with(":\\") {
            p.pop();
        }
        PathBuf::from(p)
    } else {
        let mut p = first(&["TMPDIR", "TMP", "TEMP"]).unwrap_or_else(|| "/tmp".to_string());
        if p.len() > 1 && p.ends_with('/') {
            p.pop();
        }
        PathBuf::from(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

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

    #[test]
    fn os_tmpdir_follows_node() {
        let unix = |e: &HashMap<String, String>| os_tmpdir_for(e, false);
        assert_eq!(unix(&env(&[("TMPDIR", "/x/")])), PathBuf::from("/x"));
        assert_eq!(unix(&env(&[("TMPDIR", "/")])), PathBuf::from("/"));
        assert_eq!(
            unix(&env(&[("TMPDIR", ""), ("TMP", "/t")])),
            PathBuf::from("/t")
        );
        assert_eq!(unix(&env(&[("TEMP", "/e")])), PathBuf::from("/e"));
        assert_eq!(unix(&env(&[])), PathBuf::from("/tmp"));
        let win = |e: &HashMap<String, String>| os_tmpdir_for(e, true);
        assert_eq!(win(&env(&[("TEMP", "C:\\t\\")])), PathBuf::from("C:\\t"));
        assert_eq!(win(&env(&[("TEMP", "C:\\")])), PathBuf::from("C:\\"));
        assert_eq!(win(&env(&[("TMP", "D:\\x")])), PathBuf::from("D:\\x"));
        assert_eq!(
            win(&env(&[("SystemRoot", "C:\\Windows")])),
            PathBuf::from("C:\\Windows\\temp")
        );
        assert_eq!(
            win(&env(&[("windir", "D:\\W")])),
            PathBuf::from("D:\\W\\temp")
        );
        assert_eq!(win(&env(&[])), std::env::temp_dir());
    }
}
