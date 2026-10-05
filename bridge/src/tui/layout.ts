import type { Rect } from './frame.js';

// Where everything goes: title on top, help at the bottom, a sidebar and the agent panel between.

export interface Layout {
  title: Rect;
  listHead: Rect;
  list: Rect;
  sep: Rect;
  panelHead: Rect;
  panel: Rect;
  help: Rect;
}

const MIN_COLS = 60;
const MIN_ROWS = 10;

export function layout(cols: number, rows: number): Layout | null {
  if (cols < MIN_COLS || rows < MIN_ROWS) return null;
  const sbw = Math.max(20, Math.min(28, Math.floor(cols / 3)));
  const body = rows - 3;
  const pc = cols - sbw - 1;
  return {
    title: { row: 0, col: 0, rows: 1, cols },
    listHead: { row: 1, col: 0, rows: 1, cols: sbw },
    list: { row: 2, col: 0, rows: body, cols: sbw },
    sep: { row: 1, col: sbw, rows: rows - 2, cols: 1 },
    panelHead: { row: 1, col: sbw + 1, rows: 1, cols: pc },
    panel: { row: 2, col: sbw + 1, rows: body, cols: pc },
    help: { row: rows - 1, col: 0, rows: 1, cols },
  };
}
