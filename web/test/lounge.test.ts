import { describe, expect, it } from 'vitest';
import type { OfficeAgent, OfficeDesk } from '../../bridge/src/model';
import { chatLine, LOUNGE_AFTER_MS, loungeSlots, restingAgents } from '../src/lounge';

const agent = (id: string, state: OfficeAgent['state'], since: number | null): OfficeAgent => ({
  id, terminalHandle: null, agentType: 'claude', terminalTitle: null, subagentsRunning: 0, model: null, effort: null,
  stats: { instructions: 9, instructionsToday: 4, toolCalls: 10, toolCallsToday: 3, subagents: 0, hiredAt: null },
  state, rawState: state, activity: '', prompt: null, lastMessage: '## 로그인 버그를 고쳤습니다. 테스트도 통과했어요.', since,
});
const desk = (agents: OfficeAgent[]): OfficeDesk => ({
  id: 'r::/w', repoId: 'r', isMain: true, parentId: null, name: 'w', repo: 'web', branch: 'main', path: '/w', status: 'active',
  workspaceStatus: null, comment: '', preview: '', isActive: false, unread: false, lastActivityAt: null, changes: null, pr: null, agents,
});

describe('lounge', () => {
  const now = 10 * LOUNGE_AFTER_MS;
  it('sends only agents that finished a while ago and have nothing unseen, longest rest first', () => {
    const d = desk([
      agent('fresh', 'done', now - 1000),
      agent('old', 'done', now - 5 * LOUNGE_AFTER_MS),
      agent('older', 'done', now - 6 * LOUNGE_AFTER_MS),
      agent('busy', 'typing', 0),
      agent('waiting', 'waiting', 0),
      agent('unread', 'done', 0),
    ]);
    expect(restingAgents([d], new Set(['unread']), now, 5).map((r) => r.agent.id)).toEqual(['older', 'old']);
    expect(restingAgents([d], new Set(), now, 1).map((r) => r.agent.id)).toEqual(['unread']);
  });

  it('has five spots and talks about real work', () => {
    expect(loungeSlots({ x: 0, y: 0, w: 250, h: 230 })).toHaveLength(5);
    const r = { agent: agent('a', 'done', 0), desk: desk([]) };
    const lines = [0, 1, 2, 3, 4].map((i) => chatLine(r, i));
    expect(lines).toContain('web 일 하나 끝냈어요');
    expect(lines).toContain('방금 "로그인 버그를 고쳤습니다."');
    expect(lines).toContain('오늘 지시 4건 했어요');
  });
});
