import { describe, expect, it } from 'vitest';
import { layout } from '../src/tui/layout.js';

describe('layout', () => {
  it('splits a sidebar and a panel between a title row and a help row', () => {
    const l = layout(120, 36)!;
    expect(l.title).toEqual({ row: 0, col: 0, rows: 1, cols: 120 });
    expect(l.list).toEqual({ row: 2, col: 0, rows: 33, cols: 28 });
    expect(l.sep).toEqual({ row: 1, col: 28, rows: 34, cols: 1 });
    expect(l.panel).toEqual({ row: 2, col: 29, rows: 33, cols: 91 });
    expect(l.panelHead).toEqual({ row: 1, col: 29, rows: 1, cols: 91 });
    expect(l.help).toEqual({ row: 35, col: 0, rows: 1, cols: 120 });
  });

  it('narrows the sidebar on small terminals and gives up below 60x10', () => {
    expect(layout(66, 12)!.list.cols).toBe(22);
    expect(layout(60, 10)!.list.cols).toBe(20);
    expect(layout(59, 20)).toBeNull();
    expect(layout(80, 9)).toBeNull();
  });
});
