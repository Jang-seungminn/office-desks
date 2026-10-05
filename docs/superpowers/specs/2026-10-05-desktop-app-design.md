# Office Desks in Rust: core, server, desktop app, TUI

This spec replaces the earlier draft of this file, which used a Node sidecar. The background roadmap is `docs/superpowers/specs/2026-10-04-native-backend-tui-design.md`.

## Why

The user wants two products on one core:

1. **The program.** A standalone desktop app like Orca or Warp: **simple and fast** now, and Orca-level breadth later.
2. **office-desk.** The playful pixel-office web view that makes using the program fun. It keeps its look and feel and never turns tool-like.

The user decided (2026-10-05) to **move everything to Rust**: the core, the server, the desktop app and the TUI. Only the office-desk web frontend stays TypeScript, because it is a web page. The Rust server serves it unchanged.

The work runs as a continuous implement → review → fix loop with subagents until the result is right.

## Verified (2026-10-05, macOS)

`portable-pty 0.9` and `vt100 0.16` together cover what the Node core relied on (`node-pty` plus `@xterm/headless`):
- spawn, write, resize and exit;
- screen rows and cells (fg/bg color, bold, wide Korean characters);
- the cursor position;
- the agent's modes (bracketed paste, application cursor);
- `contents_formatted()`, which replays to an identical screen.

`vt100` does **not** answer terminal queries. Device attributes (DA) and cursor position reports (DSR) differ from `@xterm/headless` there, so the core needs a small responder (see R1).

## Name (decided 2026-10-05)

The program (desktop app, TUI and CLI binary) is called **Gongbang (공방)**: the workshop where the agents work. office-desk keeps its name as the playful office view of it.
- In R4, the desktop app is titled Gongbang, and its bundle id is based on `gongbang`.
- In R6, the shipped binary becomes `gongbang`. Whether `office-desks` stays as an alias is decided in R6.
- Internal crate names (`od-core`, `od-server`, …) do not change. The name `gongbang` was free on crates.io, npm and Homebrew on 2026-10-05.

## Target architecture

```
crates/
  od-core     model (serde, JSON identical to bridge/src/model.ts), text/screen helpers, keys, hire validation,
              env scrub, registry, git worktrees + changes/diff, hooks, PtyHost (portable-pty + vt100),
              NativeBackend, transcripts/subagents/stats, awards, org, uploads, commands catalog, answer driver
  od-server   axum + tokio: the full HTTP/WS API the web office uses today (same paths, shapes, codes,
              Korean messages) + /hook + /term WS + embedded web/dist (rust-embed) + security rules
  od-orca     Orca backend (orca CLI runner) and the demo backend, for parity
  od-tui      the terminal app (ratatui + crossterm + tui-term), feature parity with TUI v3
  od-app      Tauri 2 desktop app: runs od-core + od-server in-process, app UI talks to it over the same API
  office-desks  the CLI binary: `office-desks` (TUI in a TTY), `--no-tui` (server), `app` (desktop), flags as today
app/          the desktop app UI (Vite + TS + xterm.js), served by Tauri
web/          office-desk web (unchanged TypeScript), embedded into od-server at build time
```

- **API contract.** The HTTP/WS API is the contract between the core and every client: the web office, the desktop app UI, and tools. The Rust server must be wire-compatible with the current Node bridge, so the web office works unchanged.
- **Node's role.** After the cutover, Node is used only to build the web and app frontends (Vite). Nothing at runtime needs Node.

## Milestones

Each milestone gets its own plan and goes through subagent-driven execution, with a review per task, a final review and an E2E check. Each one ends with a stacked PR.

| # | Milestone | Done when |
|---|---|---|
| **R1** | **od-core.** Port the native core and the pure modules to Rust, keeping the exact JSON shapes of `model.ts`. PtyHost uses portable-pty plus vt100, with a DA/DSR query responder and a mute switch while the TUI or app attaches. The ported unit tests (from `bridge/test`) pass on macOS and Windows CI. | `cargo test` is green on macOS and Windows. Every native-core behaviour from M2/M3 is covered. |
| **R2** | **od-server.** axum serves the full API parity with `bridge/src/server.ts`, plus `/hook`, `/term` and the token rules, using the native backend. It embeds `web/dist`. | **Contract tests** compare every endpoint's JSON and status codes against fixtures recorded from the Node bridge. The web office runs unchanged against the Rust server in a browser E2E (native backend, real Claude). |
| **R3** | **od-orca.** Port the Orca backend (CLI runner, terminal_not_writable handling, retry) and the demo backend. | Orca users and `--demo` work on Rust (contract tests plus a read-only Orca smoke test). |
| **R4** | **od-app.** Ship the Tauri 2 desktop app v1 (the scope is below). | `cargo tauri build` produces a macOS .app and a Windows bundle in CI. E2E checks the app UI against the in-process server. |
| **R5** | **od-tui.** Ship the terminal app at TUI v3 parity (sidebar, panes, mouse, copy, zoom, stop/remove) using ratatui and tui-term. | The ported TUI tests pass and the TUI E2E harness passes. |
| **R6** | **Cutover.** The `office-desks` Rust binary replaces the Node bridge and bin. Remove `bridge/`. Update CI (cargo on macOS and Windows), README, and distribution (GitHub release binaries; npx is dropped or becomes a thin downloader). | Nothing in the repo runs Node at runtime, and all E2E checks pass. |

## Desktop app v1 scope (R4)

The app is simple and fast:
- **Sidebar.** Projects → worktrees → agents with state. It has actions for add project (folder picker), new work, add agent, stop agent and remove worktree. Destructive actions confirm first.
- **Main area.** One tab per open agent terminal (xterm.js plus WebGL, fit and unicode11) over `/term`. Closing a tab detaches, and the agent keeps running. There is one optional side-by-side split.
- **Keyboard** (⌘ on macOS, Ctrl on Windows):

  | Keys | Action |
  |---|---|
  | `⌘/Ctrl+T` | new work |
  | `⌘/Ctrl+W` | close tab |
  | `⌘/Ctrl+1…9` | switch tab |
  | `⌘/Ctrl+\` | split |
  | `⌘/Ctrl+B` | sidebar |

- **Office.** **🏢 사무실** opens the web office in its own window. It is untouched and playful.
- **Lifetime.** The core runs **in-process**: no sidecar, no Node. Closing the app disposes the agents.
- **Out of v1:** code signing, auto-update, agents that survive the app closing (a daemon), plain shell tabs, settings, themes, and usage/search on native.

## Cross-cutting rules

- **Platforms and CI.** macOS and Windows are first-class. CI runs `cargo fmt --check`, `clippy -D warnings` and `cargo test` on both, plus the existing web build and tests.
- **Wire compatibility.** The JSON field names follow `model.ts` (camelCase via serde). Status codes and Korean messages are identical, and contract tests pin both.
- **Security.** The server binds to 127.0.0.1 only. It applies the same origin, Host and Sec-Fetch rules. Hook and `/term` access require tokens compared in constant time. No shell is ever used, and process arguments are always passed as argv arrays.
- **Process discipline.** Anything that starts servers or agents records its PIDs and stops only those. Never use port 4317, and never touch the user's Orca agents. Use scratch repos and `OFFICE_DESKS_HOME` only.
- **During the migration.** The Node bridge stays as-is and keeps working until R6, so the user always has a working tool.
