import { describe, expect, it } from 'vitest';
import type { OfficeSnapshot } from '../src/model.js';
import { App, type TuiDeps } from '../src/tui/app.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;?<>]*[a-zA-Z~]|\x1b[78=>]/g, '');

function setup(desks: unknown[] = [{ id: 'r1::/w/app', repoId: 'r1', repo: 'app', name: 'app', branch: 'main', agents: [{ id: 'a1:main', agentType: 'claude', state: 'done', activity: '완료', terminalHandle: 'pty_a1' }] }]) {
  let snap = { desks, updatedAt: 0, error: null } as unknown as OfficeSnapshot;
  const listeners = new Set<() => void>();
  const calls: unknown[] = [];
  const hostWrites: string[] = [];
  const deps: TuiDeps = {
    snapshot: () => snap,
    onSnapshot: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    refresh: async () => {},
    hire: async (spec) => (calls.push(['hire', spec]), spec.agent === 'codex' ? { warning: '첫 지시는 Claude에만 자동으로 전달돼요' } : {}),
    addRepo: async (p) => {
      calls.push(['addRepo', p]);
      if (p === '/nope') throw new Error('git 저장소가 아니에요: /nope');
    },
    terminalOf: (id) => (id === 'a1:main' ? 'a1' : null),
    host: {
      has: () => true,
      write: (_id: string, d: string) => void hostWrites.push(d),
      onData: () => () => {},
      onExit: () => () => {},
      resize: () => {},
      serialize: () => 'AGENT SCREEN',
      setReplies: () => {},
    },
    url: 'http://127.0.0.1:4318',
  };
  const out = { columns: 100, rows: 24, text: '', write: (s: string) => ((out.text += s), true) };
  const input = { on: () => {} };
  const app = new App(deps, input, out);
  app.start();
  const setSnap = (s: OfficeSnapshot) => {
    snap = s;
    listeners.forEach((fn) => fn());
  };
  return { app, out, calls, hostWrites, setSnap, host: deps.host };
}

describe('App', () => {
  it('renders the lobby, attaches with Enter, forwards keys and comes back with Ctrl+]', async () => {
    const { app, out, hostWrites } = setup();
    expect(strip(out.text)).toContain('Office Desks');
    out.text = '';
    await app.handle('\r');
    expect(out.text).toContain('AGENT SCREEN');
    await app.handle('hi');
    expect(hostWrites).toEqual(['hi']);
    out.text = '';
    await app.handle('\x1d');
    expect(strip(out.text)).toContain('Enter 붙기');
  });

  it('adds a project and reports failures as notices', async () => {
    const { app, out, calls } = setup();
    await app.handle('p');
    await app.handle('/repo/x\r');
    expect(calls).toContainEqual(['addRepo', '/repo/x']);
    expect(strip(out.text)).toContain('프로젝트를 추가했어요');
    await app.handle('p');
    await app.handle('/nope\r');
    expect(strip(out.text)).toContain('⚠️ git 저장소가 아니에요: /nope');
  });

  it('starts new work through validateHire and shows a hire warning', async () => {
    const { app, out, calls } = setup();
    await app.handle('n');
    await app.handle('fix-login\r');
    await app.handle('\x7f\x7f\x7f\x7f\x7f\x7fcodex\r');
    await app.handle('go\r');
    expect(calls).toContainEqual(['hire', { kind: 'worktree', repoId: 'r1', name: 'fix-login', agent: 'codex', baseBranch: null, prompt: 'go' }]);
    expect(strip(out.text)).toContain('첫 지시는 Claude에만');
  });

  it('rejects an invalid worktree name without calling hire', async () => {
    const { app, out, calls } = setup();
    await app.handle('n');
    await app.handle('bad name\r\r\r');
    expect(calls).toEqual([]);
    expect(strip(out.text)).toContain('⚠️');
  });

  it('asks before quitting when agents are running', async () => {
    const { app, out } = setup();
    let quit = false;
    void app.done.then(() => (quit = true));
    await app.handle('q');
    expect(strip(out.text)).toContain('에이전트 1개가 함께 종료됩니다');
    await app.handle('n');
    await new Promise((r) => setTimeout(r, 0));
    expect(quit).toBe(false);
    await app.handle('q');
    await app.handle('y');
    await new Promise((r) => setTimeout(r, 0));
    expect(quit).toBe(true);
  });

  it('quits at once in an empty office and guides the first step', async () => {
    const { app, out } = setup([]);
    expect(strip(out.text)).toContain('p로 git 저장소를 추가하세요');
    await app.handle('n');
    expect(strip(out.text)).toContain('먼저 p로 프로젝트를 추가하세요');
    let quit = false;
    void app.done.then(() => (quit = true));
    await app.handle('q');
    await new Promise((r) => setTimeout(r, 0));
    expect(quit).toBe(true);
  });
});

describe('App controller additions', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const two = [
    { id: 'd1', repoId: 'r1', repo: 'app', name: 'a', branch: 'main', agents: [{ id: 'a1', agentType: 'claude', state: 'done', activity: 'x', terminalHandle: 'p1' }] },
    { id: 'd2', repoId: 'r1', repo: 'app', name: 'b', branch: 'main', agents: [{ id: 'a2', agentType: 'claude', state: 'done', activity: 'y', terminalHandle: 'p2' }] },
  ];

  it('joins an escape sequence split across chunks', async () => {
    const { app, out } = setup(two);
    await app.handle('\x1b');
    await app.handle('[B');
    await app.handle('\x1b[');
    await app.handle('Bx');
    await wait(80);
    out.text = '';
    await app.handle('\r');
    // second row (a2) has no terminal in setup(): the notice proves it was selected
    expect(strip(out.text)).toContain('에이전트가 이미 종료됐어요');
  });

  it('delivers a lone ESC as escape after a short wait', async () => {
    const { app, out } = setup();
    await app.handle('p');
    await app.handle('\x1b');
    await wait(120);
    expect(strip(out.text)).toContain('Enter 붙기');
    expect(strip(out.text.slice(out.text.lastIndexOf('Office Desks')))).not.toContain('Esc 취소');
  });

  it('re-enters the alternate screen after leaving attach', async () => {
    const { app, out } = setup();
    await app.handle('\r');
    out.text = '';
    await app.handle('\x1d');
    expect(out.text).toContain('\x1b[?1049h\x1b[?25l\x1b[2J');
  });

  it('survives onLeave firing synchronously inside start()', async () => {
    const { app, out, host } = setup();
    host.has = () => false;
    await app.handle('\r');
    expect(strip(out.text)).toContain('에이전트가 종료됐어요');
    await app.handle('p');
    expect(strip(out.text)).toContain('git 저장소 경로');
  });
});
