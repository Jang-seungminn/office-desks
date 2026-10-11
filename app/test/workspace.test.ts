// @vitest-environment jsdom
// Tab lifecycle in the DOM, with TermView faked: one view per tab, kept across switches,
// disposed (detached) only on close; split panes; muted tabs after prune; no stop calls.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, desk, snap } from './fixtures';

const views = vi.hoisted(() => [] as any[]);
vi.mock('../src/termView', () => ({
  TermView: class {
    disposed = 0;
    focused = 0;
    fits = 0;
    pasted: string[] = [];
    visibleAtOpen: boolean;
    constructor(public host: HTMLElement, public cfg: unknown, public agentId: string) {
      // xterm measures its cell at open: no hidden ancestor, and attached to the document.
      this.visibleAtOpen = host.isConnected && host.closest('[hidden]') === null;
      views.push(this);
    }
    fit() {
      this.fits++;
    }
    focus() {
      this.focused++;
    }
    copySelection() {
      return `sel:${this.agentId}`;
    }
    paste(t: string) {
      this.pasted.push(t);
    }
    text() {
      return `text:${this.agentId}`;
    }
    dispose() {
      this.disposed++;
    }
  },
}));
const api = vi.hoisted(() => ({ stopAgent: vi.fn(), removeWorktree: vi.fn() }));
vi.mock('../src/api', async (orig) => ({ ...(await orig<object>()), ...api }));

const { Workspace } = await import('../src/workspace');
const { installDebug } = await import('../src/debug');

const d = desk({ id: 'r1::/p', name: 'wt1' });
const A = agent({ id: 'A' });
const B = agent({ id: 'B', agentType: 'codex' });
const C = agent({ id: 'C' });
const cfg = { port: 51234, token: 'secret-token' };

let root: HTMLElement;
let ws: InstanceType<typeof Workspace>;
const tabIds = () => [...root.querySelectorAll<HTMLElement>('.tab')].map((t) => t.dataset.agent);
const shown = () => [...root.querySelectorAll<HTMLElement>('.pane')].filter((p) => !p.hidden).map((p) => p.dataset.agent);
const view = (id: string) => views.find((v) => v.agentId === id);

beforeEach(() => {
  views.length = 0;
  document.body.replaceChildren();
  root = document.createElement('main');
  root.className = 'workspace';
  document.body.append(root);
  ws = new Workspace(root, cfg);
});

describe('Workspace', () => {
  it('starts empty with the hint', () => {
    expect(root.querySelector('.workspace-empty')!.textContent).toBe('왼쪽에서 에이전트를 골라 터미널을 여세요');
    expect(tabs()).toEqual([]);
  });

  it('opens one tab and one view per agent; reopening does not reattach', () => {
    ws.open(d, A);
    ws.open(d, B);
    ws.open(d, A);
    expect(tabIds()).toEqual(['A', 'B']);
    expect(views.map((v) => v.agentId)).toEqual(['A', 'B']);
    expect(ws.state.active).toBe('A');
    expect(shown()).toEqual(['A']);
    expect(root.querySelector('.tab[data-agent="B"] .tab-title')!.textContent).toBe('wt1 · codex');
    expect(root.querySelector<HTMLElement>('.workspace-empty')!.hidden).toBe(true);
  });

  it('switching tabs keeps each view (no reattach) and shows one pane', () => {
    ws.open(d, A);
    ws.open(d, B);
    ws.switchTo(0);
    ws.switchTo(1);
    ws.switchTo(0);
    expect(views).toHaveLength(2);
    expect(views.every((v) => v.disposed === 0)).toBe(true);
    expect(shown()).toEqual(['A']);
    expect(view('A').focused).toBeGreaterThan(0);
  });

  it('clicking a title activates it; ✕ detaches that tab only', () => {
    ws.open(d, A);
    ws.open(d, B);
    root.querySelector<HTMLButtonElement>('.tab[data-agent="A"] .tab-title')!.click();
    expect(ws.state.active).toBe('A');
    root.querySelector<HTMLButtonElement>('.tab[data-agent="B"] .tab-close')!.click();
    expect(tabIds()).toEqual(['A']);
    expect(view('B').disposed).toBe(1);
    expect(view('A').disposed).toBe(0);
    expect(root.querySelector('.pane[data-agent="B"]')).toBeNull();
    expect(api.stopAgent).not.toHaveBeenCalled();
  });

  it('close() with no argument closes the active tab; with no tabs it does nothing', () => {
    ws.close();
    ws.open(d, A);
    ws.open(d, B);
    ws.close();
    expect(tabIds()).toEqual(['A']);
    expect(view('B').disposed).toBe(1);
    ws.close();
    expect(tabIds()).toEqual([]);
    expect(root.querySelector<HTMLElement>('.workspace-empty')!.hidden).toBe(false);
    ws.close();
    expect(views.every((v) => v.disposed === 1)).toBe(true);
    expect(api.stopAgent).not.toHaveBeenCalled();
  });

  it('split shows two panes, active left and split right; toggling again hides one', () => {
    ws.open(d, A);
    ws.open(d, B);
    ws.open(d, C);
    ws.switchTo(0);
    ws.toggleSplit();
    expect(ws.state.split).toBe('B');
    expect(shown().sort()).toEqual(['A', 'B']);
    expect(root.querySelector('.pane[data-agent="A"]')!.classList.contains('pane-left')).toBe(true);
    expect(root.querySelector('.pane[data-agent="B"]')!.classList.contains('pane-right')).toBe(true);
    expect(root.querySelector('.panes')!.classList.contains('split')).toBe(true);
    ws.switchTo(1);
    expect(root.querySelector('.pane[data-agent="B"]')!.classList.contains('pane-left')).toBe(true);
    expect(root.querySelector('.pane[data-agent="A"]')!.classList.contains('pane-right')).toBe(true);
    ws.toggleSplit();
    expect(shown()).toEqual(['B']);
    expect(views).toHaveLength(3);
  });

  it('creates a view only for a pane that is visible at the time', () => {
    ws.open(d, A);
    ws.open(d, B);
    ws.switchTo(0);
    const before = views.length;
    ws.toggleSplit();
    expect(views.length).toBe(before); // B already had its view
    for (const v of views) expect(v.host.hidden).toBe(v.agentId !== 'A' && v.agentId !== 'B');
  });

  it('every view is created in a visible, attached pane (first open, and after closing all)', () => {
    ws.open(d, A);
    ws.close();
    ws.open(d, B);
    ws.open(d, C);
    ws.switchTo(0);
    ws.toggleSplit();
    expect(views.map((v) => v.agentId)).toEqual(['A', 'B', 'C']);
    expect(views.every((v) => v.visibleAtOpen)).toBe(true);
  });

  it('tab titles carry the switch shortcut for the first 9', () => {
    for (let i = 0; i < 10; i++) ws.open(d, agent({ id: `x${i}` }));
    const titles = [...root.querySelectorAll<HTMLElement>('.tab')].map((t) => t.title);
    expect(titles[0]).toMatch(/1$/);
    expect(titles[8]).toMatch(/9$/);
    expect(titles[9]).toBe('');
  });

  it('prune mutes tabs whose agent left, without closing them', () => {
    ws.open(d, A);
    ws.open(d, B);
    ws.prune(snap([desk({ agents: [A] })]));
    expect(tabIds()).toEqual(['A', 'B']);
    expect(root.querySelector('.tab[data-agent="B"]')!.classList.contains('gone')).toBe(true);
    expect(root.querySelector('.tab[data-agent="A"]')!.classList.contains('gone')).toBe(false);
    expect(view('B').disposed).toBe(0);
    ws.prune(snap([desk({ agents: [A, B] })]));
    expect(root.querySelector('.tab[data-agent="B"]')!.classList.contains('gone')).toBe(false);
  });

  it('copy and paste go to the focused pane of a split, else the active one', () => {
    ws.open(d, A);
    ws.open(d, B);
    ws.switchTo(0);
    ws.toggleSplit(); // A left (active), B right (split)
    const inB = document.createElement('textarea'); // stands in for xterm's textarea
    view('B').host.append(inB);
    inB.focus();
    expect(ws.copy()).toBe('sel:B');
    ws.paste('right');
    expect(view('B').pasted).toEqual(['right']);
    expect(view('A').pasted).toEqual([]);
    inB.blur();
    expect(ws.copy()).toBe('sel:A');
    ws.paste('left');
    expect(view('A').pasted).toEqual(['left']);
  });

  it('copy and paste go to the active view', () => {
    expect(ws.copy()).toBe('');
    ws.paste('nothing');
    ws.open(d, A);
    ws.open(d, B);
    expect(ws.copy()).toBe('sel:B');
    ws.paste('hey');
    expect(view('B').pasted).toEqual(['hey']);
    expect(view('A').pasted).toEqual([]);
  });

  it('keeps keyboard focus on the same tab button across a re-render', () => {
    ws.open(d, A);
    ws.open(d, B);
    root.querySelector<HTMLButtonElement>('.tab[data-agent="A"] .tab-close')!.focus();
    ws.prune(snap([]));
    expect(document.activeElement).toBe(root.querySelector('.tab[data-agent="A"] .tab-close'));
  });

  it('hands the config to each view in memory and never writes the token into the DOM', () => {
    // The real-socket check is in termViewWiring.test.ts.
    ws.open(d, A);
    ws.open(d, B);
    ws.toggleSplit();
    expect(views.every((v) => v.cfg === cfg)).toBe(true);
    const attrs = [...document.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.value));
    expect(attrs.join('\n')).not.toContain('secret-token');
    expect(document.documentElement.outerHTML).not.toContain('secret-token');
    expect(document.title).not.toContain('secret-token');
  });

  it('the E2E hook reads tabs, active, split and text, and never the config', () => {
    (window as any).__TAURI_INTERNALS__ = { __gongbangE2E: true };
    installDebug(ws);
    ws.open(d, A);
    ws.open(d, B);
    ws.toggleSplit();
    const g = (window as any).__gongbang;
    expect(g.tabs()).toEqual(['A', 'B']);
    expect(g.active()).toBe('B');
    expect(g.split()).toBe('A');
    expect(g.text('A')).toBe('text:A');
    expect(g.text('nope')).toBe('');
    expect(JSON.stringify(Object.keys(g))).not.toContain('token');
    delete (window as any).__gongbang;
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('without the E2E flag there is no hook', () => {
    installDebug(ws);
    expect((window as any).__gongbang).toBeUndefined();
  });
});

function tabs() {
  return tabIds();
}
