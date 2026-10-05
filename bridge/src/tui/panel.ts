import { BLANK, cellFromXterm, type XtermCellLike } from './cells.js';
import type { Frame, Rect } from './frame.js';

// The selected agent's screen, copied cell by cell from its headless xterm into the panel.

export interface HeadlessLike {
  cols: number;
  rows: number;
  buffer: {
    active: {
      viewportY: number;
      baseY: number;
      cursorX: number;
      cursorY: number;
      getLine(y: number): { getCell(x: number, cell?: never): XtermCellLike | undefined } | undefined;
      getNullCell(): unknown;
    };
  };
}

export function maxScroll(t: HeadlessLike): number {
  return t.buffer.active.baseY;
}

export function drawPanel(f: Frame, r: Rect, t: HeadlessLike, scroll: number): { row: number; col: number } | null {
  const buf = t.buffer.active;
  const top = Math.max(0, buf.baseY - Math.min(scroll, buf.baseY));
  const reuse = buf.getNullCell() as never;
  for (let y = 0; y < r.rows; y++) {
    const line = y < t.rows ? buf.getLine(top + y) : undefined;
    for (let x = 0; x < r.cols; x++) {
      const c = line && x < t.cols ? line.getCell(x, reuse) : undefined;
      f.set(r.row + y, r.col + x, c ? cellFromXterm(c) : BLANK);
    }
    // A wide char cut by the right edge would leave half a glyph: blank it.
    const lastCol = r.col + r.cols - 1;
    if (f.get(r.row + y, lastCol).width === 2) f.set(r.row + y, lastCol, BLANK);
  }
  if (scroll > 0) return null;
  const { cursorX, cursorY } = buf;
  return cursorY < r.rows && cursorX < r.cols ? { row: r.row + cursorY, col: r.col + cursorX } : null;
}
