import { describe, expect, it } from 'vitest';
import { closeTab, EMPTY, openTab, switchTo, toggleSplit, type TabsState } from '../src/tabs';

const tab = (id: string) => ({ agentId: id, title: `${id} · claude` });
const ids = (s: TabsState) => s.tabs.map((t) => t.agentId);

describe('tabs', () => {
  it('runs the open/switch/split/close sequence', () => {
    let s = openTab(openTab(openTab(EMPTY, tab('A')), tab('B')), tab('C'));
    expect(ids(s)).toEqual(['A', 'B', 'C']);
    expect(s.active).toBe('C');
    s = switchTo(s, 0);
    expect(s.active).toBe('A');
    s = toggleSplit(s);
    expect(s.split).toBe('B');
    s = switchTo(s, 1); // B, the split one: they trade places
    expect(s.active).toBe('B');
    expect(s.split).toBe('A');
    s = closeTab(s, 'B');
    expect(s.active).toBe('C');
    expect(s.split).toBeNull();
    expect(ids(s)).toEqual(['A', 'C']);
  });

  it('toggleSplit with one tab is unchanged', () => {
    const s = openTab(EMPTY, tab('A'));
    expect(toggleSplit(s)).toEqual(s);
  });

  it('toggleSplit uses the tab before the active one when it is last, and toggles off', () => {
    const s = openTab(openTab(EMPTY, tab('A')), tab('B'));
    const on = toggleSplit(s);
    expect(on).toMatchObject({ active: 'B', split: 'A' });
    expect(toggleSplit(on)).toMatchObject({ active: 'B', split: null });
  });

  it('closing the last tab leaves nothing active', () => {
    const s = closeTab(openTab(EMPTY, tab('A')), 'A');
    expect(s).toEqual({ tabs: [], active: null, split: null });
  });

  it('closing the active tab picks the next, else the previous', () => {
    const s = switchTo(openTab(openTab(openTab(EMPTY, tab('A')), tab('B')), tab('C')), 1);
    expect(closeTab(s, 'B').active).toBe('C');
    expect(closeTab(s, 'C').active).toBe('B'); // not active: unchanged
    expect(closeTab(closeTab(s, 'C'), 'B').active).toBe('A');
  });

  it('closing the split tab clears the split and keeps active', () => {
    const s = toggleSplit(switchTo(openTab(openTab(openTab(EMPTY, tab('A')), tab('B')), tab('C')), 0));
    expect(s).toMatchObject({ active: 'A', split: 'B' });
    expect(closeTab(s, 'B')).toMatchObject({ active: 'A', split: null });
    expect(closeTab(s, 'C')).toMatchObject({ active: 'A', split: 'B' });
  });

  it('switchTo out of range is a no-op', () => {
    const s = openTab(openTab(openTab(EMPTY, tab('A')), tab('B')), tab('C'));
    expect(switchTo(s, 8)).toBe(s);
    expect(switchTo(s, -1)).toBe(s);
  });

  it('opening an existing tab activates it without duplicating', () => {
    let s = openTab(openTab(EMPTY, tab('A')), tab('B'));
    s = openTab(s, tab('A'));
    expect(ids(s)).toEqual(['A', 'B']);
    expect(s.active).toBe('A');
  });

  it('opening the split tab swaps it with the active one', () => {
    const s = toggleSplit(switchTo(openTab(openTab(EMPTY, tab('A')), tab('B')), 0));
    expect(s).toMatchObject({ active: 'A', split: 'B' });
    expect(openTab(s, tab('B'))).toMatchObject({ active: 'B', split: 'A' });
  });

  it('never mutates its input', () => {
    const s = openTab(EMPTY, tab('A'));
    const frozen = JSON.stringify(s);
    openTab(s, tab('B'));
    closeTab(s, 'A');
    expect(JSON.stringify(s)).toBe(frozen);
    expect(EMPTY.tabs).toEqual([]);
  });
});
