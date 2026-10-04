# TUI v2: sidebar + live panel

This builds on M3 (`docs/superpowers/specs/2026-10-04-m3-tui-design.md`, PR #3).

## Why

The user tried M3 and named three gaps:
- You can't see the agent list and an agent's screen at the same time. Lobby and attach are separate screens.
- The look and the controls feel rough.
- Features are missing.

v2 turns the TUI into a real multiplexer in the Orca sense: one screen with a sidebar and a live agent panel.

## Decisions

| Topic | Decision |
|---|---|
| Layout | Left **sidebar**: projects → worktrees → agents, each with state. Right **panel**: the selected agent's live screen. A title bar sits on top and a context help bar at the bottom. Split panes are deferred to v3. |
| Focus | Two focus targets, **list** and **panel**. Ctrl+] toggles between them. In list focus, moving the selection switches the panel to that agent live. `Enter` or `→` moves focus into the panel, and from then on keys go to the agent. |
| Rendering | Our own **cell compositor**. Each frame reads the selected agent's headless xterm buffer cell by cell (character, width, fg/bg in 16-color, 256-color or RGB, bold, italic, dim, underline, inverse) and draws it inside the panel border. Only changed cells are written. Frames are capped at about 30 fps. |
| Agent size | Every agent PTY is sized to the panel's inner size. It is resized again when the terminal is resized, so switching agents never needs a resize. The web terminal view sees the same size. |
| Cursor | With panel focus, the real cursor sits at the agent's cursor position (offset into the panel) and is visible, so Korean IME composition appears in place. With list focus, the cursor is hidden. |
| Zoom | `z` shows the selected agent full screen, using the M3 `AttachSession` passthrough. Ctrl+] returns. This is useful when a TUI needs every column, or for copying text with the mouse. |
| Scrollback | With list focus, `PgUp`/`PgDn` scroll the panel back through the agent's history, read from the headless buffer. A "↑ 기록 보는 중" badge shows while scrolled. Any other key, or new focus, snaps back to live. |
| New actions | `x` stops the selected agent after a confirm, killing its PTY. `d` removes the selected worktree after a confirm. It is allowed only when the worktree has no running agents and isn't the main checkout. It runs `git worktree remove`; a dirty worktree is refused with a clear message, and branches are kept. |
| Look | The title bar is reversed and shows the URL and counts (✎ working, ! waiting). Repo headings are bold. State glyphs are colored. The selected row is highlighted. The focused pane's border is bright and the other is dim. Waiting agents are tinted. Every pane line has exact width (Korean is 2 columns). |
| Existing keys | Unchanged: `a` add agent, `n` new work, `p` add project, `q` quit (with confirm). Forms appear in the help bar, with the cursor in place. |

## Verified (2026-10-04)

The `@xterm/headless` 6 cell API reads everything we need:
- `getChars`;
- `getWidth`, which is 2 for Hangul followed by a 0-width placeholder;
- the fg/bg color modes (palette or RGB) and their values;
- `isBold` and `isUnderline`, among others;
- `buffer.active.cursorX/Y`.

Reading is fast: about 40,000 cells per ms, so a 120×40 frame takes about 0.1 ms.

## Architecture

The existing `bridge/src/tui/` modules are kept. The following are new or changed:

- **`cells.ts`** (pure). This is the style model:
  - `Style`: fg/bg as default, palette index or RGB, plus bold/italic/dim/underline/inverse.
  - `Cell`: `{ ch, width, style }`.
  - `cellFromXterm(cell)`.
  - `sgr(from, to)`, which returns the minimal SGR string to switch styles.
- **`frame.ts`** (pure). A `Frame` is a cols×rows grid of `Cell`.
  - `putText(frame, row, col, text, style, width)` is width-aware and clips.
  - `diff(prev, next) → string` returns cursor moves and SGR runs for the changed cells only.
  - `fullPaint(frame)` paints everything.
- **`layout.ts`** (pure). `layout(cols, rows)` returns rectangles for the title, sidebar, panel inner area and help bar. The sidebar is 28 columns wide, clamped between 20 and a third of the terminal width. The narrow-terminal threshold is kept.
- **`sidebar.ts`** (pure). This replaces `lobby.ts` rendering inside the sidebar rect: groups, selection, scroll and glyphs. `lobbyRows` is reused.
- **`panel.ts`**:
  - `drawPanel(frame, rect, term, scroll)` copies cells from a headless xterm's active buffer at `viewportY − scroll` into the rect.
  - It returns the agent's cursor position for the real cursor.
- **`renderer.ts`**. Owns the last frame and draws on change (snapshot, PTY data for the visible agent, focus, resize).
  - Throttled to about 33 ms.
  - Writes `diff()` plus the cursor placement.
  - After a resize or a return from zoom it does a full repaint.
- **`app.ts`** (reworked). Modes are `list | panel | form | confirm | zoom`.
  - Panel focus forwards raw input to the agent except Ctrl+]. It reuses `isAttachEscape` and the escape-buffering logic.
  - The renderer subscribes to `onData` of the currently shown agent only.
- **PtyHost**: `buffer(id)` exposes the headless terminal (read-only) for the panel. It also exposes `scrollbackLength(id)`.
- **NativeBackend**:
  - `stopAgent(agentId)` kills the PTY and cleans its settings file.
  - `removeWorktree(deskId)` refuses the main checkout and worktrees with live agents, then runs `git worktree remove <path>` (no `--force`). Git's message is mapped to Korean: "변경사항이 있는 워크트리는 지울 수 없어요".
  - Both are exposed as backend methods, and capabilities gain `stop` and `remove`. The web may use them later; that is out of scope here.

## Interaction details

- **Default focus.** The app starts with list focus and the first agent selected, so the panel shows it at once.
- **Panel focus:**
  - All keys go to the agent, including Ctrl+C, arrows and paste.
  - Ctrl+] returns to list focus.
  - The help bar reads `패널 입력 중 · Ctrl+] 목록으로 · z 크게`. The `z` there means "Ctrl+] then z": zoom is a list-focus key, so v2 needs no chords.
- **Selecting a row without an agent.** The panel shows a centered hint: "에이전트가 없어요 — a로 띄우기".
- **When the shown agent exits:**
  - The panel shows "종료됨".
  - If the panel had focus, focus returns to the list.
- **Resize.** Recompute the layout, resize every agent PTY to the new panel size, then do a full repaint.
- **Terminal modes the agent enables** (bracketed paste, application cursor keys, kitty keyboard) are *not* passed to the real terminal in panel mode, because we draw cells instead of passing bytes through. Instead we encode keys ourselves:
  - Bracketed paste: when the agent has bracketed-paste mode on (read from the headless terminal's modes), wrap pasted text in `ESC[200~ … ESC[201~`. A paste is detected as a multi-character chunk that contains a newline.
  - Application cursor keys: when the agent has DECCKM on, send arrows as `ESCO*`.
  - Everything else passes through as raw bytes.
  - Zoom mode keeps full passthrough for anything this misses.

## Error handling

Errors are the same as in v1: action errors become `⚠️` notices, and crashes restore the terminal. Removing a worktree or stopping an agent always asks first ("정말 … ? (y/N)").

## Testing

- **Pure:**
  - SGR minimal transitions.
  - `putText` widths and clipping, Korean included.
  - The frame diff produces only changed runs, and a full repaint round-trips through a headless terminal.
  - The layout math at several sizes.
  - The sidebar render.
- **Panel:**
  - Draw a headless agent terminal containing colors, Korean text and a cursor into a frame.
  - Paint the frame into a second headless terminal acting as the real screen.
  - Assert that the panel rect matches the agent's screen cell for cell (chars, and colors where comparable), and that the cursor lands at the offset position.
  - The same with scrollback offset.
- **App:**
  - Focus toggling and key routing.
  - Live preview switching on selection.
  - Zoom in and out.
  - `x` and `d` confirms and their backend calls.
  - Bracketed paste and DECCKM encoding in panel focus.
- **Backend:** `stopAgent` and `removeWorktree` against a scratch git repo, covering the main checkout, live agents and dirty worktrees.
- **E2E:** extend the M3 node-pty harness, using a scratch repo and a port other than 4317:
  1. The sidebar and panel show together.
  2. Selecting a row switches the panel live.
  3. Typing into a focused Claude works.
  4. Ctrl+] returns focus to the list.
  5. `z` zoom works, and Ctrl+] returns from it.
  6. `x` stops an agent.
  7. `d` removes a worktree.
  8. `q` then `y` quits.

## Out of scope (v3+)

- Split panes and tabs.
- Mouse support (click to select, wheel scroll).
- Copy mode with selection.
- A theme config.
- Web buttons for stop and remove.
- Detaching to a daemon and resuming sessions.
- Usage display and search on native (M4).
