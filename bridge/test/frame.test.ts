import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { style } from '../src/tui/cells.js';
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
