import { describe, expect, it } from 'vitest';
import { OrcaBackend } from '../src/backend/orca.js';
import { BackendBusyError } from '../src/backend/types.js';
import type { OfficeAgent, OfficeDesk } from '../src/model.js';
import { OrcaCliError, type OrcaRunner } from '../src/orcaCli.js';

/** Records every argv; answers via the handler. */
function fake(handler: (args: string[]) => unknown = () => ({})): { orca: OrcaRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    orca: async (args) => {
      calls.push(args);
      const r = handler(args);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe('OrcaBackend.snapshot', () => {
  it('maps worktree ps and lists terminals only when stale or when an unknown pane appears', async () => {
    let now = 0;
    let panes = ['t1:l1'];
    const { orca, calls } = fake((args) =>
      args[0] === 'worktree'
        ? { worktrees: [{ worktreeId: 'r::/a', agents: panes.map((p) => ({ paneKey: p, state: 'working' })) }] }
        : { terminals: panes.map((p) => ({ handle: `h-${p}`, tabId: p.split(':')[0], leafId: p.split(':')[1] })) },
    );
    const backend = new OrcaBackend(orca, undefined, () => now);
    const lists = () => calls.filter((c) => c.join(' ') === 'terminal list').length;

    await backend.snapshot();
    now = 1500;
    await backend.snapshot();
    now = 3000;
    await backend.snapshot();
    expect(lists()).toBe(1);

    panes = ['t1:l1', 't2:l2']; // a new agent appears
    now = 4500;
    const s = await backend.snapshot();
    expect(lists()).toBe(2);
    expect(s.desks[0].agents[1].terminalHandle).toBe('h-t2:l2');

    now = 4500 + 16_000; // stale
    await backend.snapshot();
    expect(lists()).toBe(3);
  });
});

describe('OrcaBackend input', () => {
  it('sends prompts, keys and focus with --flag=value text', async () => {
    const { orca, calls } = fake();
    const b = new OrcaBackend(orca, undefined, Date.now, 'darwin');
    await b.sendPrompt('term_1', '--help\nme');
    await b.sendKeys('term_1', { bytes: '\x1b[A' });
    await b.sendKeys('term_1', { enter: true });
    await b.focus('term_1');
    expect(calls).toEqual([
      ['terminal', 'send', '--terminal', 'term_1', '--text=--help\nme', '--enter'],
      ['terminal', 'send', '--terminal', 'term_1', '--text=\x1b[A'],
      ['terminal', 'send', '--terminal', 'term_1', '--enter'],
      ['terminal', 'switch', '--terminal', 'term_1'],
    ]);
  });

  it('joins prompt lines on Windows, where cmd.exe shims cannot carry newlines', async () => {
    const { orca, calls } = fake();
    await new OrcaBackend(orca, undefined, Date.now, 'win32').sendPrompt('term_1', 'a\n  b\r\nc');
    expect(calls).toEqual([['terminal', 'send', '--terminal', 'term_1', '--text=a b c', '--enter']]);
  });

  it('reads the screen tail', async () => {
    const { orca } = fake(() => ({ terminal: { tail: ['a', 'b'] } }));
    expect(await new OrcaBackend(orca).readScreen('term_1')).toEqual(['a', 'b']);
    const { orca: empty } = fake(() => ({}));
    expect(await new OrcaBackend(empty).readScreen('term_1')).toEqual([]);
  });
});

describe('OrcaBackend blocked prompts', () => {
  const blocked = (id: string) => new OrcaCliError(`Agent can not take a prompt (request ID: ${id})`, 'agent_prompt_blocked');

  it('turns agent_prompt_blocked into BackendBusyError and retries the same prompt', async () => {
    let refuse = true;
    const { orca, calls } = fake(() => (refuse ? blocked('aaaaaaaa-1111') : {}));
    const b = new OrcaBackend(orca);
    const err = await b.sendPrompt('term_1', 'hello').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendBusyError);
    expect((err as BackendBusyError).requestId).toBe('aaaaaaaa-1111');
    expect(b.blockedHandle('aaaaaaaa-1111')).toBe('term_1');

    refuse = false;
    await b.retryPrompt('aaaaaaaa-1111');
    expect(calls.at(-1)).toEqual([
      'terminal', 'send', '--terminal', 'term_1', '--text=hello', '--enter', '--retry-request=aaaaaaaa-1111', '--wait-submit=10',
    ]);
    expect(b.blockedHandle('aaaaaaaa-1111')).toBeNull();
  });

  it('matches a blocked prompt by message when the error code is generic', async () => {
    const { orca } = fake(() => new OrcaCliError('agent_prompt_blocked: busy (request ID: cccccccc-3333)', 'orca_error'));
    const err = await new OrcaBackend(orca).sendPrompt('term_1', 'hi').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendBusyError);
    expect((err as BackendBusyError).requestId).toBe('cccccccc-3333');
  });

  it('chains a re-blocked retry to the original prompt', async () => {
    let next = 'aaaaaaaa-1111';
    const { orca, calls } = fake(() => (next ? blocked(next) : {}));
    const b = new OrcaBackend(orca);
    await b.sendPrompt('term_1', 'hello').catch(() => undefined);
    next = 'bbbbbbbb-2222';
    const again = await b.retryPrompt('aaaaaaaa-1111').catch((e: unknown) => e);
    expect((again as BackendBusyError).requestId).toBe('bbbbbbbb-2222');
    next = '';
    await b.retryPrompt('bbbbbbbb-2222');
    expect(calls.at(-1)).toEqual([
      'terminal', 'send', '--terminal', 'term_1', '--text=hello', '--enter', '--retry-request=bbbbbbbb-2222', '--wait-submit=10',
    ]);
  });

  it('forgets blocked prompts after 10 minutes and rethrows other errors', async () => {
    let now = 0;
    let refuse: Error = blocked('aaaaaaaa-1111');
    const { orca } = fake(() => refuse);
    const b = new OrcaBackend(orca, undefined, () => now);
    await b.sendPrompt('term_1', 'one').catch(() => undefined);
    now = 10 * 60_000 + 1;
    refuse = blocked('bbbbbbbb-2222');
    await b.sendPrompt('term_1', 'two').catch(() => undefined);
    expect(b.blockedHandle('aaaaaaaa-1111')).toBeNull();
    expect(b.blockedHandle('bbbbbbbb-2222')).toBe('term_1');

    refuse = new OrcaCliError('boom', 'orca_error');
    await expect(b.sendPrompt('term_1', 'x')).rejects.toThrow('boom');
    await expect(b.retryPrompt('nope')).rejects.toThrow();
  });
});

describe('OrcaBackend hire', () => {
  it('waits for the new agent TUI before typing the first prompt', async () => {
    const { orca, calls } = fake((args) =>
      args[1] === 'create' ? { terminal: { handle: 'term_9' } } : args[1] === 'wait' ? { wait: { satisfied: true } } : {},
    );
    expect(await new OrcaBackend(orca).hire({ kind: 'agent', deskId: 'r::/a', agent: 'claude', prompt: 'go' })).toEqual({});
    expect(calls).toEqual([
      ['terminal', 'create', '--worktree=id:r::/a', '--command=claude', '--title=claude'],
      ['terminal', 'wait', '--terminal=term_9', '--for=tui-idle', '--timeout-ms=60000'],
      ['terminal', 'send', '--terminal=term_9', '--text=go', '--enter'],
    ]);
  });

  it('warns instead of typing when the TUI never became idle', async () => {
    const { orca, calls } = fake((args) => (args[1] === 'create' ? { handle: 'term_9' } : { wait: { satisfied: false } }));
    const r = await new OrcaBackend(orca).hire({ kind: 'agent', deskId: 'r::/a', agent: 'claude', prompt: 'go' });
    expect(r.warning).toMatch(/첫 지시는 보내지 못했어요/);
    expect(calls.some((c) => c[1] === 'send')).toBe(false);
  });

  it('passes a new worktree prompt to Orca directly', async () => {
    const { orca, calls } = fake();
    await new OrcaBackend(orca).hire({ kind: 'worktree', repoId: 'r1', name: 'x', agent: 'codex', baseBranch: null, prompt: 'go' });
    expect(calls).toEqual([['worktree', 'create', '--repo=id:r1', '--name=x', '--no-parent', '--agent=codex', '--prompt=go']]);
  });
});

describe('OrcaBackend board, search, usage, sessions', () => {
  it('clears a comment with a single space (Orca has no empty comment)', async () => {
    const { orca, calls } = fake();
    const b = new OrcaBackend(orca);
    await b.setBoard('r::/a', { workspaceStatus: 'in-review', comment: '' });
    await b.setBoard('r::/a', { comment: 'hi' });
    expect(calls).toEqual([
      ['worktree', 'set', '--worktree=id:r::/a', '--workspace-status=in-review', '--comment= '],
      ['worktree', 'set', '--worktree=id:r::/a', '--comment=hi'],
    ]);
  });

  it('maps conversation search hits', async () => {
    const { orca, calls } = fake(() => ({
      hits: [
        { agent: 'claude', title: 'Fix', cwd: '/p/a', updatedAt: '2026-10-01', evidence: { snippet: 'x [[y]]', role: 'user' }, source: { filePath: '/f.jsonl' }, resumeCommand: 'claude -r 1' },
        {},
      ],
    }));
    expect(await new OrcaBackend(orca).searchConversations('y')).toEqual([
      { agent: 'claude', title: 'Fix', cwd: '/p/a', updatedAt: '2026-10-01', snippet: 'x [[y]]', role: 'user', filePath: '/f.jsonl', resumeCommand: 'claude -r 1' },
      { agent: '', title: '', cwd: '', updatedAt: null, snippet: '', role: null, filePath: null, resumeCommand: null },
    ]);
    expect(calls[0]).toEqual(['search', '--query=y', '--scope=conversation', '--limit=30']);
  });

  it('reads usage from account list', async () => {
    const { orca } = fake(() => ({ rateLimits: { claude: { provider: 'claude', status: 'ok', session: { usedPercent: 50 } } } }));
    const u = await new OrcaBackend(orca).usage();
    expect(u?.providers).toEqual([{ provider: 'claude', windows: [expect.objectContaining({ key: 'session', usedPercent: 50 })] }]);
  });

  it('finds sessions through orca search and caches them', async () => {
    const { orca } = fake(() => ({ hits: [{ cwd: '/p/a', source: { presence: 'present', filePath: '/s.jsonl' } }] }));
    const b = new OrcaBackend(orca);
    const desk = { id: 'r::/p/a', path: '/p/a' } as OfficeDesk;
    const agent = { id: 'tab:leaf', agentType: 'claude', prompt: 'add pixel assets please', lastMessage: null, terminalTitle: null } as OfficeAgent;
    expect(b.cachedSession('tab:leaf')).toBeNull();
    expect(await b.findSession(desk, agent)).toBe('/s.jsonl');
    expect(b.cachedSession('tab:leaf')).toBe('/s.jsonl');
  });
});

describe('OrcaBackend v2', () => {
  it('turns terminal_not_writable into a friendly error with a stable code', async () => {
    const { orca } = fake(() => new OrcaCliError('terminal_not_writable Terminal prompt request ID: 1fe4f207-0a7f-487d-8c7e-d7f040e56dd6. Re-issue …', 'terminal_not_writable'));
    const b = new OrcaBackend(orca, undefined, Date.now, 'darwin');
    const sent = await b.sendPrompt('term_1', 'hi').catch((e: unknown) => e);
    expect(sent).toMatchObject({ code: 'terminal_not_writable' });
    expect((sent as Error).message).toMatch(/입력할 수 없어요/);
    await expect(b.sendKeys('term_1', { enter: true })).rejects.toMatchObject({ code: 'terminal_not_writable' });
  });

  it('declares what Orca can do and refuses native-only calls', async () => {
    const b = new OrcaBackend(fake().orca);
    expect(b.capabilities).toEqual({ usage: true, search: true, board: true, hire: true, changes: true, transcripts: true, focus: true, repos: false });
    expect(b.messages.noSession).toMatch(/Agent Session History/);
    expect(b.hook('x', 'y', {})).toBe(false);
    await expect(b.addRepo('/tmp')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(b.dispose()).resolves.toBeUndefined();
  });
});
