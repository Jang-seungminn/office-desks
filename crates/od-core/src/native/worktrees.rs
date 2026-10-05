//! Worktrees straight from git: list them, create one per task, and identify a repo by its main
//! checkout. Port of `bridge/src/native/worktrees.ts`.

use std::path::{Component, Path, PathBuf};

use crate::backend::BackendError;
use crate::git::GitRunner;
use crate::native::registry::RepoRecord;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub head: String,
    pub is_main: bool,
}

/// `git worktree list --porcelain`: blank-line separated records, the main worktree first.
pub fn parse_porcelain(out: &str) -> Vec<WorktreeInfo> {
    let mut list: Vec<WorktreeInfo> = Vec::new();
    let normalized = out.replace("\r\n", "\n");
    for block in split_blocks(&normalized) {
        let mut fields: Vec<(&str, &str)> = Vec::new();
        for line in block.split('\n') {
            if line.is_empty() {
                continue;
            }
            let (k, v) = match line.find(' ') {
                Some(sp) => (&line[..sp], &line[sp + 1..]),
                None => (line, ""),
            };
            // Map semantics: the last duplicate wins.
            fields.retain(|(fk, _)| *fk != k);
            fields.push((k, v));
        }
        let get = |k: &str| fields.iter().find(|(fk, _)| *fk == k).map(|(_, v)| *v);
        let wt = match get("worktree") {
            Some(w) if !w.is_empty() => w,
            _ => continue,
        };
        if get("bare").is_some() {
            continue;
        }
        let branch = get("branch").unwrap_or("");
        list.push(WorktreeInfo {
            path: wt.to_string(),
            branch: branch
                .strip_prefix("refs/heads/")
                .unwrap_or(branch)
                .to_string(),
            head: get("HEAD").unwrap_or("").to_string(),
            is_main: list.is_empty(),
        });
    }
    list
}

/// Equivalent of JS `split(/\n\s*\n/)`: a newline, optional whitespace, a newline.
fn split_blocks(s: &str) -> Vec<&str> {
    let b = s.as_bytes();
    let mut parts = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\n' {
            // `\s*` is greedy but backtracks: the separator ends at the last '\n' of the
            // whitespace run.
            let mut j = i + 1;
            let mut last_nl = None;
            while j < b.len() && (b[j] as char).is_ascii_whitespace() {
                if b[j] == b'\n' {
                    last_nl = Some(j);
                }
                j += 1;
            }
            if let Some(e) = last_nl {
                parts.push(&s[start..i]);
                start = e + 1;
                i = e + 1;
                continue;
            }
        }
        i += 1;
    }
    parts.push(&s[start..]);
    parts
}

pub fn list_worktrees(
    repo_path: &str,
    git: &dyn GitRunner,
) -> Result<Vec<WorktreeInfo>, crate::git::GitError> {
    Ok(parse_porcelain(
        &git.run(repo_path, &["worktree", "list", "--porcelain"])?,
    ))
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

fn repo_id(keyed_path: &str) -> String {
    sha1_smol::Sha1::from(keyed_path.as_bytes())
        .digest()
        .to_string()[..12]
        .to_string()
}

/// The repo that `dir` belongs to, named after its main checkout (also from inside a linked
/// worktree).
pub fn resolve_repo(dir: &str, git: &dyn GitRunner) -> Result<RepoRecord, BackendError> {
    let main = list_worktrees(dir, git)
        .ok()
        .and_then(|l| l.into_iter().next());
    let Some(main) = main else {
        return Err(BackendError::with_code(
            format!("git 저장소가 아니에요: {dir}"),
            "not_a_repo",
        ));
    };
    let repo_path = normalize_path(&main.path);
    let keyed = if cfg!(windows) {
        repo_path.to_lowercase()
    } else {
        repo_path.clone()
    };
    let id = repo_id(&keyed);
    let name = Path::new(&repo_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(RepoRecord {
        id,
        path: repo_path,
        name,
        extra: Default::default(),
    })
}

pub fn add_worktree(
    repo_path: &str,
    dest: &str,
    branch: &str,
    base: Option<&str>,
    git: &dyn GitRunner,
) -> Result<(), crate::git::GitError> {
    let mut args = vec!["worktree", "add", "-b", branch, dest];
    if let Some(b) = base.filter(|b| !b.is_empty()) {
        args.push(b);
    }
    git.run(repo_path, &args).map(|_| ())
}

pub fn worktree_dest(home: &Path, repo_name: &str, name: &str) -> PathBuf {
    let safe: String = repo_name
        .chars()
        .flat_map(|c| {
            let keep = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
            // JS replaces per UTF-16 code unit: an astral char becomes two underscores.
            std::iter::repeat_n(if keep { c } else { '_' }, c.len_utf16())
        })
        .collect();
    home.join("worktrees").join(safe).join(name)
}

/// `git worktree remove` (never --force): a dirty worktree is refused by git and left as is; the
/// branch stays.
pub fn remove_worktree(
    repo_path: &str,
    wt_path: &str,
    git: &dyn GitRunner,
) -> Result<(), crate::git::GitError> {
    git.run(repo_path, &["worktree", "remove", wt_path])
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::SystemGit;
    use std::fs;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let o = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    fn real(p: &Path) -> PathBuf {
        dunce::canonicalize(p).unwrap()
    }

    fn scratch_repo() -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::Builder::new()
            .prefix("od-git-")
            .tempdir()
            .unwrap();
        let dir = real(t.path());
        git(&dir, &["init", "-q", "-b", "main"]);
        git(
            &dir,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
        (t, dir)
    }

    fn s(p: &Path) -> &str {
        p.to_str().unwrap()
    }

    fn info(path: &str, branch: &str, head: &str, is_main: bool) -> WorktreeInfo {
        WorktreeInfo {
            path: path.into(),
            branch: branch.into(),
            head: head.into(),
            is_main,
        }
    }

    #[test]
    fn parse_porcelain_reads_main_and_linked_skipping_bare() {
        let out = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /w/feat\nHEAD bbb\nbranch refs/heads/feat\n\nworktree /w/det\nHEAD ccc\ndetached\n\nworktree /bare\nbare\n\n";
        assert_eq!(
            parse_porcelain(out),
            vec![
                info("/r", "main", "aaa", true),
                info("/w/feat", "feat", "bbb", false),
                info("/w/det", "", "ccc", false),
            ]
        );
    }

    #[test]
    fn parse_porcelain_handles_crlf() {
        let out = "worktree /r\r\nHEAD aaa\r\nbranch refs/heads/main\r\n\r\n";
        assert_eq!(parse_porcelain(out), vec![info("/r", "main", "aaa", true)]);
    }

    #[test]
    fn resolves_a_repo_adds_a_worktree_and_lists_it() {
        let (_t, repo) = scratch_repo();
        fs::write(repo.join("a.txt"), "x").unwrap();
        let g = SystemGit;
        let rec = resolve_repo(s(&repo), &g).unwrap();
        assert_eq!(rec.path, normalize_path(s(&repo)));
        assert_eq!(rec.name, repo.file_name().unwrap().to_str().unwrap());
        assert_eq!(rec.id.len(), 12);
        assert!(rec
            .id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));

        let h = tempfile::Builder::new()
            .prefix("od-home-")
            .tempdir()
            .unwrap();
        let home = real(h.path());
        let dest = worktree_dest(&home, &rec.name, "fix-login");
        assert_eq!(
            dest,
            home.join("worktrees").join(&rec.name).join("fix-login")
        );
        add_worktree(s(&repo), s(&dest), "fix-login", None, &g).unwrap();
        let list = list_worktrees(s(&repo), &g).unwrap();
        let got: Vec<(String, String, bool)> = list
            .iter()
            .map(|w| (normalize_path(&w.path), w.branch.clone(), w.is_main))
            .collect();
        assert_eq!(
            got,
            vec![
                (normalize_path(s(&repo)), "main".to_string(), true),
                (normalize_path(s(&dest)), "fix-login".to_string(), false),
            ]
        );
        // Resolving from inside a linked worktree still names the main checkout.
        assert_eq!(resolve_repo(s(&dest), &g).unwrap().path, rec.path);
    }

    #[test]
    fn removes_a_clean_worktree_but_keeps_its_branch() {
        let (_t, repo) = scratch_repo();
        let h = tempfile::Builder::new()
            .prefix("od-home-")
            .tempdir()
            .unwrap();
        let dest = worktree_dest(&real(h.path()), "app", "fix-login");
        let g = SystemGit;
        add_worktree(s(&repo), s(&dest), "fix-login", None, &g).unwrap();
        remove_worktree(s(&repo), s(&dest), &g).unwrap();
        let paths: Vec<String> = list_worktrees(s(&repo), &g)
            .unwrap()
            .iter()
            .map(|w| normalize_path(&w.path))
            .collect();
        assert!(!paths.contains(&normalize_path(s(&dest))));
        assert_ne!(git(&repo, &["branch", "--list", "fix-login"]).trim(), "");
    }

    #[test]
    fn refuses_a_dirty_worktree_and_leaves_it_alone() {
        let (_t, repo) = scratch_repo();
        let h = tempfile::Builder::new()
            .prefix("od-home-")
            .tempdir()
            .unwrap();
        let dest = worktree_dest(&real(h.path()), "app", "wip");
        let g = SystemGit;
        add_worktree(s(&repo), s(&dest), "wip", None, &g).unwrap();
        fs::write(dest.join("new.txt"), "x").unwrap();
        assert!(remove_worktree(s(&repo), s(&dest), &g).is_err());
        assert!(dest.exists());
    }

    #[test]
    fn rejects_a_non_repo_with_not_a_repo() {
        let t = tempfile::Builder::new()
            .prefix("od-nogit-")
            .tempdir()
            .unwrap();
        let e = resolve_repo(s(t.path()), &SystemGit).unwrap_err();
        assert_eq!(e.code.as_deref(), Some("not_a_repo"));
        assert!(e.message.starts_with("git 저장소가 아니에요: "));
    }

    #[test]
    fn worktree_dest_sanitizes_the_repo_name() {
        let d = worktree_dest(Path::new("/h"), "my repo/ü", "x");
        assert_eq!(
            d,
            Path::new("/h")
                .join("worktrees")
                .join("my_repo__")
                .join("x")
        );
    }

    #[test]
    fn worktree_dest_replaces_per_utf16_unit() {
        let d = worktree_dest(Path::new("/h"), "a\u{1F600}b", "x");
        assert_eq!(d, Path::new("/h").join("worktrees").join("a__b").join("x"));
    }

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

    #[cfg(unix)]
    #[test]
    fn repo_id_golden() {
        // Verified against Node: sha1('/tmp/x').slice(0, 12)
        assert_eq!(repo_id("/tmp/x"), "e7ad2368a922");
    }

    #[cfg(windows)]
    #[test]
    fn normalize_path_converts_slashes_on_windows() {
        assert_eq!(normalize_path("C:/a/b"), "C:\\a\\b");
    }

    #[test]
    fn add_worktree_passes_the_base() {
        use std::sync::Mutex;
        struct Rec(Mutex<Vec<Vec<String>>>);
        impl GitRunner for Rec {
            fn run(&self, _: &str, a: &[&str]) -> Result<String, crate::git::GitError> {
                self.0
                    .lock()
                    .unwrap()
                    .push(a.iter().map(|s| s.to_string()).collect());
                Ok(String::new())
            }
        }
        let r = Rec(Mutex::new(vec![]));
        add_worktree("/r", "/d", "b", Some("origin/main"), &r).unwrap();
        assert_eq!(
            r.0.lock().unwrap()[0],
            ["worktree", "add", "-b", "b", "/d", "origin/main"]
        );
    }
}
