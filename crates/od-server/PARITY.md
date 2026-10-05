# od-server parity with the Node bridge

`od-server` is the Rust port of `bridge/src/server.ts` and the files around it, for the native backend. It must answer like the Node server on the wire. The proof is the contract replay (`tests/native`, trial `contract`): `tests/contract/steps.json` is run against Node by the recorder (`npm run contract:record`, macOS only) and the answers are committed as `tests/contract/fixtures/*.json`. Rust replays the same steps against `NativeBackend`, on macOS and on Windows. Wire-level cases that need a fake backend are in `tests/api.rs`.

Legend: **Group** is the fixture file. "api" means `tests/api.rs`, "unit" means tests inside the module.

## Port table

| TS | Rust | Tests | Group |
|---|---|---|---|
| `server.ts` guard + 403, security headers on every response | `app::dispatch`, `security::{is_allowed_request, apply_headers}` | unit in `security.rs`; api `foreign_host_is_403_with_security_headers`, `cross_site_origin_is_403` | `guard`, `empty` |
| `GET /api/snapshot` | `routes::read::snapshot` | api `snapshot_and_org` | `empty`, `manage` |
| `GET /api/org` | `routes::read::org` | api `snapshot_and_org` | `empty`, `manage` |
| `POST /api/org` | `routes::manage::org` | api `org_post_saves_broadcasts_and_ignores_content_type`, `org_save_failure_is_502_without_code` | `manage` |
| `GET /api/conversation` | `routes::read::conversation_route` | api `conversation_*` | `read` |
| `GET /api/conversation/image` | `routes::media::conversation_image` | api `conversation_image_index_and_types` | `media` |
| `GET /api/local-image` | `routes::media::local_image` | api `local_image_rules` | `media` |
| `GET /api/uploads/<name>` | `routes::media::upload` | api `uploads_serve_only_plain_names` | `media` |
| `GET /api/changes`, `/api/diff` | `routes::read::changes` | api `changes_and_diff_need_a_known_desk_and_the_capability` | `read` |
| `GET /api/search` | `routes::read::search` | api `search_*` | `read` |
| `GET /api/commands` | `routes::read::commands` | api `commands_route` | `read` |
| `GET /api/terminal` | `routes::read::terminal` | api `terminal_route` | `read` |
| `POST /api/send` | `routes::input::send` (`deliver`) | api `send_*` | `input` |
| `POST /api/send/retry` | `routes::input::retry` | api `retry_needs_a_blocked_prompt_on_a_known_terminal` | `input` |
| `POST /api/keys` | `routes::input::keys` | api `keys_*` | `input` |
| `POST /api/answer` | `routes::input::answer` | api `answer_*`, `a_second_answer_on_the_same_terminal_is_409` | `input` |
| `POST /api/queue` | `routes::input::queue` | api `queue_*` | `input` |
| `POST /api/focus` | `routes::input::focus` | api `focus_a_known_terminal` | `input` |
| `POST /api/hire` | `routes::manage::hire` | api `hire_*` | `manage`, `input` |
| `POST /api/worktree` | `routes::manage::worktree` | api `worktree_*` | `manage` |
| `POST /api/repos` | `routes::manage::repos` | api `repos_*` | `manage` |
| `/api/*` gates (405, 415, 404) | `routes::dispatch` | api `api_gates`, `unknown_post_api_is_404_not_found` | `empty` |
| `POST /hook/<id>` | `hook::handle` | api `hook_*` | `hook` |
| `/ws` upgrade, hub, initial messages | `ws::upgrade`, `hub::Hub`, `app::upgrade` | api `ws_*`, `rejected_upgrades_are_403`, `a_lagged_client_gets_a_full_resend`; unit in `hub.rs` | `empty`, `guard`, `manage` |
| static files (`web/dist`) | `assets::serve_static` (`WebDist` embeds `web/dist`; `MemAssets` in tests) | api `static_files_are_served_over_the_wire`, `root_without_dist_is_the_no_dist_text`; unit in `assets.rs` | none |
| `security.ts` | `security::{is_allowed_request, apply_headers}` (token compare: `od_core::security::same_token`) | unit in `security.rs` (every `security.test.ts` case, with port 4318) | `guard` |
| `poller.ts` | `poller::Poller`, `enrich::Enricher`, `start_background` in `lib.rs` (usage, awards, org, upload cleanup) | unit in `poller.rs`; api `usage_is_polled_at_start_and_sent_third`, `poller_idles_after_the_last_client_closes`, `transcripts_*` | `hook`, `manage` |
| `backend/index.ts` `createNativeBackend` | `lib.rs` `native_backend`, `hook_url` | api `hook_url_encodes_the_agent_id`, `native_backend_uses_the_scratch_home` | all (the contract runs on `NativeBackend`) |
| `bin/office-desks.mjs` (server part) | `crates/office-desks` (`main.rs`, `cli.rs`) | `crates/office-desks/tests/cli.rs`, unit in `cli.rs` | none |
| `/term/<id>` (new, no TS) | `term::upgrade` | native trials `term_*` | none |

## Deliberate differences

Each line says what differs and why.

Errors and bodies:
- **JSON parse error text.** A body that is not JSON gives 400 `{error}` with serde_json's message, where Node gives V8's `SyntaxError` text. Reason: Rust cannot reproduce V8's text; the contract compares status and body kind only (`compare: "status"`).
- **Lone surrogate escapes in a body.** `"\ud800"` is refused by serde_json (400), where `JSON.parse` accepts it. Reason: Rust strings are valid UTF-8.
- **Nesting and number limits.** serde_json stops at a nesting depth of 128 (400), and `1e400` is an error, where JS parses a deep array and `Infinity`. Reason: serde_json limits; no client sends these.
- **fs, git and join errors.** They answer 502 `{error}` with no `code`. TS adds Node's `code` (for example `ENOENT`) on fs errors. Reason: `io::Error`, `GitError` and `JoinError` carry no such code; the web UI does not read it.
- **Panics map to 502.** A panic in a handler is caught (`CatchPanicLayer`, inside the header layer) and answers 502 `{error}` with the security headers. Reason: Node's catch-all would answer 502 for the thrown error that corresponds.
- **Invalid request-target.** The 400 text is Node's `Invalid URL` and the same status, but the check is the `url` crate, not Node's `new URL`; inputs that the two parse differently (exotic hosts in an absolute-form target) may differ. Reason: no WHATWG parser in the standard library.

Field coercion (body values that are not the expected type):
- **`workspaceStatus`.** A non-string value is stored as `String(v)` (`1` becomes `"1"`, `null` becomes `"null"`). TS stores the raw JSON value. Visible in the snapshot (a string, not a number or null) and in `state.json`. Reason: threading a raw `Value` through `DeskMeta`, `OfficeDesk` and the state mapper is not worth it; the web UI sends select strings only. The regex check itself matches TS, which also coerces.
- **Hire `name` and `baseBranch`.** A value that is not a string counts as absent. TS coerces (a numeric `name` passes the name regex, `baseBranch: 7` reaches git as `7`). Reason: parked from R1; no client sends these.
- **`/api/send` with an array of images.** Each image is validated before the upload folder is made; TS makes the folder first. With a broken folder and a bad image, TS gives 502 and Rust gives 400. The object form (`images: {length}`) follows TS.
- **Transcript `media_type` in the image routes.** Rust accepts the four real image types only. TS looks the type up in an object, so `constructor` or `__proto__` would be served with that content type (404 in Rust). Reason: needs a hand-made transcript; stricter is safer.

Sockets and upgrades:
- **Refused `/ws` and `/term` upgrades.** The answer is 403 (`{"error":"forbidden origin"}` for `/ws` and the guard, `forbidden`, `bad path` or `unknown terminal` for `/term`) plus `Connection: close`. TS calls `socket.destroy()`. Reason: axum cannot drop a socket before the upgrade; the contract fixture is `{rejected:true}` and the Rust runner also checks the 403.
- **Malformed `/ws` handshake.** Non-GET, a bad `Upgrade`, a missing `Sec-WebSocket-Key` or a version other than 13 get axum's rejection (405 or 400 with its text body). `ws` sends its own bodies, plus `Sec-WebSocket-Version: 13, 8` on a mismatch.
- **Security headers on the 101.** The five headers are also on the Switching Protocols response. Node's `ws` writes a bare 101. Harmless.
- **Upgrade detection** follows Node (`Connection` has an `upgrade` token and `Upgrade` is non-empty), so `Upgrade: websocket` alone is a normal request in both.
- **No heartbeat on `/ws`.** Neither side pings; a dead client is noticed when a send fails. Same as TS, listed so nobody adds it by accident.
- **`/term` is new.** There is no TS counterpart (see `src/term.rs` for the protocol). It is a Rust-only addition for the TUI and desktop app.
- **`/term/*` without an upgrade.** Any method answers 400 `{"error":"websocket upgrade required"}`. TS served `index.html` for it. Reason: nothing in the web app links to such a path.
- **Resize limits.** `/term` ignores a resize outside cols 1..=1000 and rows 1..=500, and `PtyHost::resize` ignores sizes over 1000 x 500 (see od-core PARITY). Reason: vt100 allocates every cell.

Server behaviour:
- **No 503 for a rebuilding dist.** TS answers 503 `web UI is being rebuilt` while `web/dist` is missing or being replaced. The Rust binary embeds the files (rust-embed), so there is no such state. Without a built `web/dist`, `/` answers a plain text hint.
- **`POST /hook` waits for the refresh.** The handler awaits the poller refresh for at most 500 ms before it answers 204. TS is fire-and-forget. Reason: on the Rust blocking pool the next `GET /api/snapshot` would otherwise often read the state from before the hook (found by the `hook-snapshot` contract step).
- **`Poller::refresh` is stricter.** A caller waits for a poll that started after the call; TS callers may share a poll that is already in flight and so read older data. Reason: avoids a stale join.
- **Extra poll after `set_idle(false)`.** If a poll is in flight, the loop polls once more at once (a `Notify` permit). TS only restarts a pending timer.
- **`/api/answer` driver errors** are always 409 `{error}` with no `code`, as TS (`catch (err)`), unlike the catch-all's 409 with `code` for `terminal_not_writable`.
- **Key order.** `serde_json` has `preserve_order` on (workspace-wide) and the busy and terminal bodies are built in TS key order. The contract compares parsed JSON, so it does not check key order.

Binary (`office-desks`):
- **`--backend orca|demo`** (and `--demo`, `OFFICE_DESKS_BACKEND=orca|demo`) is refused with exit 1 until R3 ports those backends. Precedence otherwise is Node's: `--backend` over `OFFICE_DESKS_BACKEND` over `--demo`/`OFFICE_DESKS_DEMO` over native.
- **No Orca probe.** TS runs `orca status` when nothing selects a backend; the Rust binary starts the native backend. Reason: there is no Orca backend yet (R3).
- **`--port` and `OFFICE_DESKS_PORT`** accept ASCII digits only, 1 to 65535 (JS `Number()` accepts `1e3`, `0x10` and more). `--backend` or `--port` with no value is an error (Node reads `undefined`).
- **Bind error text.** `[office-desks] cannot listen on 127.0.0.1:<port>: <io::Error Display>`, exit 1, before any backend exists. Node prints `listen EADDRINUSE: address already in use ...` from its `error` event.
- **No port fallback.** The binary never picks another port. The Node TUI takes the next free port when 4317 is busy (see the README); the Rust binary has no TUI yet and fails with the bind error.
- **`--no-tui`** is accepted and does nothing (there is no TUI yet).
- **No SIGHUP handling.** Node handles it only in the TUI.
- **Shutdown cannot be forced.** A second signal during `shutdown()` does nothing. If `shutdown()` hangs there is no force exit, as in Node.
- **Windows shutdown is untested.** The bin shutdown test is a smoke test on Windows (`child.kill()` is `TerminateProcess` and asserts only that the process exits). Graceful shutdown is asserted on unix only (SIGINT and SIGTERM). The Ctrl+C, Ctrl+Break, close and shutdown console events are handled but never exercised, so graceful shutdown on Windows stays unverified until R4/R6.
- **`hook-relay`** as the first argument runs before anything else and is bounded to 3 s overall, even if stdin stays open.
- **Static paths.** A segment like `..foo` is a normal name and is served if such an asset exists, as with Node's `path.normalize`. Files outside the six TS extensions are `application/octet-stream`, as in TS.

## Left for later

- Orca and demo backend selection, and `probeOrca`: R3.
- `stop` and `remove` HTTP routes for agents and worktrees (the desktop app needs them; `server.ts` has none): R4.
- The terminal app (TUI) on top of this server: R5.
