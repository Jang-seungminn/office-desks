//! Local screenshots an agent linked in its own messages. Port of `bridge/src/localImage.ts`.
//!
//! Two gates: the path must appear as a Markdown link in a chat message ([`is_linked_image`]),
//! and the file must resolve (symlinks followed) to a real image by extension, size and magic
//! bytes ([`read_local_image`]).

use std::io::Read;

use crate::model::{ConversationMessage, MessageRole};

const MAX_BYTES: u64 = 20 * 1024 * 1024;

/// Image type from the file's magic bytes, or None if it isn't one of the image formats we
/// serve. `head` is the first 12 bytes of the file (shorter heads count as zero padded).
pub fn sniff_image(head: &[u8]) -> Option<&'static str> {
    let mut b = [0u8; 12];
    let n = head.len().min(12);
    b[..n].copy_from_slice(&head[..n]);
    if b[..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
        Some("image/png")
    } else if b[..3] == [0xff, 0xd8, 0xff] {
        Some("image/jpeg")
    } else if &b[..4] == b"GIF8" {
        Some("image/gif")
    } else if &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Only paths the agent or the user actually linked as Markdown (`](path)` / `](<path>)`) in a
/// chat message count; tool-call summaries and stray mentions don't.
pub fn is_linked_image(messages: &[ConversationMessage], wanted: &str) -> bool {
    let plain = format!("]({wanted})");
    let angled = format!("](<{wanted}>)");
    let file_url = format!("](file://{wanted})");
    messages.iter().any(|m| {
        m.role != MessageRole::Tool
            && (m.text.contains(&plain) || m.text.contains(&angled) || m.text.contains(&file_url))
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalImage {
    /// `image/png`, `image/jpeg`, `image/gif` or `image/webp`.
    pub media_type: &'static str,
    pub buf: Vec<u8>,
}

/// Read a local image after resolving symlinks and checking it is really an image file.
pub fn read_local_image(wanted: &str) -> Option<LocalImage> {
    // dunce: no `\\?\` prefix on Windows, so the extension and absolute checks see a normal path.
    let real = dunce::canonicalize(wanted).ok()?;
    let lower = real.to_string_lossy().to_ascii_lowercase();
    let is_image_name = [".png", ".jpg", ".jpeg", ".gif", ".webp"]
        .iter()
        .any(|e| lower.ends_with(e));
    if !is_image_name || !real.is_absolute() {
        return None;
    }
    let st = std::fs::metadata(&real).ok()?;
    if !st.is_file() || st.len() > MAX_BYTES {
        return None;
    }
    let mut f = std::fs::File::open(&real).ok()?;
    let mut head = Vec::with_capacity(12);
    (&mut f).take(12).read_to_end(&mut head).ok()?;
    let media_type = sniff_image(&head)?;
    let buf = std::fs::read(&real).ok()?;
    Some(LocalImage { media_type, buf })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: [u8; 12] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];

    fn msg(role: MessageRole, text: &str) -> ConversationMessage {
        ConversationMessage {
            role,
            text: text.into(),
            ts: None,
            images: None,
            queued: None,
            tool_use_id: None,
        }
    }

    // localImage.test.ts: isLinkedImage only counts Markdown links in chat messages
    #[test]
    fn only_counts_markdown_links_in_chat_messages() {
        let shot = "/tmp/shots/a.png";
        let a = MessageRole::Assistant;
        assert!(is_linked_image(
            &[msg(a, &format!("look ![a]({shot})"))],
            shot
        ));
        assert!(is_linked_image(
            &[msg(a, &format!("look ![a](<{shot}>)"))],
            shot
        ));
        assert!(is_linked_image(
            &[msg(a, &format!("look ![a](file://{shot})"))],
            shot
        ));
        assert!(!is_linked_image(
            &[msg(a, &format!("I saved it to {shot}"))],
            shot
        ));
        assert!(!is_linked_image(
            &[msg(MessageRole::Tool, &format!("Read: ![x]({shot})"))],
            shot
        ));
        // Roles other than tool count, and one hit among many is enough.
        assert!(is_linked_image(
            &[
                msg(a, "nothing"),
                msg(MessageRole::User, &format!("[x]({shot})"))
            ],
            shot
        ));
        assert!(!is_linked_image(&[msg(a, &format!("![a]({shot}x)"))], shot));
        assert!(!is_linked_image(&[], shot));
    }

    // localImage.test.ts: serves real images by magic bytes
    #[test]
    fn serves_real_images_by_magic_bytes() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("ok.png");
        std::fs::write(&f, PNG).unwrap();
        let img = read_local_image(f.to_str().unwrap()).unwrap();
        assert_eq!(img.media_type, "image/png");
        assert_eq!(img.buf, PNG);
        // Extension case does not matter; the type comes from the bytes, not the name.
        let jpg = t.path().join("PHOTO.JPEG");
        std::fs::write(&jpg, [0xff, 0xd8, 0xff, 0xe0, 0, 0]).unwrap();
        assert_eq!(
            read_local_image(jpg.to_str().unwrap()).unwrap().media_type,
            "image/jpeg"
        );
    }

    // localImage.test.ts: refuses non-images renamed to .png and symlinks to non-image files
    #[test]
    fn refuses_non_images_renamed_to_png_and_symlinks_to_non_image_files() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path();
        let fake = dir.join("fake.png");
        std::fs::write(&fake, "ssh-rsa AAAA secret").unwrap();
        assert!(read_local_image(fake.to_str().unwrap()).is_none());
        assert!(read_local_image(dir.join("missing.png").to_str().unwrap()).is_none());
        #[cfg(unix)]
        {
            let secret = dir.join("id_rsa");
            std::fs::write(&secret, "PRIVATE KEY").unwrap();
            let link = dir.join("link.png");
            std::os::unix::fs::symlink(&secret, &link).unwrap();
            assert!(read_local_image(link.to_str().unwrap()).is_none());
            // A symlink named .png to a real image named without the extension: the resolved
            // name is checked, so it is refused too.
            let real = dir.join("real-image");
            std::fs::write(&real, PNG).unwrap();
            let link2 = dir.join("link2.png");
            std::os::unix::fs::symlink(&real, &link2).unwrap();
            assert!(read_local_image(link2.to_str().unwrap()).is_none());
        }
    }

    #[test]
    fn refuses_directories_wrong_extensions_and_big_files() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path();
        std::fs::create_dir(dir.join("d.png")).unwrap();
        assert!(read_local_image(dir.join("d.png").to_str().unwrap()).is_none());
        let txt = dir.join("a.txt");
        std::fs::write(&txt, PNG).unwrap();
        assert!(read_local_image(txt.to_str().unwrap()).is_none());
        let big = dir.join("big.png");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(MAX_BYTES + 1).unwrap();
        assert!(read_local_image(big.to_str().unwrap()).is_none());
        // Exactly at the limit with a valid header is served.
        let ok = dir.join("ok.png");
        let mut bytes = PNG.to_vec();
        bytes.resize(MAX_BYTES as usize, 0);
        std::fs::write(&ok, &bytes).unwrap();
        assert_eq!(
            read_local_image(ok.to_str().unwrap()).unwrap().buf.len() as u64,
            MAX_BYTES
        );
    }

    #[test]
    fn sniffs_every_format() {
        assert_eq!(sniff_image(&PNG), Some("image/png"));
        assert_eq!(sniff_image(&[0xff, 0xd8, 0xff]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"GIF89a......"), Some("image/gif"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBP"), Some("image/webp"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(sniff_image(b"GIF"), None);
        assert_eq!(sniff_image(&[]), None);
    }
}
