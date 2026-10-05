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
  return { app, out, calls, hostWrites, setSnap, host: deps.host, deps, input };
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

  const selectedLine = (text: string) => strip(text).split('\n').flatMap((l) => l.split('\r')).filter((l) => l.includes('▸')).pop() ?? '';

  it('joins an escape sequence split across chunks (lone ESC, then [B)', async () => {
    const { app, out } = setup(two);
    await app.handle('\x1b');
    await app.handle('[B');
    out.text = '';
    await app.handle('x');
    expect(selectedLine(out.text)).toMatch(/▸ b\b/);
  });

  it('joins an escape sequence split across chunks (ESC [, then B)', async () => {
    const { app, out } = setup(two);
    await app.handle('\x1b[');
    await app.handle('B');
    out.text = '';
    await app.handle('x');
    expect(selectedLine(out.text)).toMatch(/▸ b\b/);
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

  const agentDesk = (id: string, name: string, agentId: string) => ({ id, repoId: 'r1', repo: 'app', name, branch: 'main', agents: [{ id: agentId, agentType: 'claude', state: 'done', activity: name, terminalHandle: 'p' }] });
  const snapOf = (desks: unknown[]) => ({ desks, updatedAt: 0, error: null }) as unknown as OfficeSnapshot;

  it('serializes input chunks while a hire is in flight', async () => {
    const { app, calls, deps, input } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    deps.hire = async (spec) => (calls.push(['hire', spec]), await gate, {});
    let onData!: (d: string) => void;
    (input as { on: unknown }).on = (_e: string, fn: (d: string) => void) => (onData = fn);
    app.start();
    onData('n');
    onData('fix-a\r\r\r');
    onData('p');
    onData('/x\r');
    await wait(20);
    expect(calls.map((c) => (c as unknown[])[0])).toEqual(['hire']);
    release();
    await wait(20);
    expect(calls.map((c) => (c as unknown[])[0])).toEqual(['hire', 'addRepo']);
  });

  it('writes nothing after quit, even when a hire resolves later', async () => {
    const { app, out, deps } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    deps.hire = async () => (await gate, {});
    const pending = app.handle('a\r\r');
    await wait(5);
    void pending;
    await app.handle('q');
    await app.handle('y');
    await wait(5);
    const before = out.text;
    release();
    await wait(20);
    expect(out.text).toBe(before);
  });

  it('keeps the same agent selected after returning from attach', async () => {
    const { app, out, setSnap } = setup([agentDesk('d1', 'zeta', 'a1')]);
    await app.handle('\r');
    setSnap(snapOf([agentDesk('d0', 'alpha', 'a0'), agentDesk('d1', 'zeta', 'a1')]));
    out.text = '';
    await app.handle('\x1d');
    expect(selectedLine(out.text)).toMatch(/▸ zeta\b/);
  });

  it('keeps the selection on the same agent across a lobby snapshot update', async () => {
    const { app, out, setSnap } = setup(two);
    await app.handle('j');
    setSnap(snapOf([agentDesk('d0', 'alpha', 'a0'), ...(two as never[])]));
    expect(selectedLine(out.text)).toMatch(/▸ b\b/);
  });

  it('does not draw the lobby on a snapshot update while attached', async () => {
    const { app, out, setSnap } = setup();
    await app.handle('\r');
    out.text = '';
    setSnap(snapOf([agentDesk('d9', 'zzz', 'a9')]));
    expect(strip(out.text)).not.toContain('Enter 붙기');
  });

  it('adds an agent to the selected worktree', async () => {
    const { app, out, calls } = setup();
    await app.handle('a');
    await app.handle('\r');
    await app.handle('hello\r');
    expect(calls).toContainEqual(['hire', { kind: 'agent', deskId: 'r1::/w/app', agent: 'claude', prompt: 'hello' }]);
    expect(strip(out.text)).toContain('에이전트를 띄웠어요');
  });

  it('treats Ctrl+C in the lobby like q', async () => {
    const { app, out } = setup();
    await app.handle('\x03');
    expect(strip(out.text)).toContain('에이전트 1개가 함께 종료됩니다');
    const empty = setup([]);
    let quit = false;
    void empty.app.done.then(() => (quit = true));
    await empty.app.handle('\x03');
    await wait(0);
    expect(quit).toBe(true);
  });

  it('forwards the rest of the chunk after Enter to the agent', async () => {
    const { app, hostWrites } = setup();
    await app.handle('\rhi');
    expect(hostWrites).toEqual(['hi']);
  });
});

describe('App review fixes', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const hostOf = (deps: TuiDeps) => deps.host as unknown as Record<string, unknown>;

  it('does not resize the agent on a snapshot update while attached, only on a real resize', async () => {
    const { app, deps, setSnap } = setup();
    let resizes = 0;
    hostOf(deps).resize = () => void resizes++;
    await app.handle('\r');
    const after = resizes;
    setSnap({ desks: [], updatedAt: 1, error: null } as unknown as OfficeSnapshot);
    expect(resizes).toBe(after);
  });

  it('runs the delayed lone ESC through the input queue', async () => {
    const { deps, out } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    deps.addRepo = async () => void (await gate);
    let onData!: (d: string) => void;
    const app = new App(deps, { on: (_e: string, fn: (d: string) => void) => (onData = fn) }, out, 20);
    const seen: string[] = [];
    const key = (app as unknown as { key(k: { name: string }): Promise<void> }).key.bind(app);
    (app as unknown as { key(k: { name: string }): Promise<void> }).key = (k) => (seen.push(k.name), key(k));
    app.start();
    onData('p');
    onData('/r\r\x1b'); // submits (addRepo hangs), then a lone ESC is held
    await wait(80);
    expect(seen).not.toContain('escape');
    release();
    await wait(80);
    expect(seen.at(-1)).toBe('escape');
  });

  it('forwards the raw bytes after the attaching Enter, including a held partial sequence', async () => {
    const a = setup();
    await a.app.handle('\r\x1bOA\x1b[1;5Aé');
    expect(a.hostWrites).toEqual(['\x1bOA\x1b[1;5Aé']);
    const b = setup();
    await b.app.handle('\r\x1b[');
    await b.app.handle('A');
    expect(b.hostWrites.join('')).toBe('\x1b[A');
  });

  it('shows the real cursor after the typed text while a form is open, hidden otherwise', async () => {
    const { app, out } = setup();
    out.text = '';
    await app.handle('n');
    expect(strip(out.text)).toContain('새 워크트리 이름 (app): ');
    expect(strip(out.text)).not.toContain('█');
    await app.handle('ab');
    // ' 새 워크트리 이름 (app): ab' is 27 columns wide; the cursor sits right after it.
    expect(out.text.endsWith('\x1b[24;28H\x1b[?25h')).toBe(true);
    await app.handle('\x1b');
    await wait(120);
    expect(out.text.endsWith('\x1b[?25l')).toBe(true);
  });

  it('says it is working while a hire or a project add is in flight', async () => {
    const { app, out, deps } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    deps.hire = async () => (await gate, {});
    const pending = app.handle('a\r\r');
    await wait(5);
    expect(strip(out.text)).toContain('만드는 중…');
    release();
    await pending;
    expect(strip(out.text.slice(out.text.lastIndexOf('Office Desks')))).not.toContain('만드는 중…');
    let rel2!: () => void;
    const gate2 = new Promise<void>((r) => (rel2 = r));
    deps.addRepo = async () => void (await gate2);
    const p2 = app.handle('p/x\r');
    await wait(5);
    expect(strip(out.text)).toContain('추가하는 중…');
    rel2();
    await p2;
  });

  it('stops an attached session when closed (title popped, modes reset)', async () => {
    const { app, out } = setup();
    await app.handle('\r');
    out.text = '';
    app.close();
    expect(out.text).toContain('\x1b[23;0t');
  });
});
