import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { compose, type View } from '../src/tui/compose.js';
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

async function view(patch: Partial<View> = {}): Promise<View> {
  const agent = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
  await write(agent, 'hello agent\r\nsecond');
  return { rows, selected: 0, focus: 'panel', url: 'http://x:1', agent, scroll: 0, agentCursorHidden: false, help: ' q 종료', helpCursor: null, ...patch };
}

describe('compose', () => {
  it('panel focus: title, panel text, separator, cursor and help', async () => {
    const v = await view();
    const { frame, cursor } = compose(v, 80, 12);
    const L = layout(80, 12)!;
    expect(text(frame, 0)).toContain('Office Desks');
    expect(text(frame, 0)).toContain('http://x:1');
    expect(text(frame, 0)).toContain('✎ 1  ! 0');
    expect(text(frame, 2, L.panel.col)).toContain('hello agent');
    expect(text(frame, 1, L.panel.col)).toContain('proj/main · claude');
    for (let y = 1; y <= 10; y++) expect(frame.get(y, L.sep.col).ch).toBe('│');
    expect(cursor).toEqual({ row: L.panel.row + 1, col: L.panel.col + 6 });
    expect(text(frame, 11)).toBe(' q 종료'.padEnd(80 - 2, ' ')); // 한글 is 4 cols for 2 chars
  });

  it('panel focus with the agent cursor hidden: still placed (IME), but marked hidden', async () => {
    const L = layout(80, 12)!;
    const { cursor } = compose(await view({ agentCursorHidden: true }), 80, 12);
    expect(cursor).toEqual({ row: L.panel.row + 1, col: L.panel.col + 6, hidden: true });
  });

  it('list focus: no cursor, list head bold', async () => {
    const { frame, cursor } = compose(await view({ focus: 'list' }), 80, 12);
    expect(cursor).toBeNull();
    expect(frame.get(1, 1).style.bold).toBe(true);
    expect(frame.get(1, layout(80, 12)!.panelHead.col).style.bold).toBe(false);
  });

  it('help cursor when the list has focus', async () => {
    const { cursor } = compose(await view({ focus: 'list', helpCursor: 7 }), 80, 12);
    expect(cursor).toEqual({ row: 11, col: 7 });
  });

  it('no agent: hint in the panel', async () => {
    const { frame } = compose(await view({ selected: 1, agent: null }), 80, 12);
    const L = layout(80, 12)!;
    const all = Array.from({ length: L.panel.rows }, (_, i) => text(frame, L.panel.row + i, L.panel.col)).join('\n');
    expect(all).toContain('에이전트가 없어요 — a로 띄우기');
    expect(text(frame, 1, L.panelHead.col)).toContain('(에이전트 없음)');
  });

  it('empty office: the panel hint points at p, not a', async () => {
    const { frame } = compose(await view({ rows: [], agent: null }), 80, 12);
    const L = layout(80, 12)!;
    const all = Array.from({ length: L.panel.rows }, (_, i) => text(frame, L.panel.row + i, L.panel.col)).join('\n');
    expect(all).toContain('p로 프로젝트를 추가하세요');
    expect(all).not.toContain('a로 띄우기');
  });

  it('exited agent: row has agentId but no terminal', async () => {
    const { frame } = compose(await view({ agent: null }), 80, 12);
    const L = layout(80, 12)!;
    const all = Array.from({ length: L.panel.rows }, (_, i) => text(frame, L.panel.row + i, L.panel.col)).join('\n');
    expect(all).toContain('종료됨');
  });

  it('scrolled back: head says so and no panel cursor', async () => {
    const { frame, cursor } = compose(await view({ scroll: 2 }), 80, 12);
    expect(text(frame, 1, layout(80, 12)!.panelHead.col)).toContain('↑ 기록 보는 중');
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
});
