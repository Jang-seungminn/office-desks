import unicode11 from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { agentTerminal } from '../src/native/ptyHost.js';
import { cellFromXterm } from '../src/tui/cells.js';
import { diff, Frame } from '../src/tui/frame.js';
import { drawPanel, maxScroll } from '../src/tui/panel.js';

const write = (t: Terminal, s: string) => new Promise<void>((r) => t.write(s, r));
const row = (t: Terminal, y: number, x0: number, n: number) => t.buffer.active.getLine(y)!.translateToString(false, x0, x0 + n);

describe('drawPanel', () => {
  it('reproduces the agent screen cell for cell inside the rect, with colors and the cursor', async () => {
    const agent = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    await write(agent, '\x1b[1;32mok\x1b[0m 한글\r\nline2\r\n\x1b[38;5;45mcolor\x1b[0m');
    const f = new Frame(30, 8);
    const cursor = drawPanel(f, { row: 2, col: 5, rows: 4, cols: 20 }, agent, 0);
    expect(cursor).toEqual({ row: 2 + 2, col: 5 + 5 });
    const real = new Terminal({ cols: 30, rows: 8, allowProposedApi: true });
    await write(real, diff(null, f));
    for (let y = 0; y < 4; y++) expect(row(real, 2 + y, 5, 20)).toBe(row(agent, y, 0, 20));
    const c = real.buffer.active.getNullCell();
    real.buffer.active.getLine(2)!.getCell(5, c);
    expect(c.isBold()).toBeTruthy();
    expect(c.getFgColor()).toBe(2);
  });

  it('shows history when scrolled back and hides the cursor then', async () => {
    const agent = new Terminal({ cols: 10, rows: 3, scrollback: 100, allowProposedApi: true });
    await write(agent, Array.from({ length: 8 }, (_, i) => `L${i}`).join('\r\n'));
    expect(maxScroll(agent)).toBe(5);
    const f = new Frame(10, 3);
    expect(drawPanel(f, { row: 0, col: 0, rows: 3, cols: 10 }, agent, 2)).toBeNull();
    expect(Array.from({ length: 2 }, (_, x) => f.get(0, x).ch).join('')).toBe('L3');
  });

  it('clips an agent bigger than the rect and blanks the rest when smaller', async () => {
    const agent = new Terminal({ cols: 8, rows: 2, allowProposedApi: true });
    await write(agent, 'abcdefgh');
    const f = new Frame(6, 4);
    drawPanel(f, { row: 0, col: 0, rows: 4, cols: 6 }, agent, 0);
    expect(Array.from({ length: 6 }, (_, x) => f.get(0, x).ch).join('')).toBe('abcdef');
    expect(f.get(3, 0).ch).toBe(' ');
  });
});

describe('drawPanel with emoji', () => {
  it('keeps cells in place after an emoji, as a real (Unicode 11) terminal draws them', async () => {
    const agent = agentTerminal(20, 2);
    await write(agent, 'ok ✅ done\x1b[1;14HX🚀y');
    const at = (y: number, x: number) => cellFromXterm(agent.buffer.active.getLine(y)!.getCell(x)!);
    expect(at(0, 3)).toMatchObject({ ch: '✅', width: 2 });
    const f = new Frame(20, 2);
    drawPanel(f, { row: 0, col: 0, rows: 2, cols: 20 }, agent, 0);
    const real = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
    real.loadAddon(new unicode11.Unicode11Addon());
    real.unicode.activeVersion = '11';
    await write(real, diff(null, f));
    for (let x = 0; x < 20; x++) {
      expect(cellFromXterm(real.buffer.active.getLine(0)!.getCell(x)!), `col ${x}`).toEqual(at(0, x));
    }
    expect(row(real, 0, 0, 20).trimEnd()).toBe('ok ✅ done   X🚀y');
  });
});
