//! The built web UI the server hands out: `WebDist` (rust-embed over `web/dist`) in the real
//! server, `MemAssets` in tests so a developer's local build never changes a test result.

use std::borrow::Cow;
use std::collections::HashMap;

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::{js, reqs, DEV_WEB_PORT};

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

/// The `MIME` table of `server.ts` by file extension.
fn mime(key: &str) -> &'static str {
    let name = key.rsplit('/').next().unwrap_or(key);
    // `path.extname`: the last dot, but not a leading one.
    let ext = match name.rfind('.') {
        Some(i) if i > 0 => &name[i..],
        _ => "",
    };
    match ext {
        ".html" => "text/html; charset=utf-8",
        ".js" | ".mjs" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".png" => "image/png",
        ".json" => "application/json",
        ".svg" => "image/svg+xml",
        ".woff2" => "font/woff2",
        ".wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// The asset key for a decoded path: segments joined by `/`, or None when the path is empty or
/// climbs above the root (both serve the index).
fn asset_key(decoded: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    let mut escaped = false;
    let segments: Vec<&str> = if cfg!(windows) {
        decoded.split(['/', '\\']).collect()
    } else {
        decoded.split('/').collect()
    };
    for seg in segments {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    escaped = true;
                }
            }
            s => parts.push(s),
        }
    }
    if escaped || parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// Port of `serveStatic`: the file named by `pathname`, else `index.html`. The answer is the same
/// for every method. The TS 503 "web UI is being rebuilt" has no equivalent with embedded files.
pub fn serve_static(assets: &dyn Assets, pathname: &str) -> Response {
    let Some(index) = assets.get("index.html") else {
        let text = format!(
            "Office Desks bridge is running. Build the web UI with \"npm run build\", or use \"npm run dev\" and open http://localhost:{DEV_WEB_PORT}"
        );
        let mut res = (StatusCode::OK, text).into_response();
        res.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
        return res;
    };
    let Some(decoded) = js::decode_uri_component(pathname) else {
        return reqs::json(StatusCode::BAD_REQUEST, &json!({ "error": "bad path" }));
    };
    let (key, body) = match asset_key(&decoded).and_then(|k| assets.get(&k).map(|b| (k, b))) {
        Some(found) => found,
        None => ("index.html".to_string(), index),
    };
    let mut res = (StatusCode::OK, body.into_owned()).into_response();
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime(&key)));
    res
}

/// Response extension: this response is an app page; the header layer sends the app CSP.
#[derive(Debug, Clone, Copy)]
pub(crate) struct AppPage;

/// `/app` + `rest`: the app file, else the app's `index.html`; 404 `{"error":"app UI not built"}`
/// when the app has no index. Every response carries [`AppPage`].
pub fn serve_app(assets: &dyn Assets, rest: &str) -> Response {
    let mut res = if assets.get("index.html").is_none() {
        reqs::json(
            StatusCode::NOT_FOUND,
            &json!({ "error": "app UI not built" }),
        )
    } else {
        serve_static(assets, rest)
    };
    res.extensions_mut().insert(AppPage);
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    fn mem(files: &[(&str, &str)]) -> MemAssets {
        MemAssets(
            files
                .iter()
                .map(|(k, v)| (k.to_string(), v.as_bytes().to_vec()))
                .collect(),
        )
    }

    async fn get(a: &MemAssets, path: &str) -> (u16, String, String) {
        let res = serve_static(a, path);
        let status = res.status().as_u16();
        let ct = res
            .headers()
            .get(header::CONTENT_TYPE)
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default();
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, ct, String::from_utf8_lossy(&body).into_owned())
    }

    fn site() -> MemAssets {
        mem(&[
            ("index.html", "INDEX"),
            ("assets/app.js", "JS"),
            ("a.woff2", "FONT"),
        ])
    }

    #[tokio::test]
    async fn root_and_unknown_paths_give_the_index() {
        let a = site();
        for p in ["/", "/nope", "/assets", "/assets/"] {
            let (s, ct, b) = get(&a, p).await;
            assert_eq!(
                (s, ct.as_str(), b.as_str()),
                (200, "text/html; charset=utf-8", "INDEX"),
                "{p}"
            );
        }
    }

    #[tokio::test]
    async fn files_get_their_mime() {
        let a = site();
        let (s, ct, b) = get(&a, "/assets/app.js").await;
        assert_eq!(
            (s, ct.as_str(), b.as_str()),
            (200, "text/javascript; charset=utf-8", "JS")
        );
        let (_, ct, b) = get(&a, "/a.woff2").await;
        assert_eq!((ct.as_str(), b.as_str()), ("font/woff2", "FONT"));
        assert_eq!(mime("x/m.mjs"), "text/javascript; charset=utf-8");
        assert_eq!(mime("x.wasm"), "application/wasm");
        assert_eq!(mime("x.bin"), "application/octet-stream");
    }

    #[tokio::test]
    async fn bad_percent_encoding_is_400() {
        let (s, ct, b) = get(&site(), "/%E0%A4%A").await;
        assert_eq!(
            (s, ct.as_str(), b.as_str()),
            (400, "application/json", "{\"error\":\"bad path\"}")
        );
    }

    #[tokio::test]
    async fn traversal_gives_the_index() {
        let a = site();
        for p in ["/../../etc/passwd", "/assets/..%2F..%2Fx"] {
            assert_eq!(get(&a, p).await.2, "INDEX", "{p}");
        }
        // Climbing within the root still resolves.
        assert_eq!(get(&a, "/assets/../a.woff2").await.2, "FONT");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn backslash_traversal_gives_the_index() {
        assert_eq!(get(&site(), "/assets\\..\\..\\x").await.2, "INDEX");
    }

    #[tokio::test]
    async fn no_dist_gives_the_text() {
        let (s, ct, b) = get(&MemAssets::default(), "/anything").await;
        assert_eq!((s, ct.as_str()), (200, "text/plain; charset=utf-8"));
        assert!(b.starts_with("Office Desks bridge is running."));
        assert!(b.ends_with("http://localhost:5173"));
    }

    #[test]
    fn mem_assets_serve_their_files() {
        let a = MemAssets(HashMap::from([("index.html".to_string(), b"<p>".to_vec())]));
        assert_eq!(a.get("index.html").as_deref(), Some(&b"<p>"[..]));
        assert!(a.get("missing").is_none());
    }

    #[tokio::test]
    async fn serve_app_serves_files_and_falls_back_to_its_index() {
        let a = mem(&[("index.html", "APP"), ("assets/a.js", "JS")]);
        for p in ["", "/", "/nope"] {
            let res = serve_app(&a, p);
            assert!(res.extensions().get::<AppPage>().is_some(), "{p}");
            assert_eq!(
                res.headers()[header::CONTENT_TYPE],
                "text/html; charset=utf-8"
            );
            let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
            assert_eq!(&body[..], b"APP", "{p}");
        }
        let res = serve_app(&a, "/assets/a.js");
        assert!(res.extensions().get::<AppPage>().is_some());
        assert_eq!(
            res.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], b"JS");
    }

    #[tokio::test]
    async fn serve_app_without_index_is_404() {
        let res = serve_app(&mem(&[("assets/a.js", "JS")]), "/");
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert!(res.extensions().get::<AppPage>().is_some());
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], br#"{"error":"app UI not built"}"#);
    }
}
