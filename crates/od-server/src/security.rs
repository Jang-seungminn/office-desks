//! Port of `bridge/src/security.ts`: the request guard and the headers on every response.
//!
//! The bridge can type into local terminals, so a random website must not be able to reach it
//! from the user's browser. Reject DNS-rebinding (Host), cross-site (Origin, Sec-Fetch-Site)
//! and framed (Sec-Fetch-Dest) requests. Requests without these headers come from non-browser
//! local tools and are allowed.

use axum::http::header::{HeaderMap, HeaderName, HeaderValue};

const LOCAL_HOSTNAMES: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// The Content-Security-Policy directives, in the TS order.
const CSP: [&str; 9] = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    // Remote images are never loaded: agent output could use them as a tracking/exfiltration beacon.
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
];

/// Node decodes header values as latin1: every byte is one char.
fn latin1(v: &HeaderValue) -> String {
    v.as_bytes().iter().map(|&b| b as char).collect()
}

/// `req.headers[name]` as Node gives it: a repeated header is joined with `", "`, except `Host`,
/// whose duplicates Node discards (the first one wins).
fn node_header(headers: &HeaderMap, name: &str) -> Option<String> {
    if name == "host" {
        return headers.get(name).map(latin1);
    }
    let all: Vec<String> = headers.get_all(name).iter().map(latin1).collect();
    if all.is_empty() {
        None
    } else {
        Some(all.join(", "))
    }
}

/// `/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/` split into (hostname, port digits).
fn split_host_port(s: &str) -> Option<(&str, Option<&str>)> {
    let (host, rest) = if s.starts_with('[') {
        match s.find(']') {
            Some(i) if i >= 2 => (&s[..=i], &s[i + 1..]),
            // `[^:]+` could still match a colon-free "[x"; such a host is never local.
            _ => match s.find(':') {
                Some(i) => (&s[..i], &s[i..]),
                None => (s, ""),
            },
        }
    } else {
        match s.find(':') {
            Some(i) => (&s[..i], &s[i..]),
            None => (s, ""),
        }
    };
    if host.is_empty() {
        return None;
    }
    if rest.is_empty() {
        return Some((host, None));
    }
    let digits = rest.strip_prefix(':')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((host, Some(digits)))
}

fn is_local(host_port: &str, allowed_ports: &[u16]) -> bool {
    let Some((hostname, port)) = split_host_port(host_port) else {
        return false;
    };
    let Some(port) = port else {
        return false;
    };
    // `Number(port)`: leading zeros are fine, huge values never match.
    let port: f64 = port.parse().unwrap_or(f64::NAN);
    LOCAL_HOSTNAMES.contains(&hostname.to_lowercase().as_str())
        && allowed_ports.iter().any(|&p| f64::from(p) == port)
}

/// Port of `isAllowedRequest`. `allowed_ports` is `[bound port, 5173]` in the server.
pub fn is_allowed_request(headers: &HeaderMap, allowed_ports: &[u16]) -> bool {
    match node_header(headers, "host") {
        Some(h) if !h.is_empty() && is_local(&h, allowed_ports) => {}
        _ => return false,
    }
    // Browsers label every request; only our own pages ("same-origin") or a typed URL ("none") may pass.
    if let Some(site) = node_header(headers, "sec-fetch-site") {
        if site != "same-origin" && site != "none" {
            return false;
        }
    }
    if let Some(dest) = node_header(headers, "sec-fetch-dest") {
        if matches!(dest.as_str(), "iframe" | "frame" | "embed" | "object") {
            return false;
        }
    }
    let Some(origin) = node_header(headers, "origin") else {
        return true;
    };
    let Ok(u) = url::Url::parse(&origin) else {
        return false;
    };
    let Some(host) = u.host_str() else {
        return false;
    };
    // `URL.host`: the hostname plus the port unless it is the scheme's default.
    let host = match u.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    };
    u.scheme() == "http" && is_local(&host, allowed_ports)
}

/// Port of `setSecurityHeaders`: no framing (clickjacking), no sniffing, no referrer, strict CSP.
pub fn apply_headers(headers: &mut HeaderMap) {
    let set = |h: &mut HeaderMap, name: &'static str, value: &str| {
        h.insert(
            HeaderName::from_static(name),
            HeaderValue::from_str(value).expect("static header value"),
        );
    };
    set(headers, "x-frame-options", "DENY");
    set(headers, "x-content-type-options", "nosniff");
    set(headers, "referrer-policy", "no-referrer");
    set(headers, "cross-origin-resource-policy", "same-origin");
    set(headers, "content-security-policy", &CSP.join("; "));
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORTS: [u16; 2] = [4318, 5173];

    fn allowed(pairs: &[(&str, &str)]) -> bool {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_bytes(v.as_bytes()).unwrap(),
            );
        }
        is_allowed_request(&h, &PORTS)
    }

    #[test]
    fn allows_same_origin_and_dev_server_origins_on_localhost() {
        assert!(allowed(&[
            ("host", "127.0.0.1:4318"),
            ("origin", "http://127.0.0.1:4318")
        ]));
        assert!(allowed(&[
            ("host", "localhost:5173"),
            ("origin", "http://localhost:5173")
        ]));
    }

    #[test]
    fn allows_non_browser_local_tools_without_origin() {
        assert!(allowed(&[("host", "127.0.0.1:4318")]));
    }

    #[test]
    fn rejects_cross_site_origins() {
        let host = ("host", "127.0.0.1:4318");
        assert!(!allowed(&[host, ("origin", "https://evil.example")]));
        assert!(!allowed(&[host, ("origin", "http://localhost:9999")]));
        assert!(!allowed(&[host, ("origin", "null")]));
    }

    #[test]
    fn rejects_cross_site_and_framed_browser_requests_without_origin() {
        let host = ("host", "127.0.0.1:4318");
        assert!(!allowed(&[
            host,
            ("sec-fetch-site", "cross-site"),
            ("sec-fetch-dest", "image")
        ]));
        assert!(!allowed(&[host, ("sec-fetch-site", "same-site")]));
        assert!(!allowed(&[
            host,
            ("sec-fetch-site", "same-origin"),
            ("sec-fetch-dest", "iframe")
        ]));
        assert!(allowed(&[
            host,
            ("sec-fetch-site", "same-origin"),
            ("sec-fetch-dest", "empty")
        ]));
        assert!(allowed(&[
            host,
            ("sec-fetch-site", "none"),
            ("sec-fetch-dest", "document")
        ]));
        for dest in ["frame", "embed", "object"] {
            assert!(!allowed(&[host, ("sec-fetch-dest", dest)]));
        }
    }

    #[test]
    fn rejects_dns_rebinding_hosts() {
        assert!(!allowed(&[("host", "evil.example:4318")]));
        assert!(!allowed(&[]));
    }

    #[test]
    fn extra_host_and_origin_cases() {
        assert!(allowed(&[("host", "[::1]:4318")]));
        assert!(allowed(&[("host", "LOCALHOST:4318")]));
        assert!(!allowed(&[("host", "127.0.0.1")]));
        assert!(!allowed(&[("host", "127.0.0.1:9999")]));
        assert!(!allowed(&[("host", "127.0.0.1:")]));
        assert!(allowed(&[("host", "127.0.0.1:04318")]));
        let host = ("host", "127.0.0.1:4318");
        assert!(allowed(&[host, ("origin", "http://127.0.0.1:4318/")]));
        assert!(!allowed(&[host, ("origin", "https://127.0.0.1:4318")]));
        assert!(allowed(&[host, ("origin", "http://[::1]:5173")]));
        assert!(!allowed(&[host, ("origin", "")]));
        // Node decodes header bytes as latin1, so a non-ASCII path does not break the check.
        assert!(allowed(&[host, ("origin", "http://localhost:4318/\u{e9}")]));
        // The first Host wins, as in Node.
        assert!(allowed(&[host, ("host", "evil.example:4318")]));
    }

    #[test]
    fn apply_headers_sets_the_five_headers() {
        let mut h = HeaderMap::new();
        apply_headers(&mut h);
        assert_eq!(h["x-frame-options"], "DENY");
        assert_eq!(h["x-content-type-options"], "nosniff");
        assert_eq!(h["referrer-policy"], "no-referrer");
        assert_eq!(h["cross-origin-resource-policy"], "same-origin");
        assert_eq!(
            h["content-security-policy"],
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; \
             connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; \
             object-src 'none'"
        );
    }
}
