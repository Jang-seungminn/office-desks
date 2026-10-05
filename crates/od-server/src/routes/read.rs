//! Read routes. This task: `GET /api/snapshot` and `GET /api/org`; Task 6 adds the rest.

use axum::http::StatusCode;
use axum::response::Response;

use crate::app::AppState;
use crate::reqs::json;

/// `poller.current`.
pub(crate) fn snapshot(st: &AppState) -> Response {
    json(StatusCode::OK, &*st.poller.current())
}

/// The org chart as loaded (or last saved).
pub(crate) fn org(st: &AppState) -> Response {
    json(StatusCode::OK, &st.org())
}
