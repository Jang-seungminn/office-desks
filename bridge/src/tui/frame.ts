import { BLANK, sameStyle, sgr, type Cell, type Style } from './cells.js';
import { charWidth, clean } from './text.js';

// The TUI screen as a grid of cells. Each render builds a new Frame; diff() writes only the
// cells that changed since the last one (a full paint after a resize or on the first frame).

export interface Rect {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

export class Frame {
  private readonly cells: Cell[];

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.cells = Array.from({ length: cols * rows }, () => BLANK);
  }

  get(row: number, col: number): Cell {
    return this.cells[row * this.cols + col] ?? BLANK;
  }

  set(row: number, col: number, cell: Cell): void {
    if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return;
    this.cells[row * this.cols + col] = cell;
  }
}

export function fillRect(f: Frame, r: Rect, cell: Cell = BLANK): void {
  for (let y = r.row; y < r.row + r.rows; y++) for (let x = r.col; x < r.col + r.cols; x++) f.set(y, x, cell);
}

/** `text` in exactly `width` columns from (row, col): padded, or cut with '…'; never half a wide char. */
export function putText(f: Frame, row: number, col: number, text: string, st: Style, width: number): void {
  const chars: [string, number][] = [];
  for (const ch of clean(text)) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f && chars.length) {
      chars[chars.length - 1] = [chars[chars.length - 1][0] + ch, 2];
      continue;
    }
    const w = charWidth(cp);
    if (w > 0) chars.push([ch, w]);
  }
  const total = chars.reduce((s, [, w]) => s + w, 0);
  const limit = total <= width ? width : width - 1;
  let x = 0;
  for (const [ch, w] of chars) {
    if (x + w > limit) break;
    f.set(row, col + x, { ch, width: w as 1 | 2, style: st });
    if (w === 2) f.set(row, col + x + 1, { ch: '', width: 0, style: st });
    x += w;
  }
  if (total > width && x < width) f.set(row, col + x++, { ch: '…', width: 1, style: st });
  while (x < width) f.set(row, col + x++, { ch: ' ', width: 1, style: st });
}

const same = (a: Cell, b: Cell) => a.ch === b.ch && a.width === b.width && sameStyle(a.style, b.style);

export function diff(prev: Frame | null, next: Frame): string {
  const full = !prev || prev.cols !== next.cols || prev.rows !== next.rows;
  let out = full ? '\x1b[0m\x1b[2J' : '';
  let current: Style | null = null;
  for (let y = 0; y < next.rows; y++) {
    let x = 0;
    while (x < next.cols) {
      if (!full && same(prev!.get(y, x), next.get(y, x))) {
        x++;
        continue;
      }
      // Start a run at the head of a wide char whose trailing half changed.
      let start = x;
      if (next.get(y, start).width === 0 && start > 0) start--;
      out += `\x1b[${y + 1};${start + 1}H`;
      let c = start;
      while (c < next.cols && (full || !same(prev!.get(y, c), next.get(y, c)) || next.get(y, c).width === 0)) {
        const cell = next.get(y, c);
        if (cell.width !== 0) {
          if (!current || !sameStyle(current, cell.style)) {
            out += sgr(cell.style);
            current = cell.style;
          }
          out += cell.ch;
        }
        c++;
      }
      x = Math.max(c, x + 1);
    }
  }
  return out ? out + '\x1b[0m' : '';
}
