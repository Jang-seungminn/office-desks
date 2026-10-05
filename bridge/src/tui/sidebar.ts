import { style, type Color } from './cells.js';
import { fillRect, putText, type Frame, type Rect } from './frame.js';
import type { LobbyRow } from './lobby.js';

// The agent list: repo headings, then one row per agent (or empty worktree) with its state glyph.

const GLYPH: Record<string, [string, number]> = {
  typing: ['✎', 3],
  reading: ['◎', 6],
  running: ['▶', 5],
  waiting: ['!', 1],
  done: ['✓', 2],
  away: ['·', 8],
};
const palette = (index: number): Color => ({ mode: 'palette', index });

export function drawSidebar(f: Frame, r: Rect, rows: LobbyRow[], selected: number, focused: boolean): void {
  fillRect(f, r);
  if (!rows.length) {
    putText(f, r.row, r.col, ' p로 프로젝트를 추가하세요', style({ dim: true }), r.cols);
    return;
  }
  const lines: { row: number | null; repo?: string }[] = [];
  let last: string | null = null;
  rows.forEach((row, i) => {
    if (row.repo !== last) lines.push({ row: null, repo: (last = row.repo) });
    lines.push({ row: i });
  });
  const at = Math.max(0, lines.findIndex((l) => l.row === selected));
  const start = Math.min(Math.max(0, at - r.rows + 1), Math.max(0, lines.length - r.rows));
  lines.slice(start, start + r.rows).forEach((l, y) => {
    const ry = r.row + y;
    if (l.row === null) {
      putText(f, ry, r.col, ` ${l.repo}`, style({ bold: true }), r.cols);
      return;
    }
    const row = rows[l.row];
    const sel = l.row === selected;
    const base = sel ? style({ inverse: focused, bg: focused ? { mode: 'default' } : palette(8) }) : style({});
    const [g, color] = row.state ? (GLYPH[row.state] ?? ['?', 7]) : [' ', 7];
    putText(f, ry, r.col, `${sel ? ' ▸ ' : '   '}${row.desk}`, base, r.cols - 2);
    putText(f, ry, r.col + r.cols - 2, g, { ...base, fg: palette(color), bold: row.state === 'waiting' }, 1);
    putText(f, ry, r.col + r.cols - 1, ' ', base, 1);
  });
}
