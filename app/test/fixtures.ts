import type { OfficeAgent, OfficeDesk, OfficeSnapshot } from '../../bridge/src/model';

export function desk(o: Partial<OfficeDesk>): OfficeDesk {
  return { id: 'r1::/p', repoId: 'r1', isMain: false, parentId: null, name: 'wt', repo: 'repo', branch: 'b', path: '/p', status: 'inactive', workspaceStatus: null, comment: '', preview: '', isActive: false, unread: false, lastActivityAt: null, changes: null, pr: null, agents: [], ...o };
}
export function agent(o: Partial<OfficeAgent>): OfficeAgent {
  return { id: 'a1', terminalHandle: null, agentType: 'claude', terminalTitle: null, subagentsRunning: 0, model: null, effort: null, stats: null, state: 'done', rawState: '', activity: '', prompt: null, lastMessage: null, since: null, ...o };
}
export const snap = (desks: OfficeDesk[], error: string | null = null): OfficeSnapshot => ({ desks, updatedAt: 0, error });
