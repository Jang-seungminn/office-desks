import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { isSelected, ordered, selectionText, topLine } from '../src/tui/selection.js';

const write = (t: Terminal, s: string) => new Promise<void>((r) => t.write(s, r));
const sel = (a: [number, number], h: [number, number]) => ({ pane: 0, anchor: { line: a[0], col: a[1] }, head: { line: h[0], col: h[1] } });

describe('selection', () => {
  it('orders a reversed drag and tests membership as a stream', () => {
    const s = sel([2, 5], [1, 3]);
    expect(ordered(s)).toEqual([{ line: 1, col: 3 }, { line: 2, col: 5 }]);
    expect(isSelected(s, 1, 2)).toBe(false);
    expect(isSelected(s, 1, 50)).toBe(true);
    expect(isSelected(s, 2, 5)).toBe(true);
    expect(isSelected(s, 2, 6)).toBe(false);
  });

  it('extracts Korean text, joins wrapped lines and trims line ends', async () => {
    const t = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
    await write(t, 'ok 한글\r\nabcdefghijKLM\r\nlast');
    // line 1 is wrapped into line 2 ("abcdefghij" + "KLM")
    expect(selectionText(t, sel([0, 0], [0, 9]))).toBe('ok 한글');
    expect(selectionText(t, sel([2, 2], [1, 0]))).toBe('abcdefghijKLM');
    expect(selectionText(t, sel([0, 3], [3, 1]))).toBe('한글\nabcdefghijKLM\nla');
  });

  it('maps pane rows to buffer lines when scrolled back', async () => {
    const t = new Terminal({ cols: 10, rows: 3, scrollback: 50, allowProposedApi: true });
    await write(t, Array.from({ length: 8 }, (_, i) => `L${i}`).join('\r\n'));
    expect(topLine(t, 0)).toBe(5);
    expect(topLine(t, 2)).toBe(3);
    expect(topLine(t, 99)).toBe(0);
  });
});
