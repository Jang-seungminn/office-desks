import { describe, expect, it } from 'vitest';
import type { OfficeAgent, OfficeSnapshot } from '../../bridge/src/model';
import { Notices } from '../src/notices';

const agent = (id: string, state: OfficeAgent['state'], since: number): OfficeAgent => ({
  id,
  terminalHandle: 'h',
  agentType: 'claude',
  terminalTitle: null,
  subagentsRunning: 0,
  model: null,
  effort: null,
  state,
  rawState: state,
  activity: '',
  prompt: null,
  lastMessage: null,
  since,
});

const snap = (agents: OfficeAgent[], unread = false): OfficeSnapshot => ({
  updatedAt: 0,
  error: null,
  desks: [
    { id: 'd', repoId: 'r', isMain: true, parentId: null, name: 'd', repo: 'r', branch: '', path: '/d', status: 'active', workspaceStatus: null, comment: '', preview: '', isActive: false, unread, agents },
  ],
});

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('Notices', () => {
  it('flags reports that arrived after the office started, until the agent is opened', () => {
    let now = 1000;
    const n = new Notices(memory(), () => now);
    expect(n.attention(snap([agent('a', 'done', 500)]))).toEqual([]); // older than first run
    expect(n.attention(snap([agent('a', 'done', 2000)]))).toEqual([{ agentId: 'a', deskId: 'd', kind: 'done' }]);
    now = 3000;
    n.markSeen('a');
    expect(n.attention(snap([agent('a', 'done', 2000)]))).toEqual([]);
    expect(n.attention(snap([agent('a', 'waiting', 4000)]))).toEqual([{ agentId: 'a', deskId: 'd', kind: 'waiting' }]);
    expect(n.attention(snap([agent('a', 'typing', 5000)]))).toEqual([]);
  });

  it("counts Orca's unread flag until the agent is opened here", () => {
    let now = 1000;
    const n = new Notices(memory(), () => now);
    now = 2000;
    expect(n.attention(snap([agent('a', 'done', 0)], true))).toHaveLength(1);
    now = 3000;
    n.markSeen('a');
    expect(n.attention(snap([agent('a', 'done', 0)], true))).toHaveLength(0);
  });

  it('remembers read state across reloads', () => {
    const store = memory();
    const now = 1000;
    new Notices(store, () => now).markSeen('a');
    const again = new Notices(store, () => 5000);
    expect(again.attention(snap([agent('a', 'done', 900)]))).toEqual([]);
  });

  it('reports only fresh stops as notifications', () => {
    const n = new Notices(memory(), () => 0);
    expect(n.transitions(snap([agent('a', 'done', 1)]))).toEqual([]); // first look: nothing "changed"
    expect(n.transitions(snap([agent('a', 'typing', 2)]))).toEqual([]);
    expect(n.transitions(snap([agent('a', 'done', 3)]))).toEqual([{ agentId: 'a', deskId: 'd', kind: 'done' }]);
    expect(n.transitions(snap([agent('a', 'done', 3)]))).toEqual([]);
    expect(n.transitions(snap([agent('a', 'waiting', 4)]))).toEqual([{ agentId: 'a', deskId: 'd', kind: 'waiting' }]);
  });
});
