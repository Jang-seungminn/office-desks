import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ChangedFile, ChangeSummary } from './model.js';

// What each worktree has changed, straight from git (no shell, fixed argv): a per-file list of
// uncommitted changes against HEAD, and the diff of one file on request.

const MAX_DIFF_BYTES = 400_000;

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 4 * 1024 * 1024, timeout: 8000, windowsHide: true }, (err, stdout) => {
      // Keep stdout on errors: `diff --no-index` exits 1 exactly when it has output.
      if (err) reject(Object.assign(err, { stdout }));
      else resolve(stdout);
    });
  });

/** `git status --porcelain=v1 -z` → path and two-letter status (rename targets win). */
export function parseStatus(out: string): { path: string; code: string }[] {
  const parts = out.split('\0').filter(Boolean);
  const rows: { path: string; code: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const path = parts[i].slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // the next entry is the original name
    rows.push({ path, code });
  }
  return rows;
}

/** `git diff --numstat -z` → added/deleted per path (binary files report '-'). */
export function parseNumstat(out: string): Map<string, { added: number; deleted: number }> {
  const map = new Map<string, { added: number; deleted: number }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let path = m[3];
    if (path === '') {
      // rename: "a\td\t\0old\0new"
      path = parts[i + 2] ?? '';
      i += 2;
    }
    map.set(path, { added: m[1] === '-' ? 0 : Number(m[1]), deleted: m[2] === '-' ? 0 : Number(m[2]) });
  }
  return map;
}

function statusLabel(code: string): ChangedFile['status'] {
  if (code === '??') return 'untracked';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('R')) return 'renamed';
  return 'modified';
}

/** Lines in a new (untracked) text file, so it doesn't show as +0; big or binary files count 0. */
async function countLines(file: string): Promise<number> {
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size > 1_000_000) return 0;
    const buf = await readFile(file);
    if (buf.includes(0)) return 0; // binary
    const text = buf.toString('utf8');
    return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  } catch {
    return 0;
  }
}

export async function changeSummary(cwd: string, git: GitRunner = runGit): Promise<ChangeSummary> {
  const status = parseStatus(await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  // A repo without commits has no HEAD to diff against; counts then come from status only.
  const numstat = await git(cwd, ['diff', '--numstat', '-z', 'HEAD']).then(parseNumstat, () => new Map());
  const files: ChangedFile[] = await Promise.all(
    status.map(async ({ path: file, code }) => ({
      path: file,
      status: statusLabel(code),
      added: numstat.get(file)?.added ?? (code === '??' ? await countLines(path.join(cwd, file)) : 0),
      deleted: numstat.get(file)?.deleted ?? 0,
    })),
  );
  return {
    files,
    added: files.reduce((n, f) => n + f.added, 0),
    deleted: files.reduce((n, f) => n + f.deleted, 0),
  };
}

/** Unified diff of one changed file against HEAD (untracked files: their content as additions). */
export async function fileDiff(cwd: string, file: ChangedFile, git: GitRunner = runGit): Promise<{ diff: string; truncated: boolean }> {
  let diff: string;
  if (file.status === 'untracked') {
    // `--no-index` exits 1 when files differ, which execFile reports as an error with stdout.
    diff = await git(cwd, ['diff', '--no-color', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', file.path]).catch(
      (e: { stdout?: string }) => e.stdout ?? '',
    );
  } else {
    diff = await git(cwd, ['diff', '--no-color', 'HEAD', '--', file.path]).catch(() => '');
  }
  const truncated = diff.length > MAX_DIFF_BYTES;
  return { diff: truncated ? diff.slice(0, MAX_DIFF_BYTES) : diff, truncated };
}

/** Orca's linkedPR can be a bare number or an object; normalise what we can show. */
export function normalizePr(raw: unknown): { number: number | null; url: string | null; title: string | null; state: string | null } | null {
  if (raw === null || raw === undefined || raw === false) return null;
  if (typeof raw === 'number') return { number: raw, url: null, title: null, state: null };
  if (typeof raw === 'string') {
    const n = /(\d+)\s*$/.exec(raw)?.[1];
    return { number: n ? Number(n) : null, url: /^https:\/\//.test(raw) ? raw : null, title: null, state: null };
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const num = o.number ?? o.prNumber ?? o.id;
    const url = typeof o.url === 'string' ? o.url : typeof o.htmlUrl === 'string' ? o.htmlUrl : null;
    return {
      number: typeof num === 'number' ? num : typeof num === 'string' && /^\d+$/.test(num) ? Number(num) : null,
      url: url && /^https:\/\//.test(url) ? url : null,
      title: typeof o.title === 'string' ? o.title : null,
      state: typeof o.state === 'string' ? o.state : null,
    };
  }
  return null;
}
