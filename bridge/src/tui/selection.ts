// A stream selection inside one pane, in the agent's buffer coordinates (so scrolling doesn't
// move it), and the text it covers: wrapped lines rejoined, line ends trimmed.

export interface Point {
  line: number;
  col: number;
}

export interface Selection {
  pane: number;
  anchor: Point;
  head: Point;
}

const before = (a: Point, b: Point) => a.line < b.line || (a.line === b.line && a.col <= b.col);

export function ordered(s: Selection): [Point, Point] {
  return before(s.anchor, s.head) ? [s.anchor, s.head] : [s.head, s.anchor];
}

export function isSelected(s: Selection, line: number, col: number): boolean {
  const [a, b] = ordered(s);
  if (line < a.line || line > b.line) return false;
  if (line === a.line && col < a.col) return false;
  if (line === b.line && col > b.col) return false;
  return true;
}

/** First buffer line shown in a pane scrolled back by `scroll` lines. */
export function topLine(t: { buffer: { active: { baseY: number } } }, scroll: number): number {
  const base = t.buffer.active.baseY;
  return Math.max(0, base - Math.min(scroll, base));
}

export interface TextBufferLike {
  cols: number;
  buffer: {
    active: {
      getLine(y: number):
        | {
            isWrapped: boolean;
            translateToString(trim?: boolean, start?: number, end?: number): string;
            getCell(x: number): { getWidth(): number; getChars(): string } | undefined;
          }
        | undefined;
    };
  };
}

export function selectionText(t: TextBufferLike, s: Selection): string {
  const [a, b] = ordered(s);
  const out: string[] = [];
  for (let y = a.line; y <= b.line; y++) {
    const line = t.buffer.active.getLine(y);
    if (!line) continue;
    let start = y === a.line ? a.col : 0;
    // A start on a wide char's continuation cell snaps back to the char itself.
    if (start > 0 && line.getCell(start)?.getWidth() === 0) start--;
    const end = y === b.line ? b.col + 1 : t.cols;
    // Untrimmed, so a wrapped line's trailing cells survive the join; trimmed once at the end.
    const piece = line.translateToString(false, start, end);
    if (y > a.line && line.isWrapped && out.length) {
      // A wide char that didn't fit leaves a blank filler cell at the end of the previous row.
      const prev = t.buffer.active.getLine(y - 1);
      const filler = line.getCell(0)?.getWidth() === 2 && prev?.getCell(t.cols - 1)?.getChars() === '';
      out[out.length - 1] = (filler ? out[out.length - 1].slice(0, -1) : out[out.length - 1]) + piece;
    } else out.push(piece);
  }
  return out.map((l) => l.replace(/\s+$/, '')).join('\n');
}
