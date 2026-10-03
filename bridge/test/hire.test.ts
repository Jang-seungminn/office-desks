import { describe, expect, it } from 'vitest';
import { planHire } from '../src/hire.js';
import type { OfficeDesk } from '../src/model.js';

const desks = [{ id: 'r1::/p/main', repoId: 'r1', name: 'main' }, { id: 'r1::/p/feat', repoId: 'r1', name: 'feat' }] as OfficeDesk[];

describe('planHire', () => {
  it('builds a new-worktree command with --flag=value only', () => {
    expect(planHire({ repoId: 'r1', name: 'fix-login', agent: 'claude', prompt: ' --help me ', baseBranch: 'origin/main' }, desks)).toEqual({
      kind: 'worktree',
      args: ['worktree', 'create', '--repo=id:r1', '--name=fix-login', '--no-parent', '--agent=claude', '--base-branch=origin/main', '--prompt=--help me'],
      promptAfter: null,
    });
  });

  it('adds an agent to an existing worktree and sends the prompt later', () => {
    expect(planHire({ deskId: 'r1::/p/feat', agent: 'codex', prompt: 'go' }, desks)).toEqual({
      kind: 'agent',
      args: ['terminal', 'create', '--worktree=id:r1::/p/feat', '--command=codex', '--title=codex'],
      promptAfter: 'go',
    });
  });

  it('rejects unknown repos/worktrees/agents and unsafe names', () => {
    const bad = [
      { repoId: 'nope', name: 'x', agent: 'claude' },
      { repoId: 'r1', name: '--fresh', agent: 'claude' },
      { repoId: 'r1', name: 'a b', agent: 'claude' },
      { repoId: 'r1', name: 'feat', agent: 'claude' },
      { repoId: 'r1', name: 'ok', agent: 'bash -c x' },
      { repoId: 'r1', name: 'ok', agent: 'claude', baseBranch: '-x' },
      { deskId: 'r1::/elsewhere', agent: 'claude' },
    ];
    for (const b of bad) expect('error' in planHire(b, desks)).toBe(true);
  });
});
