# od-orca parity with the Node bridge

`od-orca` is the Rust port of the Orca and demo backends: the Orca CLI runner, `OrcaBackend`, the session resolver,
usage, and `DemoBackend`. Backend selection (`create_backend`) lives in `od-server`, so the app in R4 can reuse it. TS is
the spec; error codes and Korean/English messages are copied verbatim, and every `BackendError` carries a code (the
`no_plain_errors` test scans the crate sources for `BackendError::plain`).

Legend: "unit" means tests inside the module; "trials" means `tests/cli` (libtest-mimic, with a fake `orca` binary).

## Port table

| TS | Rust | Tests |
|---|---|---|
| `orcaCli.ts` `resolveOrcaCommand` | `cli::resolve_orca_command`, `resolve_orca_command_for` (Windows resolution in `od_core::native::env`) | unit in `cli.rs` |
| `orcaCli.ts` `createOrcaRunner`, `OrcaCliError` | `cli::OrcaCli` (`OrcaRunner`, `run_with_timeout`), `parse_output`, `one_line`; errors are `BackendError::with_code` (`not_found`, `timeout`, `spawn_error`, `bad_output`, `unsafe_for_cmd`, ...) | unit in `cli.rs`; trials `echo_round_trip`, `coded_error`, `bad_output`, `empty_output`, `ok_false_without_error`, `timeout_kills_its_child`, `timeout_override_outlives_default`, `output_too_large`, `not_found`, `probe`, `bare_name_uses_the_env_path`, `bare_name_not_on_the_env_path`; Windows `cmd_shim_timeout_kills_the_grandchild` |
| `backend/index.ts` `probeOrca` | `cli::probe_orca` (build the runner with `PROBE_TIMEOUT`, 3 s); `od_server::default_probe(env)` does that | unit in `cli.rs`; trial `probe` |
| `backend/index.ts` `createBackend` | `od_server::create_backend`, `BackendKind::from_env`, `default_probe` (`crates/od-server/src/backends.rs`) | see `crates/od-server/PARITY.md` |
| `backend/orca.ts` | `backend::OrcaBackend`, `orca_hire_args`, `join_lines_for_cmd` | unit in `backend.rs` (`orcaBackend.test.ts` cases one to one, plus `lenient_shapes`, `no_plain_errors`, the retry cap and hire tests) |
| `sessionResolver.ts` | `sessions::{SessionResolver, search_key}`, `verify::transcript_verifier` | unit in `sessions.rs`, `verify.rs` |
| `usage.ts` | `usage::to_usage` | unit in `usage.rs` |
| `demo.ts` | `demo::DemoRunner` (private; fake `worktree ps`, `terminal list`, `terminal read`, `account list`, `conversation search`), `demo_org`, `demo_enrichment` | unit in `demo.rs`; contract group `demo` |
| `backend/demo.ts` | `demo::DemoBackend`, `DemoOptions`, `DemoServerFiles` | unit in `demo.rs` (`demoBackend.test.ts` cases, plus clock, tick and rotation tests); contract group `demo` |
| `server.ts` verifier (`transcriptVerifier` passed to the backend) | `verify::transcript_verifier` | unit in `verify.rs` |
| `server.ts` `DEMO` files and startup line | `DemoBackend::server_files` (awards, org file and default org); the startup line is in `crates/office-desks/src/main.rs` | unit in `demo.rs`; bin tests `demo_serves_the_demo_office`, `orca_backend_shows_a_missing_cli` |

## Deliberate differences

Each line says what differs and why.

Process runner (`cli.rs`):
- **The child's environment is the runner's `EnvMap`** (`env_clear`, then the map). Node passes no `env`, so its child inherits `process.env`; the default map (`process_env()`) is the same thing. An injected map is used as is (no `agent_env` filtering: `ORCA_*` stays, as in Node).
- **A command that is not absolute is looked up on the map's PATH** with `od_core::native::env::find_command` (as `NativeBackend` does), and on Windows a name with an extension (`orca.exe`) is looked up on PATH too. Not found is `not_found` with no spawn. Node's spawn searches the process PATH; Rust's std, given a bare name, would fall back to its own folders (`/bin:/usr/bin`, the app and system folders on Windows), which could find another `orca`. The Windows `.exe`-over-`.cmd` resolution at construction is unchanged.
- **`stdin` is null.** TS leaves the pipe open. Reason: `orca` never reads input, and a child waiting on stdin must not hang a call.
- **32 MiB output cap per stream (`MAX_OUTPUT`).** Over it, the runner kills and reaps the child and answers `bad_output` `orca output too large`. TS has no cap. Reason: a runaway child must not fill memory.
- **The timeout kill is SIGKILL** (`start_kill`). On Windows it is `TerminateJobObject` on the child's job (see the Job Object line below), then `TerminateProcess` on the child, which alone is the fallback when there is no job. Node's `execFile` sends SIGTERM. Reason: tokio offers the forceful kill, and the child is reaped (at most 1 s) so no zombie is left.
- **`spawn_error` text is Rust's `io::Error` text**, for example `Permission denied (os error 13)`, not Node's `spawn <cmd> EACCES`. The code `spawn_error` is the same.
- **A batch argument std refuses maps to `unsafe_for_cmd`**, only when the command is a `.cmd`/`.bat` shim (`ErrorKind::InvalidInput`). An `.exe` install keeps `spawn_error` for the same error (for example a NUL in an argument).
- **Windows: the `.cmd` shim's grandchild is killed with a Job Object (fixed; Node leaves it running).** Right after the spawn the child goes into a Job Object of its own (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `BREAKAWAY_OK`). On a timeout or an over-cap stream the runner terminates the job, which ends the child and every process it started that did not break away (the shim's `orca-real.exe`), so the pipes close and the reader threads end. This used to be a parked reader thread. Details:
  - Launching commands: the Orca CLI's `open` starts the app detached without breakaway, so a timeout during such a command would kill the launched app too. office-desks never runs `open`; keep it that way or add breakaway handling first.
  - Race window: a process the child starts between `spawn` and `AssignProcessToJobObject` (microseconds; cmd.exe parses the script first) is not in the job and survives a timeout as before.
  - Every other way out (success, an error exit, a dropped call) clears the job's limits before closing it, so a process the CLI leaves behind on purpose (an app it launched) keeps running. Only a crash of ours closes the job with the limit set.
  - A dropped (cancelled) call kills only the direct child (`kill_on_drop`), as before.
  - If the job cannot be made or assigned, the call runs without one.
  - Trial `cmd_shim_timeout_kills_the_grandchild` (Windows CI) asserts the grandchild's PID is gone after the timeout.
- **Trailing-backslash `.cmd` contingency: evaluated, not needed.** std's `append_bat_arg` quotes an argument that ends in `\` and doubles the trailing backslashes. The Windows CI trial `cmd_shim_round_trip` (`--path=C:\a b\c\`) is green (run 37284311347), so no extra refusal exists.

Lenient shapes where TS would throw (TS answers 502 or fails the call; Rust degrades):
- A non-object CLI result reads as `null`/`{}`.
- A non-array `worktrees`, `terminals` or `hits` reads as empty; a worktree or terminal row that does not deserialize is dropped.
- Non-string `tail` rows become `""` (TS returned them as is).
- In search hits, a non-string `cwd` becomes `""`; a non-string `updatedAt`, `role`, `filePath` or `resumeCommand` becomes `null`; non-string `filePath`/`cwd`/`title` fields count as absent in the session resolver; a non-object hit is treated as `{}`.
- `windowMinutes` is used only as a non-zero JSON number (TS coerces numeric strings, so `"90"` gave `2시간` and `"abc"` gave `NaN시간`). Window labels come from an exact table (TS would find prototype keys like `constructor`).
- `resetsAt` and timestamps are truncated to whole milliseconds (TS keeps a float).

Time limits and bounds:
- **Hire can block up to 65 s.** The `terminal wait --timeout-ms=60000` runs under a 65 s runner timeout (`HIRE_WAIT_TIMEOUT`, via `run_with_timeout`); `create` and `send` use the normal 15 s. TS runs the wait under the 15 s runner timeout, so a slow agent start failed as `timeout`. This is a deliberate fix (the cost: a hire request can hold for a minute).
- **The blocked-prompt retry map is capped at 256 entries** (`BLOCKED_MAX`; oldest first; the id just added is never evicted), on top of TS's 10-minute prune on insert. TS's map is unbounded. Normal use behaves exactly like TS; with more than 256 prompts blocked at once the oldest loses its retry id.
- **30 s overall session resolve timeout, in a spawned task.** `SessionResolver` bounds each agent's search with `RESOLVE_TIMEOUT` (error `timeout`, `session search timed out`); TS has only the 15 s timeout per `orca` call. The search runs in a spawned tokio task, so a caller that is dropped does not cancel it and later callers join it or hit the cache. Per-agent dedupe: one search per agent at a time. The miss cache is 30 s (`MISS_TTL_MS`), as in TS.
- **The session cache keeps at most 256 agents** (`CACHE_MAX`; oldest `at` first, never the agent just written). TS's map is unbounded. The resolver never sees snapshots, so it cannot prune agents that are gone; a cap needs no wiring and normal offices never reach it.
- **A failed `orca search` is cached as a miss for `MISS_TTL_MS`** (30 s): that call still reports the error, and until the TTL the same phrase answers the last good session (or none) without spawning `orca` again. TS leaves the cache untouched on an error, so a failing search was re-spawned every poll. An overall `RESOLVE_TIMEOUT` is not cached.
- **`dispose` stops new searches.** `OrcaBackend::dispose` (and so the demo's) marks the resolver disposed; `resolve` then answers from the cache and starts no `orca search`. A search already inside `orca` finishes. TS `dispose` does nothing for Orca.
- **Snapshot single-flight comes from the poller.** `od_server::Poller` is `backend.snapshot()`'s only caller (`lib.rs`, `source`), so the backend adds no sharing of its own.

Wiring:
- **The session resolver gets the backend's injected `windows` flag** (`OrcaOptions.windows`) rather than reading the platform itself. TS reads `process.platform`. Reason: the Windows cleaning of search phrases and the hire newline joining are testable on any host.
- **The probe runs after the bind.** Node runs `orca status` first, then listens; the Rust binary binds first, so a busy port fails before any `orca` is spawned.
- **`node_basename` strips a drive prefix in `own_transcript`** (od-core, from the nodepath consolidation in Task 1).

Demo:
- **START is taken at construction** (TS: at module load).
- **`OFFICE_DESKS_DEMO_EPOCH`** fixes the demo clock (epoch ms, ASCII digits only). It is a new hook, in Rust and also in Node (`bridge/src/demo.ts`), used by the demo contract. With it set, `updatedAt` (snapshot and usage) also equals the epoch, because the inner `OrcaBackend` gets the demo clock; the TTLs never expire under a fixed epoch. Unset, the demo uses the wall clock as before.
- **`od_core::home::os_tmpdir` follows Node's `os.tmpdir()`**: `TMPDIR`, `TMP`, `TEMP` then `/tmp` on unix; `TEMP`, `TMP`, `<SystemRoot|windir>\temp` on Windows, with the trailing separator stripped. Only the Windows last resort differs: here `std::env::temp_dir()` if none is set. Demo files live under `<tmp>/office-desks-demo`. On Windows the upload folder (`od_core::uploads::upload_dir`) uses it too; on unix uploads keep `std::env::temp_dir()` (see od-core PARITY).
- **Awards dates use the machine's local zone** (TS `localDate`), so `awards.json` varies by TZ for a fixed epoch. The demo contract does not record `awards`.
- **`org_file` is only a path;** nothing is written there.

## Parked (same as TS)

- `/term` answers 404 for Orca and demo agents (no PTY of ours).

## Left for later (same as TS)

- On Windows with a `.cmd` shim, a multi-line agent-hire prompt is refused (`unsafe_for_cmd`) on the first-prompt `terminal send`, after `terminal create` already started the agent. The prompt is not newline-joined there. Use `ORCA_CLI_COMMAND` with an `orca.exe` path to avoid it.

## Test map

- **Fake runner unit tests** (`FakeRunner`, no process): `backend.rs`, `sessions.rs`, `usage.rs`, `verify.rs`, `demo.rs`, and the pure parts of `cli.rs` (resolution, parsing, `spawn_plan`).
- **Fake-orca process trials** (`tests/cli`): the twelve trials listed in the port table run on both OSes (`bare_name_uses_the_env_path` runs a bare `orca` whose PATH holds only the fake, after a guard checks the lookup). Windows only (`cfg(windows)`): `cmd_shim_round_trip`, `cmd_shim_refuses_before_spawn`, `exe_preferred_over_cmd`, `cmd_only_install`, `cmd_shim_timeout_kills_the_grandchild`. CI checks that `cmd_shim_round_trip` is in the trial list.
- **Demo contract:** `crates/od-server/tests/contract/steps-demo.json` is recorded against the Node bridge (`npm run contract:record -- --only demo`, `OFFICE_DESKS_BACKEND=demo`, fixed epoch, `TZ=UTC`) and replayed against `DemoBackend` (trial `contract_demo`, 19 steps verified). Notes:
  - Timestamps are normalized: the contract normalizer replaces every numeric `updatedAt`, `since`, `lastActivityAt` and `resetsAt` with `0` on both sides, so those values are not compared. Other times (for example `hiredAt` in stats, and transcript `ts`) are compared and are stable because the epoch is fixed.
  - `demo-changes-gated` and `demo-worktree-gated` answer 404 `unknown worktree` on both sides because the demo does not declare the `changes` and `board` capabilities (`server.ts` checks `backend.capabilities.changes` / `.board` before the desk lookup answers); they pin the gating, not a missing desk.
  - **Untested demo routes:** the contract does not record `awards` (TZ and date dependent), `/api/conversation/image`, `/api/local-image`, uploads, `/api/commands`, `/api/terminal`, or key/focus/queue routes that need a live terminal. Their demo behaviour is covered only by the `demo.rs` unit tests.
  - **State rotation** (the 8 s tick that cycles each demo agent's state) is covered only by unit tests (`worktree_ps_rotates_every_eight_seconds`, `worktree_ps_state_rotation_follows_a_moving_clock`), because the contract fixes the clock.
- **Manual read-only smoke test against the real Orca (2026-10-05, run with the user's approval).** `cargo run -p od-orca --example orca_smoke -- --user-approved-read-only` and `npx tsx bridge/scripts/orca-smoke.ts --user-approved-read-only` allow only `status`, `worktree ps`, `terminal list` and `terminal read`; anything else is refused and recorded. Result, identical for Rust and Node: reachable, 11 desks, 4 agents (1 with a terminal handle). Calls: `status` 1, `worktree ps` 2, `terminal list` 2, `terminal read` 1. One screen of 37 lines, composer ready. Nothing was refused. Both re-ran `terminal list` on the second snapshot because 3 agents had no handle (the TS refresh rule); this is parity, not a bug. Compare outputs with `jq -S`, since Rust sorts the `calls` keys.
- **The CLI child gets `process_env()`, not the raw OS env.** Variables whose name or value isn't UTF-8 are dropped (Node passes them through). Windows env lookups such as `TEMP`/`TMP` are case-sensitive here; Node's `process.env` is case-insensitive on Windows. Both only matter for unusual environments.
