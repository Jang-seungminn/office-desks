import { Terminal } from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { BackendError } from '../src/backend/types.js';
import type { OfficeSnapshot } from '../src/model.js';
import { App, type TuiDeps } from '../src/tui/app.js';

// The App against real headless terminals: one per agent (its screen) and one for the user's
// terminal, which every byte the App writes goes through, so assertions read the screen as seen.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const put = (t: Terminal, s: string) => new Promise<void>((r) => t.write(s, r));

const agentDesk = (id: string, name: string, agentId: string, pty: string, repo = 'app') => ({
  id,
  repoId: 'r1',
  repo,
  name,
  branch: 'main',
  agents: [{ id: agentId, agentType: 'claude', state: 'done', activity: name, terminalHandle: pty }],
});
const emptyDesk = (id: string, name: string) => ({ id, repoId: 'r1', repo: 'app', name, branch: 'main', agents: [] });
const TWO = [agentDesk('d1', 'a', 'a1', 'p1'), agentDesk('d2', 'b', 'a2', 'p2')];
const snapOf = (desks: unknown[]) => ({ desks, updatedAt: 0, error: null }) as unknown as OfficeSnapshot;

async function setup(desks: unknown[] = TWO, agentText: Record<string, string> = { p1: 'agent one screen', p2: 'agent two screen' }) {
  let snap = snapOf(desks);
  const listeners = new Set<() => void>();
  const calls: unknown[][] = [];
  const writes: [string, string][] = [];
  const resizes: [number, number][] = [];
  const terms = new Map<string, Terminal>();
  const data = new Map<string, Set<(d: string) => void>>();
  const exitFns = new Set<(id: string, code: number) => void>();
  const ptyOf: Record<string, string> = {};
  for (const d of desks as { agents: { id: string; terminalHandle: string }[] }[]) {
    for (const a of d.agents) {
      ptyOf[a.id] = a.terminalHandle;
      const t = new Terminal({ cols: 40, rows: 10, scrollback: 200, allowProposedApi: true });
      await put(t, agentText[a.terminalHandle] ?? '');
      terms.set(a.terminalHandle, t);
    }
  }
  const alive = (id: string) => terms.has(id);
  const host = {
    has: alive,
    write: (id: string, d: string) => void writes.push([id, d]),
    onData: (id: string, fn: (d: string) => void) => {
      const set = data.get(id) ?? new Set();
      data.set(id, set.add(fn));
      return () => void set.delete(fn);
    },
    onExit: (fn: (id: string, code: number) => void) => (exitFns.add(fn), () => void exitFns.delete(fn)),
    resize: (id: string, c: number, r: number) => terms.get(id)?.resize(c, r),
    serialize: (id: string) => `SERIALIZED ${id}`,
    setReplies: () => {},
  };
  const deps: TuiDeps = {
    snapshot: () => snap,
    onSnapshot: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    refresh: async () => {},
    hire: async (spec) => (calls.push(['hire', spec]), spec.agent === 'codex' ? { warning: '첫 지시는 Claude에만 자동으로 전달돼요' } : {}),
    addRepo: async (p) => {
      calls.push(['addRepo', p]);
      if (p === '/nope') throw new Error('git 저장소가 아니에요: /nope');
    },
    stopAgent: async (id) => void calls.push(['stopAgent', id]),
    removeWorktree: async (id) => void calls.push(['removeWorktree', id]),
    terminalOf: (id) => (ptyOf[id] && alive(ptyOf[id]) ? ptyOf[id] : null),
    terminal: (pty) => terms.get(pty) ?? null,
    resizeAgents: (c, r) => {
      resizes.push([c, r]);
      for (const t of terms.values()) t.resize(c, r);
    },
    host,
    url: 'http://127.0.0.1:4318',
  };
  const real = new Terminal({ cols: 100, rows: 24, allowProposedApi: true });
  const resizeFns = new Set<() => void>();
  const out = {
    columns: 100,
    rows: 24,
    text: '',
    write: (s: string) => ((out.text += s), real.write(s), true),
    on: (_e: 'resize', fn: () => void) => resizeFns.add(fn),
    off: (_e: 'resize', fn: () => void) => resizeFns.delete(fn),
  };
  let onInput: (d: string) => void = () => {};
  const input = { on: (_e: 'data', fn: (d: string) => void) => (onInput = fn) };
  const app = new App(deps, input, out);
  app.start();
  /** The user's screen as text lines, once everything written so far is parsed. */
  const screen = async () => {
    await put(real, '');
    return Array.from({ length: real.rows }, (_, y) => real.buffer.active.getLine(y)!.translateToString(true));
  };
  // Spaces collapsed, so assertions don't depend on padding.
  const text = async () => (await screen()).join('\n').replace(/ +/g, ' ');
  const selectedLine = async () => (await screen()).find((l) => l.includes('▸')) ?? '';
  const emit = async (pty: string, s: string) => {
    await put(terms.get(pty)!, s);
    for (const fn of data.get(pty) ?? []) fn(s);
    await put(terms.get(pty)!, ''); // past the App's parse barrier: its render is now scheduled
  };
  /** Like PtyHost: the headless write is queued (parsed later) and listeners are told at once. */
  const emitRaw = (pty: string, s: string) => {
    terms.get(pty)!.write(s);
    for (const fn of data.get(pty) ?? []) fn(s);
  };
  const exit = (pty: string) => {
    terms.get(pty)?.dispose();
    terms.delete(pty);
    for (const fn of exitFns) fn(pty, 0);
  };
  const setSnap = (desks: unknown[]) => {
    snap = snapOf(desks);
    listeners.forEach((fn) => fn());
  };
  const resize = (cols: number, rows: number) => {
    out.columns = cols;
    out.rows = rows;
    real.resize(cols, rows);
    resizeFns.forEach((fn) => fn());
  };
  return { app, out, deps, calls, writes, resizes, terms, screen, text, selectedLine, emit, emitRaw, exit, setSnap, resize, input: () => onInput };
}

describe('App: sidebar and live panel', () => {
  it('shows the sidebar and the first agent panel together at start', async () => {
    const { text, resizes } = await setup();
    const t = await text();
    expect(t).toContain('Office Desks');
    expect(t).toContain(' app');
    expect(t).toContain('agent one screen');
    expect(t).toContain('app/a · claude');
    // 100x24: a 28-column sidebar and a separator leave the panel 71x21.
    expect(resizes).toEqual([[71, 21]]);
  });

  it('switches the panel live when the selection moves, without Enter', async () => {
    const { app, text, selectedLine } = await setup();
    await app.handle('\x1b[B');
    expect(await selectedLine()).toMatch(/▸ b\b/);
    expect(await text()).toContain('agent two screen');
    await app.handle('k');
    expect(await text()).toContain('agent one screen');
  });

  it('routes keys to the shown agent in panel focus, encoded for its modes, until Ctrl+]', async () => {
    const { app, writes, emit, text } = await setup();
    await app.handle('\r');
    expect(await text()).toContain('패널 입력 중 · Ctrl+] 목록으로');
    await app.handle('hi');
    expect(writes).toEqual([['p1', 'hi']]);
    await emit('p1', '\x1b[?1h');
    await app.handle('\x1b[A');
    expect(writes.at(-1)).toEqual(['p1', '\x1bOA']);
    await app.handle('\x1b[200~pasted\x1b[201~');
    expect(writes.at(-1)).toEqual(['p1', 'pasted']);
    writes.length = 0;
    await app.handle('ab\x1dzz');
    expect(writes).toEqual([['p1', 'ab']]);
    expect(await text()).toContain('q 나가기 · Enter 입력');
    await app.handle('j');
    expect(writes).toEqual([['p1', 'ab']]);
  });

  it('focuses the panel with → and Ctrl+] too, and forwards the rest of that chunk', async () => {
    const a = await setup();
    await a.app.handle('\x1b[Cxy');
    expect(a.writes).toEqual([['p1', 'xy']]);
    const b = await setup();
    await b.app.handle('\x1dq');
    expect(b.writes).toEqual([['p1', 'q']]);
    const c = await setup();
    await c.app.handle('\r\x1b[');
    await c.app.handle('A');
    expect(c.writes.map(([, d]) => d).join('')).toBe('\x1b[A');
  });

  it('holds a paste split across chunks and sends it whole', async () => {
    const { app, writes, emit } = await setup();
    await emit('p1', '\x1b[?2004h');
    await app.handle('\r');
    await app.handle('\x1b[200~par');
    expect(writes).toEqual([]);
    await app.handle('t\x1b[201~');
    expect(writes).toEqual([['p1', '\x1b[200~part\x1b[201~']]);
  });

  it('re-renders only a diff when the shown agent prints, and ignores other agents', async () => {
    const { app, out, emit, text } = await setup();
    const full = out.text.length;
    out.text = '';
    await emit('p1', '\r\nnew line here');
    app.flush();
    expect(await text()).toContain('new line here');
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text.length).toBeLessThan(full / 4);
    out.text = '';
    await emit('p2', 'hidden');
    app.flush();
    await wait(30);
    expect(out.text).toBe('');
  });

  it('draws agent output only once its headless terminal has parsed it', async () => {
    const { app, emitRaw, terms, text } = await setup();
    emitRaw('p1', ' parsed later');
    app.flush(); // nothing parsed yet: a draw now would show the old screen and never be redone
    await put(terms.get('p1')!, '');
    await wait(40);
    expect(await text()).toContain('agent one screen parsed later');
  });

  it('coalesces agent output into one render after a short delay', async () => {
    const { out, emit, text } = await setup();
    out.text = '';
    await emit('p1', ' x');
    await emit('p1', ' y');
    expect(out.text).toBe('');
    await wait(40);
    expect(await text()).toContain('agent one screen x y');
  });

  it('scrolls back with PgUp and returns to live on any other key', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `L${i}`).join('\r\n');
    const { app, screen, text } = await setup(TWO, { p1: lines, p2: '' });
    expect(await text()).toContain('L39');
    await app.handle('\x1b[5~');
    const scr = await screen();
    expect(scr.join('\n')).toContain('↑ 기록 보는 중');
    expect(scr.some((l) => /│L0\s*$/.test(l))).toBe(true);
    await app.handle('\x1b[6~');
    expect(await text()).not.toContain('↑ 기록 보는 중');
    await app.handle('\x1b[5~');
    await app.handle('h');
    const live = await text();
    expect(live).not.toContain('↑ 기록 보는 중');
    expect(live).toContain('L39');
  });

  it('zooms with z through AttachSession and repaints in full on Ctrl+]', async () => {
    const { app, out, resizes } = await setup();
    out.text = '';
    await app.handle('z');
    expect(out.text).toContain('SERIALIZED p1');
    out.text = '';
    await app.handle('\x1d');
    expect(out.text).toContain('\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[2J');
    expect(out.text).toContain('agent one screen');
    expect(resizes.at(-1)).toEqual([71, 21]);
  });

  it('stops the selected agent after y, not after n, and says so for a row without one', async () => {
    const { app, calls, text } = await setup([...TWO, emptyDesk('d3', 'c')]);
    await app.handle('x');
    expect(await text()).toContain('에이전트를 종료할까요? app/a · claude (y/N)');
    await app.handle('n');
    expect(calls).toEqual([]);
    await app.handle('jx');
    await app.handle('y');
    expect(calls).toEqual([['stopAgent', 'a2']]);
    await app.handle('jx');
    expect(await text()).toContain('종료할 에이전트가 없어요');
  });

  it('removes a worktree after y and shows backend refusals as notices', async () => {
    const { app, calls, deps, text } = await setup();
    await app.handle('d');
    expect(await text()).toContain('워크트리를 지울까요? a (브랜치는 남아요) (y/N)');
    await app.handle('y');
    expect(calls).toEqual([['removeWorktree', 'd1']]);
    deps.removeWorktree = async () => {
      throw new BackendError('에이전트가 실행 중인 워크트리는 지울 수 없어요 (x로 먼저 종료)', 'has_agents');
    };
    await app.handle('dy');
    expect(await text()).toContain('⚠ 에이전트가 실행 중인 워크트리는');
    deps.removeWorktree = async () => {
      throw new BackendError('메인 체크아웃은 지울 수 없어요', 'main_checkout');
    };
    await app.handle('dy');
    expect(await text()).toContain('메인 체크아웃은 지울 수 없어요');
  });

  it('draws an error notice exactly as composed: no stray double space after the warning sign', async () => {
    const { app, deps, screen } = await setup([...TWO, emptyDesk('d3', 'c')]);
    deps.removeWorktree = async () => {
      throw new BackendError('변경사항이 있는 워크트리는 지울 수 없어요', 'dirty');
    };
    await app.handle('jj');
    await app.handle('d');
    await app.handle('y');
    const help = (await screen()).at(-1)!.trimEnd();
    expect(help).toBe(' ⚠ 변경사항이 있는 워크트리는 지울 수 없어요');
  });

  it('resizes the agents to the new panel and repaints in full on a terminal resize', async () => {
    const { out, resizes, resize, text } = await setup();
    out.text = '';
    resize(120, 30);
    expect(resizes.at(-1)).toEqual([91, 27]);
    expect(out.text).toContain('\x1b[2J');
    expect(await text()).toContain('agent one screen');
  });

  it('returns to list focus when the shown agent exits', async () => {
    const { app, exit, writes, text } = await setup();
    await app.handle('\r');
    exit('p1');
    const t = await text();
    expect(t).toContain('에이전트가 종료됐어요');
    expect(t).toContain('종료됨');
    await app.handle('hi');
    expect(writes).toEqual([]);
  });

  it('leaves panel focus when a snapshot takes the shown agent away', async () => {
    const { app, setSnap, writes, text, selectedLine } = await setup();
    await app.handle('\r');
    setSnap([TWO[1]]);
    expect(await selectedLine()).toMatch(/▸ b\b/);
    expect(await text()).toContain('에이전트가 종료됐어요');
    await app.handle('hi');
    expect(writes).toEqual([]);
  });

  it('ignores a paste in list focus but types it into a form', async () => {
    const { app, calls, text, selectedLine } = await setup();
    await app.handle('\x1b[200~study\x1b[201~');
    expect(calls).toEqual([]);
    expect(await selectedLine()).toMatch(/▸ a\b/);
    expect(await text()).not.toContain('(y/N)');
    await app.handle('p');
    await app.handle('\x1b[200~/repo/x\r\x1b[201~');
    await app.handle('\r');
    expect(calls).toEqual([['addRepo', '/repo/x']]);
  });

  it('sends a lone ESC to the agent in panel focus after the escape wait', async () => {
    const { app, writes } = await setup();
    await app.handle('\r');
    await app.handle('\x1b');
    expect(writes).toEqual([]);
    await wait(120);
    expect(writes).toEqual([['p1', '\x1b']]);
  });

  it('keeps ignoring a slow paste in list focus as long as its chunks keep coming', async () => {
    const { app, calls, text, selectedLine } = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.now();
      await app.handle('\x1b[200~xx');
      vi.setSystemTime(t0 + 900);
      await app.handle('xx');
      vi.setSystemTime(t0 + 1800);
      await app.handle('jdy\x1b[201~');
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toEqual([]);
    expect(await selectedLine()).toMatch(/▸ a\b/);
    expect(await text()).not.toContain('(y/N)');
  });

  it('never renders after close, even with agent output pending', async () => {
    const { app, out, emit } = await setup();
    await emit('p1', 'late');
    app.close();
    out.text = '';
    await wait(40);
    app.flush();
    await emit('p1', 'later');
    await wait(40);
    expect(out.text).toBe('');
  });
});

describe('App: forms, confirmations and input handling kept from M3', () => {
  it('adds a project and reports failures as notices', async () => {
    const { app, calls, text } = await setup();
    await app.handle('p');
    await app.handle('/repo/x\r');
    expect(calls).toContainEqual(['addRepo', '/repo/x']);
    expect(await text()).toContain('프로젝트를 추가했어요');
    await app.handle('p');
    await app.handle('/nope\r');
    expect(await text()).toContain('⚠ git 저장소가 아니에요: /nope');
  });

  it('starts new work through validateHire and shows a hire warning', async () => {
    const { app, calls, text } = await setup();
    await app.handle('n');
    await app.handle('fix-login\r');
    await app.handle('\x7f\x7f\x7f\x7f\x7f\x7fcodex\r');
    await app.handle('go\r');
    expect(calls).toContainEqual(['hire', { kind: 'worktree', repoId: 'r1', name: 'fix-login', agent: 'codex', baseBranch: null, prompt: 'go' }]);
    expect(await text()).toContain('첫 지시는 Claude에만');
  });

  it('rejects an invalid worktree name without calling hire', async () => {
    const { app, calls, text } = await setup();
    await app.handle('n');
    await app.handle('bad name\r\r\r');
    expect(calls).toEqual([]);
    expect(await text()).toContain('⚠');
  });

  it('adds an agent to the selected worktree', async () => {
    const { app, calls, text } = await setup();
    await app.handle('a');
    await app.handle('\r');
    await app.handle('hello\r');
    expect(calls).toContainEqual(['hire', { kind: 'agent', deskId: 'd1', agent: 'claude', prompt: 'hello' }]);
    expect(await text()).toContain('에이전트를 띄웠어요');
  });

  it('asks before quitting when agents are running (q and Ctrl+C)', async () => {
    const { app, text } = await setup();
    let quit = false;
    void app.done.then(() => (quit = true));
    await app.handle('q');
    expect(await text()).toContain('에이전트 2개가 함께 종료됩니다');
    await app.handle('n');
    await wait(0);
    expect(quit).toBe(false);
    await app.handle('\x03');
    await app.handle('y');
    await wait(0);
    expect(quit).toBe(true);
  });

  it('quits at once in an empty office and guides the first step', async () => {
    const { app, text } = await setup([]);
    expect(await text()).toContain('p로 프로젝트를 추가하세요');
    await app.handle('n');
    expect(await text()).toContain('먼저 p로 프로젝트를 추가하세요');
    let quit = false;
    void app.done.then(() => (quit = true));
    await app.handle('q');
    await wait(0);
    expect(quit).toBe(true);
  });

  it('joins an escape sequence split across chunks in list focus', async () => {
    const a = await setup();
    await a.app.handle('\x1b');
    await a.app.handle('[B');
    expect(await a.selectedLine()).toMatch(/▸ b\b/);
    const b = await setup();
    await b.app.handle('\x1b[');
    await b.app.handle('B');
    expect(await b.selectedLine()).toMatch(/▸ b\b/);
  });

  it('delivers a lone ESC as escape after a short wait (closes a form)', async () => {
    const { app, text } = await setup();
    await app.handle('p');
    expect(await text()).toContain('Esc 취소');
    await app.handle('\x1b');
    await wait(120);
    const t = await text();
    expect(t).toContain('q 나가기');
    expect(t).not.toContain('Esc 취소');
  });

  it('shows the real cursor after the typed text while a form is open, hidden otherwise', async () => {
    const { app, out, text } = await setup();
    await app.handle('n');
    expect(await text()).toContain('새 워크트리 이름 (app): ');
    await app.handle('ab');
    // ' 새 워크트리 이름 (app): ab' is 27 columns wide; the cursor sits right after it.
    expect(out.text.endsWith('\x1b[24;28H\x1b[?25h')).toBe(true);
    await app.handle('\x1b');
    await wait(120);
    expect(out.text.endsWith('\x1b[?25l')).toBe(true);
  });

  it('serializes input chunks while a hire is in flight', async () => {
    const { calls, deps, input } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    deps.hire = async (spec) => (calls.push(['hire', spec]), await gate, {});
    const onData = input();
    onData('n');
    onData('fix-a\r\r\r');
    onData('p');
    onData('/x\r');
    await wait(20);
    expect(calls.map((c) => c[0])).toEqual(['hire']);
    release();
    await wait(20);
    expect(calls.map((c) => c[0])).toEqual(['hire', 'addRepo']);
  });

  it('runs the delayed lone ESC through the input queue', async () => {
    const { deps, out } = await setup();
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

  it('writes nothing after quit, even when a hire resolves later', async () => {
    const { app, out, deps } = await setup();
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

  it('says it is working while a hire is in flight', async () => {
    const { app, deps, text } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    deps.hire = async () => (await gate, {});
    const pending = app.handle('a\r\r');
    await wait(5);
    expect(await text()).toContain('만드는 중…');
    release();
    await pending;
    expect(await text()).not.toContain('만드는 중…');
  });

  it('keeps the selection on the same agent across a snapshot update', async () => {
    const { app, setSnap, selectedLine } = await setup();
    await app.handle('j');
    setSnap([agentDesk('d0', 'alpha', 'a0', 'p0'), ...TWO]);
    expect(await selectedLine()).toMatch(/▸ b\b/);
  });

  it('keeps the same agent selected after returning from zoom, and ignores snapshots while zoomed', async () => {
    const { app, out, setSnap, selectedLine, resizes } = await setup([TWO[1]]);
    await app.handle('z');
    const n = resizes.length;
    out.text = '';
    setSnap([agentDesk('d0', 'alpha', 'a0', 'p0'), TWO[1]]);
    expect(out.text).toBe('');
    expect(resizes.length).toBe(n);
    await app.handle('\x1d');
    expect(await selectedLine()).toMatch(/▸ b\b/);
  });

  it('survives zoom leaving synchronously when the agent is already gone', async () => {
    const { app, deps, text } = await setup();
    (deps.host as { has: (id: string) => boolean }).has = () => false;
    await app.handle('z');
    expect(await text()).toContain('에이전트가 종료됐어요');
    await app.handle('p');
    expect(await text()).toContain('git 저장소 경로');
  });

  it('stops a zoom session when closed (title popped, modes reset)', async () => {
    const { app, out } = await setup();
    await app.handle('z');
    out.text = '';
    app.close();
    expect(out.text).toContain('\x1b[23;0t');
  });
});
