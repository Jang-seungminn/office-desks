//! Small helpers shared across the crate and the server.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

/// Lock a mutex, ignoring poisoning (a panicked holder must not take the bridge down).
pub fn lock<T: ?Sized>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Milliseconds since the Unix epoch (`Date.now()`); 0 if the clock is before it.
pub fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_ms_is_recent() {
        assert!(epoch_ms() > 1_700_000_000_000);
    }

    #[test]
    fn lock_survives_poison() {
        let m = Mutex::new(1);
        let _ = std::thread::scope(|s| {
            s.spawn(|| {
                let _g = m.lock().unwrap();
                panic!("poison");
            })
            .join()
        });
        assert_eq!(*lock(&m), 1);
    }
}
