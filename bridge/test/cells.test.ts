import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { BLANK, cellFromXterm, DEFAULT_STYLE, sameStyle, sgr, style } from '../src/tui/cells.js';

describe('sgr', () => {
  it('encodes default, 16-color, 256-color and RGB colors and attributes from a reset', () => {
    expect(sgr(DEFAULT_STYLE)).toBe('\x1b[0m');
    expect(sgr(style({ fg: { mode: 'palette', index: 1 }, bold: true }))).toBe('\x1b[0;1;31m');
    expect(sgr(style({ fg: { mode: 'palette', index: 9 }, bg: { mode: 'palette', index: 4 } }))).toBe('\x1b[0;91;44m');
    expect(sgr(style({ fg: { mode: 'palette', index: 45 }, bg: { mode: 'palette', index: 12 } }))).toBe('\x1b[0;38;5;45;104m');
    expect(sgr(style({ fg: { mode: 'rgb', rgb: 0x0a141e }, underline: true, inverse: true, dim: true, italic: true }))).toBe('\x1b[0;2;3;4;7;38;2;10;20;30m');
    expect(sameStyle(style({ bold: true }), style({ bold: true }))).toBe(true);
    expect(sameStyle(style({ bold: true }), DEFAULT_STYLE)).toBe(false);
    expect(BLANK).toEqual({ ch: ' ', width: 1, style: DEFAULT_STYLE });
  });
});

describe('cellFromXterm', () => {
  it('reads characters, widths, colors and attributes from a headless terminal', async () => {
    const t = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
    await new Promise<void>((r) => t.write('\x1b[1;31mR\x1b[0;38;5;45mx\x1b[48;2;10;20;30m한\x1b[0m\x1b[4mu', r));
    const line = t.buffer.active.getLine(0)!;
    const c = t.buffer.active.getNullCell();
    const at = (x: number) => cellFromXterm(line.getCell(x, c)!);
    expect(at(0)).toEqual({ ch: 'R', width: 1, style: style({ fg: { mode: 'palette', index: 1 }, bold: true }) });
    expect(at(1).style.fg).toEqual({ mode: 'palette', index: 45 });
    expect(at(2)).toMatchObject({ ch: '한', width: 2, style: { bg: { mode: 'rgb', rgb: 0x0a141e } } });
    expect(at(3)).toMatchObject({ ch: '', width: 0 });
    expect(at(4).style.underline).toBe(true);
    expect(at(5)).toEqual(BLANK);
  });
});
