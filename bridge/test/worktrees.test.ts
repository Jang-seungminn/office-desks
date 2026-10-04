import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addWorktree, listWorktrees, parsePorcelain, removeWorktree, resolveRepo, worktreeDest } from '../src/native/worktrees.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function scratchRepo(): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'od-git-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

describe('parsePorcelain', () => {
  it('reads main and linked worktrees, skipping bare ones', () => {
    const out = 'worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /w/feat\nHEAD bbb\nbranch refs/heads/feat\n\nworktree /w/det\nHEAD ccc\ndetached\n\nworktree /bare\nbare\n\n';
    expect(parsePorcelain(out)).toEqual([
      { path: '/r', branch: 'main', head: 'aaa', isMain: true },
      { path: '/w/feat', branch: 'feat', head: 'bbb', isMain: false },
      { path: '/w/det', branch: '', head: 'ccc', isMain: false },
    ]);
  });
});

describe('git worktrees', () => {
  it('resolves a repo from any folder inside it, adds a worktree and lists it', async () => {
    const repo = scratchRepo();
    writeFileSync(path.join(repo, 'a.txt'), 'x');
    const rec = await resolveRepo(repo);
    expect(rec).toMatchObject({ path: repo, name: path.basename(repo) });
    expect(rec.id).toMatch(/^[0-9a-f]{12}$/);

    const home = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'od-home-')));
    const dest = worktreeDest(home, rec.name, 'fix-login');
    expect(dest).toBe(path.join(home, 'worktrees', rec.name, 'fix-login'));
    await addWorktree(repo, dest, 'fix-login', null);
    const list = await listWorktrees(repo);
    expect(list.map((w) => [path.normalize(w.path), w.branch, w.isMain])).toEqual([
      [path.normalize(repo), 'main', true],
      [path.normalize(dest), 'fix-login', false],
    ]);
    // Resolving from inside a linked worktree still names the main checkout.
    expect((await resolveRepo(dest)).path).toBe(rec.path);
  });

  it('removes a clean worktree but keeps its branch', async () => {
    const repo = scratchRepo();
    const home = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'od-home-')));
    const dest = worktreeDest(home, 'app', 'fix-login');
    await addWorktree(repo, dest, 'fix-login', null);
    await removeWorktree(repo, dest);
    expect((await listWorktrees(repo)).map((w) => path.normalize(w.path))).not.toContain(path.normalize(dest));
    expect(git(repo, 'branch', '--list', 'fix-login').trim()).not.toBe('');
  });

  it('refuses a dirty worktree and leaves it alone', async () => {
    const repo = scratchRepo();
    const home = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'od-home-')));
    const dest = worktreeDest(home, 'app', 'wip');
    await addWorktree(repo, dest, 'wip', null);
    writeFileSync(path.join(dest, 'new.txt'), 'x');
    await expect(removeWorktree(repo, dest)).rejects.toThrow();
    expect(existsSync(dest)).toBe(true);
  });

  it('rejects a folder that is not a git repository with a readable error', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'od-nogit-'));
    await expect(resolveRepo(dir)).rejects.toMatchObject({ code: 'not_a_repo' });
  });
});
