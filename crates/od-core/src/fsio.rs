//! Small file helpers: private folders and files, the atomic save of org.json and awards.json
//! (the TS `saveOrg` / `AwardBook.save`), and the Windows rename retry the registry shares.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

fn retry_delay(attempt: u32) -> Duration {
    Duration::from_millis(50 * (u64::from(attempt) + 1))
}

/// Windows: a virus scanner or indexer can hold the target for a moment (EPERM/EBUSY).
pub(crate) fn is_transient_rename_error(e: &io::Error) -> bool {
    // 5 ACCESS_DENIED, 32 SHARING_VIOLATION, 33 LOCK_VIOLATION
    e.kind() == io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(5 | 32 | 33))
}

/// Run `op`, retrying up to 4 more times (50 ms, 100 ms, ...) while `retryable` says so.
pub(crate) fn retry_io(
    mut op: impl FnMut() -> io::Result<()>,
    retryable: impl Fn(&io::Error) -> bool,
    sleep: impl Fn(Duration),
) -> io::Result<()> {
    let mut attempt = 0;
    loop {
        match op() {
            Ok(()) => return Ok(()),
            Err(e) if retryable(&e) && attempt < 4 => {
                sleep(retry_delay(attempt));
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// `mkdir -p` with mode 0700 on Unix.
pub(crate) fn create_private_dir_all(dir: &Path) -> io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(dir)
}

/// Write a file with mode 0600 on Unix (truncating).
pub(crate) fn write_private(file: &Path, body: &[u8]) -> io::Result<()> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(file)?;
    f.write_all(body)
}

/// Create the folder, write a temp file and rename it over the target. If the rename keeps
/// failing (Windows: antivirus or the indexer holding the target open) write the target
/// directly and drop the temp file, like the TS code.
pub(crate) fn save_atomic(file: &Path, body: &str) -> io::Result<()> {
    if let Some(dir) = file.parent().filter(|d| !d.as_os_str().is_empty()) {
        create_private_dir_all(dir)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    // Unique per call, so two saves of the same file never share a temp file.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    tmp.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let tmp = PathBuf::from(tmp);
    write_private(&tmp, body.as_bytes())?;
    let renamed = retry_io(
        || std::fs::rename(&tmp, file),
        |e| cfg!(windows) && is_transient_rename_error(e),
        std::thread::sleep,
    );
    if renamed.is_err() {
        let direct = write_private(file, body.as_bytes());
        let _ = std::fs::remove_file(&tmp);
        return direct;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[test]
    fn rename_retries_transient_errors_with_backoff_then_gives_up() {
        let slept = RefCell::new(Vec::new());
        let calls = Cell::new(0);
        let busy = || io::Error::from(io::ErrorKind::PermissionDenied);
        let ok = retry_io(
            || {
                calls.set(calls.get() + 1);
                if calls.get() < 3 {
                    Err(busy())
                } else {
                    Ok(())
                }
            },
            is_transient_rename_error,
            |d| slept.borrow_mut().push(d),
        );
        assert!(ok.is_ok());
        assert_eq!(calls.get(), 3);
        assert_eq!(
            *slept.borrow(),
            vec![Duration::from_millis(50), Duration::from_millis(100)]
        );

        calls.set(0);
        let err = retry_io(
            || {
                calls.set(calls.get() + 1);
                Err(busy())
            },
            is_transient_rename_error,
            |_| {},
        );
        assert!(err.is_err());
        assert_eq!(calls.get(), 5); // first try + 4 retries

        calls.set(0);
        let err = retry_io(
            || {
                calls.set(calls.get() + 1);
                Err(io::Error::from(io::ErrorKind::NotFound))
            },
            is_transient_rename_error,
            |_| {},
        );
        assert!(err.is_err());
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn saves_into_new_folders_and_replaces_without_leftovers() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("a").join("b.json");
        save_atomic(&f, "1").unwrap();
        save_atomic(&f, "2").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "2");
        assert_eq!(std::fs::read_dir(f.parent().unwrap()).unwrap().count(), 1);
    }
}
