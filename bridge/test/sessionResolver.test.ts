import { describe, expect, it } from 'vitest';
import type { OfficeAgent, OfficeDesk } from '../src/model.js';
import { searchKey, SessionResolver } from '../src/sessionResolver.js';

const agent = (over: Partial<OfficeAgent> = {}): OfficeAgent => ({
  id: 'tab:leaf',
  terminalHandle: 'term_1',
  agentType: 'claude',
  terminalTitle: null,
  subagentsRunning: 0,
  model: null,
  effort: null,
  stats: null,
  state: 'done',
  rawState: 'done',
  activity: '',
  prompt: 'add pixel assets please',
  lastMessage: null,
  since: null,
  ...over,
});
const desk = { id: 'r::/Users/me/proj', path: '/Users/me/proj' } as OfficeDesk;

describe('searchKey', () => {
  it('prefers the prompt, then the session title, then the last message; refuses tiny text', () => {
    expect(searchKey(agent())).toEqual({ phrase: 'add pixel assets please', title: null });
    expect(searchKey(agent({ prompt: '', terminalTitle: 'Command context logging' }))).toEqual({
      phrase: 'Command context logging',
      title: 'Command context logging',
    });
    expect(searchKey(agent({ prompt: '', terminalTitle: 'claude', lastMessage: 'Fixed the orphan pages, lint is clean' }))?.phrase).toBe(
      'Fixed the orphan pages, lint is clean',
    );
    expect(searchKey(agent({ prompt: '1', lastMessage: null }))).toBeNull();
    expect(searchKey(agent({ prompt: 'run "&calc&" now please' }), 'win32')?.phrase).toBe('run calc now please');
  });
});

describe('SessionResolver', () => {
  it('passes path/agent filters, ignores hits from other cwds, caches per phrase', async () => {
    const calls: string[][] = [];
    const resolver = new SessionResolver(async (args) => {
      calls.push(args);
      return {
        hits: [
          { cwd: '/Users/me/other', source: { presence: 'present', filePath: '/x/other.jsonl' } },
          { cwd: '/Users/me/proj/', source: { presence: 'present', filePath: '/x/mine.jsonl' } },
        ],
      };
    });
    expect(await resolver.resolve(desk, agent())).toBe('/x/mine.jsonl');
    expect(calls[0]).toEqual(expect.arrayContaining(['--path=/Users/me/proj', '--agent=claude', '--sort=newest', '--query=add pixel assets please']));
    await resolver.resolve(desk, agent());
    expect(calls).toHaveLength(1);
    await resolver.resolve(desk, agent({ prompt: 'a brand new prompt' }));
    expect(calls).toHaveLength(2);
  });

  it('caches misses for 30s instead of searching every poll, and keeps the last good session', async () => {
    let calls = 0;
    let hits: unknown[] = [{ cwd: '/Users/me/proj', source: { filePath: '/x/a.jsonl' } }];
    let now = 0;
    const resolver = new SessionResolver(
      async () => {
        calls++;
        return { hits };
      },
      undefined,
      () => now,
    );
    expect(await resolver.resolve(desk, agent())).toBe('/x/a.jsonl');
    hits = [];
    expect(await resolver.resolve(desk, agent({ prompt: 'not indexed yet' }))).toBe('/x/a.jsonl');
    expect(await resolver.resolve(desk, agent({ prompt: 'not indexed yet' }))).toBe('/x/a.jsonl');
    expect(calls).toBe(2);
    now += 31_000;
    await resolver.resolve(desk, agent({ prompt: 'not indexed yet' }));
    expect(calls).toBe(3);
  });

  it('skips hits whose transcript fails verification (fuzzy matches from other sessions)', async () => {
    const resolver = new SessionResolver(
      async () => ({
        hits: [
          { cwd: '/Users/me/proj', source: { filePath: '/x/wrong.jsonl' } },
          { cwd: '/Users/me/proj', source: { filePath: '/x/right.jsonl' } },
        ],
      }),
      async (file) => file === '/x/right.jsonl',
    );
    expect(await resolver.resolve(desk, agent())).toBe('/x/right.jsonl');
  });

  it('prefers the hit whose session title matches when searching by title', async () => {
    const resolver = new SessionResolver(async () => ({
      hits: [
        { title: 'Other session', cwd: '/Users/me/proj', source: { filePath: '/x/other.jsonl' } },
        { title: 'command context logging', cwd: '/Users/me/proj', source: { filePath: '/x/title.jsonl' } },
      ],
    }));
    expect(await resolver.resolve(desk, agent({ prompt: '', terminalTitle: 'Command context logging' }))).toBe('/x/title.jsonl');
  });
});
