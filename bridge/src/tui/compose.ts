import { style, type Color, type Style } from './cells.js';
import { Frame, fillRect, putText, type Rect } from './frame.js';
import { layout } from './layout.js';
import type { LobbyRow } from './lobby.js';
import { drawPanel, type HeadlessLike } from './panel.js';
import { drawSidebar } from './sidebar.js';
import { displayWidth } from './text.js';

// The whole screen as one Frame: title, list head, sidebar, separator, panel head, panel and help.

export type Focus = 'list' | 'panel';
export interface View {
  rows: LobbyRow[];
  selected: number;
  focus: Focus;
  url: string;
  /** The selected agent's terminal, if alive. */
  agent: HeadlessLike | null;
  /** Panel scroll-back (0 = live). */
  scroll: number;
  /** Help/notice/form line for the bottom row. */
  help: string;
  /** Column for the real cursor in the help row (forms), else null. */
  helpCursor: number | null;
}

const BRIGHT: Color = { mode: 'palette', index: 6 };
const DIM = style({ dim: true });

function centered(f: Frame, r: Rect, text: string, st: Style): void {
  const w = Math.min(displayWidth(text), r.cols);
  const col = r.col + Math.floor((r.cols - w) / 2);
  putText(f, r.row + Math.floor((r.rows - 1) / 2), col, text, st, w);
}

export function compose(v: View, cols: number, rows: number): { frame: Frame; cursor: { row: number; col: number } | null } {
  const frame = new Frame(cols, rows);
  const L = layout(cols, rows);
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

  const sel = v.rows[v.selected];
  let headText = '(에이전트 없음)';
  if (sel?.agentId) {
    headText = `${sel.repo}/${sel.desk} · ${sel.agentType ?? '?'}`;
    if (v.scroll > 0) headText += ' · ↑ 기록 보는 중';
  }
  putText(frame, L.panelHead.row, L.panelHead.col, ` ${headText}`, head(!listFocus), L.panelHead.cols);

  let cursor: { row: number; col: number } | null = null;
  if (sel?.agentId && v.agent) {
    const c = drawPanel(frame, L.panel, v.agent, v.scroll);
    if (!listFocus && v.scroll === 0) cursor = c;
  } else {
    fillRect(frame, L.panel);
    centered(frame, L.panel, sel?.agentId ? '종료됨' : '에이전트가 없어요 — a로 띄우기', DIM);
  }

  putText(frame, L.help.row, L.help.col, v.help, style({}), L.help.cols);
  if (!cursor && v.helpCursor !== null) cursor = { row: rows - 1, col: Math.min(v.helpCursor, cols - 1) };
  return { frame, cursor };
}
