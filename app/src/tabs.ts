// Pure, immutable tab and split state. `active` is the left (or only) pane, `split` the right one.

export interface Tab { agentId: string; title: string }
export interface TabsState { tabs: Tab[]; active: string | null; split: string | null }

export const EMPTY: TabsState = Object.freeze({ tabs: [], active: null, split: null }) as TabsState;

/** Makes `id` active; a split pane that becomes active trades places with the old active one. */
function activate(s: TabsState, tabs: Tab[], id: string): TabsState {
  const split = s.split === id ? s.active : s.split;
  return { tabs, active: id, split: split === id ? null : split };
}

export function openTab(s: TabsState, t: Tab): TabsState {
  const exists = s.tabs.some((x) => x.agentId === t.agentId);
  return activate(s, exists ? s.tabs : [...s.tabs, t], t.agentId);
}

export function closeTab(s: TabsState, agentId: string): TabsState {
  const i = s.tabs.findIndex((x) => x.agentId === agentId);
  if (i < 0) return s;
  const tabs = s.tabs.filter((x) => x.agentId !== agentId);
  let active = s.active;
  let split = s.split;
  if (s.active === agentId) {
    active = (tabs[i] ?? tabs[i - 1])?.agentId ?? null;
    // The split belonged to the closed main pane: it collapses (pinned by tabs.test.ts).
    split = null;
  }
  if (split === agentId || split === active) split = null;
  return { tabs, active, split };
}

export function switchTo(s: TabsState, index: number): TabsState {
  if (!Number.isInteger(index) || index < 0 || index >= s.tabs.length) return s;
  return activate(s, s.tabs, s.tabs[index].agentId);
}

export function toggleSplit(s: TabsState): TabsState {
  if (s.split !== null) return { ...s, split: null };
  if (s.tabs.length < 2 || s.active === null) return s;
  const i = s.tabs.findIndex((x) => x.agentId === s.active);
  const other = i + 1 < s.tabs.length ? s.tabs[i + 1] : s.tabs[i - 1];
  return { ...s, split: other.agentId };
}
