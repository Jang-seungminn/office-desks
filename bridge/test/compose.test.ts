import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { compose, type PaneView, type View } from '../src/tui/compose.js';
import type { Frame } from '../src/tui/frame.js';
import { layout } from '../src/tui/layout.js';
import type { LobbyRow } from '../src/tui/lobby.js';

const write = (t: Terminal, s: string) => new Promise<void>((r) => t.write(s, r));
const text = (f: Frame, row: number, col = 0, n = f.cols - col) =>
  Array.from({ length: n }, (_, i) => f.get(row, col + i)).map((c) => (c.width === 0 ? '' : c.ch)).join('');

const rows: LobbyRow[] = [
  { deskId: 'd1', repoId: 'r1', repo: 'proj', desk: 'main', isMain: true, agentId: 'a1', agentType: 'claude', state: 'typing', activity: '' },
  { deskId: 'd2', repoId: 'r1', repo: 'proj', desk: 'feat', isMain: false, agentId: null, agentType: null, state: null, activity: '' },
];

type Patch = Partial<Omit<View, 'panes'>> & { agent?: Terminal | null; scroll?: number; agentCursorHidden?: boolean };

async function view(patch: Patch = {}): Promise<View> {
  const { agent: ag, scroll = 0, agentCursorHidden = false, ...rest } = patch;
  const agent = ag === undefined ? new Terminal({ cols: 20, rows: 5, allowProposedApi: true }) : ag;
  if (ag === undefined) await write(agent!, 'hello agent\r\nsecond');
  const v = { rows, selected: 0, focus: 'panel' as const, url: 'http://x:1', help: ' q 종료', helpCursor: null, preset: 1 as const, focusedPane: 0, ...rest };
  return { ...v, panes: [{ row: v.rows[v.selected] ?? null, agent, cursorHidden: agentCursorHidden, scroll, selection: null }] };
}

async function agentWith(content: string): Promise<Terminal> {
  const t = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
  await write(t, content);
  return t;
}

const pv = (row: LobbyRow | null, agent: Terminal | null, extra: Partial<PaneView> = {}): PaneView => ({ row, agent, cursorHidden: false, scroll: 0, selection: null, ...extra });
const base = (patch: Partial<View>): View => ({ rows, selected: 0, focus: 'panel', url: 'u', help: '', helpCursor: null, preset: 1, focusedPane: 0, panes: [], ...patch });

describe('compose', () => {
  it('panel focus: title, panel text, separator, cursor and help', async () => {
    const v = await view();
    const { frame, cursor } = compose(v, 80, 12);
    const L = layout(80, 12)!;
    expect(text(frame, 0)).toContain('Office Desks');
    expect(text(frame, 0)).toContain('http://x:1');
    expect(text(frame, 0)).toContain('✎ 1  ! 0');
    expect(text(frame, 2, L.panes[0].body.col)).toContain('hello agent');
    expect(text(frame, 1, L.panes[0].body.col)).toContain('proj/main · claude');
    for (let y = 1; y <= 10; y++) expect(frame.get(y, L.sep.col).ch).toBe('│');
    expect(cursor).toEqual({ row: L.panes[0].body.row + 1, col: L.panes[0].body.col + 6 });
    expect(text(frame, 11)).toBe(' q 종료'.padEnd(80 - 2, ' ')); // 한글 is 4 cols for 2 chars
  });

  it('panel focus with the agent cursor hidden: still placed (IME), but marked hidden', async () => {
    const L = layout(80, 12)!;
    const { cursor } = compose(await view({ agentCursorHidden: true }), 80, 12);
    expect(cursor).toEqual({ row: L.panes[0].body.row + 1, col: L.panes[0].body.col + 6, hidden: true });
  });

  it('list focus: no cursor, list head bold', async () => {
    const { frame, cursor } = compose(await view({ focus: 'list' }), 80, 12);
    expect(cursor).toBeNull();
    expect(frame.get(1, 1).style.bold).toBe(true);
    expect(frame.get(1, layout(80, 12)!.panes[0].head.col).style.bold).toBe(true); // v3: focused pane head stays bright in list focus
  });

  it('help cursor when the list has focus', async () => {
    const { cursor } = compose(await view({ focus: 'list', helpCursor: 7 }), 80, 12);
    expect(cursor).toEqual({ row: 11, col: 7 });
  });

  it('no agent: hint in the panel', async () => {
    const { frame } = compose(await view({ selected: 1, agent: null }), 80, 12);
    const L = layout(80, 12)!;
    const all = Array.from({ length: L.panes[0].body.rows }, (_, i) => text(frame, L.panes[0].body.row + i, L.panes[0].body.col)).join('\n');
    expect(all).toContain('에이전트가 없어요 — a로 띄우기');
    expect(text(frame, 1, L.panes[0].head.col)).toContain('(에이전트 없음)');
  });

  it('empty office: the panel hint points at p, not a', async () => {
    const { frame } = compose(await view({ rows: [], agent: null }), 80, 12);
    const L = layout(80, 12)!;
    const all = Array.from({ length: L.panes[0].body.rows }, (_, i) => text(frame, L.panes[0].body.row + i, L.panes[0].body.col)).join('\n');
    expect(all).toContain('p로 프로젝트를 추가하세요');
    expect(all).not.toContain('a로 띄우기');
  });

  it('exited agent: row has agentId but no terminal', async () => {
    const { frame } = compose(await view({ agent: null }), 80, 12);
    const L = layout(80, 12)!;
    const all = Array.from({ length: L.panes[0].body.rows }, (_, i) => text(frame, L.panes[0].body.row + i, L.panes[0].body.col)).join('\n');
    expect(all).toContain('종료됨');
  });

  it('scrolled back: head says so and no panel cursor', async () => {
    const { frame, cursor } = compose(await view({ scroll: 2 }), 80, 12);
    expect(text(frame, 1, layout(80, 12)!.panes[0].head.col)).toContain('↑ 기록 보는 중');
    expect(cursor).toBeNull();
  });

  it('too small', async () => {
    const { frame, cursor } = compose(await view(), 50, 8);
    expect(Array.from({ length: 8 }, (_, y) => text(frame, y)).join('\n')).toContain('창을 키워 주세요');
    expect(cursor).toBeNull();
  });

  it('every row is exactly cols wide with no split wide chars', async () => {
    for (const [c, r] of [[80, 12], [61, 10], [120, 30]] as const) {
      const { frame } = compose(await view({ help: ' 한글'.repeat(40) }), c, r);
      expect(frame.cols).toBe(c);
      for (let y = 0; y < r; y++) {
        for (let x = 0; x < c; x++) {
          const cell = frame.get(y, x);
          if (cell.width === 2) expect(frame.get(y, x + 1).width).toBe(0);
          if (cell.width === 0) expect(frame.get(y, x - 1).width).toBe(2);
        }
        expect(frame.get(y, c - 1).width).not.toBe(2);
      }
    }
  });

  it('preset 2: two agents side by side, divider, only the focused head bold', async () => {
    const a = await agentWith('AAA one');
    const b = await agentWith('BBB two');
    const v = base({ preset: 2, focusedPane: 1, panes: [pv(rows[0], a), pv(rows[0], b)] });
    const { frame } = compose(v, 160, 30);
    const L = layout(160, 30, 2)!;
    expect(L.preset).toBe(2);
    for (const [i, t] of [a, b].entries()) {
      const r = L.panes[i].body;
      const line = t.buffer.active.getLine(0)!;
      for (let x = 0; x < 7; x++) expect(frame.get(r.row, r.col + x).ch).toBe(line.getCell(x)!.getChars() || ' ');
    }
    const d = L.dividers[0];
    for (let y = d.row; y < d.row + d.rows; y++) expect(frame.get(y, d.col).ch).toBe('│');
    expect(frame.get(L.panes[0].head.row, L.panes[0].head.col + 1).style.bold).toBe(false);
    expect(frame.get(L.panes[1].head.row, L.panes[1].head.col + 1).style.bold).toBe(true);
  });

  it('preset 4 at 200x50: four heads and a crossing', async () => {
    const ts = await Promise.all([1, 2, 3, 4].map((n) => agentWith(`t${n}`)));
    const { frame } = compose(base({ preset: 4, panes: ts.map((t) => pv(rows[0], t)) }), 200, 50);
    const L = layout(200, 50, 4)!;
    expect(L.panes).toHaveLength(4);
    for (const p of L.panes) expect(text(frame, p.head.row, p.head.col, 20)).toContain('proj/main · claude');
    const [v, h] = L.dividers;
    expect(frame.get(h.row, v.col).ch).toBe('┼');
    expect(frame.get(h.row, v.col + 1).ch).toBe('─');
    expect(frame.get(v.row, v.col).ch).toBe('│');
  });

  it('preset 4: the focused pane head is drawn in reverse video, the others are not', async () => {
    const ts = await Promise.all([1, 2, 3, 4].map((n) => agentWith(`t${n}`)));
    for (const focus of ['list', 'panel'] as const) {
      const { frame } = compose(base({ preset: 4, focus, focusedPane: 2, panes: ts.map((t) => pv(rows[0], t)) }), 200, 50);
      const L = layout(200, 50, 4)!;
      const inv = L.panes.map((p) => [0, 5, p.head.cols - 1].every((x) => frame.get(p.head.row, p.head.col + x).style.inverse));
      expect(inv).toEqual([false, false, true, false]);
    }
  });

  it('preset 4 at 100x36 falls back to 3: two panes', async () => {
    const ts = await Promise.all([1, 2, 3, 4].map((n) => agentWith(`t${n}`)));
    const { frame } = compose(base({ preset: 4, panes: ts.map((t) => pv(rows[0], t)) }), 100, 36);
    const L = layout(100, 36, 4)!;
    expect(L.preset).toBe(3);
    expect(L.panes).toHaveLength(2);
    expect(frame.get(L.dividers[0].row, L.dividers[0].col + 3).ch).toBe('─');
  });

  it('selection overlay toggles inverse on the selected cells only', async () => {
    const t = await agentWith('say ok now');
    const selection = { pane: 0, anchor: { line: 0, col: 4 }, head: { line: 0, col: 5 } };
    const { frame } = compose(base({ panes: [pv(rows[0], t, { selection })] }), 80, 12);
    const r = layout(80, 12)!.panes[0].body;
    const inv = Array.from({ length: 10 }, (_, x) => frame.get(r.row, r.col + x).style.inverse);
    expect(inv).toEqual([false, false, false, false, true, true, false, false, false, false]);
  });

  it('cursor comes only from the focused pane in panel focus', async () => {
    const a = await agentWith('ab');
    const b = await agentWith('abcdef');
    const L = layout(160, 30, 2)!;
    const panes = [pv(rows[0], a), pv(rows[0], b)];
    const c1 = compose(base({ preset: 2, focusedPane: 1, panes }), 160, 30).cursor;
    expect(c1).toEqual({ row: L.panes[1].body.row, col: L.panes[1].body.col + 6 });
    const c0 = compose(base({ preset: 2, focusedPane: 0, panes }), 160, 30).cursor;
    expect(c0).toEqual({ row: L.panes[0].body.row, col: L.panes[0].body.col + 2 });
    expect(compose(base({ preset: 2, focusedPane: 1, focus: 'list', panes }), 160, 30).cursor).toBeNull();
    const scrolled = [pv(rows[0], a), pv(rows[0], b, { scroll: 1 })];
    expect(compose(base({ preset: 2, focusedPane: 1, panes: scrolled }), 160, 30).cursor).toBeNull();
  });

  it('empty pane shows (비어 있음) and a neutral hint, not a launch hint', async () => {
    const t = await agentWith('x');
    const { frame } = compose(base({ preset: 2, panes: [pv(rows[0], t), pv(null, null)] }), 160, 30);
    const L = layout(160, 30, 2)!;
    expect(text(frame, L.panes[1].head.row, L.panes[1].head.col)).toContain('(비어 있음)');
    const b = L.panes[1].body;
    const body = Array.from({ length: b.rows }, (_, i) => text(frame, b.row + i, b.col, b.cols)).join('\n');
    expect(body).toContain('목록에서 고르면 여기 보여요');
    expect(body).not.toContain('a로 띄우기');
    expect(frame.get(b.row + Math.floor((b.rows - 1) / 2), b.col + Math.floor(b.cols / 2)).style.dim).toBe(true);
  });

  it('empty office: head (에이전트 없음) and the p hint in every pane', async () => {
    const { frame } = compose(base({ rows: [], preset: 2, panes: [pv(null, null), pv(null, null)] }), 160, 30);
    const L = layout(160, 30, 2)!;
    for (const p of L.panes) {
      expect(text(frame, p.head.row, p.head.col, p.head.cols)).toContain('(에이전트 없음)');
      const body = Array.from({ length: p.body.rows }, (_, i) => text(frame, p.body.row + i, p.body.col, p.body.cols)).join('\n');
      expect(body).toContain('p로 프로젝트를 추가하세요');
    }
  });

  it('selection overlay covers both halves of a wide char', async () => {
    const t = await agentWith('ab한글cd');
    const r = layout(80, 12)!.panes[0].body;
    // Ends on 한's right half (col 3) and starts on 글's left... both chars fully reversed.
    const cases: [number, number, boolean[]][] = [
      [3, 3, [false, false, true, true, false, false]], // continuation cell of 한
      [4, 4, [false, false, false, false, true, true]], // lead cell of 글
      [1, 2, [false, true, true, true, false, false]],
    ];
    for (const [from, to, want] of cases) {
      const selection = { pane: 0, anchor: { line: 0, col: from }, head: { line: 0, col: to } };
      const { frame } = compose(base({ panes: [pv(rows[0], t, { selection })] }), 80, 12);
      expect(Array.from({ length: 6 }, (_, x) => frame.get(r.row, r.col + x).style.inverse)).toEqual(want);
    }
  });

  it('clamps an out-of-range focused pane to the drawn panes', async () => {
    const a = await agentWith('ab');
    const L = layout(80, 12)!;
    const { frame, cursor } = compose(base({ focusedPane: 3, panes: [pv(rows[0], a)] }), 80, 12);
    expect(frame.get(L.panes[0].head.row, L.panes[0].head.col + 1).style.bold).toBe(true);
    expect(cursor).toEqual({ row: L.panes[0].body.row, col: L.panes[0].body.col + 2 });
  });

  it('preset 4 frame rows are cols wide with no split wide chars', async () => {
    const ts = await Promise.all([1, 2, 3, 4].map((n) => agentWith(`한글 ${n}`.repeat(9))));
    const { frame } = compose(base({ preset: 4, panes: ts.map((t) => pv(rows[0], t)) }), 201, 50);
    for (let y = 0; y < 50; y++) {
      for (let x = 0; x < 201; x++) {
        const cell = frame.get(y, x);
        if (cell.width === 2) expect(frame.get(y, x + 1).width).toBe(0);
        if (cell.width === 0) expect(frame.get(y, x - 1).width).toBe(2);
      }
      expect(frame.get(y, 200).width).not.toBe(2);
    }
  });
});
