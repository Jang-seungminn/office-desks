import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeBackend, type PtyLike } from '../src/backend/native.js';
import type { PtyOptions } from '../src/native/ptyHost.js';
import { Registry } from '../src/native/registry.js';

const READY = ['', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ auto mode on'];
const TRUST = [' Quick safety check: Is this a project you created or one you trust?', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'];

class FakePty implements PtyLike {
  spawned: { id: string; opts: PtyOptions }[] = [];
  writes: [string, string][] = [];
  screens = new Map<string, string[]>();
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

async function setup(git: (cwd: string, args: string[]) => Promise<string> = async () => PORCELAIN) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'od-native-'));
  const registry = new Registry(path.join(home, 'state.json'));
  await registry.load();
  await registry.addRepo(REPO);
  const pty = new FakePty();
  const gitCalls: string[][] = [];
  const backend = new NativeBackend({
    pty,
    registry,
    home,
    hookUrl: (id, token) => `http://127.0.0.1:4317/hook/${id}?token=${token}`,
    git: async (cwd, args) => {
      gitCalls.push([cwd, ...args]);
      return git(cwd, args);
    },
    claudeProjects: path.join(home, 'claude-projects'),
    env: { PATH: '/bin', CLAUDECODE: '1' },
    relay: '/r/hook-relay.mjs',
    node: '/n/node',
    sleep: async () => {},
  });
  return { backend, pty, registry, home, gitCalls };
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
    expect(pty.spawned[0].opts).toMatchObject({ file: 'codex', args: [], cwd: dest });
  });

  it('delivers the pending first prompt once, on SessionStart, even after a trust dialog', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: 'fix the login bug' });
    const id = pty.spawned[0].id;
    const agentId = `${id}:main`;
    pty.screens.set(id, TRUST);
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

  it('finds the transcript from the hook, or by session id under the projects folder', async () => {
    const { backend, pty, home } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const sid = pty.spawned[0].opts.args[1];
    const agentId = `${pty.spawned[0].id}:main`;
    const s = await backend.snapshot();
    const desk = s.desks[1];
    const agent = desk.agents[0];
    expect(await backend.findSession(desk, agent)).toBeNull();
    const dir = path.join(home, 'claude-projects', '-p-app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${sid}.jsonl`), '{}\n');
    expect(await backend.findSession(desk, agent)).toBe(path.join(dir, `${sid}.jsonl`));
    expect(backend.cachedSession(agentId)).toBe(path.join(dir, `${sid}.jsonl`));
  });

  it('registers a repo from any folder inside it', async () => {
    const { backend, registry } = await setup(async () => 'worktree /q/other\nHEAD a\nbranch refs/heads/main\n\n');
    await backend.addRepo('/q/other/src');
    expect(registry.repos.map((r) => r.path)).toContain(path.normalize('/q/other'));
    await expect(backend.addRepo('relative/path')).rejects.toMatchObject({ code: 'not_absolute' });
  });

  it('kills every agent on dispose', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    await backend.dispose();
    expect(pty.screens.size).toBe(0);
  });
});
