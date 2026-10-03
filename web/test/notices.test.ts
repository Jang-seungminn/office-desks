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
  stats: null,
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
    { id: 'd', repoId: 'r', isMain: true, parentId: null, name: 'd', repo: 'r', branch: '', path: '/d', status: 'active', workspaceStatus: null, comment: '', preview: '', isActive: false, unread, lastActivityAt: null, changes: null, pr: null, agents },
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

  it('pops up only for finishes after real work, and rate-limits per agent', () => {
    let now = 0;
    const n = new Notices(memory(), () => now);
    expect(n.transitions(snap([agent('a', 'done', 0)]))).toEqual([]); // first look: nothing "changed"
    now = 1000;
    expect(n.transitions(snap([agent('a', 'typing', 1000)]))).toEqual([]);
    now = 6000;
    expect(n.transitions(snap([agent('a', 'reading', 6000)]))).toEqual([]); // still the same work stretch
    now = 5000 + 30_000;
    expect(n.transitions(snap([agent('a', 'done', now)]))).toEqual([{ agentId: 'a', deskId: 'd', kind: 'done' }]); // worked 34s
    // A background job wakes it for 3 seconds: badge-worthy, not popup-worthy.
    now += 10_000;
    n.transitions(snap([agent('a', 'typing', now)]));
    now += 3_000;
    expect(n.transitions(snap([agent('a', 'done', now)]))).toEqual([]);
    // Long work again, but within the 2-minute cooldown: still quiet.
    n.transitions(snap([agent('a', 'typing', now)]));
    now += 40_000;
    expect(n.transitions(snap([agent('a', 'done', now)]))).toEqual([]);
    // Waiting on the human always pops up (with its own short cooldown).
    now += 1_000;
    expect(n.transitions(snap([agent('a', 'waiting', now)]))).toEqual([{ agentId: 'a', deskId: 'd', kind: 'waiting' }]);
  });
});
