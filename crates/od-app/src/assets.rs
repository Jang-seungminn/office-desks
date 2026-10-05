//! The built app UI (`app/dist`), served by od-server under `/app/`.

use std::borrow::Cow;

/// `app/dist`, embedded in release builds (where `build.rs` requires it) and read from disk in
/// debug builds. The folder may be missing; then every lookup is None and `/app/` answers
/// `app UI not built`.
#[derive(rust_embed::RustEmbed)]
#[folder = "../../app/dist"]
#[allow_missing = true]
pub struct AppDist;

impl od_server::Assets for AppDist {
    fn get(&self, path: &str) -> Option<Cow<'static, [u8]>> {
        <AppDist as rust_embed::RustEmbed>::get(path).map(|f| f.data)
    }
}
