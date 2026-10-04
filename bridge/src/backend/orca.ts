import type { HireSpec } from './types.js';

/** Orca argv for a validated hire. Values only ever go in as --flag=value. */
export function orcaHireArgs(spec: HireSpec): string[] {
  if (spec.kind === 'agent') {
    return ['terminal', 'create', `--worktree=id:${spec.deskId}`, `--command=${spec.agent}`, `--title=${spec.agent}`];
  }
  const args = ['worktree', 'create', `--repo=id:${spec.repoId}`, `--name=${spec.name}`, '--no-parent', `--agent=${spec.agent}`];
  if (spec.baseBranch) args.push(`--base-branch=${spec.baseBranch}`);
  if (spec.prompt) args.push(`--prompt=${spec.prompt}`);
  return args;
}
