//! The built web UI the server hands out: `WebDist` (rust-embed over `web/dist`) in the real
//! server, `MemAssets` in tests so a developer's local build never changes a test result.

use std::borrow::Cow;
use std::collections::HashMap;

/// Files of the web UI by path relative to the dist root (`index.html`, `assets/x.js`).
pub trait Assets: Send + Sync {
    fn get(&self, path: &str) -> Option<Cow<'static, [u8]>>;
}

/// `web/dist`, embedded in release builds and read from disk in debug builds. The folder may be
/// missing (CI builds the crate without the web UI); then every lookup is None.
#[derive(rust_embed::RustEmbed)]
#[folder = "../../web/dist"]
#[allow_missing = true]
pub struct WebDist;

impl Assets for WebDist {
    fn get(&self, path: &str) -> Option<Cow<'static, [u8]>> {
        <WebDist as rust_embed::RustEmbed>::get(path).map(|f| f.data)
    }
}

/// In-memory assets for tests.
#[derive(Debug, Clone, Default)]
pub struct MemAssets(pub HashMap<String, Vec<u8>>);

impl Assets for MemAssets {
    fn get(&self, path: &str) -> Option<Cow<'static, [u8]>> {
        self.0.get(path).map(|b| Cow::Owned(b.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mem_assets_serve_their_files() {
        let a = MemAssets(HashMap::from([("index.html".to_string(), b"<p>".to_vec())]));
        assert_eq!(a.get("index.html").as_deref(), Some(&b"<p>"[..]));
        assert!(a.get("missing").is_none());
    }
}
