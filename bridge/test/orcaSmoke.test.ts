import { describe, expect, it } from 'vitest';
import { newLog, readOnly } from '../scripts/orca-smoke.js';

// The smoke script's allowlist, with a fake inner runner: nothing here runs the real orca.
describe('orca-smoke readOnly', () => {
  it('refuses and records a non-allowed argv without running it', async () => {
    const ran: string[][] = [];
    const log = newLog();
    const ro = readOnly(async (args) => (ran.push(args), {}), log);
    await expect(ro(['terminal', 'send', '--terminal', 't1', '--text=hi'])).rejects.toThrow('smoke: refused terminal send --terminal t1 --text=hi');
    await expect(ro(['worktree', 'create'])).rejects.toThrow('smoke: refused worktree create');
    await expect(ro(['terminal'])).rejects.toThrow();
    await expect(ro(['statusx'])).rejects.toThrow();
    expect(ran).toEqual([]);
    expect(log.refused).toEqual(['terminal send --terminal t1 --text=hi', 'worktree create', 'terminal', 'statusx']);
    expect(log.calls).toEqual({ status: 0, 'worktree ps': 0, 'terminal list': 0, 'terminal read': 0 });
  });

  it('runs and counts the allowed prefixes', async () => {
    const ran: string[][] = [];
    const log = newLog();
    const ro = readOnly(async (args) => (ran.push(args), {}), log);
    for (const a of [['status'], ['worktree', 'ps'], ['terminal', 'list'], ['terminal', 'read', '--terminal', 't1', '--screen'], ['terminal', 'read', '--terminal', 't2', '--screen']]) {
      await ro(a);
    }
    expect(ran).toHaveLength(5);
    expect(log.refused).toEqual([]);
    expect(log.calls).toEqual({ status: 1, 'worktree ps': 1, 'terminal list': 1, 'terminal read': 2 });
  });
});
