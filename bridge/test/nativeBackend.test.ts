import { existsSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeBackend, type PtyLike } from '../src/backend/native.js';
import type { PtyOptions } from '../src/native/ptyHost.js';
import { Registry } from '../src/native/registry.js';
import { validateHire } from '../src/hire.js';

const READY = ['', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ auto mode on'];
const TRUST = [' Quick safety check: Is this a project you created or one you trust?', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'];

class FakePty implements PtyLike {
  spawned: { id: string; opts: PtyOptions }[] = [];
  writes: [string, string][] = [];
  screens = new Map<string, string[]>();
  data = new Map<string, Set<(d: string) => void>>();
  sizes = new Map<string, { cols: number; rows: number }>();
  replies = new Map<string, boolean>();
  terminal(): null {
    return null;
  }
  ids(): string[] {
    return [...this.screens.keys()];
  }
  onData(id: string, fn: (d: string) => void): () => void {
    const set = this.data.get(id) ?? new Set();
    set.add(fn);
    this.data.set(id, set);
    return () => set.delete(fn);
  }
  resize(id: string, cols: number, rows: number): void {
    this.sizes.set(id, { cols, rows });
  }
  serialize(id: string): string {
    return (this.screens.get(id) ?? []).join('\r\n');
  }
  setReplies(id: string, on: boolean): void {
    this.replies.set(id, on);
  }
  size(id: string): { cols: number; rows: number } | null {
    return this.screens.has(id) ? (this.sizes.get(id) ?? { cols: 120, rows: 40 }) : null;
  }
  private exits = new Set<(id: string, code: number) => void>();
  spawn(id: string, opts: PtyOptions): void {
    this.spawned.push({ id, opts });
    this.screens.set(id, READY);
  }
  has(id: string): boolean {
    return this.screens.has(id);
  }
  write(id: string, data: string): void {
    this.writes.push([id, data]);
  }
  screenLines(id: string): string[] {
    return this.screens.get(id) ?? [];
  }
  onExit(fn: (id: string, code: number) => void): () => void {
    this.exits.add(fn);
    return () => this.exits.delete(fn);
  }
  kill(id: string): void {
    this.screens.delete(id);
    for (const fn of this.exits) fn(id, 0);
  }
  async dispose(): Promise<void> {
    for (const id of [...this.screens.keys()]) this.kill(id);
  }
}

const REPO = { id: 'abcdef123456', path: '/p/app', name: 'app' };
const PORCELAIN = 'worktree /p/app\nHEAD a\nbranch refs/heads/main\n\nworktree /h/worktrees/app/feat\nHEAD b\nbranch refs/heads/feat\n\n';

async function setup(
  git: (cwd: string, args: string[]) => Promise<string> = async () => PORCELAIN,
  pty: FakePty = new FakePty(),
  opts: { home?: string; which?: (cmd: string, env: Record<string, string>) => string | null } = {},
) {
  const clock = { t: 1_000_000 };
  const home = opts.home ?? mkdtempSync(path.join(os.tmpdir(), 'od-native-'));
  const registry = new Registry(path.join(home, 'state.json'));
  await registry.load();
  await registry.addRepo(REPO);
  const gitCalls: string[][] = [];
  const backend = new NativeBackend({
    pty,
    registry,
    home,
    hookUrl: (id, token) => `http://127.0.0.1:4317/hook/${id}?token=${token}`,
    git: async (cwd, args) => {
      gitCalls.push([cwd, ...args]);
      // Like git, `worktree add` creates the folder.
      if (args[0] === 'worktree' && args[1] === 'add') mkdirSync(args[4], { recursive: true });
      return git(cwd, args);
    },
    claudeProjects: path.join(home, 'claude-projects'),
    env: { PATH: '/bin', CLAUDECODE: '1' },
    relay: '/r/hook-relay.mjs',
    node: '/n/node',
    sleep: async () => {},
    now: () => clock.t,
    which: opts.which ?? ((cmd) => `/bin/${cmd}`),
  });
  return { backend, pty, registry, home, gitCalls, clock };
}

const tokenOf = (pty: FakePty, i = 0) => new URL(pty.spawned[i].opts.env.OFFICE_DESKS_HOOK_URL).searchParams.get('token')!;

describe('NativeBackend snapshot', () => {
  it('lists every worktree of registered repos as desks, with board metadata', async () => {
    const { backend, registry } = await setup();
    await registry.setMeta('abcdef123456::/h/worktrees/app/feat', { workspaceStatus: 'in-review', comment: 'look' });
    const s = await backend.snapshot();
    expect(s.desks.map((d) => [d.id, d.isMain, d.branch, d.repo, d.workspaceStatus, d.comment])).toEqual([
      ['abcdef123456::/h/worktrees/app/feat', false, 'feat', 'app', 'in-review', 'look'],
      ['abcdef123456::/p/app', true, 'main', 'app', null, ''],
    ]);
  });
});

describe('NativeBackend desk names', () => {
  const FIX = 'worktree /p/app\nHEAD a\nbranch refs/heads/main\n\nworktree /h/worktrees/app/fix-login\nHEAD b\nbranch refs/heads/fix-login\n\n';

  it('names a worktree desk after its folder, the main checkout after its folder too', async () => {
    const { backend } = await setup(async () => FIX);
    const s = await backend.snapshot();
    expect(s.desks.map((d) => [d.id, d.name])).toEqual([
      ['abcdef123456::/h/worktrees/app/fix-login', 'fix-login'],
      ['abcdef123456::/p/app', 'app'],
    ]);
  });

  it('refuses to hire a second worktree with the same name', async () => {
    const { backend } = await setup(async () => FIX);
    const desks = (await backend.snapshot()).desks;
    expect(validateHire({ repoId: 'abcdef123456', name: 'fix-login', agent: 'claude' }, desks)).toEqual({ error: '같은 이름의 워크트리가 이미 있어요' });
  });
});

describe('NativeBackend stop and remove', () => {
  const FEAT = 'abcdef123456::/h/worktrees/app/feat';
  const hireMain = (b: NativeBackend) => b.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });

  it('stops an agent by killing its terminal', async () => {
    const { backend, pty } = await setup();
    await hireMain(backend);
    const id = pty.spawned[0].id;
    await backend.stopAgent(`${id}:main`);
    expect(pty.has(id)).toBe(false);
    expect((await backend.snapshot()).desks.find((d) => d.isMain)!.agents).toEqual([]);
  });

  it('reports an unknown agent as not found', async () => {
    const { backend } = await setup();
    await expect(backend.stopAgent('nope:main')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses the main checkout and unknown desks, going by git\'s own listing', async () => {
    const { backend, gitCalls } = await setup();
    await expect(backend.removeWorktree('abcdef123456::/p/app')).rejects.toMatchObject({ code: 'main_checkout' });
    await expect(backend.removeWorktree('zzz::/p/app')).rejects.toMatchObject({ code: 'not_found' });
    await expect(backend.removeWorktree('garbage')).rejects.toMatchObject({ code: 'not_found' });
    await expect(backend.removeWorktree('abcdef123456::/h/worktrees/app/gone')).rejects.toMatchObject({ code: 'not_found' });
    expect(gitCalls.some((c) => c[1] === 'worktree' && c[2] === 'remove')).toBe(false);
  });

  it('knows the main checkout from git even when the registered path is spelled differently', async () => {
    const MAIN_ELSEWHERE = 'worktree /real/app\nHEAD a\nbranch refs/heads/main\n\nworktree /h/worktrees/app/feat\nHEAD b\nbranch refs/heads/feat\n\n';
    const { backend, gitCalls } = await setup(async () => MAIN_ELSEWHERE);
    await expect(backend.removeWorktree('abcdef123456::/real/app')).rejects.toMatchObject({ code: 'main_checkout' });
    expect(gitCalls.some((c) => c[1] === 'worktree' && c[2] === 'remove')).toBe(false);
  });

  it('refuses a worktree with a running agent', async () => {
    const { backend, gitCalls } = await setup();
    await backend.hire({ kind: 'agent', deskId: FEAT, agent: 'claude', prompt: null });
    await expect(backend.removeWorktree(FEAT)).rejects.toMatchObject({ code: 'has_agents' });
    expect(gitCalls.some((c) => c[1] === 'worktree' && c[2] === 'remove')).toBe(false);
  });

  it('removes an idle worktree through git, without --force', async () => {
    const { backend, gitCalls } = await setup();
    await backend.removeWorktree(FEAT);
    expect(gitCalls).toContainEqual(['/p/app', 'worktree', 'remove', '/h/worktrees/app/feat']);
  });

  it('maps a git refusal to dirty', async () => {
    const { backend } = await setup(async (_cwd, args) => {
      if (args[1] === 'remove') throw new Error("fatal: '/h/worktrees/app/feat' contains modified or untracked files, use --force to delete it");
      return PORCELAIN;
    });
    const err = await backend.removeWorktree(FEAT).catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ code: 'dirty', message: '변경사항이 있는 워크트리는 지울 수 없어요' });
  });

  it('reports any other git failure as remove_failed with git\'s first line', async () => {
    const { backend } = await setup(async (_cwd, args) => {
      if (args[1] === 'remove') throw new Error('fatal: cannot remove a locked working tree\nlock reason: x');
      return PORCELAIN;
    });
    await expect(backend.removeWorktree(FEAT)).rejects.toMatchObject({
      code: 'remove_failed',
      message: '워크트리를 지우지 못했어요 — fatal: cannot remove a locked working tree',
    });
  });

  it('reports a failed listing as remove_failed and removes nothing', async () => {
    const { backend, gitCalls } = await setup(async () => {
      throw new Error('fatal: not a git repository');
    });
    await expect(backend.removeWorktree(FEAT)).rejects.toMatchObject({ code: 'remove_failed', message: '워크트리를 지우지 못했어요 — fatal: not a git repository' });
    expect(gitCalls.some((c) => c[1] === 'worktree' && c[2] === 'remove')).toBe(false);
  });
});

describe('NativeBackend hire and hooks', () => {
  it('spawns claude with a session id, hook settings and a scrubbed env', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const { opts } = pty.spawned[0];
    expect(opts.file).toBe('claude');
    expect(opts.cwd).toBe('/p/app');
    expect(opts.args[0]).toBe('--session-id');
    expect(opts.args[2]).toBe('--settings');
    expect(opts.env.CLAUDECODE).toBeUndefined();
    expect(opts.env.OFFICE_DESKS_HOOK_URL).toMatch(/^http:\/\/127\.0\.0\.1:4317\/hook\/[0-9a-f-]+:main\?token=[0-9a-f]{32}$/);
    const desk = (await backend.snapshot()).desks.find((d) => d.id === 'abcdef123456::/p/app')!;
    expect(desk.agents).toHaveLength(1);
    expect(desk.agents[0]).toMatchObject({ agentType: 'claude', terminalHandle: `pty_${pty.spawned[0].id}` });
  });

  it('creates a worktree for a new task, then runs the agent in it', async () => {
    const { backend, pty, gitCalls, home } = await setup();
    await backend.hire({ kind: 'worktree', repoId: 'abcdef123456', name: 'fix-login', agent: 'codex', baseBranch: 'origin/main', prompt: null });
    const dest = path.join(home, 'worktrees', 'app', 'fix-login');
    expect(gitCalls).toContainEqual(['/p/app', 'worktree', 'add', '-b', 'fix-login', dest, 'origin/main']);
    // The agent runs in the real path, the one git lists (macOS tmp is /var → /private/var).
    expect(pty.spawned[0].opts).toMatchObject({ file: 'codex', args: [], cwd: realpathSync.native(dest) });
  });

  it.skipIf(process.platform === 'win32')('puts the new agent on its desk when the office home is behind a symlink', async () => {
    const real = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'od-real-')));
    const link = path.join(mkdtempSync(path.join(os.tmpdir(), 'od-link-')), 'home');
    symlinkSync(real, link);
    const wt = `${real}/worktrees/app/fix-login`;
    const porcelain = `worktree /p/app\nHEAD a\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD b\nbranch refs/heads/fix-login\n\n`;
    const { backend, pty } = await setup(async () => porcelain, undefined, { home: link });
    await backend.hire({ kind: 'worktree', repoId: 'abcdef123456', name: 'fix-login', agent: 'claude', baseBranch: null, prompt: null });
    expect(pty.spawned[0].opts.cwd).toBe(wt);
    const desk = (await backend.snapshot()).desks.find((d) => d.id === `abcdef123456::${wt}`)!;
    expect(desk.agents).toHaveLength(1);
  });

  it('refuses an agent command that is not installed, before creating anything', async () => {
    const { backend, pty, gitCalls, home } = await setup(undefined, undefined, { which: () => null });
    await expect(backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null })).rejects.toMatchObject({ code: 'agent_not_found' });
    await expect(
      backend.hire({ kind: 'worktree', repoId: 'abcdef123456', name: 'fix-login', agent: 'codex', baseBranch: null, prompt: null }),
    ).rejects.toMatchObject({ code: 'agent_not_found', message: expect.stringContaining('codex') });
    expect(gitCalls.some((c) => c[1] === 'worktree' && c[2] === 'add')).toBe(false);
    expect(pty.spawned).toEqual([]);
    expect((await backend.snapshot()).desks[1].agents).toEqual([]);
    const dir = path.join(home, 'agents');
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('looks the command up on the agent PATH', async () => {
    const seen: [string, string | undefined][] = [];
    const { backend } = await setup(undefined, undefined, {
      which: (cmd, env) => {
        seen.push([cmd, env.PATH]);
        return `/bin/${cmd}`;
      },
    });
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'gemini', prompt: null });
    expect(seen).toEqual([['gemini', '/bin']]);
  });

  it('warns that only Claude gets the first prompt typed in', async () => {
    const { backend, pty } = await setup();
    expect(await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'codex', prompt: 'do it' })).toEqual({
      warning: '첫 지시는 Claude에만 자동으로 전달돼요. 패널에서 보내 주세요',
    });
    expect(pty.spawned).toHaveLength(1);
    expect(await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'codex', prompt: null })).toEqual({});
    expect(await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: 'do it' })).toEqual({});
  });

  it('does not count the startup screen as waiting for the first 2 seconds, unless a hook arrived', async () => {
    const { backend, pty, clock } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const [a, b] = pty.spawned.map((s) => s.id);
    pty.screens.set(a, TRUST);
    pty.screens.set(b, TRUST);
    backend.hook(`${b}:main`, tokenOf(pty, 1), { hook_event_name: 'SessionStart' }); // hook says done; the dialog on screen wins
    const state = async (id: string) => (await backend.snapshot()).desks[1].agents.find((x) => x.id === `${id}:main`)!.rawState;
    clock.t += 1999;
    expect(await state(a)).toBe('unknown');
    expect(await state(b)).toBe('waiting');
    clock.t += 1;
    expect(await state(a)).toBe('waiting');
  });

  it('delivers the pending first prompt once, on SessionStart, even after a trust dialog', async () => {
    const ctx = await setup();
    const { backend, pty } = ctx;
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: 'fix the login bug' });
    const id = pty.spawned[0].id;
    const agentId = `${id}:main`;
    pty.screens.set(id, TRUST);
    const { clock } = ctx;
    clock.t += 2000; // past the startup grace
    let s = await backend.snapshot();
    expect(s.desks[1].agents[0].state).toBe('waiting'); // the trust dialog needs the user
    expect(pty.writes).toEqual([]);

    pty.screens.set(id, READY);
    expect(backend.hook(agentId, tokenOf(pty), { hook_event_name: 'SessionStart', session_id: 's1', transcript_path: '/t/s1.jsonl' })).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(pty.writes).toEqual([
      [id, '\x1b[200~fix the login bug\x1b[201~'],
      [id, '\r'],
    ]);
    backend.hook(agentId, tokenOf(pty), { hook_event_name: 'SessionStart', source: 'clear' });
    await new Promise((r) => setTimeout(r, 0));
    expect(pty.writes).toHaveLength(2);
    s = await backend.snapshot();
    expect(s.desks[1].agents[0].state).toBe('done');
  });

  it('rejects a wrong token or unknown agent and changes nothing', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const agentId = `${pty.spawned[0].id}:main`;
    expect(backend.hook(agentId, 'f'.repeat(32), { hook_event_name: 'UserPromptSubmit', prompt: 'x' })).toBe(false);
    expect(backend.hook('nope:main', tokenOf(pty), { hook_event_name: 'UserPromptSubmit', prompt: 'x' })).toBe(false);
    expect((await backend.snapshot()).desks[1].agents[0].prompt).toBeNull();
  });

  it('maps hook events to states the office understands', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const agentId = `${pty.spawned[0].id}:main`;
    const t = tokenOf(pty);
    backend.hook(agentId, t, { hook_event_name: 'SessionStart' });
    backend.hook(agentId, t, { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    backend.hook(agentId, t, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } });
    const a = (await backend.snapshot()).desks[1].agents[0];
    expect(a).toMatchObject({ state: 'reading', rawState: 'working', prompt: 'go', activity: 'Read: src/a.ts' });
  });

  it('removes an agent whose process exited', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    pty.kill(pty.spawned[0].id);
    expect((await backend.snapshot()).desks[1].agents).toEqual([]);
  });
});

describe('NativeBackend input, board, sessions, repos', () => {
  it('pastes prompts and types keys into the PTY', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const id = pty.spawned[0].id;
    await backend.sendPrompt(`pty_${id}`, 'line one\nline two');
    await backend.sendKeys(`pty_${id}`, { bytes: '\x1b[A' });
    await backend.sendKeys(`pty_${id}`, { enter: true });
    expect(pty.writes).toEqual([
      [id, '\x1b[200~line one\nline two\x1b[201~'],
      [id, '\r'],
      [id, '\x1b[A'],
      [id, '\r'],
    ]);
    expect(await backend.readScreen(`pty_${id}`)).toEqual(READY);
    expect(backend.blockedHandle('x')).toBeNull();
    await expect(backend.retryPrompt('x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('stores the board in the registry', async () => {
    const { backend, registry } = await setup();
    await backend.setBoard('abcdef123456::/p/app', { workspaceStatus: 'todo', comment: 'c' });
    await backend.setBoard('abcdef123456::/p/app', { comment: '' });
    expect(registry.meta('abcdef123456::/p/app')).toEqual({ workspaceStatus: 'todo' });
  });

  it('finds the transcript by session id (rate-limited), or from the hook path without scanning', async () => {
    const { backend, pty, home, clock } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const sid = pty.spawned[0].opts.args[1];
    const agentId = `${pty.spawned[0].id}:main`;
    const desk = (await backend.snapshot()).desks[1];
    const agent = desk.agents[0];
    expect(await backend.findSession(desk, agent)).toBeNull();
    const dir = path.join(home, 'claude-projects', '-p-app');
    mkdirSync(dir, { recursive: true });
    const byId = path.join(dir, `${sid}.jsonl`);
    writeFileSync(byId, '{}\n');
    expect(await backend.findSession(desk, agent)).toBeNull(); // rate-limited
    clock.t += 5001;
    expect(await backend.findSession(desk, agent)).toBe(byId);
    expect(backend.cachedSession(agentId)).toBe(byId);

    // A hook path outside the projects folder, or for another session, is ignored.
    backend.hook(agentId, tokenOf(pty), { hook_event_name: 'SessionStart', transcript_path: path.join(home, `${sid}.jsonl`) });
    expect(backend.cachedSession(agentId)).toBe(byId);
    backend.hook(agentId, tokenOf(pty), { hook_event_name: 'SessionStart', transcript_path: path.join(dir, 'other.jsonl') });
    expect(backend.cachedSession(agentId)).toBe(byId);

    // A hook-supplied path is authoritative: no scan while it is missing.
    const hookFile = path.join(home, 'claude-projects', '-elsewhere', `${sid}.jsonl`);
    backend.hook(agentId, tokenOf(pty), { hook_event_name: 'SessionStart', transcript_path: hookFile });
    expect(backend.cachedSession(agentId)).toBeNull();
    clock.t += 5001;
    expect(backend.cachedSession(agentId)).toBeNull();
    mkdirSync(path.dirname(hookFile), { recursive: true });
    writeFileSync(hookFile, '{}\n');
    expect(backend.cachedSession(agentId)).toBe(hookFile);
  });

  it('follows a new session id from SessionStart (/clear) but still rejects foreign basenames', async () => {
    const { backend, pty, home } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const agentId = `${pty.spawned[0].id}:main`;
    const dir = path.join(home, 'claude-projects', '-p-app');
    mkdirSync(dir, { recursive: true });
    const newId = '11111111-2222-3333-4444-555555555555';
    const file = path.join(dir, `${newId}.jsonl`);
    writeFileSync(file, '{}\n');
    backend.hook(agentId, tokenOf(pty), { hook_event_name: 'SessionStart', source: 'clear', session_id: newId, transcript_path: file });
    expect(backend.cachedSession(agentId)).toBe(file);
    const desk = (await backend.snapshot()).desks[1];
    expect(await backend.findSession(desk, desk.agents[0])).toBe(file);

    // Scan fallback also follows the new id when no path is given.
    const id2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const file2 = path.join(dir, `${id2}.jsonl`);
    writeFileSync(file2, '{}\n');
    backend.hook(agentId, tokenOf(pty), { hook_event_name: 'SessionStart', session_id: id2 });
    expect(backend.cachedSession(agentId)).toBe(file2);

    // A path matching neither id is rejected.
    const id3 = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
    backend.hook(agentId, tokenOf(pty), { hook_event_name: 'SessionStart', session_id: id3, transcript_path: path.join(dir, 'other.jsonl') });
    expect(backend.cachedSession(agentId)).toBeNull(); // adopted id3, nothing on disk, bogus path ignored
  });

  it('honors CLAUDE_CONFIG_DIR for the transcript root', async () => {
    const cfg = mkdtempSync(path.join(os.tmpdir(), 'od-cfg-'));
    const pty = new FakePty();
    const { home, registry } = await setup();
    const backend = new NativeBackend({
      pty,
      registry,
      home,
      hookUrl: (id, token) => `http://127.0.0.1:4317/hook/${id}?token=${token}`,
      git: async () => PORCELAIN,
      env: { PATH: '/bin', CLAUDE_CONFIG_DIR: cfg },
      relay: '/r/hook-relay.mjs',
      node: '/n/node',
      sleep: async () => {},
      which: (cmd) => `/bin/${cmd}`,
    });
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const sid = pty.spawned[0].opts.args[1];
    const agentId = `${pty.spawned[0].id}:main`;
    const dir = path.join(cfg, 'projects', 'x');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sid}.jsonl`);
    writeFileSync(file, '{}\n');
    expect(backend.cachedSession(agentId)).toBe(file);
  });

  it('cleans up when the spawn fails', async () => {
    const pty = new FakePty();
    pty.spawn = () => {
      throw new Error('spawn failed');
    };
    const { backend, home } = await setup(undefined, pty);
    await expect(backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null })).rejects.toThrow('spawn failed');
    expect((await backend.snapshot()).desks[1].agents).toEqual([]);
    const dir = path.join(home, 'agents');
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('registers a repo from any folder inside it', async () => {
    const { backend, registry } = await setup(async () => 'worktree /q/other\nHEAD a\nbranch refs/heads/main\n\n');
    await backend.addRepo('/q/other/src');
    expect(registry.repos.map((r) => r.path)).toContain(path.normalize('/q/other'));
    await expect(backend.addRepo('relative/path')).rejects.toMatchObject({ code: 'not_absolute' });
  });

  it('exposes the live terminal of an agent for attaching', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const id = pty.spawned[0].id;
    expect(backend.terminalOf(`${id}:main`)).toBe(id);
    expect(backend.pty).toBe(pty);
    pty.kill(id);
    expect(backend.terminalOf(`${id}:main`)).toBeNull();
    expect(backend.terminalOf('nope:main')).toBeNull();
  });

  it('kills every agent on dispose and removes settings files', async () => {
    const { backend, pty, home } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const dir = path.join(home, 'agents');
    expect(readdirSync(dir)).toHaveLength(1);
    await backend.dispose();
    expect(pty.screens.size).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });
});
