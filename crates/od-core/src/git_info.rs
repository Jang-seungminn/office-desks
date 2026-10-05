//! What each worktree has changed, straight from git. Port of `bridge/src/gitInfo.ts`.
//!
//! `normalize_pr` lives in `state_mapper` (Task 2) and is re-exported here.

use std::collections::HashMap;
use std::path::Path;

use crate::git::{GitError, GitRunner};
use crate::jsstr::{slice_utf16, utf16_len};
use crate::model::{ChangeStatus, ChangeSummary, ChangedFile};

pub use crate::state_mapper::normalize_pr;

/// Diffs longer than this many UTF-16 code units (JS `string.length`) are cut.
pub const MAX_DIFF_BYTES: usize = 400_000;

/// Untracked files above this size are not line-counted.
const MAX_COUNT_BYTES: u64 = 1_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusRow {
    pub path: String,
    pub code: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NumstatEntry {
    pub added: i64,
    pub deleted: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDiff {
    pub diff: String,
    pub truncated: bool,
}

/// `git status --porcelain=v1 -z` -> path and two-letter status (rename targets win).
pub fn parse_status(out: &str) -> Vec<StatusRow> {
    let parts: Vec<&str> = out.split('\0').filter(|s| !s.is_empty()).collect();
    let mut rows = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let code: String = parts[i].chars().take(2).collect();
        let path: String = parts[i].chars().skip(3).collect();
        if code.starts_with('R') || code.starts_with('C') {
            i += 1; // the next entry is the original name
        }
        rows.push(StatusRow { path, code });
        i += 1;
    }
    rows
}

fn count(s: &str) -> Option<i64> {
    if s == "-" {
        return Some(0);
    }
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // JS Number() of an absurdly long digit string is a huge float; saturate.
    Some(s.parse::<i64>().unwrap_or(i64::MAX))
}

/// `git diff --numstat -z` -> added/deleted per path (binary files report `-`).
pub fn parse_numstat(out: &str) -> HashMap<String, NumstatEntry> {
    let mut map = HashMap::new();
    let parts: Vec<&str> = out.split('\0').collect();
    let mut i = 0;
    while i < parts.len() {
        let mut it = parts[i].splitn(3, '\t');
        let parsed = (|| {
            let a = count(it.next()?)?;
            let d = count(it.next()?)?;
            Some((a, d, it.next()?))
        })();
        if let Some((added, deleted, p)) = parsed {
            let mut path = p;
            if path.is_empty() {
                // rename: "a\td\t\0old\0new"
                path = parts.get(i + 2).copied().unwrap_or("");
                i += 2;
            }
            map.insert(path.to_string(), NumstatEntry { added, deleted });
        }
        i += 1;
    }
    map
}

fn status_label(code: &str) -> ChangeStatus {
    if code == "??" {
        ChangeStatus::Untracked
    } else if code.contains('D') {
        ChangeStatus::Deleted
    } else if code.contains('A') {
        ChangeStatus::Added
    } else if code.contains('R') {
        ChangeStatus::Renamed
    } else {
        ChangeStatus::Modified
    }
}

/// Lines in a new (untracked) text file; big or binary files count 0.
fn count_lines(file: &Path) -> i64 {
    let Ok(md) = std::fs::metadata(file) else {
        return 0;
    };
    if !md.is_file() || md.len() > MAX_COUNT_BYTES {
        return 0;
    }
    let Ok(buf) = std::fs::read(file) else {
        return 0;
    };
    if buf.contains(&0) {
        return 0;
    }
    if buf.is_empty() {
        return 0;
    }
    let n = buf.iter().filter(|&&b| b == b'\n').count() as i64 + 1;
    n - i64::from(buf.ends_with(b"\n"))
}

pub fn change_summary(cwd: &str, git: &dyn GitRunner) -> Result<ChangeSummary, GitError> {
    let status = parse_status(&git.run(
        cwd,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?);
    // A repo without commits has no HEAD to diff against; counts then come from status only.
    let numstat = git
        .run(cwd, &["diff", "--numstat", "-z", "HEAD"])
        .map(|o| parse_numstat(&o))
        .unwrap_or_default();
    let files: Vec<ChangedFile> = status
        .into_iter()
        .map(|StatusRow { path, code }| {
            let n = numstat.get(&path);
            let added = match n {
                Some(n) => n.added,
                None if code == "??" => count_lines(&Path::new(cwd).join(&path)),
                None => 0,
            };
            ChangedFile {
                status: status_label(&code),
                added,
                deleted: n.map_or(0, |n| n.deleted),
                path,
            }
        })
        .collect();
    Ok(ChangeSummary {
        added: files.iter().map(|f| f.added).sum(),
        deleted: files.iter().map(|f| f.deleted).sum(),
        files,
    })
}

/// Unified diff of one changed file against HEAD (untracked files: their content as additions).
/// Never fails: a git error yields an empty diff (or, for `--no-index`, its stdout).
pub fn file_diff(cwd: &str, file: &ChangedFile, git: &dyn GitRunner) -> FileDiff {
    let diff = if file.status == ChangeStatus::Untracked {
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        // `--no-index` exits 1 when files differ; the diff is in the error's stdout.
        match git.run(
            cwd,
            &["diff", "--no-color", "--no-index", "--", null, &file.path],
        ) {
            Ok(s) => s,
            Err(e) => e.stdout,
        }
    } else {
        git.run(cwd, &["diff", "--no-color", "HEAD", "--", &file.path])
            .unwrap_or_default()
    };
    // JS counts UTF-16 units and `slice` cuts there. slice_utf16 never splits a char, so when the
    // cut would land inside a surrogate pair it keeps one unit less than TS (a lone surrogate
    // that TS would emit is not representable in a Rust String anyway).
    let truncated = utf16_len(&diff) > MAX_DIFF_BYTES;
    FileDiff {
        diff: if truncated {
            slice_utf16(&diff, MAX_DIFF_BYTES).to_string()
        } else {
            diff
        },
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::SystemGit;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let o = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(o.status.success(), "git {args:?}: {:?}", o);
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    fn repo() -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        git(d, &["init", "-q"]);
        git(d, &["config", "user.email", "t@example.com"]);
        git(d, &["config", "user.name", "t"]);
        git(d, &["config", "commit.gpgsign", "false"]);
        git(d, &["config", "core.autocrlf", "false"]);
        std::fs::write(d.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(d.join("gone.txt"), "bye\n").unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-qm", "init"]);
        t
    }

    fn s(t: &tempfile::TempDir) -> &str {
        t.path().to_str().unwrap()
    }

    fn row(p: &str, c: &str) -> StatusRow {
        StatusRow {
            path: p.into(),
            code: c.into(),
        }
    }

    #[test]
    fn parses_porcelain_status_including_renames() {
        assert_eq!(
            parse_status(" M a.txt\0?? new.txt\0R  b.txt\0old.txt\0"),
            vec![row("a.txt", " M"), row("new.txt", "??"), row("b.txt", "R ")]
        );
    }

    #[test]
    fn parses_numstat_including_binary_files() {
        let m = parse_numstat("3\t1\ta.txt\0-\t-\timg.png\0");
        assert_eq!(
            m["a.txt"],
            NumstatEntry {
                added: 3,
                deleted: 1
            }
        );
        assert_eq!(
            m["img.png"],
            NumstatEntry {
                added: 0,
                deleted: 0
            }
        );
    }

    #[test]
    fn numstat_rename_uses_new_path() {
        let m = parse_numstat("1\t2\t\0old.txt\0new.txt\0");
        assert_eq!(
            m["new.txt"],
            NumstatEntry {
                added: 1,
                deleted: 2
            }
        );
        assert_eq!(m.len(), 1);
    }

    #[test]
    fn lists_modified_deleted_and_untracked_files_with_line_counts() {
        let t = repo();
        let d = t.path();
        std::fs::write(d.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        git(d, &["rm", "-q", "gone.txt"]);
        std::fs::write(d.join("new.txt"), "hello\n").unwrap();
        let sum = change_summary(s(&t), &SystemGit).unwrap();
        let by = |p: &str| sum.files.iter().find(|f| f.path == p).unwrap().clone();
        let a = by("a.txt");
        assert_eq!(
            (a.status, a.added, a.deleted),
            (ChangeStatus::Modified, 2, 1)
        );
        let g = by("gone.txt");
        assert_eq!((g.status, g.deleted), (ChangeStatus::Deleted, 1));
        let n = by("new.txt");
        assert_eq!((n.status, n.added), (ChangeStatus::Untracked, 1));
        assert_eq!((sum.added, sum.deleted), (3, 2));
        assert!(file_diff(s(&t), &a, &SystemGit).diff.contains("+TWO"));
        assert!(file_diff(s(&t), &n, &SystemGit).diff.contains("+hello"));
    }

    #[test]
    fn spaces_binary_and_renames() {
        let t = repo();
        let d = t.path();
        std::fs::write(d.join("my file.txt"), "x\ny\n").unwrap();
        std::fs::write(d.join("img.bin"), [0u8, 1, 2, 0]).unwrap();
        git(d, &["mv", "a.txt", "b.txt"]);
        let sum = change_summary(s(&t), &SystemGit).unwrap();
        let by = |p: &str| sum.files.iter().find(|f| f.path == p).cloned();
        let sp = by("my file.txt").unwrap();
        assert_eq!((sp.status, sp.added), (ChangeStatus::Untracked, 2));
        assert!(file_diff(s(&t), &sp, &SystemGit).diff.contains("+x"));
        assert_eq!(by("img.bin").unwrap().added, 0);
        let r = by("b.txt").unwrap();
        assert_eq!(r.status, ChangeStatus::Renamed);
        assert!(by("a.txt").is_none());
    }

    #[test]
    fn repo_without_commits_counts_untracked_from_files() {
        let t = tempfile::tempdir().unwrap();
        git(t.path(), &["init", "-q"]);
        std::fs::write(t.path().join("n.txt"), "a\nb").unwrap();
        let sum = change_summary(s(&t), &SystemGit).unwrap();
        assert_eq!(sum.files.len(), 1);
        assert_eq!(sum.files[0].added, 2);
    }

    #[test]
    fn huge_untracked_file_is_truncated_not_empty() {
        let t = repo();
        let big = "x".repeat(79) + "\n";
        std::fs::write(t.path().join("big.txt"), big.repeat(55_000)).unwrap(); // ~4.4 MiB
        let f = ChangedFile {
            path: "big.txt".into(),
            status: ChangeStatus::Untracked,
            added: 0,
            deleted: 0,
        };
        let d = file_diff(s(&t), &f, &SystemGit);
        assert!(d.truncated);
        assert_eq!(d.diff.len(), MAX_DIFF_BYTES);
    }

    struct Fixed(String);
    impl GitRunner for Fixed {
        fn run(&self, _: &str, _: &[&str]) -> Result<String, GitError> {
            Ok(self.0.clone())
        }
    }

    fn modified() -> ChangedFile {
        ChangedFile {
            path: "x".into(),
            status: ChangeStatus::Modified,
            added: 0,
            deleted: 0,
        }
    }

    #[test]
    fn truncates_at_max_diff_units() {
        let at = Fixed("a".repeat(MAX_DIFF_BYTES));
        let r = file_diff(".", &modified(), &at);
        assert!(!r.truncated);
        assert_eq!(r.diff.len(), MAX_DIFF_BYTES);
        let over = Fixed("a".repeat(MAX_DIFF_BYTES + 1));
        let r = file_diff(".", &modified(), &over);
        assert!(r.truncated);
        assert_eq!(r.diff.len(), MAX_DIFF_BYTES);
        // Counted in UTF-16 units, not bytes: 3-byte chars, 1 unit each.
        let ko = Fixed("가".repeat(MAX_DIFF_BYTES));
        assert!(!file_diff(".", &modified(), &ko).truncated);
        let ko = Fixed("가".repeat(MAX_DIFF_BYTES + 1));
        let r = file_diff(".", &modified(), &ko);
        assert!(r.truncated);
        assert_eq!(r.diff.chars().count(), MAX_DIFF_BYTES);
    }

    #[test]
    fn git_failure_gives_empty_diff() {
        struct Fail;
        impl GitRunner for Fail {
            fn run(&self, _: &str, _: &[&str]) -> Result<String, GitError> {
                Err(GitError {
                    message: "x".into(),
                    stdout: "partial".into(),
                })
            }
        }
        assert_eq!(file_diff(".", &modified(), &Fail).diff, "");
        let mut u = modified();
        u.status = ChangeStatus::Untracked;
        assert_eq!(file_diff(".", &u, &Fail).diff, "partial");
    }

    #[test]
    fn normalize_pr_accepts_numbers_urls_and_objects() {
        use serde_json::json;
        assert_eq!(normalize_pr(&json!(12)).unwrap().number, Some(12));
        let p = normalize_pr(&json!("https://github.com/o/r/pull/7")).unwrap();
        assert_eq!(p.number, Some(7));
        assert_eq!(p.url.as_deref(), Some("https://github.com/o/r/pull/7"));
        let p = normalize_pr(
            &json!({"number":3,"url":"javascript:alert(1)","title":"Fix","state":"open"}),
        )
        .unwrap();
        assert_eq!(p.number, Some(3));
        assert_eq!(p.url, None);
        assert_eq!(p.title.as_deref(), Some("Fix"));
        assert_eq!(p.state.as_deref(), Some("open"));
        assert!(normalize_pr(&json!(null)).is_none());
    }
}
