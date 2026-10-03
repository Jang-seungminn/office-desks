import { describe, expect, it } from 'vitest';
import type { OfficeAgent, OfficeDesk } from '../../bridge/src/model';
import { arrangeOffice, zoneOf } from '../src/arrange';

const agent = (state: OfficeAgent['state'], since: number): OfficeAgent => ({
  id: `${state}${since}`,
  terminalHandle: null,
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

const desk = (name: string, repo: string, agents: OfficeAgent[], lastActivityAt = 0): OfficeDesk => ({
  id: `${repo}::/${name}`,
  repoId: repo,
  isMain: false,
  parentId: null,
  name,
  repo,
  branch: name,
  path: `/${name}`,
  status: 'active',
  workspaceStatus: null,
  comment: '',
  preview: '',
  isActive: false,
  unread: false,
  lastActivityAt,
  changes: null,
  pr: null,
  agents,
});

describe('arrangeOffice', () => {
  const desks = [
    desk('a-old-work', 'A', [agent('typing', 100)]),
    desk('b-new-work', 'B', [agent('running', 300)]),
    desk('a-new-work', 'A', [agent('reading', 200), agent('done', 999)]),
    desk('a-done', 'A', [agent('done', 50)]),
    desk('b-asks', 'B', [agent('waiting', 80)]),
    desk('a-empty', 'A', [], 10),
    desk('c-empty', 'C', [], 20),
  ];

  it('puts working, then waiting, then agent-less worktrees on separate floors', () => {
    expect(arrangeOffice(desks).map((z) => [z.key, z.count])).toEqual([
      ['working', 3],
      ['waiting', 2],
      ['idle', 2],
    ]);
    expect(zoneOf(desks[2])).toBe('working'); // one active agent is enough
  });

  it('orders rooms and desks newest first, splitting a repo across floors', () => {
    const [working, waiting, idle] = arrangeOffice(desks);
    // B's newest work (300) beats A's (200); inside A, 200 before 100. A finished agent doesn't count as work.
    expect(working.rooms.map((r) => [r.repo, r.desks.map((d) => d.name)])).toEqual([
      ['B', ['b-new-work']],
      ['A', ['a-new-work', 'a-old-work']],
    ]);
    expect(waiting.rooms.map((r) => r.repo)).toEqual(['B', 'A']);
    expect(idle.rooms.map((r) => r.repo)).toEqual(['C', 'A']);
    expect(working.rooms[1].total).toBe(4);
  });

  it('keeps finished agents with an unopened report on the top floor until they are opened', () => {
    const finished = desk('just-done', 'D', [{ ...agent('done', 500), id: 'fresh' }]);
    const [top] = arrangeOffice([...desks, finished], new Set(['fresh']));
    expect(top.key).toBe('working');
    expect(top.rooms[0].desks.map((d) => d.name)).toEqual(['just-done']); // newest (500) first
    expect(arrangeOffice([finished]).map((z) => z.key)).toEqual(['waiting']); // once seen
  });

  it('skips empty floors', () => {
    expect(arrangeOffice([desk('x', 'X', [])]).map((z) => z.key)).toEqual(['idle']);
  });
});
