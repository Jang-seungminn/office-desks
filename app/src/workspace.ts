// The tab bar and the terminal panes: one TermView per tab, one optional side-by-side split.
import type { OfficeAgent, OfficeDesk, OfficeSnapshot } from '../../bridge/src/model';
import { platform, type TermConfig } from './host';
import { isModalOpen } from './modal';
import * as T from './tabs';
import { TermView } from './termView';
import { tabTitle } from './tree';

const EMPTY_TEXT = '왼쪽에서 에이전트를 골라 터미널을 여세요';

/** The tab-switch chord for tab n (1-based), as Task 8's keymap binds it. */
function switchLabel(n: number): string {
  return platform() === 'mac' ? `⌘${n}` : `Ctrl+Shift+${n}`;
}

interface Slot { pane: HTMLDivElement; view: TermView }

export class Workspace {
  private st: T.TabsState = T.EMPTY;
  private readonly slots = new Map<string, Slot>();
  private readonly gone = new Set<string>();
  private readonly bar: HTMLDivElement;
  private readonly panes: HTMLDivElement;
  private readonly empty: HTMLDivElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly cfg: TermConfig,
  ) {
    this.bar = document.createElement('div');
    this.bar.className = 'tabbar';
    this.bar.setAttribute('role', 'tablist');
    this.panes = document.createElement('div');
    this.panes.className = 'panes';
    this.empty = document.createElement('div');
    this.empty.className = 'workspace-empty';
    this.empty.textContent = EMPTY_TEXT;
    root.classList.add('has-tabs');
    root.replaceChildren(this.bar, this.panes, this.empty);
    this.render();
  }

  get state(): T.TabsState {
    return this.st;
  }

  open(desk: OfficeDesk, agent: OfficeAgent): void {
    this.set(T.openTab(this.st, { agentId: agent.id, title: tabTitle(desk, agent) }));
  }

  /** Closes (detaches) a tab, the active one by default. The agent keeps running. */
  close(agentId?: string): void {
    const id = agentId ?? this.st.active;
    if (id === null || id === undefined) return;
    this.set(T.closeTab(this.st, id));
  }

  switchTo(index: number): void {
    this.set(T.switchTo(this.st, index));
  }

  toggleSplit(): void {
    this.set(T.toggleSplit(this.st));
  }

  copy(): string {
    return this.targetView()?.copySelection() ?? '';
  }

  paste(text: string): void {
    this.targetView()?.paste(text);
  }

  focusActive(): void {
    this.activeView()?.focus();
  }

  /** Refits the visible panes (after the sidebar toggles). */
  fit(): void {
    for (const id of [this.st.active, this.st.split]) if (id) this.slots.get(id)?.view.fit();
  }

  text(agentId: string): string {
    return this.slots.get(agentId)?.view.text() ?? '';
  }

  /** Tabs whose agent left the snapshot turn muted; they stay open (their banner says why). */
  prune(s: OfficeSnapshot): void {
    const live = new Set(s.desks.flatMap((d) => d.agents.map((a) => a.id)));
    this.gone.clear();
    for (const t of this.st.tabs) if (!live.has(t.agentId)) this.gone.add(t.agentId);
    this.renderBar();
  }

  /** The visible pane holding keyboard focus (the split one, say), else the active one. */
  private targetView(): TermView | undefined {
    const f = document.activeElement;
    for (const id of [this.st.active, this.st.split]) {
      const slot = id ? this.slots.get(id) : undefined;
      if (slot && f && slot.pane.contains(f)) return slot.view;
    }
    return this.activeView();
  }

  private activeView(): TermView | undefined {
    return this.st.active ? this.slots.get(this.st.active)?.view : undefined;
  }

  private set(next: T.TabsState): void {
    if (next === this.st) return;
    const prevActive = this.st.active;
    this.st = next;
    const open = new Set(next.tabs.map((t) => t.agentId));
    for (const [id, slot] of this.slots) {
      if (open.has(id)) continue;
      slot.view.dispose();
      slot.pane.remove();
      this.slots.delete(id);
      this.gone.delete(id);
    }
    this.render();
    if (next.active && next.active !== prevActive && !isModalOpen()) this.slots.get(next.active)?.view.focus();
  }

  private render(): void {
    this.renderBar();
    const { active, split } = this.st;
    this.panes.classList.toggle('split', split !== null);
    this.empty.hidden = this.st.tabs.length > 0;
    this.panes.hidden = this.st.tabs.length === 0;
    // Show the panes first, then create views: xterm measures its cell size at open.
    for (const [id, slot] of this.slots) this.place(slot.pane, id === active ? 'left' : id === split ? 'right' : null);
    for (const id of [active, split]) {
      if (!id || this.slots.has(id)) continue;
      const pane = document.createElement('div');
      pane.className = 'pane';
      pane.dataset.agent = id;
      this.place(pane, id === active ? 'left' : 'right');
      this.panes.append(pane);
      this.slots.set(id, { pane, view: new TermView(pane, this.cfg, id) });
    }
  }

  private place(pane: HTMLDivElement, side: 'left' | 'right' | null): void {
    pane.hidden = side === null;
    pane.classList.toggle('pane-left', side === 'left');
    pane.classList.toggle('pane-right', side === 'right');
  }

  private renderBar(): void {
    // Keep keyboard focus on the same tab button across the rebuild.
    const f = document.activeElement;
    const keep =
      f instanceof HTMLElement && this.bar.contains(f)
        ? { id: f.closest<HTMLElement>('.tab')?.dataset.agent, cls: f.className }
        : null;
    const items = this.st.tabs.map((t, i) => {
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.dataset.agent = t.agentId;
      tab.setAttribute('role', 'tab');
      const on = t.agentId === this.st.active || t.agentId === this.st.split;
      tab.setAttribute('aria-selected', String(t.agentId === this.st.active));
      tab.classList.toggle('active', t.agentId === this.st.active);
      tab.classList.toggle('in-split', t.agentId === this.st.split);
      tab.classList.toggle('visible', on);
      tab.classList.toggle('gone', this.gone.has(t.agentId));
      if (i < 9) tab.title = switchLabel(i + 1);
      const title = document.createElement('button');
      title.type = 'button';
      title.className = 'tab-title';
      title.textContent = t.title;
      title.addEventListener('click', () => this.switchTo(this.st.tabs.findIndex((x) => x.agentId === t.agentId)));
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'tab-close';
      x.textContent = '✕';
      x.setAttribute('aria-label', `${t.title} 탭 닫기`);
      x.title = '탭 닫기 (에이전트는 계속 실행돼요)';
      x.addEventListener('click', () => this.close(t.agentId));
      tab.append(title, x);
      return tab;
    });
    this.bar.replaceChildren(...items);
    if (keep) {
      const tab = items.find((t) => t.dataset.agent === keep.id);
      (tab?.querySelector<HTMLElement>(`button.${keep.cls}`) ?? tab?.querySelector<HTMLElement>('button'))?.focus();
    }
  }
}
