//! The token comparison the TS code does with `crypto.timingSafeEqual`. Only this helper lives
//! here; the request guards of `bridge/src/security.ts` (origin, host) are R2's.

/// Whether a presented token equals the expected one, in constant time for equal lengths (like
/// `timingSafeEqual`). A length mismatch returns early, as in TS, which only reveals the length.
/// Used by the native backend's hook endpoint; R2's `/term` can share it.
pub fn same_token(want: &str, got: &str) -> bool {
    let (want, got) = (want.as_bytes(), got.as_bytes());
    if want.len() != got.len() {
        return false;
    }
    let diff = want.iter().zip(got).fold(0u8, |acc, (a, b)| acc | (a ^ b));
    std::hint::black_box(diff) == 0
}

#[cfg(test)]
mod tests {
    use super::same_token;

    #[test]
    fn compares_whole_tokens() {
        assert!(same_token("abc123", "abc123"));
        assert!(same_token("", ""));
        assert!(!same_token("abc123", "abc124"));
        assert!(!same_token("abc123", "abc12"));
        assert!(!same_token("abc", "abcd"));
        assert!(!same_token("abc", ""));
    }
}
