import { describe, expect, it } from 'vitest';
import { layout } from '../src/tui/layout.js';

describe('layout', () => {
  it('splits a sidebar and a panel between a title row and a help row', () => {
    const l = layout(120, 36)!;
    expect(l.title).toEqual({ row: 0, col: 0, rows: 1, cols: 120 });
    expect(l.list).toEqual({ row: 2, col: 0, rows: 33, cols: 28 });
    expect(l.sep).toEqual({ row: 1, col: 28, rows: 34, cols: 1 });
    expect(l.panes[0].body).toEqual({ row: 2, col: 29, rows: 33, cols: 91 });
    expect(l.panes[0].head).toEqual({ row: 1, col: 29, rows: 1, cols: 91 });
    expect(l.help).toEqual({ row: 35, col: 0, rows: 1, cols: 120 });
  });

  it('narrows the sidebar on small terminals and gives up below 60x10', () => {
    expect(layout(66, 12)!.list.cols).toBe(22);
    expect(layout(60, 10)!.list.cols).toBe(20);
    expect(layout(59, 20)).toBeNull();
    expect(layout(80, 9)).toBeNull();
  });
});

describe('layout presets', () => {
  it('keeps the v2 single pane for preset 1', () => {
    const l = layout(120, 36, 1)!;
    expect(l.panes).toEqual([{ head: { row: 1, col: 29, rows: 1, cols: 91 }, body: { row: 2, col: 29, rows: 33, cols: 91 } }]);
    expect(l.dividers).toEqual([]);
  });

  it('splits left|right, top/bottom and 2x2 with 1-cell dividers', () => {
    const two = layout(200, 50, 2)!;
    expect(two.panes.map((p) => p.body.cols)).toEqual([85, 85]);
    expect(two.dividers).toEqual([{ row: 1, col: 29 + 85, rows: 48, cols: 1 }]);
    const three = layout(200, 50, 3)!;
    expect(three.panes.map((p) => [p.head.row, p.body.rows])).toEqual([[1, 22], [25, 23]]);
    const four = layout(200, 50, 4)!;
    expect(four.panes).toHaveLength(4);
    expect(four.dividers).toHaveLength(2);
    expect(four.panes[1].body.col).toBe(four.panes[0].body.col + four.panes[0].body.cols + 1);
  });

  it('falls back when panes would be too small', () => {
    expect(layout(100, 36, 4)!.preset).toBe(3); // 71 cols can't hold two 40-col panes side by side
    expect(layout(100, 12, 3)!.preset).toBe(1); // 10 rows can't hold two 6-row bodies
    expect(layout(200, 12, 4)!.preset).toBe(2);
  });
});
