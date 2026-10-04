# TUI v3: split presets, mouse, drag-to-copy

This builds on TUI v2 (`docs/superpowers/specs/2026-10-04-tui-v2-design.md`, PR #4).

## Why

In v2 you can see one agent's screen beside the list. The user's next ask is to see several agents at once, click instead of only using keys, and copy text out of an agent's screen.

## Decisions (agreed with the user)

| Topic | Decision |
|---|---|
| Splits | **Layout presets**, not free tmux-style splits. In list focus, keys `1`–`4` choose a layout: `1` is one pane, `2` is left \| right, `3` is top / bottom, `4` is a 2×2 grid. Each pane shows one agent. One pane is the **focused pane**, drawn with a bright border and head. |
| Assigning agents | Moving the selection in the list shows that agent in the **focused pane** (live preview, as in v2). The other panes keep their agents. If the chosen agent is already in another pane, the two panes **swap**, because an agent has only one size and can't appear twice. `Tab` and `Shift+Tab` move the focused pane while the list has focus. |
| Typing | `Enter` types into the focused pane's agent. `Ctrl+]` returns to the list, as in v2. Zoom (`z`) works on the focused pane's agent. |
| Agent sizes | Each agent shown in a pane is resized to that pane's inner size. Agents not shown keep their last size, so nothing reflows needlessly. The web terminal view shows whatever size the agent has. |
| Mouse | Mouse reporting is turned on in the real terminal (SGR mode `?1000h ?1002h ?1006h`) and off on every exit path (it is already in `RESET_MODES`). See the next table for what each action does. |
| Copy | Text is copied to the system clipboard with a **local command**. Office Desks runs on the user's machine, so this works in every terminal, including Terminal.app, which lacks OSC 52. macOS uses `pbcopy`. Windows uses `clip.exe`, fed UTF-16LE with a BOM so Korean text survives. Linux uses `wl-copy`, else `xclip -selection clipboard`, else OSC 52. A notice confirms: `복사했어요 (N자)`. |
| Native terminal selection | The terminal's own selection still works with **Shift+drag** (Option+drag in macOS Terminal and iTerm2). The help line says so. |

Mouse actions:

| Action | Effect |
|---|---|
| Click a list row | Selects that row, with list focus. |
| Click inside a pane | Focuses that pane and gives it typing focus. |
| Wheel over the list | Moves the selection. |
| Wheel over a pane | Scrolls that pane's history by 3 lines per notch. |
| Drag inside a pane | Selects text in that pane, measured in that agent's buffer (scrollback included) and shown in reverse video. Releasing the button copies the selection. The selection never crosses into another pane. |
| Any key or click | Clears the selection. |

## Architecture changes (bridge/src/tui/)

- **`layout.ts`.** `layout(cols, rows, preset)` returns `panes: Rect[]` (1, 2 or 4 inner rects, each with a head row) instead of a single panel rect. The sidebar is unchanged. Below a minimum pane size (40×6), a preset falls back to fewer panes: 4 → 2 → 1.
- **`compose.ts`.**
  - It draws N panes, each with its own head (`repo/desk · type`, plus the scroll badge) and border lines between panes.
  - The focused pane is bright.
  - It draws a selection overlay in reverse video.
  - The cursor goes to the focused pane's agent only while it has typing focus.
- **`mouse.ts`** (new, pure).
  - It parses SGR mouse sequences (`ESC[<b;x;yM` and `…m`) into `{ kind: press | release | drag | wheelUp | wheelDown, x, y, button, mods }`.
  - It hit-tests a point against the layout: list row, pane index and pane-relative cell, or nothing.
- **`keys.ts`.** It decodes mouse sequences as `{ name: 'mouse', event }`, so they never reach the agent in panel focus. Forwarding mouse events to agents that enable their own mouse mode is out of scope for v3.
- **`selection.ts`** (new, pure).
  - The selection model holds the pane, the anchor and the head, in buffer coordinates (absolute line plus column).
  - `selectionText(term, sel)` extracts text line by line with `translateToString(true, …)`. It joins wrapped lines without a newline (using `isWrapped`) and trims trailing spaces. Wide characters are kept whole.
- **`clipboard.ts`** (new). `copyText(text, platform, run)` picks the command per platform and falls back to OSC 52. The process runner is injectable for tests. It never uses a shell; arguments go in an argv array.
- **`app.ts` and the related pieces.**
  - The state adds `preset`, `panes: (agentId | null)[]`, `focusedPane`, the selection, and per-pane scroll.
  - On selection change, the selected agent moves into the focused pane, swapping if it is shown elsewhere.
  - Each shown agent gets its own `onData` subscription, and any of them triggers a render.
  - `resizeAgents` becomes per pane: `resizeAgent(ptyId, cols, rows)` for each shown agent.
- **`main.ts`.** The deps provide `resizeAgent(id, cols, rows)`. `MOUSE_ON` is written at start, and `RESET_MODES` already turns it off.

## Error handling

- A failed copy, such as a missing `pbcopy` or a nonzero exit, shows `⚠ 복사하지 못했어요`, then tries OSC 52.
- A layout too big for the terminal falls back to fewer panes and shows a notice once.
- An exited agent in a pane shows `종료됨` in that pane.

## Testing

- **Pure:**
  - Mouse parsing: press, drag, release, wheel and modifiers, including split chunks via the existing escape buffering.
  - Hit-testing for every preset at several sizes.
  - Pane layout math and fallback.
  - Selection text with Korean text, wrapped lines, a drag across the scrollback boundary, and a reversed drag (head before anchor).
  - `copyText` command choice per platform, the UTF-16LE BOM for `clip.exe`, and the fallback order.
- **Compose:** 2- and 4-pane frames match each agent's screen cell for cell in its rect, the focused pane is bright, the selection overlay is reversed, and widths are exact.
- **App:**
  - Presets switch, and agents are resized per pane.
  - Tab moves the focused pane.
  - Selecting a row shows it in the focused pane, and swaps when it is shown elsewhere.
  - A click focuses or selects, the wheel scrolls, and drag then release calls `copyText` with the expected text.
  - A key clears the selection.
  - Mouse sequences never reach `host.write`.
- **E2E (macOS, harness):**
  1. Use layout 2 with two Claude agents side by side and type into each.
  2. Switch to layout 4.
  3. Click and wheel.
  4. Drag-copy `OK` from a pane.

  The copy target is redirected so the user's real clipboard is never touched. `OFFICE_DESKS_COPY_FILE=<path>` makes `copyText` write to that file instead of the clipboard; it is a test-only hook, documented as such. The harness then checks that file.

## Out of scope (v4+)

- Free splits and resizing pane borders.
- Forwarding the mouse to agents that request it.
- A keyboard copy mode.
- Persisting layouts.
- Tabs and workspaces.
