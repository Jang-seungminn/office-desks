import { style, type Color, type Style } from './cells.js';
import { Frame, fillRect, putText, type Rect } from './frame.js';
import { layout, type Preset } from './layout.js';
import type { LobbyRow } from './lobby.js';
import { drawPanel, type HeadlessLike } from './panel.js';
import { isSelected, topLine, type Selection } from './selection.js';
import { drawSidebar } from './sidebar.js';
import { displayWidth } from './text.js';

// The whole screen as one Frame: title, list head, sidebar, separator, panel head, panel and help.

export type Focus = 'list' | 'panel';
export interface PaneView {
  /** What the pane shows (null = empty pane). */
  row: LobbyRow | null;
  /** Its terminal, if alive. */
  agent: HeadlessLike | null;
  /** The agent hid its cursor: the real one still goes to its position (IME), hidden. */
  cursorHidden: boolean;
  /** Scroll-back (0 = live). */
  scroll: number;
  /** The selection owned by this pane, if any. */
  selection: Selection | null;
}

export interface View {
  rows: LobbyRow[];
  selected: number;
  focus: Focus;
  url: string;
  preset: Preset;
  focusedPane: number;
  panes: PaneView[];
  /** Help/notice/form line for the bottom row. */
  help: string;
  /** Column for the real cursor in the help row (forms), else null. */
  helpCursor: number | null;
}

const BRIGHT: Color = { mode: 'palette', index: 6 };
const DIM = style({ dim: true });

/** Toggle inverse on the body cells the selection covers (buffer coordinates, so scroll-proof). */
function overlay(f: Frame, body: Rect, t: HeadlessLike, scroll: number, sel: Selection): void {
  const top = topLine(t, scroll);
  for (let y = 0; y < body.rows; y++) {
    for (let x = 0; x < body.cols; x++) {
      if (!isSelected(sel, top + y, x)) continue;
      const c = f.get(body.row + y, body.col + x);
      f.set(body.row + y, body.col + x, { ...c, style: { ...c.style, inverse: !c.style.inverse } });
    }
  }
}

function centered(f: Frame, r: Rect, text: string, st: Style): void {
  const w = Math.min(displayWidth(text), r.cols);
  const col = r.col + Math.floor((r.cols - w) / 2);
  putText(f, r.row + Math.floor((r.rows - 1) / 2), col, text, st, w);
}

export interface Cursor {
  row: number;
  col: number;
  hidden?: boolean;
}

export function compose(v: View, cols: number, rows: number): { frame: Frame; cursor: Cursor | null } {
  const frame = new Frame(cols, rows);
  const L = layout(cols, rows, v.preset);
  if (!L) {
    centered(frame, { row: 0, col: 0, rows, cols }, ' 창을 키워 주세요', DIM);
    return { frame, cursor: null };
  }
  const listFocus = v.focus === 'list';
  const head = (on: boolean): Style => (on ? style({ bold: true, fg: BRIGHT }) : DIM);

  const busy = v.rows.filter((r) => r.state === 'typing' || r.state === 'reading' || r.state === 'running').length;
  const waiting = v.rows.filter((r) => r.state === 'waiting').length;
  const counts = `✎ ${busy}  ! ${waiting} `;
  const cw = Math.min(displayWidth(counts), L.title.cols);
  const title = style({ inverse: true });
  putText(frame, 0, 0, ` Office Desks · native · 웹 ${v.url}`, title, cols - cw);
  putText(frame, 0, cols - cw, counts, title, cw);

  putText(frame, L.listHead.row, L.listHead.col, ' 목록', head(listFocus), L.listHead.cols);
  drawSidebar(frame, L.list, v.rows, v.selected, listFocus);

  for (let y = L.sep.row; y < L.sep.row + L.sep.rows; y++) putText(frame, y, L.sep.col, '│', listFocus ? DIM : style({ fg: BRIGHT }), 1);

  const typing = !listFocus;
  let cursor: Cursor | null = null;
  const n = Math.min(L.panes.length, v.panes.length);
  for (let i = 0; i < n; i++) {
    const pane = L.panes[i];
    const pv = v.panes[i];
    const focused = i === v.focusedPane;
    let headText = '(비어 있음)';
    if (pv.row) {
      headText = '(에이전트 없음)';
      if (pv.row.agentId) {
        headText = `${pv.row.repo}/${pv.row.desk} · ${pv.row.agentType ?? '?'}`;
        if (pv.scroll > 0) headText += ' · ↑ 기록 보는 중';
      }
    }
    putText(frame, pane.head.row, pane.head.col, ` ${headText}`, head(focused), pane.head.cols);

    if (pv.row?.agentId && pv.agent) {
      const c = drawPanel(frame, pane.body, pv.agent, pv.scroll);
      if (pv.selection) overlay(frame, pane.body, pv.agent, pv.scroll, pv.selection);
      if (focused && typing && pv.scroll === 0 && c) cursor = pv.cursorHidden ? { ...c, hidden: true } : c;
    } else {
      fillRect(frame, pane.body);
      const hint = !v.rows.length ? 'p로 프로젝트를 추가하세요' : pv.row?.agentId ? '종료됨' : '에이전트가 없어요 — a로 띄우기';
      centered(frame, pane.body, hint, DIM);
    }
  }

  for (const d of L.dividers) {
    for (let y = d.row; y < d.row + d.rows; y++) {
      for (let x = d.col; x < d.col + d.cols; x++) {
        const glyph = d.cols === 1 ? '│' : '─';
        const prev = frame.get(y, x).ch;
        const cross = (prev === '│' && glyph === '─') || (prev === '─' && glyph === '│') || prev === '┼';
        frame.set(y, x, { ch: cross ? '┼' : glyph, width: 1, style: DIM });
      }
    }
  }

  putText(frame, L.help.row, L.help.col, v.help, style({}), L.help.cols);
  if (!cursor && v.helpCursor !== null) cursor = { row: rows - 1, col: Math.min(v.helpCursor, cols - 1) };
  return { frame, cursor };
}
