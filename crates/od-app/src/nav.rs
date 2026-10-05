//! The app's URLs, the IPC capability pattern and the navigation policy (pure: no Tauri types).

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

/// What a window does with a navigation or a new-window request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nav {
    /// Load it in this window.
    Allow,
    /// Hand an `http`/`https` URL to the OS browser; this window stays put.
    External,
    /// Do nothing.
    Deny,
}

/// `http://127.0.0.1:<port>`, exactly (scheme, host and port).
fn same_origin(url: &Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(port)
}

/// `/app` or anything under `/app/` (not `/application`).
fn is_app_path(p: &str) -> bool {
    p == "/app" || p.starts_with("/app/")
}

/// A loopback host (`url::Url` keeps IPv6 hosts bracketed: `[::1]`).
fn loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

/// The main window (the app UI, the only one with IPC) may only navigate inside `/app/`.
pub fn main_nav(url: &Url, port: u16) -> Nav {
    if same_origin(url, port) && is_app_path(url.path()) {
        Nav::Allow
    } else {
        new_window(url)
    }
}

/// The office window (the web office, no IPC) may only navigate on our origin outside `/app/`.
pub fn office_nav(url: &Url, port: u16) -> Nav {
    if same_origin(url, port) && !is_app_path(url.path()) {
        Nav::Allow
    } else {
        new_window(url)
    }
}

/// A link that leaves the window, or `window.open`: a non-loopback `http`/`https` URL goes to
/// the OS browser; everything else (other loopback servers, `file:`, `javascript:`, `tauri:`,
/// `about:`) is denied.
pub fn new_window(url: &Url) -> Nav {
    if matches!(url.scheme(), "http" | "https") && !loopback(url) {
        Nav::External
    } else {
        Nav::Deny
    }
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

    #[test]
    fn navigation_policy() {
        use Nav::*;
        let port = 51234;
        let rows: &[(&str, Nav, Nav)] = &[
            ("http://127.0.0.1:51234/app/", Allow, Deny),
            ("http://127.0.0.1:51234/app", Allow, Deny),
            ("http://127.0.0.1:51234/app/x?y#z", Allow, Deny),
            ("http://127.0.0.1:51234/", Deny, Allow),
            ("http://127.0.0.1:51234/application", Deny, Allow),
            ("http://127.0.0.1:9999/app/", Deny, Deny),
            ("http://localhost:51234/app/", Deny, Deny),
            ("https://github.com/o/r/pull/1", External, External),
            ("http://example.com/", External, External),
            ("file:///etc/passwd", Deny, Deny),
            ("javascript:alert(1)", Deny, Deny),
            ("tauri://localhost/", Deny, Deny),
            ("http://[::1]:51234/", Deny, Deny),
            // Beyond the brief: dot segments normalise to `/`; userinfo is not the host;
            // https on our port is not our origin.
            ("http://127.0.0.1:51234/app/../", Deny, Allow),
            ("http://127.0.0.1:51234@evil.com/app/", External, External),
            ("https://127.0.0.1:51234/app/", Deny, Deny),
        ];
        for (raw, main, office) in rows {
            let url = Url::parse(raw).expect(raw);
            assert_eq!(main_nav(&url, port), *main, "main_nav {raw}");
            assert_eq!(office_nav(&url, port), *office, "office_nav {raw}");
        }
    }
}
