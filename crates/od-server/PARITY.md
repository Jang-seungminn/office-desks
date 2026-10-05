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
| `POST /api/send` | `routes::input::send` (`deliver`) | api `send_*`, `a_dropped_client_does_not_cut_the_send_short` | `input` |
| `POST /api/send/retry` | `routes::input::retry` | api `retry_needs_a_blocked_prompt_on_a_known_terminal` | `input` |
| `POST /api/keys` | `routes::input::keys` | api `keys_*` | `input` |
| `POST /api/answer` | `routes::input::answer` | api `answer_*`, `a_second_answer_on_the_same_terminal_is_409` | `input` |
| `POST /api/queue` | `routes::input::queue` | api `queue_*` | `input` |
| `POST /api/focus` | `routes::input::focus` | api `focus_a_known_terminal` | `input` |
| `POST /api/hire` | `routes::manage::hire` | api `hire_*`, `a_dropped_client_does_not_cut_the_hire_short` | `manage`, `input` |
| `POST /api/worktree` | `routes::manage::worktree` | api `worktree_*` | `manage` |
| `POST /api/repos` | `routes::manage::repos` | api `repos_*` | `manage` |
| `/api/*` gates (405, 415, 404) | `routes::dispatch` | api `api_gates`, `unknown_post_api_is_404_not_found` | `empty` |
| `POST /hook/<id>` | `hook::handle` | api `hook_*` | `hook` |
| `/ws` upgrade, hub, initial messages | `ws::upgrade`, `hub::Hub`, `app::upgrade` | api `ws_*`, `rejected_upgrades_are_403`, `a_lagged_client_gets_a_full_resend`; unit in `hub.rs` | `empty`, `guard`, `manage` |
| static files (`web/dist`) | `assets::serve_static` (`WebDist` embeds `web/dist`; `MemAssets` in tests) | api `static_files_are_served_over_the_wire`, `root_without_dist_is_the_no_dist_text`; unit in `assets.rs` | none |
| `security.ts` | `security::{is_allowed_request, apply_headers}` (token compare: `od_core::security::same_token`) | unit in `security.rs` (every `security.test.ts` case, with port 4318) | `guard` |
| `poller.ts` | `poller::Poller`, `enrich::Enricher`, `start_background` in `lib.rs` (usage, awards, org, upload cleanup) | unit in `poller.rs`; api `usage_is_polled_at_start_and_sent_third`, `poller_idles_after_the_last_client_closes`, `transcripts_*` | `hook`, `manage` |
| `backend/index.ts` `createNativeBackend` | `lib.rs` `native_backend`, `hook_url` | api `hook_url_encodes_the_agent_id`; native trial `native_backend_uses_the_scratch_home` (a repo seeded in the env's `OFFICE_DESKS_HOME` shows in `snapshot()`) | all (the contract runs on `NativeBackend`) |
| `backend/index.ts` `createBackend`, `probeOrca` | `backends::{create_backend, BackendKind::from_env, default_probe, unknown_backend}` (`crates/od-server/src/backends.rs`; Orca and demo backends in `crates/od-orca`, see its PARITY). `CreatedBackend.kind` says which kind was built | unit in `backends.rs` (`from_env_follows_node`, `explicit_kind_never_probes`, `auto_follows_the_probe`, `default_probe_is_false_without_orca`); bin tests `demo_serves_the_demo_office`, `orca_backend_shows_a_missing_cli`, `auto_without_orca_is_native` | `demo` |
| `bin/office-desks.mjs` (server part) | `crates/office-desks` (`main.rs`, `cli.rs`) | `crates/office-desks/tests/cli.rs`, unit in `cli.rs` | none |
| `/term/<id>` (new, no TS) | `term::upgrade` | native trials `term_*` | none |
| `POST /api/stop` (new, no TS route) | `routes::manage::stop` | api `stop_and_remove_*`, `lifecycle_errors_map_to_statuses`; native trial `lifecycle_native` | none |
| `POST /api/remove` (new, no TS route) | `routes::manage::remove` | api `stop_and_remove_*`, `lifecycle_errors_map_to_statuses`; native trial `lifecycle_native` | none |
| `/app/` (new, no TS: the desktop app UI) | `assets::serve_app`, `security::apply_app_headers` | api `app_mount_*` | none |

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
- **Refused `/ws` and `/term` upgrades.** A refused `/ws` upgrade answers 403 `{"error":"forbidden origin"}` plus `Connection: close`. TS calls `socket.destroy()`. Reason: axum cannot drop a socket before the upgrade; the contract fixture is `{rejected:true}` and the Rust runner also checks the 403. `/term` (no TS counterpart) refuses, in this order: the guard 403 `forbidden origin`, no upgrade 400 `websocket upgrade required`, a wrong or missing token 403 `forbidden`, a bad id 400 `bad path`, no live native terminal 404 `unknown terminal`.
- **Malformed `/ws` handshake.** Non-GET, a bad `Upgrade`, a missing `Sec-WebSocket-Key` or a version other than 13 get axum's rejection (405 or 400 with its text body). `ws` sends its own bodies, plus `Sec-WebSocket-Version: 13, 8` on a mismatch.
- **Security headers on the 101.** The five headers are also on the Switching Protocols response. Node's `ws` writes a bare 101. Harmless.
- **Upgrade detection** follows Node (`Connection` has an `upgrade` token and `Upgrade` is non-empty), so `Upgrade: websocket` alone is a normal request in both.
- **No heartbeat on `/ws`.** Neither side pings; a dead client is noticed when a send fails. Same as TS, listed so nobody adds it by accident.
- **`/term` is new.** There is no TS counterpart (see `src/term.rs` for the protocol). It is a Rust-only addition for the TUI and desktop app.
- **`/term/*` without an upgrade.** Any method answers 400 `{"error":"websocket upgrade required"}`. TS served `index.html` for it. Reason: nothing in the web app links to such a path.
- **`/term` limits.** A slow client is closed with 1013 after `term_buffer` queued chunks or 8 MiB queued bytes. Messages and frames from a client are capped at 1 MiB. On server shutdown every `/term` socket is closed with 1001.
- **Resize limits.** `/term` ignores a resize outside cols 1..=1000 and rows 1..=500, and `PtyHost::resize` ignores sizes over 1000 x 500 (see od-core PARITY). Reason: vt100 allocates every cell.

Stop and remove (new routes):
- **Status mapping.** `lifecycle_error` maps the backend error code: `not_found` is 404, `main_checkout`, `has_agents` and `dirty` are 409, `unsupported` is 400, anything else is 502. The body is `{error}` plus `code` when the backend gave one. A backend without the capability answers 400 `unsupported`.

The app mount (`/app/`):
- **Served only when `ServerConfig.app_assets` is set** (the desktop app sets it; `office-desks` never does, so there `/app/` is the normal SPA fallback). The `/app/` pages get `APP_CSP` instead of the strict CSP. It differs in exactly two directives: `style-src 'self' 'unsafe-inline'` (xterm injects `<style>` elements at runtime) and `connect-src 'self' ipc: http://ipc.localhost` (Tauri's IPC first tries `ipc://localhost` on macOS and `http://ipc.localhost` on Windows; the page's own `/term` WebSocket is covered by `'self'`). `script-src` stays `'self'` with no `unsafe-eval`. The other four headers are the same, including `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
- **Framing protection matters.** The app's IPC capability is granted to window `main` on the server's own origin. An iframe of `/` inside `main` would share that origin; both CSPs' `frame-ancestors 'none'` (and `X-Frame-Options`) prevent it, not the navigation policy. Removing that directive would reopen it.
- **IPC model.** Only the window `main`, and only pages on `http://127.0.0.1:<port>/*`, may call the three app commands (`term_config`, `pick_folder`, `open_office`). The office window (`/`) has no IPC. No `core:*`, `dialog:*` or `opener:*` permission is granted to any page. `main` may navigate only inside `/app/`; external `http`/`https` links open in the OS browser.
- **Token transport.** The `/term` token is handed over by IPC (`term_config`) but travels in the WebSocket URL query on purpose: browsers cannot set headers on a WebSocket. This is accepted because devtools are off in release builds and the server never logs URLs. A failed handshake can still print the URL in devtools of a debug build.

Server behaviour:
- **MIME table.** `.mjs` (text/javascript), `.woff2` (font/woff2) and `.wasm` (application/wasm) are typed; Node served them as octet-stream. Reason: the app UI needs them.
- **No 503 for a rebuilding dist.** TS answers 503 `web UI is being rebuilt` while `web/dist` is missing or being replaced. The Rust binary embeds the files (rust-embed), so there is no such state. Without a built `web/dist`, `/` answers a plain text hint.
- **`POST /hook` waits for the refresh.** The handler awaits the poller refresh for at most 500 ms before it answers 204. TS is fire-and-forget. Reason: on the Rust blocking pool the next `GET /api/snapshot` would otherwise often read the state from before the hook (found by the `hook-snapshot` contract step).
- **`Poller::refresh` is stricter.** A caller waits for a poll that started after the call; TS callers may share a poll that is already in flight and so read older data. Reason: avoids a stale join.
- **Extra poll after `set_idle(false)`.** If a poll is in flight, the loop polls once more at once (a `Notify` permit). TS only restarts a pending timer.
- **Key sequences survive a client abort.** `/api/queue`, `/api/answer`, `/api/send`, `/api/send/retry` and `/api/hire` run their backend call in a spawned task, so a client that disconnects does not stop it partway (the native paste writes the text, waits 400 ms, then writes Enter; a hire makes a worktree, then starts the agent). Node keeps running a handler whose client is gone, so this is the same outcome.
- **`/api/send` with `images` as an object or a string.** If its length is over 6, the answer is 400 (the MAX text). For an object otherwise, the upload folder is created first, then the answer is 502 `images is not iterable`. For a string, its UTF-16 length is compared first, before the string is rejected as an unsupported type.
- **`/api/answer` driver errors** are always 409 `{error}` with no `code`, as TS (`catch (err)`), unlike the catch-all's 409 with `code` for `terminal_not_writable`.
- **Key order.** `serde_json` has `preserve_order` on (workspace-wide) and the busy and terminal bodies are built in TS key order. The contract compares parsed JSON, so it does not check key order.

Binary (`office-desks`):
- **Backend selection** is Node's and lives in od-server, so the app (R4) and the TUI (R5) reuse it: `--backend` > `OFFICE_DESKS_BACKEND` > `--demo`/`OFFICE_DESKS_DEMO` > `orca status` probe (`default_probe`, 3 s), else native. `BackendKind::from_env` does the env part with Node's error text (`Unknown OFFICE_DESKS_BACKEND "<v>" (use orca, native or demo)`); the binary parses only its argv (`--backend`, `--demo`) and reads the env only when `--backend` is absent. `create_backend` does not poll the probe when a kind is chosen, and reports the kind it built (`CreatedBackend.kind`). The env value is trimmed like JS `trim` (`od_core::jsstr::trim`).
- **The probe runs after the port is bound** (Node probes first, then listens); the Rust binary binds first, so a busy port fails (exit 1) before any `orca` is spawned. The startup line is Node's: `[office-desks] bridge on http://127.0.0.1:<port> (<label>)`.
- **`--port` and `OFFICE_DESKS_PORT`** accept ASCII digits only, 1 to 65535 (JS `Number()` accepts `1e3`, `0x10` and more). `--backend` or `--port` with no value is an error (Node reads `undefined`).
- **Bind error text.** `[office-desks] cannot listen on 127.0.0.1:<port>: <io::Error Display>`, exit 1, before any backend exists. Node prints `listen EADDRINUSE: address already in use ...` from its `error` event.
- **No port fallback.** The binary never picks another port. The Node TUI takes the next free port when 4317 is busy (see the README); the Rust binary has no TUI yet and fails with the bind error.
- **`--no-tui`** is accepted and does nothing (there is no TUI yet).
- **No SIGHUP handling.** Node handles it only in the TUI.
- **Shutdown drains first.** `ServerHandle::shutdown` stops accepting, waits up to 2 s (`SHUTDOWN_DRAIN`) for in-flight HTTP requests (`closed()`), then disposes the backend. A hire still running after that (its client gone, or past 2 s) cannot start an agent: `PtyHost::spawn` refuses once dispose has begun (od-core PARITY). Node's shutdown disposes at once.
- **Shutdown cannot be forced.** A second signal during `shutdown()` does nothing. If `shutdown()` hangs there is no force exit, as in Node.
- **Windows shutdown is untested.** The bin shutdown test is a smoke test on Windows (`child.kill()` is `TerminateProcess` and asserts only that the process exits). Graceful shutdown is asserted on unix only (SIGINT and SIGTERM). The Ctrl+C, Ctrl+Break, close and shutdown console events are handled but never exercised, so graceful shutdown on Windows stays unverified until R4/R6.
- **`hook-relay`** as the first argument runs before anything else and is bounded to 3 s overall, even if stdin stays open.
- **Static paths.** A segment like `..foo` is a normal name and is served if such an asset exists, as with Node's `path.normalize`. Files outside the six TS extensions are `application/octet-stream`, as in TS.

## Notes for R3/R4

- **R3 (done): Orca `find_session` dedupe and timeouts** are in `od_orca::SessionResolver` (one search per agent at a time, 30 s bound); `snapshot` is single-flight through the poller, which is its only caller.
- **R3 (done): coded errors.** Every `BackendError` in the Orca and demo backends carries a code; the `no_plain_errors` test in `od-orca` enforces it.
- **R4 (done), R5 open: `Some(BackendKind::Native)`.** The app always passes it (random port, native backend, shares `OFFICE_DESKS_HOME` with the CLI). The TUI (R5) must still do the same: Auto mode picks Orca whenever it runs, and Orca/demo have no `/term` panes.
- **R4 (done): Tauri origins.** The app loads its UI from od-server's own origin (`http://127.0.0.1:<port>/app/`), so the guard is unchanged and no `allowed_origins` exists.
- **R4 (done): call `shutdown()`.** The app calls `ServerHandle::shutdown().await` on quit, close of `main` and SIGINT/SIGTERM/SIGHUP, so agents are disposed.
- **R4 (done): `hook-relay` first.** `od-app`'s `main()` dispatches `hook-relay` before the GUI starts.
- **R4 (done): the poller.** The app's UI keeps a `/ws` connection open, which keeps the poller live (it idles without a `/ws` client or `tui_active`).
- **R6: release check.** The release job must assert that `web/dist/index.html` exists before building: rust-embed embeds whatever is there, and a binary built without it serves only the no-dist hint.
- **Later: PTY input queue.** `PtyHost` input goes through an unbounded channel to the writer thread; a stuck agent with a flood of `/term` input grows it without limit. The app chunks its input at 64 KiB, which does not bound the queue.

## Left for later

- Windows: agents survive a forced kill of gongbang.exe (Task Manager, logoff): no Job Object for PtyHost children yet.
- Single-instance guard for Gongbang.
- App UI follow-ups: release WebGL contexts of hidden tabs (least recently used first); the terminal reconnect has no backoff (immediate on 1013, 500 ms after other closes, gives up after three closes with no open between); no manual reconnect button.
- Windows shortcuts are Ctrl+Shift+key by user decision (plain Ctrl+T/W/B/\ belong to Claude Code and shells); revisit only if asked.
- Linux is not a target for `od-app` (webkit2gtk); use `cargo test --workspace --exclude od-app`.
- The terminal app (TUI) on top of this server: R5.
