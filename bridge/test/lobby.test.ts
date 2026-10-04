import { describe, expect, it } from 'vitest';
import type { OfficeSnapshot } from '../src/model.js';
import { lobbyRows, renderLobby } from '../src/tui/lobby.js';
import { displayWidth } from '../src/tui/text.js';

const agent = (id: string, state: string, activity: string, agentType = 'claude') => ({ id, agentType, state, activity, terminalHandle: `pty_${id}` });
const snap = {
  desks: [
    { id: 'r2::/w/api', repoId: 'r2', repo: 'api', name: 'api', branch: 'main', agents: [] },
    { id: 'r1::/w/fix', repoId: 'r1', repo: 'app', name: 'fix-login', branch: 'fix-login', agents: [agent('b', 'typing', 'Edit: src/a.ts'), agent('c', 'done', '완료 · 다음 지시 대기', 'codex')] },
    { id: 'r1::/w/app', repoId: 'r1', repo: 'app', name: 'app', branch: 'main', agents: [agent('a', 'waiting', '확인 필요: Bash')] },
  ],
  updatedAt: 0,
  error: null,
} as unknown as OfficeSnapshot;

describe('lobbyRows', () => {
  it('orders by repo then worktree, one row per agent, one row for an empty worktree', () => {
    expect(lobbyRows(snap).map((r) => [r.repo, r.desk, r.agentId])).toEqual([
      ['api', 'api', null],
      ['app', 'app', 'a'],
      ['app', 'fix-login', 'b'],
      ['app', 'fix-login', 'c'],
    ]);
  });
});

describe('renderLobby', () => {
  const view = { rows: lobbyRows(snap), selected: 2, url: 'http://127.0.0.1:4318', notice: null };

  it('draws a header, repo groups, the selection marker and the key help, all exactly cols wide', () => {
    const out = renderLobby(view, 80, 14);
    expect(out).toHaveLength(14);
    for (const line of out) expect(displayWidth(line.replace(/\x1b\[[0-9;]*m/g, ''))).toBe(80);
    const text = out.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(text[0]).toContain('Office Desks');
    expect(text[0]).toContain('http://127.0.0.1:4318');
    expect(text.some((l) => l.trimEnd() === ' api')).toBe(true);
    expect(text.find((l) => l.includes('Edit: src/a.ts'))).toMatch(/^ ▸ /);
    expect(text.find((l) => l.includes('확인 필요'))).toMatch(/^ {3}/);
    expect(text.at(-1)).toContain('Enter 붙기');
  });

  it('shows how to start when there are no projects, and asks for a bigger window when too small', () => {
    const empty = renderLobby({ rows: [], selected: 0, url: 'u', notice: null }, 80, 10).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(empty.some((l) => l.includes('p로 git 저장소를 추가하세요'))).toBe(true);
    expect(renderLobby(view, 40, 8).map((l) => l.trim())).toContain('창을 키워 주세요');
  });

  it('scrolls to keep the selection visible and shows a notice above the help', () => {
    const many = { ...view, rows: Array.from({ length: 30 }, (_, i) => ({ ...view.rows[1], agentId: `x${i}`, activity: `row ${i}` })), selected: 25, notice: '프로젝트를 추가했어요' };
    const text = renderLobby(many, 80, 12).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(text.some((l) => l.includes('row 25') && l.startsWith(' ▸ '))).toBe(true);
    expect(text.at(-2)).toContain('프로젝트를 추가했어요');
  });
});
