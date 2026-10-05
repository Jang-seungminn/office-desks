import { describe, expect, it } from 'vitest';
import { orcaHireArgs } from '../src/backend/orca.js';
import { validateHire } from '../src/hire.js';
import type { OfficeDesk } from '../src/model.js';

const desks = [{ id: 'r1::/p/main', repoId: 'r1', name: 'main' }, { id: 'r1::/p/feat', repoId: 'r1', name: 'feat' }] as OfficeDesk[];

describe('validateHire', () => {
  it('accepts a new worktree and trims the prompt', () => {
    expect(validateHire({ repoId: 'r1', name: 'fix-login', agent: 'claude', prompt: ' --help me ', baseBranch: 'origin/main' }, desks)).toEqual({
      kind: 'worktree',
      repoId: 'r1',
      name: 'fix-login',
      agent: 'claude',
      baseBranch: 'origin/main',
      prompt: '--help me',
    });
  });

  it('accepts another agent in an existing worktree', () => {
    expect(validateHire({ deskId: 'r1::/p/feat', agent: 'codex', prompt: 'go' }, desks)).toEqual({
      kind: 'agent',
      deskId: 'r1::/p/feat',
      agent: 'codex',
      prompt: 'go',
    });
    expect(validateHire({ deskId: 'r1::/p/feat', agent: 'codex' }, desks)).toMatchObject({ prompt: null });
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
    for (const b of bad) expect('error' in validateHire(b, desks)).toBe(true);
  });
});

describe('orcaHireArgs', () => {
  it('builds a new-worktree command with --flag=value only', () => {
    expect(orcaHireArgs({ kind: 'worktree', repoId: 'r1', name: 'fix-login', agent: 'claude', baseBranch: 'origin/main', prompt: '--help me' })).toEqual([
      'worktree', 'create', '--repo=id:r1', '--name=fix-login', '--no-parent', '--agent=claude', '--base-branch=origin/main', '--prompt=--help me',
    ]);
    expect(orcaHireArgs({ kind: 'worktree', repoId: 'r1', name: 'x', agent: 'claude', baseBranch: null, prompt: null })).toEqual([
      'worktree', 'create', '--repo=id:r1', '--name=x', '--no-parent', '--agent=claude',
    ]);
  });

  it('opens a terminal running the agent in an existing worktree (prompt is sent later)', () => {
    expect(orcaHireArgs({ kind: 'agent', deskId: 'r1::/p/feat', agent: 'codex', prompt: 'go' })).toEqual([
      'terminal', 'create', '--worktree=id:r1::/p/feat', '--command=codex', '--title=codex',
    ]);
  });
});
