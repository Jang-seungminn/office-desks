//! Port of the session verifier in `bridge/src/server.ts`: only accept a session whose
//! transcript actually contains what we searched for.

use std::path::Path;
use std::sync::Arc;

use futures_util::future::FutureExt;
use od_core::jsstr::{is_js_space, slice_utf16};
use od_core::model::MessageRole;
use od_core::transcript::{read_transcript, ReadOptions};

use crate::sessions::{SearchKey, SessionVerifier};

/// `s.replace(/\s+/g, ' ')`, without the trim of `collapse_ws`.
fn squash_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if is_js_space(c) {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

fn check(file: &str, key: &SearchKey) -> bool {
    let Ok(t) = read_transcript(Path::new(file), ReadOptions::default()) else {
        return false;
    };
    if let Some(title) = &key.title {
        let wanted = title.to_lowercase();
        return t.title.as_deref().map(str::to_lowercase).as_deref() == Some(wanted.as_str())
            || !t.messages.is_empty();
    }
    let needle = slice_utf16(&key.phrase, 40);
    t.messages
        .iter()
        .any(|m| m.role != MessageRole::Tool && squash_ws(&m.text).contains(needle))
}

/// The verifier the server hands the Orca backend. The transcript is read on the blocking pool;
/// a read error or a panic there is "not this session".
pub fn transcript_verifier() -> SessionVerifier {
    Arc::new(|file: String, key: SearchKey| {
        async move {
            tokio::task::spawn_blocking(move || check(&file, &key))
                .await
                .unwrap_or(false)
        }
        .boxed()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &tempfile::TempDir, name: &str, lines: &[&str]) -> String {
        let p = dir.path().join(name);
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        p.to_string_lossy().into_owned()
    }

    fn key(phrase: &str, title: Option<&str>) -> SearchKey {
        SearchKey {
            phrase: phrase.into(),
            title: title.map(str::to_string),
        }
    }

    #[test]
    fn squash_keeps_ends() {
        assert_eq!(squash_ws("  a \n\t b  "), " a b ");
        assert_eq!(squash_ws("a\u{3000}b"), "a b");
    }

    #[tokio::test]
    async fn checks_messages_and_titles() {
        let dir = tempfile::tempdir().unwrap();
        let rich = write(
            &dir,
            "rich.jsonl",
            &[
                r#"{"type":"user","message":{"role":"user","content":"add  pixel\nassets please"}}"#,
                r#"{"type":"ai-title","aiTitle":"Fix login bug"}"#,
            ],
        );
        let v = transcript_verifier();
        assert!(v(rich.clone(), key("add pixel assets please", None)).await);
        assert!(!v(rich.clone(), key("something else entirely", None)).await);
        assert!(v(rich.clone(), key("x", Some("FIX LOGIN BUG"))).await);

        let title_only = write(
            &dir,
            "title.jsonl",
            &[r#"{"type":"ai-title","aiTitle":"Fix login bug"}"#],
        );
        assert!(v(title_only.clone(), key("x", Some("fix login bug"))).await);
        assert!(!v(title_only, key("x", Some("Other session"))).await);

        let missing = dir.path().join("missing.jsonl");
        assert!(
            !v(
                missing.to_string_lossy().into_owned(),
                key("add pixel assets please", None)
            )
            .await
        );
    }

    #[tokio::test]
    async fn needle_is_the_first_40_units() {
        let dir = tempfile::tempdir().unwrap();
        let f = write(
            &dir,
            "long.jsonl",
            &[
                r#"{"type":"user","message":{"role":"user","content":"0123456789012345678901234567890123456789 and more"}}"#,
            ],
        );
        let v = transcript_verifier();
        let phrase = "0123456789012345678901234567890123456789 but different tail";
        assert!(v(f, key(phrase, None)).await);
    }
}
