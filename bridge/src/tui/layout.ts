import type { Rect } from './frame.js';

// Where everything goes: title on top, help at the bottom, a sidebar and the agent panel between.

export interface Layout {
  title: Rect;
  listHead: Rect;
  list: Rect;
  sep: Rect;
  panes: Pane[]; // 1, 2 or 4 panes in reading order (left to right, top to bottom)
  dividers: Rect[]; // 1-column or 1-row gaps between panes
  preset: Preset; // the preset actually used, after fallback
  help: Rect;
}

export type Preset = 1 | 2 | 3 | 4; // 1 pane, left|right, top/bottom, 2x2

export interface Pane {
  head: Rect;
  body: Rect;
}

export const MIN_PANE_COLS = 40;
export const MIN_PANE_ROWS = 6; // body rows

const MIN_COLS = 60;
const MIN_ROWS = 10;

function build(area: Rect, preset: Preset): { panes: Pane[]; dividers: Rect[] } {
  const lw = Math.floor((area.cols - 1) / 2);
  const th = Math.floor((area.rows - 1) / 2);
  const cell = (row: number, col: number, rows: number, cols: number): Pane => ({
    head: { row, col, rows: 1, cols },
    body: { row: row + 1, col, rows: rows - 1, cols },
  });
  const vDiv: Rect = { row: area.row, col: area.col + lw, rows: area.rows, cols: 1 };
  const hDiv: Rect = { row: area.row + th, col: area.col, rows: 1, cols: area.cols };
  const rc = area.col + lw + 1;
  const rw = area.cols - lw - 1;
  const br = area.row + th + 1;
  const bh = area.rows - th - 1;
  if (preset === 2) return { panes: [cell(area.row, area.col, area.rows, lw), cell(area.row, rc, area.rows, rw)], dividers: [vDiv] };
  if (preset === 3) return { panes: [cell(area.row, area.col, th, area.cols), cell(br, area.col, bh, area.cols)], dividers: [hDiv] };
  if (preset === 4) {
    return {
      panes: [cell(area.row, area.col, th, lw), cell(area.row, rc, th, rw), cell(br, area.col, bh, lw), cell(br, rc, bh, rw)],
      dividers: [vDiv, hDiv],
    };
  }
  return { panes: [cell(area.row, area.col, area.rows, area.cols)], dividers: [] };
}

const fits = (panes: Pane[]) => panes.every((p) => p.body.cols >= MIN_PANE_COLS && p.body.rows >= MIN_PANE_ROWS);
const FALLBACKS: Record<Preset, Preset[]> = { 1: [1], 2: [2, 1], 3: [3, 1], 4: [4, 2, 3, 1] };

export function layout(cols: number, rows: number, preset: Preset = 1): Layout | null {
  if (cols < MIN_COLS || rows < MIN_ROWS) return null;
  const sbw = Math.max(20, Math.min(28, Math.floor(cols / 3)));
  const area: Rect = { row: 1, col: sbw + 1, rows: rows - 2, cols: cols - sbw - 1 };
  let used: Preset = 1;
  let built = build(area, 1);
  for (const p of FALLBACKS[preset]) {
    const b = build(area, p);
    if (p === 1 || fits(b.panes)) {
      used = p;
      built = b;
      break;
    }
  }
  return {
    title: { row: 0, col: 0, rows: 1, cols },
    listHead: { row: 1, col: 0, rows: 1, cols: sbw },
    list: { row: 2, col: 0, rows: rows - 3, cols: sbw },
    sep: { row: 1, col: sbw, rows: rows - 2, cols: 1 },
    ...built,
    preset: used,
    help: { row: rows - 1, col: 0, rows: 1, cols },
  };
}
