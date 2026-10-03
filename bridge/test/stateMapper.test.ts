import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTitle, mapAgentState, toSnapshot } from '../src/stateMapper.js';

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const ps = load('worktree-ps.json');
const terms = load('terminal-list.json');

describe('mapAgentState', () => {
  it.each([
    ['waiting', 'ExitPlanMode', 'waiting'],
    ['done', null, 'done'],
    ['working', 'Edit', 'typing'],
    ['working', null, 'typing'],
    ['working', 'Read', 'reading'],
    ['working', 'WebSearch', 'reading'],
    ['working', 'Bash', 'running'],
    ['something-new', null, 'away'],
    [undefined, null, 'away'],
  ] as const)('%s + %s -> %s', (raw, tool, expected) => {
    expect(mapAgentState(raw, tool)).toBe(expected);
  });
});

describe('toSnapshot', () => {
  const snap = toSnapshot(ps.worktrees, terms.terminals, 123);

  it('drops archived worktrees and keeps a stable id order', () => {
    expect(snap.desks.map((d) => d.id)).toEqual([
      'repoA::/Users/me/proj/office_desks',
      'repoB::C:\\Users\\me\\secretary',
      'repoD::/Users/me/empty',
    ]);
    expect(snap.updatedAt).toBe(123);
  });

  it('joins agents to terminal handles via paneKey', () => {
    const [a, b] = snap.desks;
    expect(a.agents[0].terminalHandle).toBe('term_1');
    expect(b.agents.map((x) => x.terminalHandle)).toEqual(['term_2', 'term_3', null, null]);
  });

  it('builds readable activity lines', () => {
    const b = snap.desks[1];
    expect(snap.desks[0].agents[0].activity).toBe('Needs you: ExitPlanMode');
    expect(b.agents[0].activity).toBe('Bash: npm test --watch=false');
    expect(b.agents[2].activity).toBe('Thinking…');
    expect(b.agents[3].activity).toMatch(/^Done/);
    expect(b.agents[3].lastMessage).toBe('All green.');
  });

  it('names desks by repo when displayName is empty or just the branch (Windows paths intact)', () => {
    const b = snap.desks[1];
    expect(b.name).toBe('secretary');
    expect(toSnapshot([{ worktreeId: 'r::/x', repo: 'vault', displayName: 'main', branch: 'refs/heads/main' }], []).desks[0].name).toBe('vault');
    expect(b.branch).toBe('knowledge-graph');
    expect(b.path).toBe('C:\\Users\\me\\secretary');
  });

  it('cleans spinner glyphs off terminal titles', () => {
    expect(cleanTitle('✳ command context logging')).toBe('command context logging');
    expect(cleanTitle('◑ Orca 터미널 대시보드 프로젝트')).toBe('Orca 터미널 대시보드 프로젝트');
    expect(cleanTitle('⠂ ')).toBeNull();
    expect(snap.desks[0].agents[0].terminalTitle).toBe('Fix login');
  });

  it('keeps desks with no agents (empty desk)', () => {
    expect(snap.desks[2].agents).toEqual([]);
  });

  it('tolerates missing fields', () => {
    expect(() => toSnapshot([{ worktreeId: 'x::y', agents: [{}] }], [])).not.toThrow();
  });
});
