import { describe, expect, it } from 'vitest';
import type { CharacterState, OfficeAgent, OfficeDesk, OfficeSnapshot } from '../../bridge/src/model';
import { projects, STATE_LABEL, tabTitle } from '../src/tree';

export function desk(o: Partial<OfficeDesk>): OfficeDesk {
  return { id: 'r1::/p', repoId: 'r1', isMain: false, parentId: null, name: 'wt', repo: 'repo', branch: 'b', path: '/p', status: 'inactive', workspaceStatus: null, comment: '', preview: '', isActive: false, unread: false, lastActivityAt: null, changes: null, pr: null, agents: [], ...o };
}
export function agent(o: Partial<OfficeAgent>): OfficeAgent {
  return { id: 'a1', terminalHandle: null, agentType: 'claude', terminalTitle: null, subagentsRunning: 0, model: null, effort: null, stats: null, state: 'done', rawState: '', activity: '', prompt: null, lastMessage: null, since: null, ...o };
}
export const snap = (desks: OfficeDesk[], error: string | null = null): OfficeSnapshot => ({ desks, updatedAt: 0, error });

describe('tree', () => {
  it('groups, sorts and names projects', () => {
    const s = snap([
      desk({ id: '1', repoId: 'z', repo: 'zeta', name: 'b' }),
      desk({ id: '2', repoId: 'z', repo: 'zeta', name: 'main', isMain: true }),
      desk({ id: '3', repoId: 'z', repo: 'zeta', name: 'a' }),
      desk({ id: '4', repoId: 'y', repo: 'alpha', name: 'only' }),
    ]);
    const ps = projects(s);
    expect(ps.map((p) => p.name)).toEqual(['alpha', 'zeta']);
    expect(ps[1].desks.map((d) => d.name)).toEqual(['main', 'a', 'b']);
  });
  it('null gives []', () => expect(projects(null)).toEqual([]));
  it('labels every state', () => {
    const all: CharacterState[] = ['typing', 'reading', 'running', 'waiting', 'done', 'away'];
    for (const st of all) expect(STATE_LABEL[st]).toBeTruthy();
  });
  it('tabTitle', () => expect(tabTitle(desk({ name: 'wt1' }), agent({}))).toBe('wt1 · claude'));
});
