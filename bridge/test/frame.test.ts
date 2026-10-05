import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { cellFromXterm, style, type Cell } from '../src/tui/cells.js';
import { diff, fillRect, Frame, putText } from '../src/tui/frame.js';

async function paint(t: Terminal, s: string) {
  await new Promise<void>((r) => t.write(s, r));
}
const text = (t: Terminal, y: number) => t.buffer.active.getLine(y)!.translateToString(true).trimEnd();

describe('putText', () => {
  it('writes exactly width columns, Korean as two cells, cut with an ellipsis', () => {
    const f = new Frame(10, 2);
    putText(f, 0, 1, '한글ab', style({ bold: true }), 6);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((c) => f.get(0, c).ch)).toEqual([' ', '한', '', '글', '', 'a', 'b', ' ']);
    expect(f.get(0, 1).width).toBe(2);
    expect(f.get(0, 2).width).toBe(0);
    putText(f, 1, 0, '한글이름', style({}), 5);
    expect([0, 1, 2, 3, 4].map((c) => f.get(1, c).ch)).toEqual(['한', '', '글', '', '…']);
    putText(f, 1, 8, 'xyz', style({}), 5); // clipped at the frame edge
    expect(f.get(1, 9).ch).toBe('y');
  });
});

describe('diff', () => {
  it('paints a full frame that a terminal reproduces, then only changed runs', async () => {
    const t = new Terminal({ cols: 12, rows: 3, allowProposedApi: true });
    const a = new Frame(12, 3);
    putText(a, 0, 0, '제목 bar', style({ inverse: true }), 12);
    putText(a, 2, 2, 'ok', style({ fg: { mode: 'palette', index: 2 } }), 2);
    const first = diff(null, a);
    await paint(t, first);
    expect(text(t, 0)).toBe('제목 bar');
    expect(text(t, 2)).toBe('  ok');

    const b = new Frame(12, 3);
    putText(b, 0, 0, '제목 bar', style({ inverse: true }), 12);
    putText(b, 2, 2, 'no', style({ fg: { mode: 'palette', index: 1 } }), 2);
    const second = diff(a, b);
    expect(second.length).toBeLessThan(first.length / 2);
    expect(second).not.toContain('제목');
    await paint(t, second);
    expect(text(t, 2)).toBe('  no');
    expect(diff(b, b)).toBe('');
  });

  it('repaints a whole wide char when only its trailing column changed, and full-paints on size change', async () => {
    const a = new Frame(6, 1);
    putText(a, 0, 0, '한x', style({}), 6);
    const b = new Frame(6, 1);
    putText(b, 0, 0, 'ab', style({}), 6);
    const t = new Terminal({ cols: 6, rows: 1, allowProposedApi: true });
    await paint(t, diff(null, a));
    await paint(t, diff(a, b));
    expect(text(t, 0)).toBe('ab');
    expect(diff(new Frame(5, 1), b)).toContain('\x1b[2J');
    fillRect(b, { row: 0, col: 0, rows: 1, cols: 6 });
    expect(b.get(0, 0).ch).toBe(' ');
  });
});

describe('diff round trips, cell for cell', () => {
  const RED = style({ fg: { mode: 'palette', index: 1 } });
  const BOLD = style({ bold: true, bg: { mode: 'rgb', rgb: 0x203040 } });

  /** Paint `prev` in full, then the diff to `next`; the terminal must then hold exactly `next`. */
  async function roundTrip(prev: Frame, next: Frame): Promise<string> {
    const t = new Terminal({ cols: next.cols, rows: next.rows, allowProposedApi: true });
    await paint(t, diff(null, prev));
    const step = diff(prev, next);
    await paint(t, step);
    for (let y = 0; y < next.rows; y++) {
      for (let x = 0; x < next.cols; x++) {
        const got: Cell = cellFromXterm(t.buffer.active.getLine(y)!.getCell(x)!);
        expect(got, `row ${y} col ${x}`).toEqual(next.get(y, x));
      }
    }
    return step;
  }
  const frame = (text: string, st = style({})) => {
    const f = new Frame(8, 2);
    putText(f, 0, 0, text, st, 8);
    putText(f, 1, 0, 'same', st, 8);
    return f;
  };

  it('narrow to wide', async () => {
    await roundTrip(frame('abcdefg'), frame('a한글b'));
  });

  it('wide to narrow', async () => {
    await roundTrip(frame('한글이름'), frame('ab한cdef'));
  });

  it('style only', async () => {
    const step = await roundTrip(frame('a한b', RED), frame('a한b', BOLD));
    expect(step).toContain('48;2;32;48;64');
  });

  it('placeholder only: the wide char is repainted whole', async () => {
    const prev = frame('x한y', RED);
    prev.set(0, 2, { ch: '', width: 0, style: BOLD }); // only the covered column differs
    const step = await roundTrip(prev, frame('x한y', RED));
    expect(step).toContain('\x1b[1;2H');
    expect(step).toContain('한');
  });
});
