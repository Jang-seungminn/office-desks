import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changeSummary, fileDiff, normalizePr, parseNumstat, parseStatus } from '../src/gitInfo.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'od-git-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  writeFileSync(path.join(dir, 'gone.txt'), 'bye\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

describe('git parsing', () => {
  it('parses porcelain status including renames', () => {
    expect(parseStatus(' M a.txt\0?? new.txt\0R  b.txt\0old.txt\0')).toEqual([
      { path: 'a.txt', code: ' M' },
      { path: 'new.txt', code: '??' },
      { path: 'b.txt', code: 'R ' },
    ]);
  });

  it('parses numstat including binary files', () => {
    const m = parseNumstat('3\t1\ta.txt\0-\t-\timg.png\0');
    expect(m.get('a.txt')).toEqual({ added: 3, deleted: 1 });
    expect(m.get('img.png')).toEqual({ added: 0, deleted: 0 });
  });
});

describe('changeSummary / fileDiff on a real repo', () => {
  it('lists modified, deleted and untracked files with line counts', async () => {
    const dir = repo();
    writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
    execFileSync('git', ['-C', dir, 'rm', '-q', 'gone.txt']);
    writeFileSync(path.join(dir, 'new.txt'), 'hello\n');
    const s = await changeSummary(dir);
    const byPath = Object.fromEntries(s.files.map((f) => [f.path, f]));
    expect(byPath['a.txt']).toMatchObject({ status: 'modified', added: 2, deleted: 1 });
    expect(byPath['gone.txt']).toMatchObject({ status: 'deleted', deleted: 1 });
    expect(byPath['new.txt']).toMatchObject({ status: 'untracked', added: 1 });
    const d = await fileDiff(dir, byPath['a.txt']);
    expect(d.diff).toContain('+TWO');
    const u = await fileDiff(dir, byPath['new.txt']);
    expect(u.diff).toContain('+hello');
  });
});

describe('normalizePr', () => {
  it('accepts numbers, URLs and objects, and rejects non-https links', () => {
    expect(normalizePr(12)).toMatchObject({ number: 12 });
    expect(normalizePr('https://github.com/o/r/pull/7')).toMatchObject({ number: 7, url: 'https://github.com/o/r/pull/7' });
    expect(normalizePr({ number: 3, url: 'javascript:alert(1)', title: 'Fix', state: 'open' })).toEqual({ number: 3, url: null, title: 'Fix', state: 'open' });
    expect(normalizePr(null)).toBeNull();
  });
});
