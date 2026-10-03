import { describe, expect, it } from 'vitest';
import type { OfficeAgent, OfficeDesk } from '../../bridge/src/model';
import { LOUNGE_AFTER_MS, loungeSlots, restingAgents } from '../src/lounge';
import { bossReply, pickTalk, reportLine } from '../src/chatter';

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

  it('has five spots', () => {
    expect(loungeSlots({ x: 0, y: 0, w: 250, h: 230 })).toHaveLength(5);
  });

  it('talks about real work, varies, and avoids recent topics', () => {
    const a = { agent: agent('a', 'done', 0), desk: desk([]) };
    const b = { agent: { ...agent('b', 'done', 0), model: 'claude-haiku-4-5' }, desk: { ...desk([]), repo: 'api' } };
    const ctx = { a: { ...a, agent: { ...a.agent, model: 'claude-opus-5-5' } }, b, now: new Date(2026, 9, 5, 12), department: () => '개발팀', awards: null };
    const seen = new Set<string>();
    const lines = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = pickTalk(ctx, new Set());
      seen.add(t.key);
      lines.add(t.lines[0]);
      expect(t.lines[1]).toBeTruthy();
    }
    expect(seen.size).toBeGreaterThan(25);
    expect(lines).toContain('방금 "로그인 버그를 고쳤습니다."');
    expect(lines).toContain('점심 뭐 먹어요?'); // Monday noon
    expect(lines).toContain('월요일이라 지시가 많네요');
    expect(lines).toContain('저 Opus라 생각이 깊어요');
    // Everything recent is skipped while there's something else to say.
    const recent = new Set([...seen].slice(0, 20));
    for (let i = 0; i < 50; i++) expect(recent.has(pickTalk(ctx, recent).key)).toBe(false);
  });

  it('mumbles alone and reports to the boss', () => {
    const a = { agent: agent('a', 'done', 0), desk: desk([]) };
    const t = pickTalk({ a, b: null, now: new Date(), department: () => null, awards: null }, new Set());
    expect(t.lines[1]).toBeNull();
    expect(reportLine(a)).toBe('보고드립니다! 로그인 버그를 고쳤습니다.');
    const awards = { leader: { agentId: 'a' } as never, hall: [] };
    expect(bossReply(a, awards, 0)).toBe('오늘 1등답네요!');
  });
});
