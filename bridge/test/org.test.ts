import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrg, sanitizeOrg, saveOrg } from '../src/org.js';
import { agentStats } from '../src/stats.js';

describe('org chart', () => {
  it('normalises names, themes and ids, and seats a project in one department only', () => {
    const out = sanitizeOrg({
      departments: [
        { id: 'd-a', name: '  개발   팀 ', theme: 'dev', repoIds: ['r1', 'r2'] },
        { id: 'd-a', name: '디자인', theme: 'nope', repoIds: ['r2', 'r3', 42] },
      ],
    });
    if ('error' in out) throw new Error(out.error);
    expect(out.departments[0]).toEqual({ id: 'd-a', name: '개발 팀', theme: 'dev', repoIds: ['r1', 'r2'] });
    expect(out.departments[1].id).not.toBe('d-a');
    expect(out.departments[1]).toMatchObject({ name: '디자인', theme: 'etc', repoIds: ['r3'] });
  });

  it('rejects bad input', () => {
    expect(sanitizeOrg(null)).toHaveProperty('error');
    expect(sanitizeOrg({ departments: [{ name: '' }] })).toHaveProperty('error');
    expect(sanitizeOrg({ departments: [{ name: 'x'.repeat(21) }] })).toHaveProperty('error');
    expect(sanitizeOrg({ departments: Array.from({ length: 21 }, (_, i) => ({ name: `d${i}` })) })).toHaveProperty('error');
  });

  it('round-trips through the file and survives a missing or broken one', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'org-'));
    const file = path.join(dir, 'sub', 'org.json');
    expect(await loadOrg(file)).toEqual({ departments: [] });
    const org = { departments: [{ id: 'd-x', name: 'X', theme: 'ops' as const, repoIds: ['r'] }] };
    await saveOrg(org, file);
    expect(await loadOrg(file)).toEqual(org);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(org);
  });
});

describe('agentStats', () => {
  it('counts instructions (today too), tool calls, subagents and the hire date', () => {
    const now = new Date(2026, 9, 3, 15);
    const today = new Date(2026, 9, 3, 9).toISOString();
    const before = new Date(2026, 8, 20, 9).toISOString();
    const s = agentStats(
      {
        messages: [
          { role: 'user', text: 'a', ts: before },
          { role: 'tool', text: 'Read', ts: before },
          { role: 'user', text: 'b', ts: today },
          { role: 'assistant', text: 'ok', ts: today },
          { role: 'tool', text: 'Bash', ts: today },
        ],
        calls: [{ toolUseId: 't', description: '', agentType: 'Explore', status: 'done' }],
      },
      now,
    );
    expect(s).toEqual({ instructions: 2, instructionsToday: 1, toolCalls: 2, subagents: 1, hiredAt: before });
  });
});
