import { describe, expect, it } from 'vitest';
import { layout } from '../src/tui/layout.js';
import { clampToBody, hitTest, splitMouse } from '../src/tui/mouseActions.js';

describe('hitTest', () => {
  it('finds the list, a pane head, a pane body cell, or nothing', () => {
    const L = layout(160, 30, 2)!;
    const [p0, p1] = L.panes;
    expect(hitTest(L, 3, L.list.row + 2)).toEqual({ area: 'list', y: L.list.row + 2 });
    expect(hitTest(L, p0.body.col + 4, p0.body.row + 1)).toEqual({ area: 'pane', pane: 0, x: 4, y: 1 });
    expect(hitTest(L, p1.body.col, p1.body.row)).toEqual({ area: 'pane', pane: 1, x: 0, y: 0 });
    expect(hitTest(L, p1.head.col + 3, p1.head.row)).toEqual({ area: 'head', pane: 1 });
    expect(hitTest(L, L.dividers[0].col, p0.body.row)).toEqual({ area: 'none' });
    expect(hitTest(L, 0, 0)).toEqual({ area: 'none' });
    expect(hitTest(L, 0, L.help.row)).toEqual({ area: 'none' });
    expect(hitTest(L, L.sep.col, 5)).toEqual({ area: 'none' });
  });

  it('works for all four panes of a 2x2 grid', () => {
    const L = layout(200, 50, 4)!;
    L.panes.forEach((p, i) => expect(hitTest(L, p.body.col + p.body.cols - 1, p.body.row + p.body.rows - 1)).toEqual({ area: 'pane', pane: i, x: p.body.cols - 1, y: p.body.rows - 1 }));
  });
});

describe('clampToBody', () => {
  it('keeps a drag inside one pane and says which edge it went past', () => {
    const L = layout(160, 30, 2)!;
    const b = L.panes[0].body;
    expect(clampToBody(L, 0, b.col + 3, b.row + 2)).toEqual({ x: 3, y: 2, edge: 0 });
    expect(clampToBody(L, 0, L.panes[1].body.col + 5, b.row + 2)).toEqual({ x: b.cols - 1, y: 2, edge: 0 });
    expect(clampToBody(L, 0, 0, b.row - 1)).toEqual({ x: 0, y: 0, edge: -1 });
    expect(clampToBody(L, 0, b.col + 1, b.row + b.rows + 3)).toEqual({ x: 1, y: b.rows - 1, edge: 1 });
  });
});

describe('splitMouse', () => {
  it('takes mouse reports out of the bytes, in order', () => {
    const parts = splitMouse('ab\x1b[<0;5;6Mcd\x1b[<0;5;6m');
    expect(parts.map((p) => (p.kind === 'text' ? p.text : p.event?.kind))).toEqual(['ab', 'press', 'cd', 'release']);
    expect(parts[1]).toMatchObject({ kind: 'mouse', raw: '\x1b[<0;5;6M', event: { x: 4, y: 5 } });
  });

  it('leaves bytes inside a bracketed paste alone', () => {
    const s = 'x\x1b[200~a\x1b[<0;5;5Mb\x1b[201~\x1b[<64;1;1M';
    const parts = splitMouse(s);
    expect(parts.map((p) => p.kind)).toEqual(['text', 'mouse']);
    expect(parts[0]).toEqual({ kind: 'text', text: 'x\x1b[200~a\x1b[<0;5;5Mb\x1b[201~' });
  });

  it('drops a horizontal wheel report without an event', () => {
    expect(splitMouse('\x1b[<66;1;1Mz')).toEqual([{ kind: 'mouse', raw: '\x1b[<66;1;1M', event: null }, { kind: 'text', text: 'z' }]);
  });
});
