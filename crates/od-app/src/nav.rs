//! The app's URLs and the IPC capability pattern (pure: no Tauri types).

use url::Url;

/// `http://127.0.0.1:<port>`: the server's only origin (it binds 127.0.0.1 only).
pub fn origin(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// The app UI: `<origin>/app/`.
pub fn app_url(port: u16) -> Url {
    Url::parse(&format!("{}/app/", origin(port))).expect("app url")
}

/// The web office: `<origin>/`.
pub fn office_url(port: u16) -> Url {
    Url::parse(&format!("{}/", origin(port))).expect("office url")
}

/// The remote pattern of the IPC capability: `<origin>/*`.
///
/// Not `<origin>/app/*`: Tauri checks the IPC ACL against the request's `Origin` header, which
/// has no path, so a `/app/*` pattern denies every call (R4 Decision 1, verified at runtime).
/// The web office at `/` stays out of the IPC because the capability names window `main` only
/// and the main window may only navigate inside `/app/`.
pub fn app_remote_pattern(port: u16) -> String {
    format!("{}/*", origin(port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(origin(51234), "http://127.0.0.1:51234");
        assert_eq!(app_url(51234).as_str(), "http://127.0.0.1:51234/app/");
        assert_eq!(office_url(51234).as_str(), "http://127.0.0.1:51234/");
        assert_eq!(app_remote_pattern(51234), "http://127.0.0.1:51234/*");
    }
}
