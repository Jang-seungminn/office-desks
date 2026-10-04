import { createHash } from 'node:crypto';
import path from 'node:path';
import { BackendError } from '../backend/types.js';
import { runGit, type GitRunner } from '../gitInfo.js';
import type { RepoRecord } from './registry.js';

// Worktrees straight from git: list them, create one per task, and identify a repo by its main checkout.

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
}

/** `git worktree list --porcelain`: blank-line separated records, the main worktree first. */
export function parsePorcelain(out: string): WorktreeInfo[] {
  const list: WorktreeInfo[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const sp = line.indexOf(' ');
      if (line) fields.set(sp < 0 ? line : line.slice(0, sp), sp < 0 ? '' : line.slice(sp + 1));
    }
    const wt = fields.get('worktree');
    if (!wt || fields.has('bare')) continue;
    list.push({
      path: wt,
      branch: (fields.get('branch') ?? '').replace(/^refs\/heads\//, ''),
      head: fields.get('HEAD') ?? '',
      isMain: list.length === 0,
    });
  }
  return list;
}

export async function listWorktrees(repoPath: string, git: GitRunner = runGit): Promise<WorktreeInfo[]> {
  return parsePorcelain(await git(repoPath, ['worktree', 'list', '--porcelain']));
}

/** The repo that `dir` belongs to, named after its main checkout (also from inside a linked worktree). */
export async function resolveRepo(dir: string, git: GitRunner = runGit): Promise<RepoRecord> {
  let main: WorktreeInfo | undefined;
  try {
    main = (await listWorktrees(dir, git))[0];
  } catch {
    main = undefined;
  }
  if (!main) throw new BackendError(`git 저장소가 아니에요: ${dir}`, 'not_a_repo');
  const repoPath = path.normalize(main.path);
  const id = createHash('sha1').update(process.platform === 'win32' ? repoPath.toLowerCase() : repoPath).digest('hex').slice(0, 12);
  return { id, path: repoPath, name: path.basename(repoPath) };
}

export async function addWorktree(repoPath: string, dest: string, branch: string, base: string | null, git: GitRunner = runGit): Promise<void> {
  await git(repoPath, ['worktree', 'add', '-b', branch, dest, ...(base ? [base] : [])]);
}

export function worktreeDest(home: string, repoName: string, name: string): string {
  return path.join(home, 'worktrees', repoName.replace(/[^A-Za-z0-9._-]/g, '_'), name);
}
