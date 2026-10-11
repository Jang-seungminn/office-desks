//! Images pasted into the web UI. Port of `bridge/src/uploads.ts`.
//!
//! They are written to a temp folder and handed to the agent by path: Claude Code and Codex can
//! both open an image file path they are given. File access is synchronous (use
//! `spawn_blocking` from async code); the clock and the random file id are injectable.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::fsio;
use crate::model::ImageUpload;

pub const MAX_IMAGES: usize = 6;
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const KEEP_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// Accepted `mediaType` to file extension (the TS `IMAGE_TYPES`).
pub const IMAGE_TYPES: [(&str, &str); 4] = [
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
];

/// The extension for an accepted media type.
pub fn image_ext(media_type: &str) -> Option<&'static str> {
    IMAGE_TYPES
        .iter()
        .find(|(t, _)| *t == media_type)
        .map(|(_, e)| *e)
}

/// `Rejected` is the TS `UploadError` (the server answers 400 with the message); `Io` is any
/// other failure (the server answers 502).
#[derive(Debug, thiserror::Error)]
pub enum UploadError {
    #[error("{0}")]
    Rejected(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

const UNSUPPORTED: &str = "지원하지 않는 이미지 형식입니다 (png, jpg, gif, webp)";
const TOO_BIG: &str = "이미지가 비어 있거나 10MB를 넘습니다";

/// More than [`MAX_IMAGES`] images in one send.
pub fn too_many() -> UploadError {
    UploadError::Rejected(format!(
        "이미지는 한 번에 {MAX_IMAGES}장까지 보낼 수 있습니다"
    ))
}

fn rejected(msg: &str) -> UploadError {
    UploadError::Rejected(msg.to_string())
}

/// Per-user folder: on Linux /tmp is shared, so another user must not be able to pre-create it,
/// read pasted screenshots or swap them before the agent opens them.
pub fn upload_dir_for(
    env: &HashMap<String, String>,
    tmp: &Path,
    uid: Option<u32>,
    linux: bool,
) -> PathBuf {
    let runtime = if linux {
        env.get("XDG_RUNTIME_DIR").filter(|v| !v.is_empty())
    } else {
        None
    };
    match runtime {
        Some(r) => Path::new(r).join("office-desks").join("uploads"),
        None => {
            let uid = uid.map(|u| format!("-{u}")).unwrap_or_default();
            tmp.join(format!("office-desks{uid}")).join("uploads")
        }
    }
}

#[cfg(unix)]
fn current_uid() -> Option<u32> {
    // SAFETY: getuid has no preconditions and cannot fail.
    Some(unsafe { libc::getuid() })
}

#[cfg(not(unix))]
fn current_uid() -> Option<u32> {
    None
}

/// The real upload folder for this process.
pub fn upload_dir() -> PathBuf {
    let env: HashMap<String, String> = std::env::vars().collect();
    upload_dir_for(
        &env,
        &std::env::temp_dir(),
        current_uid(),
        cfg!(target_os = "linux"),
    )
}

/// Create the folder 0700 and refuse one that is a symlink or owned by someone else.
pub fn ensure_private_dir(dir: &Path) -> Result<(), UploadError> {
    fsio::create_private_dir_all(dir)?;
    // Check our own folders (.../office-desks-<uid> and .../uploads), not the system temp root.
    let parent = dir.parent().filter(|p| {
        p.file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("office-desks"))
    });
    let ours: Vec<&Path> = match parent {
        Some(p) => vec![p, dir],
        None => vec![dir],
    };
    for d in ours {
        let st = std::fs::symlink_metadata(d)?;
        if st.file_type().is_symlink() || !st.is_dir() {
            return Err(rejected("업로드 폴더가 올바르지 않습니다"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if Some(st.uid()) != current_uid() {
                return Err(rejected("업로드 폴더의 소유자가 다릅니다"));
            }
            if st.mode() & 0o077 != 0 {
                std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700))?;
            }
        }
    }
    Ok(())
}

/// Node's `Buffer.from(s, 'base64')`: both alphabets, whitespace and other stray characters
/// skipped, decoding stops at the first `=`, a dangling partial group still yields its bytes.
pub fn decode_base64_lenient(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// 8 random hex characters (the TS `randomUUID().slice(0, 8)`).
pub fn random_file_id() -> String {
    let mut b = [0u8; 4];
    if getrandom::fill(&mut b).is_err() {
        b = (now_ms() as u32).to_le_bytes();
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The raw `images` field of a send request as the typed list [`save_images`] takes. Untrusted
/// input: a missing/null field is no images. Each image is checked in the TS order, shape (a
/// known string `mediaType` and a string `data`, else the "unsupported type" rejection) and then
/// decoded size (empty or over 10 MB), stopping at the first failure, so several bad images
/// report the same error TS does (HTTP 400). More than 6 images is rejected first; a non-empty
/// string is iterable in JS, so it is counted by UTF-16 length and then rejected as unsupported.
/// Any object is no images here: the server handles an object with a truthy `length` itself
/// (TS throws `images is not iterable` after the count check).
pub fn parse_images(raw: &serde_json::Value) -> Result<Vec<ImageUpload>, UploadError> {
    use serde_json::Value;
    let list = match raw {
        Value::Array(a) => a,
        // A string is iterable in JS: its UTF-16 length is counted first, then its first
        // "image" (a one-character string) has no media type.
        Value::String(s) if !s.is_empty() => {
            if crate::jsstr::utf16_len(s) > MAX_IMAGES {
                return Err(too_many());
            }
            return Err(rejected(UNSUPPORTED));
        }
        _ => return Ok(Vec::new()),
    };
    if list.len() > MAX_IMAGES {
        return Err(too_many());
    }
    list.iter()
        .map(|img| {
            let field = |k: &str| img.get(k).and_then(Value::as_str).map(str::to_string);
            let (Some(media_type), Some(data)) = (field("mediaType"), field("data")) else {
                return Err(rejected(UNSUPPORTED));
            };
            if image_ext(&media_type).is_none() {
                return Err(rejected(UNSUPPORTED));
            }
            let n = decode_base64_lenient(&data).len();
            if n == 0 || n > MAX_IMAGE_BYTES {
                return Err(rejected(TOO_BIG));
            }
            Ok(ImageUpload { media_type, data })
        })
        .collect()
}

/// Write the images into `dir` and return their paths, in order.
pub fn save_images(images: &[ImageUpload], dir: &Path) -> Result<Vec<String>, UploadError> {
    save_images_with(images, dir, now_ms, random_file_id)
}

/// [`save_images`] with the clock and the random part of the file name injected.
pub fn save_images_with(
    images: &[ImageUpload],
    dir: &Path,
    mut now: impl FnMut() -> i64,
    mut rand8: impl FnMut() -> String,
) -> Result<Vec<String>, UploadError> {
    if images.is_empty() {
        return Ok(Vec::new());
    }
    if images.len() > MAX_IMAGES {
        return Err(UploadError::Rejected(format!(
            "이미지는 한 번에 {MAX_IMAGES}장까지 보낼 수 있습니다"
        )));
    }
    ensure_private_dir(dir)?;
    let mut paths = Vec::with_capacity(images.len());
    for img in images {
        let Some(ext) = image_ext(&img.media_type) else {
            return Err(rejected(
                "지원하지 않는 이미지 형식입니다 (png, jpg, gif, webp)",
            ));
        };
        let buf = decode_base64_lenient(&img.data);
        if buf.is_empty() || buf.len() > MAX_IMAGE_BYTES {
            return Err(rejected(TOO_BIG));
        }
        let file = dir.join(format!("{}-{}.{ext}", now(), rand8()));
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        o.open(&file)?.write_all(&buf)?;
        paths.push(file.to_string_lossy().into_owned());
    }
    Ok(paths)
}

/// The text typed into the agent: the message, then one image path per line.
pub fn compose_prompt(text: &str, image_paths: &[String]) -> String {
    let body = crate::jsstr::trim(text);
    if image_paths.is_empty() {
        return body.to_string();
    }
    std::iter::once(body)
        .chain(image_paths.iter().map(String::as_str))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Resolve a served upload by bare file name only, so the route can't escape the folder.
/// `/^[\w-]+\.(png|jpg|gif|webp)$/`
pub fn upload_path(name: &str, dir: &Path) -> Option<PathBuf> {
    let (stem, ext) = name.rsplit_once('.')?;
    let ok_stem = !stem.is_empty()
        && stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    (ok_stem && matches!(ext, "png" | "jpg" | "gif" | "webp")).then(|| dir.join(name))
}

/// Delete uploads untouched for more than a day. `now_ms` is Unix time in milliseconds.
pub fn clean_old_uploads(dir: &Path, now_ms: i64) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let f = e.path();
        let Ok(st) = std::fs::metadata(&f) else {
            continue;
        };
        let Ok(mtime) = st.modified() else { continue };
        let mtime_ms = match mtime.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs_f64() * 1000.0,
            Err(e) => -e.duration().as_secs_f64() * 1000.0,
        };
        if now_ms as f64 - mtime_ms > KEEP_MS {
            let _ = std::fs::remove_file(&f);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    // 89 50 4E 47
    const PNG: &str = "iVBORw==";

    fn png() -> ImageUpload {
        ImageUpload {
            media_type: "image/png".into(),
            data: PNG.into(),
        }
    }

    // uploads.test.ts: saves images and appends one path per line to the prompt
    #[test]
    fn saves_images_and_appends_one_path_per_line_to_the_prompt() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path();
        let files = save_images(&[png()], dir).unwrap();
        let file = &files[0];
        assert!(Path::new(file).starts_with(dir));
        assert!(file.ends_with(".png"));
        assert_eq!(std::fs::read(file).unwrap(), [0x89, 0x50, 0x4e, 0x47]);
        assert_eq!(
            compose_prompt("  look at this ", &files),
            format!("look at this\n{file}")
        );
        assert_eq!(compose_prompt("", &files), *file);
        assert_eq!(compose_prompt("  hi  ", &[]), "hi");
        assert!(save_images(&[], dir).unwrap().is_empty());
    }

    #[test]
    fn file_names_are_millis_dash_eight_hex_with_the_media_type_extension() {
        let t = tempfile::tempdir().unwrap();
        let mut jpeg = png();
        jpeg.media_type = "image/jpeg".into();
        let files = save_images_with(
            &[jpeg, png()],
            t.path(),
            || 1_700_000_000_123,
            || "abcd1234".into(),
        );
        // Both images get the same name stem but different extensions.
        let files = files.unwrap();
        assert_eq!(
            Path::new(&files[0]).file_name().unwrap(),
            "1700000000123-abcd1234.jpg"
        );
        assert_eq!(
            Path::new(&files[1]).file_name().unwrap(),
            "1700000000123-abcd1234.png"
        );
        // create_new: a clash is an error, never an overwrite.
        let again = save_images_with(
            &[png()],
            t.path(),
            || 1_700_000_000_123,
            || "abcd1234".into(),
        );
        assert!(matches!(again, Err(UploadError::Io(_))));
        let id = random_file_id();
        assert!(id.len() == 8 && id.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(upload_path(&format!("1-{id}.png"), Path::new("/up")).is_some());
    }

    // uploads.test.ts: writes into a private folder with private files
    #[cfg(unix)]
    #[test]
    fn writes_into_a_private_folder_with_private_files() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("office-desks-1").join("uploads");
        let files = save_images(&[png()], &dir).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(dir.parent().unwrap()), 0o700);
        assert_eq!(mode(Path::new(&files[0])), 0o600);
        // A looser existing folder is tightened.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        save_images(&[png()], &dir).unwrap();
        assert_eq!(mode(&dir), 0o700);
    }

    // uploads.test.ts: refuses an upload folder that is a symlink
    #[cfg(unix)]
    #[test]
    fn refuses_an_upload_folder_that_is_a_symlink() {
        let root = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), root.path().join("uploads")).unwrap();
        let err = save_images(&[png()], &root.path().join("uploads")).unwrap_err();
        assert!(matches!(&err, UploadError::Rejected(m) if m == "업로드 폴더가 올바르지 않습니다"));
        assert_eq!(std::fs::read_dir(elsewhere.path()).unwrap().count(), 0);
    }

    // uploads.test.ts: rejects unknown types, empty data and too many images
    #[test]
    fn rejects_unknown_types_empty_data_and_too_many_images() {
        let t = tempfile::tempdir().unwrap();
        let msg = |r: Result<Vec<String>, UploadError>| match r {
            Err(UploadError::Rejected(m)) => m,
            other => panic!("expected a rejection, got {other:?}"),
        };
        let svg = ImageUpload {
            media_type: "image/svg+xml".into(),
            data: PNG.into(),
        };
        assert_eq!(
            msg(save_images(&[svg], t.path())),
            "지원하지 않는 이미지 형식입니다 (png, jpg, gif, webp)"
        );
        let empty = ImageUpload {
            media_type: "image/png".into(),
            data: String::new(),
        };
        assert_eq!(
            msg(save_images(&[empty], t.path())),
            "이미지가 비어 있거나 10MB를 넘습니다"
        );
        assert_eq!(
            msg(save_images(&vec![png(); 7], t.path())),
            "이미지는 한 번에 6장까지 보낼 수 있습니다"
        );
        // 6 are fine.
        assert_eq!(save_images(&vec![png(); 6], t.path()).unwrap().len(), 6);
    }

    #[test]
    fn size_limit_is_ten_mib_of_decoded_bytes() {
        let t = tempfile::tempdir().unwrap();
        let big = |n: usize| ImageUpload {
            media_type: "image/png".into(),
            data: "A".repeat(n / 3 * 4),
        };
        // 3 * k bytes decode from 4 * k characters.
        let exactly = MAX_IMAGE_BYTES / 3 * 3; // 10485759
        assert!(save_images(&[big(exactly)], t.path()).is_ok());
        assert!(save_images(&[big(MAX_IMAGE_BYTES + 3)], t.path()).is_err());
    }

    #[test]
    fn base64_matches_node() {
        assert_eq!(decode_base64_lenient("aGVsbG8="), b"hello");
        assert_eq!(decode_base64_lenient("aGVs\nbG8"), b"hello");
        assert_eq!(decode_base64_lenient("-_-_"), decode_base64_lenient("+/+/"));
        assert_eq!(decode_base64_lenient("aGVsbG8=junk"), b"hello");
        assert_eq!(decode_base64_lenient("a"), b"");
        assert_eq!(decode_base64_lenient("a$b!c"), decode_base64_lenient("abc"));
    }

    #[test]
    fn parse_images_handles_untrusted_shapes() {
        use serde_json::json;
        let msg = "지원하지 않는 이미지 형식입니다 (png, jpg, gif, webp)";
        for none in [json!(null), json!([]), json!({}), json!(5), json!("")] {
            assert!(parse_images(&none).unwrap().is_empty());
        }
        let ok = parse_images(&json!([{ "mediaType": "image/png", "data": "iVBORw==" }])).unwrap();
        assert_eq!(ok, vec![png()]);
        for bad in [
            json!([null]),
            json!([{ "mediaType": "image/png" }]),
            json!([{ "mediaType": "image/png", "data": 5 }]),
            json!([{ "mediaType": 5, "data": "x" }]),
            json!("abc"),
        ] {
            assert!(
                matches!(parse_images(&bad), Err(UploadError::Rejected(m)) if m == msg),
                "{bad}"
            );
        }
        // Several bad images: the first failure in TS order wins (size of #1 before shape of #2).
        let huge = "A".repeat((MAX_IMAGE_BYTES / 3 + 1) * 4);
        let two = json!([{ "mediaType": "image/png", "data": huge }, null]);
        assert!(
            matches!(parse_images(&two), Err(UploadError::Rejected(m)) if m == "이미지가 비어 있거나 10MB를 넘습니다")
        );
        let two =
            json!([{ "mediaType": "image/png", "data": "" }, { "mediaType": "x", "data": "y" }]);
        assert!(
            matches!(parse_images(&two), Err(UploadError::Rejected(m)) if m == "이미지가 비어 있거나 10MB를 넘습니다")
        );
        let two = json!([null, { "mediaType": "image/png", "data": "" }]);
        assert!(matches!(parse_images(&two), Err(UploadError::Rejected(m)) if m == msg));
        let seven = json!(vec![json!({ "mediaType": "image/png", "data": "x" }); 7]);
        assert!(matches!(parse_images(&seven), Err(UploadError::Rejected(m)) if m.contains("6장")));
        // A string counts its UTF-16 length against the limit before its "images" are checked.
        let many = "이미지는 한 번에 6장까지 보낼 수 있습니다";
        for (s, want) in [
            ("abcdef", msg),
            ("abcdefg", many),
            ("😀😀😀", msg),
            ("😀😀😀😀", many),
        ] {
            assert!(
                matches!(parse_images(&json!(s)), Err(UploadError::Rejected(m)) if m == want),
                "{s}"
            );
        }
    }

    // uploads.test.ts: serves uploads by bare name only
    #[test]
    fn serves_uploads_by_bare_name_only() {
        let up = Path::new("/up");
        assert_eq!(
            upload_path("123-abcd1234.png", up),
            Some(up.join("123-abcd1234.png"))
        );
        assert_eq!(upload_path("../secret.png", up), None);
        assert_eq!(upload_path("a.exe", up), None);
        for bad in [
            "",
            ".png",
            "a/b.png",
            "a\\b.png",
            "a.png\n",
            "a b.png",
            "a.PNG",
            "a.jpeg",
            "한글.png",
            "a.b.png",
        ] {
            assert_eq!(upload_path(bad, up), None, "{bad:?}");
        }
        for ok in ["a_b-C9.jpg", "1.gif", "x.webp"] {
            assert!(upload_path(ok, up).is_some(), "{ok:?}");
        }
    }

    // uploads.test.ts: deletes uploads older than a day (now is injected)
    #[test]
    fn deletes_uploads_older_than_a_day() {
        let t = tempfile::tempdir().unwrap();
        let (old, fresh, edge) = (
            t.path().join("old.png"),
            t.path().join("fresh.png"),
            t.path().join("edge.png"),
        );
        let now_ms = 1_800_000_000_000i64;
        let at = |ms: i64| UNIX_EPOCH + Duration::from_millis(ms as u64);
        for (f, mtime) in [
            (&old, now_ms - 2 * 86_400_000),
            (&fresh, now_ms - 1000),
            (&edge, now_ms - 86_400_000), // exactly a day: kept (strictly older is deleted)
        ] {
            std::fs::write(f, "x").unwrap();
            std::fs::File::options()
                .write(true)
                .open(f)
                .unwrap()
                .set_modified(at(mtime))
                .unwrap();
        }
        let sub = t.path().join("dir");
        std::fs::create_dir(&sub).unwrap();
        clean_old_uploads(t.path(), now_ms);
        assert!(!old.exists());
        assert!(fresh.exists());
        assert!(edge.exists());
        assert!(sub.exists());
        // A missing folder is fine.
        clean_old_uploads(&t.path().join("missing"), now_ms);
    }

    #[test]
    fn default_folder_is_per_user() {
        let tmp = Path::new("/tmp");
        let none = HashMap::new();
        assert_eq!(
            upload_dir_for(&none, tmp, Some(501), false),
            tmp.join("office-desks-501").join("uploads")
        );
        assert_eq!(
            upload_dir_for(&none, tmp, None, false),
            tmp.join("office-desks").join("uploads")
        );
        let xdg = HashMap::from([("XDG_RUNTIME_DIR".to_string(), "/run/user/1".to_string())]);
        assert_eq!(
            upload_dir_for(&xdg, tmp, Some(1), true),
            Path::new("/run/user/1")
                .join("office-desks")
                .join("uploads")
        );
        // XDG_RUNTIME_DIR only counts on Linux.
        assert_eq!(
            upload_dir_for(&xdg, tmp, Some(1), false),
            tmp.join("office-desks-1").join("uploads")
        );
        assert!(upload_dir().ends_with("uploads"));
    }
}
