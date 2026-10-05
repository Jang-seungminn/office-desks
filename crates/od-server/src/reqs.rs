//! Request plumbing: the parsed request URL, JSON bodies and the error → response mapping of
//! the `server.ts` catch-all (PARITY.md, "Errors to HTTP").

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use http_body_util::BodyExt;
use od_core::backend::BackendError;
use od_core::git::GitError;
use od_core::uploads::UploadError;
use serde::Serialize;
use serde_json::Value;

/// `new URL(req.url, "http://127.0.0.1:<port>")`: the pathname (still percent-encoded, as in
/// Node) and the decoded query pairs, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestUrl {
    pub pathname: String,
    pub query: Vec<(String, String)>,
}

impl RequestUrl {
    /// Joins the raw request-target onto the base with WHATWG rules (dot segments removed,
    /// `//host/x` takes the host). The error is Node's `TypeError` text, `Invalid URL`.
    pub fn parse(raw_target: &str, port: u16) -> Result<RequestUrl, String> {
        let base = url::Url::parse(&format!("http://127.0.0.1:{port}")).expect("valid base URL");
        let u = base
            .join(raw_target)
            .map_err(|_| "Invalid URL".to_string())?;
        Ok(RequestUrl {
            pathname: u.path().to_string(),
            query: u.query_pairs().into_owned().collect(),
        })
    }

    /// `url.searchParams.get(key)`: the first value, or None.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
}

/// A route error, mapped to the response the TS catch-all (or the named route) gives.
#[derive(Debug)]
pub enum ApiError {
    /// 400 `{error}`: a JSON parse error or a body over the size cap.
    BadRequest(String),
    /// 409 `{error, code}` for `terminal_not_writable`, else 502 `{error}` plus `code` when set.
    Backend(BackendError),
    /// `Rejected` is 400 `{error}`, `Io` is 502 `{error}`.
    Upload(UploadError),
    /// 502: what V8 throws for `body.<field>` when the body is JSON `null`.
    NullBody(&'static str),
    /// 502 `{error}`, no `code`.
    Internal(String),
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'a str>,
}

impl ApiError {
    fn status_and_body(&self) -> (StatusCode, String, Option<&str>) {
        match self {
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone(), None),
            ApiError::Backend(e) => {
                let status = if e.code.as_deref() == Some("terminal_not_writable") {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::BAD_GATEWAY
                };
                (status, e.message.clone(), e.code.as_deref())
            }
            ApiError::Upload(e @ UploadError::Rejected(_)) => {
                (StatusCode::BAD_REQUEST, e.to_string(), None)
            }
            ApiError::Upload(e @ UploadError::Io(_)) => {
                (StatusCode::BAD_GATEWAY, e.to_string(), None)
            }
            ApiError::NullBody(field) => (
                StatusCode::BAD_GATEWAY,
                format!("Cannot read properties of null (reading '{field}')"),
                None,
            ),
            ApiError::Internal(m) => (StatusCode::BAD_GATEWAY, m.clone(), None),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, error, code) = self.status_and_body();
        json(
            status,
            &ErrorBody {
                error: &error,
                code,
            },
        )
    }
}

impl From<BackendError> for ApiError {
    fn from(e: BackendError) -> Self {
        ApiError::Backend(e)
    }
}

impl From<UploadError> for ApiError {
    fn from(e: UploadError) -> Self {
        ApiError::Upload(e)
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        ApiError::Internal(e.to_string())
    }
}

impl From<GitError> for ApiError {
    fn from(e: GitError) -> Self {
        ApiError::Internal(e.to_string())
    }
}

impl From<tokio::task::JoinError> for ApiError {
    fn from(e: tokio::task::JoinError) -> Self {
        ApiError::Internal(e.to_string())
    }
}

/// `json(res, status, body)`: `content-type: application/json` exactly, no charset.
pub fn json(status: StatusCode, body: &impl Serialize) -> Response {
    let bytes = serde_json::to_vec(body).unwrap_or_else(|_| b"null".to_vec());
    let mut res = (status, bytes).into_response();
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    res
}

/// `readJson(req, cap)`: collect the body, counting bytes; over `cap` is the TS `UploadError`
/// `요청이 너무 큽니다` (400). A parse failure is 400 with serde's text (V8's can't be matched).
pub async fn read_json(body: Body, cap: usize) -> Result<Value, ApiError> {
    let mut body = body;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| ApiError::Internal(e.to_string()))?;
        if let Ok(data) = frame.into_data() {
            if buf.len() + data.len() > cap {
                return Err(ApiError::BadRequest("요청이 너무 큽니다".into()));
            }
            buf.extend_from_slice(&data);
        }
    }
    serde_json::from_slice(&buf).map_err(|e| ApiError::BadRequest(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body_json(res: Response) -> Value {
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn parse_resolves_dot_segments_and_decodes_query() {
        let u = RequestUrl::parse("/api/x/../snapshot?q=a+b&q=c", 1).unwrap();
        assert_eq!(u.pathname, "/api/snapshot");
        assert_eq!(u.get("q"), Some("a b"));
        assert_eq!(u.get("missing"), None);
        assert_eq!(u.query.len(), 2);
    }

    #[test]
    fn parse_takes_the_host_of_a_scheme_relative_target() {
        assert_eq!(RequestUrl::parse("//evil/x", 1).unwrap().pathname, "/x");
    }

    #[test]
    fn parse_keeps_the_pathname_encoded() {
        let u = RequestUrl::parse("/a%20b/%ED%95%9C?x=%ED%95%9C", 1).unwrap();
        assert_eq!(u.pathname, "/a%20b/%ED%95%9C");
        assert_eq!(u.get("x"), Some("한"));
    }

    #[test]
    fn parse_fails_like_node() {
        assert_eq!(
            RequestUrl::parse("//[x/", 1),
            Err("Invalid URL".to_string())
        );
    }

    #[tokio::test]
    async fn read_json_caps_and_parses() {
        let err = read_json(Body::from(vec![b' '; 11]), 10).await.unwrap_err();
        let res = err.into_response();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(res).await,
            serde_json::json!({"error": "요청이 너무 큽니다"})
        );
        let v = read_json(Body::from("{\"a\":1}"), 7).await.unwrap();
        assert_eq!(v, serde_json::json!({"a": 1}));
        let bad = read_json(Body::from("{"), 10).await.unwrap_err();
        assert!(matches!(bad, ApiError::BadRequest(_)));
        assert_eq!(bad.into_response().status(), StatusCode::BAD_REQUEST);
        let null = read_json(Body::from("null"), 10).await.unwrap();
        assert_eq!(null, Value::Null);
    }

    #[tokio::test]
    async fn io_error_is_502_without_code() {
        let e = std::io::Error::new(std::io::ErrorKind::NotFound, "gone");
        let res = ApiError::from(e).into_response();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(res.headers()["content-type"], "application/json");
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], br#"{"error":"gone"}"#);
    }

    #[tokio::test]
    async fn backend_and_upload_errors_map_like_the_catch_all() {
        let res =
            ApiError::from(BackendError::with_code("ro", "terminal_not_writable")).into_response();
        assert_eq!(res.status(), StatusCode::CONFLICT);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            &bytes[..],
            br#"{"error":"ro","code":"terminal_not_writable"}"#
        );

        let res = ApiError::from(BackendError::new("x")).into_response();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            body_json(res).await,
            serde_json::json!({"error": "x", "code": "backend_error"})
        );

        let res = ApiError::from(BackendError::plain("p")).into_response();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(body_json(res).await, serde_json::json!({"error": "p"}));

        let res = ApiError::from(UploadError::Rejected("bad".into())).into_response();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(res).await, serde_json::json!({"error": "bad"}));

        let io = std::io::Error::other("disk");
        let res = ApiError::from(UploadError::Io(io)).into_response();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(body_json(res).await, serde_json::json!({"error": "disk"}));

        let res = ApiError::NullBody("text").into_response();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            body_json(res).await,
            serde_json::json!({"error": "Cannot read properties of null (reading 'text')"})
        );

        let git = GitError {
            message: "fatal".into(),
            stdout: String::new(),
        };
        let res = ApiError::from(git).into_response();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(body_json(res).await, serde_json::json!({"error": "fatal"}));
    }
}
