# M3: Office Desks TUI — lobby + full-screen attach

Roadmap: `docs/superpowers/specs/2026-10-04-native-backend-tui-design.md` (M3).
Builds on M2 (NativeBackend, PR #2).

## Goal

Running `office-desks` in a terminal opens our own agent terminal manager (TUI). The same process also serves the pixel office on the web (127.0.0.1:4317).

The TUI lets you:
- see every project, worktree and agent with live state;
- create agents and register projects;
- "attach" to any agent's terminal and type into it directly.

This is the first version of our own Orca-like tool.

## Decisions (agreed with the user)

| Topic | Decision |
|---|---|
| Screen model (v1) | A **lobby** list, plus a **full-screen attach** to one agent at a time, like `tmux attach`. A sidebar and split panes are deferred to v2. |
| Escape key | **Ctrl+]** (byte `0x1d`). The convention comes from telnet and `docker attach`, and Claude Code doesn't use the key. |
| Orca relationship | `office-desks` started from an interactive terminal always runs **TUI + native** backend. To put only the web office on top of Orca, use `--backend orca` or `npm start`, which keep today's server-only behavior. |
| Process model | One process runs the TUI, the HTTP/WS server and the agent PTYs. Quitting the TUI ends the agents, as already decided for native. |

## Verified (2026-10-04)

- `@xterm/addon-serialize@0.14.0` works with `@xterm/headless@6`. `serialize()` of a buffer replays exactly, including SGR colors and Korean double-width text. That makes a lossless repaint possible when attaching to an agent that has been running in the background.
- Windows CI: the M2 PTY echo test runs under ConPTY on `windows-latest` and passes.

## Entry points

- **`office-desks`** (bin), when stdin and stdout are TTYs and neither `--backend orca|demo` nor `--no-tui` is given:
  - sets `OFFICE_DESKS_BACKEND=native` and `OFFICE_DESKS_TUI=1`;
  - starts the server;
  - starts the TUI.
- **`office-desks --no-tui`**, or a run without a TTY: server only. M2 behavior, including Orca auto-select.
- **`npm start` / `npm run dev`:** unchanged (server only).
- **`npm run tui`:** a new dev script that runs the TUI from source (`tsx`).

## Architecture

```
bin/office-desks.mjs ──► bridge/dist/server.js   (HTTP/WS, poller, backend)  ──exports──► { backend, poller, PORT }
                    └──► bridge/dist/tui/main.js (TUI app; only when TTY + native)
                                    │
                    NativeBackend ──┴── PtyHost (+ onData, resize, serialize)
```

- **`server.ts` exports.**
  - It exports `backend`, `poller` and `PORT`. It is an ESM module with top-level await, so importers get them after startup.
  - When `OFFICE_DESKS_TUI=1`, server logs go to `<officeHome>/office-desks.log` instead of stdout, so they can't corrupt the TUI screen.
- **`PtyHost` additions:**
  - `onData(id, fn): () => void` streams live output.
  - `resize(id, cols, rows)` resizes both the PTY and the headless terminal.
  - `serialize(id): string` returns a repaint string from `@xterm/addon-serialize`.
- **`NativeBackend` additions:**
  - `attachTarget(agentId)` returns `{ ptyId, title }`, or `null`, so the TUI can reach the PTY host.
  - The `pty` dependency is exposed read-only as `ptyHost` for the TUI.
- **`bridge/src/tui/`.** Small, pure-where-possible modules:
  - `keys.ts`: decodes a stdin chunk into lobby actions. In attach mode the only special byte is `0x1d`.
  - `lobby.ts`: `renderLobby(snapshot, ui, size) → string[]`. A pure function that renders from the office snapshot, grouped by repo, with the state glyph, agent type and activity.
  - `prompt.ts`: line-input prompts inside the lobby (repo path, worktree name, agent, first prompt). It handles UTF-8 and IME input from the terminal as plain text.
  - `screen.ts`: a terminal writer with alt-screen enter/leave, clear, cursor hide/show and a status line.
  - `attach.ts`: the attach session.
    - Enter: resize the PTY to the terminal size minus one row, write `serialize()`, then pipe `onData` to stdout and stdin to the PTY.
    - Status line: redrawn on the last row after output, throttled and using save/restore cursor.
    - Leave: on Ctrl+] or agent exit.
  - `app.ts`: the state machine (lobby ↔ prompt ↔ attach ↔ quit-confirm). It handles stdin raw mode, SIGWINCH, and restoring the terminal on exit or crash.

## Lobby (v1)

```
 Office Desks · native · 웹 http://127.0.0.1:4317                     ⌨ 2  🙋 1
 ──────────────────────────────────────────────────────────────────────────────
 app
   main            claude   🙋 확인 필요 · Bash
 ▸ fix-login       claude   ⌨ Edit: src/auth/session.ts
   fix-login       codex    ☕ 완료
 api
   rate-limit      (에이전트 없음)
 ──────────────────────────────────────────────────────────────────────────────
 q 종료 · ↑↓ 이동 · Enter 붙기 · a 에이전트 추가 · n 새 작업 · p 프로젝트 추가
```

- Rows are agents. A worktree without agents gets one row so you can add to it.
- Keys:
  - `↑`/`↓`/`k`/`j` move the selection.
  - `Enter` attaches.
  - `a` adds an agent to the selected worktree.
  - `n` starts new work: pick a repo, name it, pick an agent, then give the first prompt.
  - `p` adds a project.
  - `q` quits. It asks for confirmation when agents are running ("에이전트 N개가 종료됩니다. 종료할까요? (y/N)").
- The lobby re-renders when the poller snapshot changes and on resize.
- It uses the same validation (`validateHire`) and backend calls (`backend.hire`, `backend.addRepo`) as the web.
- An empty office shows "프로젝트가 없어요 — p로 git 저장소를 추가하세요".

## Attach

- The screen switches to the alt screen. The agent's PTY is resized to `cols × (rows−1)`, and the last row is our status line: `app/fix-login · claude · Ctrl+] 로비`.
- Repaint uses the serialized buffer, followed by the live stream.
- Every stdin byte goes to the PTY except `0x1d`, which returns to the lobby. Pasting large text works, since it is passed through.
- On SIGWINCH, both the PTY and the headless terminal are resized.
- When the agent exits while attached, the TUI returns to the lobby with a "에이전트가 종료됐어요" notice.
- The web keeps working while you are attached. Web reads use the same headless buffer, so the web terminal view reflects the new size.

## Error handling and robustness

- **Restoring the terminal.** Leave the alt screen, show the cursor and turn raw mode off on every exit path: quit, SIGINT/SIGTERM, uncaught exceptions. This runs before `backend.dispose()`.
- **Startup failure.** If startup fails before the TUI is up (for example, the port is in use), print the error normally and exit 1.
- **Narrow terminals.** Below 60×10, the lobby shows a single "창을 키워 주세요" line.
- **Windows.** Raw stdin and VT output are on by default in Windows Terminal and conhost on Windows 10 and later. Ctrl+] arrives as `0x1d` and must be verified in the Windows smoke test.

## Testing

- **Unit (pure):**
  - `renderLobby` cases: grouping, selection, empty office, narrow terminal, Korean width.
  - Key decoding: arrows, Enter, Ctrl+], UTF-8.
  - Prompt editing: backspace with multibyte characters.
  - App state transitions, using a fake backend and a fake PTY host.
- **Integration:**
  - `PtyHost.onData`, `resize` and `serialize` with the `process.execPath` echo program.
  - An attach session driven through fake stdin/stdout streams. Assert that it writes the serialized repaint, forwards keys, and returns on `0x1d`.
- **E2E (manual or scripted):** run `office-desks` in a real terminal (or a PTY driven by a test harness, using node-pty itself) with a scratch `OFFICE_DESKS_HOME`:
  1. add a project;
  2. create work;
  3. attach;
  4. answer the trust dialog;
  5. see the reply;
  6. press Ctrl+] to return to the lobby;
  7. quit and confirm.
  The web office stays in sync throughout.

## Out of scope (v2+)

- A sidebar with a composited live pane, split panes and tabs.
- Mouse support.
- Copy mode / scrollback browsing. For now, use your terminal's own scrollback in the lobby, or the web chat.
- Configurable keys.
- TUI on top of Orca.
- Detaching while keeping agents alive (a daemon).
- Session resume (M4).
