//! Node `path` semantics the TS code relies on, in one place. `win32_*` follow `path.win32` on
//! every host (testable on macOS); `node_*` follow `path` for the OS we run on.

use std::path::{Component, Path, PathBuf};

fn is_win_sep(c: char) -> bool {
    c == '\\' || c == '/'
}

/// `path.win32.isAbsolute`.
pub fn win32_is_absolute(p: &str) -> bool {
    let b: Vec<char> = p.chars().take(3).collect();
    match b.as_slice() {
        [c, ..] if is_win_sep(*c) => true,
        [d, ':', s, ..] if d.is_ascii_alphabetic() && is_win_sep(*s) => true,
        _ => false,
    }
}

/// `path.isAbsolute` with Node's rules for this OS (`/x` is absolute on Windows too).
pub fn node_is_absolute(p: &str) -> bool {
    if cfg!(windows) {
        win32_is_absolute(p)
    } else {
        p.starts_with('/')
    }
}

/// `path.win32.extname(p) != ""`.
pub fn win32_has_ext(p: &str) -> bool {
    let base = p.rsplit(is_win_sep).next().unwrap_or("");
    // A leading dot is not an extension (".bashrc"); ".." has none either.
    match base.rfind('.') {
        Some(i) => i > 0 && base != "..",
        None => false,
    }
}

/// `path.win32.join(dir, file)` for the simple shapes PATH entries take.
pub fn win32_join(dir: &str, file: &str) -> String {
    let dir = dir.replace('/', "\\");
    let file = file.replace('/', "\\");
    if dir.ends_with('\\') {
        format!("{dir}{file}")
    } else {
        format!("{dir}\\{file}")
    }
}

/// Lexical `path.normalize`: collapses `.`, `..` and repeated separators, using the platform
/// separator. A trailing separator is dropped (Node keeps it); git never emits one.
pub fn normalize_path(p: &str) -> String {
    let mut out = PathBuf::new();
    for c in Path::new(p).components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                match out.components().next_back() {
                    Some(Component::Normal(_)) => {
                        out.pop();
                    }
                    // `/..` is `/`.
                    Some(Component::RootDir | Component::Prefix(_)) => {}
                    _ => out.push(".."),
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        ".".to_string()
    } else {
        out.to_string_lossy().into_owned()
    }
}

/// `path.resolve`: absolute against the working directory, then a lexical normalize. No
/// filesystem access beyond reading the working directory for a relative path.
pub fn resolve_lexical(p: &Path) -> Option<PathBuf> {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(p)
    };
    let norm = normalize_path(&abs.to_string_lossy());
    // Windows paths compare without case, like `path.win32.relative`.
    Some(PathBuf::from(if cfg!(windows) {
        norm.to_lowercase()
    } else {
        norm
    }))
}

/// Node `path.posix.basename(p)`.
pub fn posix_basename(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    if t.is_empty() {
        return "";
    }
    t.rsplit('/').next().unwrap_or(t)
}

/// Node `path.win32.basename(p)`: `\` and `/` separate, and a drive prefix (`C:`) is dropped.
pub fn win32_basename(p: &str) -> &str {
    let b = p.as_bytes();
    let p = if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        &p[2..]
    } else {
        p
    };
    let sep = |c: char| c == '/' || c == '\\';
    let t = p.trim_end_matches(sep);
    if t.is_empty() {
        return "";
    }
    t.rsplit(sep).next().unwrap_or(t)
}

/// Node `path.basename(p)` for the OS we run on.
pub fn node_basename(p: &str) -> &str {
    if cfg!(windows) {
        win32_basename(p)
    } else {
        posix_basename(p)
    }
}

/// Desk ids use forward slashes on every OS (git prints them that way on Windows too).
pub fn slash(p: &str) -> String {
    p.replace('\\', "/")
}

/// `samePath` of `sessionResolver.ts`: equal after a lexical normalize, ignoring trailing
/// separators, and ignoring case on Windows.
pub fn same_path(a: &str, b: &str) -> bool {
    fn norm(p: &str) -> String {
        let n = normalize_path(p);
        let t = n.trim_end_matches(['/', '\\']);
        if cfg!(windows) {
            t.to_lowercase()
        } else {
            t.to_string()
        }
    }
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_path_handles_parent_dirs() {
        assert_eq!(normalize_path("a/.."), ".");
        assert_eq!(
            normalize_path("a/b/../c"),
            Path::new("a").join("c").to_string_lossy()
        );
        assert_eq!(
            normalize_path("../a"),
            Path::new("..").join("a").to_string_lossy()
        );
        assert_eq!(normalize_path("a/../.."), "..");
        assert_eq!(
            normalize_path("a//b/./"),
            Path::new("a").join("b").to_string_lossy()
        );
    }

    #[cfg(unix)]
    #[test]
    fn normalize_path_root_parent_stays_root() {
        assert_eq!(normalize_path("/.."), "/");
        assert_eq!(normalize_path("/a/../.."), "/");
    }

    #[cfg(windows)]
    #[test]
    fn normalize_path_converts_slashes_on_windows() {
        assert_eq!(normalize_path("C:/a/b"), "C:\\a\\b");
    }

    #[test]
    fn basenames_follow_node() {
        assert_eq!(posix_basename("/a/b.png"), "b.png");
        assert_eq!(posix_basename("/a/b/"), "b");
        assert_eq!(posix_basename("/"), "");
        assert_eq!(posix_basename(""), "");
        assert_eq!(posix_basename("a\\b"), "a\\b");
        assert_eq!(win32_basename("C:\\x\\y.png"), "y.png");
        assert_eq!(win32_basename("C:\\x\\y\\\\"), "y");
        assert_eq!(win32_basename("C:y.png"), "y.png");
        assert_eq!(win32_basename("C:"), "");
        assert_eq!(win32_basename("a/b\\c"), "c");
        assert_eq!(win32_basename("\\"), "");
    }

    #[cfg(unix)]
    #[test]
    fn node_is_absolute_on_unix() {
        assert!(node_is_absolute("/x"));
        assert!(!node_is_absolute("x/y"));
        assert!(!node_is_absolute("C:\\x"));
        assert!(!node_is_absolute("\\x"));
        assert_eq!(node_basename("/a/b"), "b");
    }

    #[cfg(windows)]
    #[test]
    fn node_is_absolute_on_windows() {
        assert!(node_is_absolute("C:\\x"));
        assert!(node_is_absolute("c:/x"));
        assert!(node_is_absolute("\\x"));
        assert!(node_is_absolute("/x"));
        assert!(!node_is_absolute("C:x"));
        assert!(!node_is_absolute("C:"));
        assert!(!node_is_absolute("x\\y"));
        assert_eq!(node_basename("C:\\a\\b"), "b");
    }

    #[test]
    fn same_path_ignores_dots_and_trailing_separators() {
        assert!(same_path("/Users/me/proj/", "/Users/me/proj"));
        assert!(same_path("/a/./b", "/a/b"));
        assert!(same_path("/a/b/../c", "/a/c"));
        assert!(!same_path("/a/b", "/a/c"));
    }

    #[cfg(unix)]
    #[test]
    fn same_path_is_case_sensitive_on_unix() {
        assert!(!same_path("/A", "/a"));
    }

    #[cfg(windows)]
    #[test]
    fn same_path_ignores_case_on_windows() {
        assert!(same_path("C:\\Users\\Me\\Proj\\", "c:/users/me/proj"));
    }

    #[test]
    fn slash_uses_forward_slashes() {
        assert_eq!(slash("a\\b/c"), "a/b/c");
    }
}
