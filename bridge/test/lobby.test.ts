import { describe, expect, it } from 'vitest';
import type { OfficeSnapshot } from '../src/model.js';
import { lobbyRows } from '../src/tui/lobby.js';

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
