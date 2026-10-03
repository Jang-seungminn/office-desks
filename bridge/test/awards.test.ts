import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AwardBook, bestToday } from '../src/awards.js';
import type { OfficeAgent, OfficeDesk } from '../src/model.js';

const agent = (id: string, instructionsToday: number, toolCallsToday: number): OfficeAgent => ({
  id,
  terminalHandle: null,
  agentType: 'claude',
  terminalTitle: `${id} 작업`,
  subagentsRunning: 0,
  model: null,
  effort: null,
  stats: { instructions: 50, instructionsToday, toolCalls: 100, toolCallsToday, subagents: 0, hiredAt: null },
  state: 'done',
  rawState: 'done',
  activity: '',
  prompt: null,
  lastMessage: null,
  since: null,
});

const desk = (agents: OfficeAgent[]): OfficeDesk => ({
  id: 'r::/w', repoId: 'r', isMain: true, parentId: null, name: 'w', repo: 'web', branch: 'main', path: '/w',
  status: 'active', workspaceStatus: null, comment: '', preview: '', isActive: false, unread: false,
  lastActivityAt: null, changes: null, pr: null, agents,
});

describe('awards', () => {
  it('scores instructions ×10 + tool calls and skips idle agents', () => {
    const best = bestToday([desk([agent('a', 3, 5), agent('b', 2, 40), agent('c', 0, 900)])], '2026-10-03');
    expect(best).toMatchObject({ agentId: 'b', score: 60, name: 'b 작업', repo: 'web' });
    expect(bestToday([desk([agent('c', 0, 900)])], '2026-10-03')).toBeNull();
  });

  it('keeps the day leader and crowns it when the date changes', async () => {
    const book = new AwardBook(path.join(await mkdtemp(path.join(os.tmpdir(), 'aw-')), 'awards.json'));
    await book.load();
    const day1 = new Date(2026, 9, 3, 10);
    expect(book.update([desk([agent('a', 3, 5)])], day1)).toBe(true);
    // a closes its terminal; a weaker agent doesn't steal the lead
    expect(book.update([desk([agent('b', 1, 1)])], day1)).toBe(false);
    expect(book.current.leader?.agentId).toBe('a');
    const day2 = new Date(2026, 9, 4, 9);
    expect(book.update([desk([])], day2)).toBe(true);
    expect(book.current.hall.map((h) => [h.date, h.agentId])).toEqual([['2026-10-03', 'a']]);
    expect(book.current.leader).toBeNull();
    await book.save();
    const again = new AwardBook((book as unknown as { file: string }).file);
    await again.load();
    expect(again.current.hall).toHaveLength(1);
  });
});
