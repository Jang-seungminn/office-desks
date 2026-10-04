import { describe, expect, it } from 'vitest';
import { PaneSet } from '../src/tui/panes.js';

describe('PaneSet', () => {
  it('shows an agent in the focused pane', () => {
    const p = new PaneSet(4);
    p.show('a', 4);
    expect(p.agents).toEqual(['a', null, null, null]);
    p.focusNext(1, 4);
    p.show('b', 4);
    expect(p.agents).toEqual(['a', 'b', null, null]);
  });

  it('swaps when the agent is in another visible pane', () => {
    const p = new PaneSet(4);
    p.show('a', 4);
    p.focusNext(1, 4);
    p.show('b', 4);
    p.show('a', 4);
    expect(p.agents).toEqual(['b', 'a', null, null]);
  });

  it('moves an agent from a hidden slot and clears that slot', () => {
    const p = new PaneSet(4);
    for (const id of ['a', 'b', 'c', 'd']) {
      p.show(id, 4);
      p.focusNext(1, 4);
    }
    p.setPreset(1);
    p.clamp(1);
    expect(p.agents).toEqual(['a', 'b', 'c', 'd']);
    p.show('c', 1);
    expect(p.agents).toEqual(['c', 'b', 'a', 'd']);
    p.show('d', 1);
    p.setPreset(4);
    expect(p.agents.filter((x) => x === 'd')).toHaveLength(1);
  });

  it('wraps focus around', () => {
    const p = new PaneSet(2);
    p.focusNext(-1, 2);
    expect(p.focused).toBe(1);
    p.focusNext(1, 2);
    expect(p.focused).toBe(0);
  });

  it('clamps focus after the preset shrinks', () => {
    const p = new PaneSet(4);
    p.focused = 3;
    p.setPreset(2);
    p.clamp(2);
    expect(p.focused).toBe(1);
    expect(p.preset).toBe(2);
  });

  it('prunes agents that no longer exist', () => {
    const p = new PaneSet(2);
    p.show('a', 2);
    p.focusNext(1, 2);
    p.show('b', 2);
    p.prune((id) => id === 'b');
    expect(p.agents).toEqual([null, 'b', null, null]);
  });

  it('reports shown agents and pane indexes', () => {
    const p = new PaneSet(4);
    p.show('a', 4);
    p.focusNext(1, 4);
    p.focusNext(1, 4);
    p.show('c', 4);
    expect(p.shown(4)).toEqual(['a', 'c']);
    expect(p.shown(1)).toEqual(['a']);
    expect(p.paneOf('c', 4)).toBe(2);
    expect(p.paneOf('c', 2)).toBe(-1);
    expect(p.paneOf('zzz', 4)).toBe(-1);
  });

  it('resets scroll of panes whose agent changed', () => {
    const p = new PaneSet(4);
    p.show('a', 4);
    p.focusNext(1, 4);
    p.show('b', 4);
    p.scroll.fill(7);
    p.show('a', 4); // swap: pane 1 now a, pane 0 now b
    expect(p.scroll.slice(0, 2)).toEqual([0, 0]);
    expect(p.scroll.slice(2)).toEqual([7, 7]);
    p.scroll[1] = 5;
    p.show('a', 4); // no change
    expect(p.scroll[1]).toBe(5);
  });
});
