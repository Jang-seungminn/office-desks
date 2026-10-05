import { Terminal } from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { BackendError } from '../src/backend/types.js';
import type { OfficeSnapshot } from '../src/model.js';
import { watchCursor } from '../src/native/ptyHost.js';
import { App, type TuiDeps } from '../src/tui/app.js';
import type { MouseEvent } from '../src/tui/mouse.js';

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

async function setup(
  desks: unknown[] = TWO,
  agentText: Record<string, string> = { p1: 'agent one screen', p2: 'agent two screen' },
  renderMs?: number,
  size: [number, number] = [100, 24],
  escWaitMs?: number,
  over: Partial<TuiDeps> = {},
) {
  let snap = snapOf(desks);
  const listeners = new Set<() => void>();
  const calls: unknown[][] = [];
  const writes: [string, string][] = [];
  const resizes: [string, number, number][] = [];
  const copies: string[] = [];
  const terms = new Map<string, Terminal>();
  const cursors = new Map<string, { hidden: boolean }>();
  const data = new Map<string, Set<(d: string) => void>>();
  const exitFns = new Set<(id: string, code: number) => void>();
  const ptyOf: Record<string, string> = {};
  for (const d of desks as { agents: { id: string; terminalHandle: string }[] }[]) {
    for (const a of d.agents) {
      ptyOf[a.id] = a.terminalHandle;
      const t = new Terminal({ cols: 40, rows: 10, scrollback: 200, allowProposedApi: true });
      cursors.set(a.terminalHandle, watchCursor(t));
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
    cursorHidden: (pty) => cursors.get(pty)?.hidden ?? false,
    resizeAgent: (pty, c, r) => {
      resizes.push([pty, c, r]);
      terms.get(pty)?.resize(c, r);
    },
    copyText: async (t) => (copies.push(t), 'file'),
    host,
    url: 'http://127.0.0.1:4318',
    ...over,
  };
  const real = new Terminal({ cols: size[0], rows: size[1], allowProposedApi: true });
  const resizeFns = new Set<() => void>();
  const out = {
    columns: size[0],
    rows: size[1],
    text: '',
    write: (s: string) => ((out.text += s), real.write(s), true),
    on: (_e: 'resize', fn: () => void) => resizeFns.add(fn),
    off: (_e: 'resize', fn: () => void) => resizeFns.delete(fn),
  };
  let onInput: (d: string) => void = () => {};
  const input = { on: (_e: 'data', fn: (d: string) => void) => (onInput = fn) };
  const app = new App(deps, input, out, escWaitMs, renderMs);
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
  /** Is the user's screen cell at (x, y) (0-based) in reverse video? */
  const inverseAt = async (x: number, y: number) => {
    await put(real, '');
    return !!real.buffer.active.getLine(y)!.getCell(x)!.isInverse();
  };
  return { app, out, deps, calls, writes, resizes, copies, terms, screen, text, selectedLine, emit, emitRaw, exit, setSnap, resize, inverseAt, input: () => onInput };
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
    expect(resizes).toEqual([['p1', 71, 21]]);
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

  it('places but hides the real cursor in panel focus while the agent hides its own', async () => {
    const { app, out, emit } = await setup();
    await app.handle('\r');
    expect(out.text.endsWith('\x1b[?25h')).toBe(true);
    await emit('p1', '\x1b[?25l');
    app.flush();
    expect(out.text).toMatch(/\x1b\[\d+;\d+H\x1b\[\?25l$/);
    await emit('p1', '\x1b[?25h');
    app.flush();
    expect(out.text).toMatch(/\x1b\[\d+;\d+H\x1b\[\?25h$/);
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
    // A delay far longer than any slow runner's emit time: nothing can render before the flush.
    const { app, out, emit, text } = await setup(TWO, { p1: 'agent one screen', p2: 'agent two screen' }, 60_000);
    app.flush();
    out.text = '';
    await emit('p1', ' x');
    await emit('p1', ' y');
    expect(out.text).toBe('');
    app.flush();
    const drawn = out.text;
    expect(drawn).toContain('x');
    expect(drawn).toContain('y');
    expect((drawn.match(/\x1b\[\d+;\d+H/g) ?? []).length).toBeGreaterThan(0);
    out.text = '';
    app.flush(); // the timer was consumed by that one render: nothing further is pending
    expect(out.text).toBe('');
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

  it('keeps the viewed history lines in place while the agent keeps printing', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `L${i}`).join('\r\n');
    const { app, emit, screen } = await setup(TWO, { p1: lines, p2: '' });
    await app.handle('\x1b[5~');
    const before = (await screen()).slice(2, 23);
    expect(before.some((l) => /│L0\s*$/.test(l))).toBe(true);
    await emit('p1', '\r\nN1\r\nN2\r\nN3\r\nN4\r\nN5');
    app.flush();
    expect((await screen()).slice(2, 23)).toEqual(before);
    await app.handle('\x1b[6~'); // back down a page from the anchored spot
    await app.handle('\x1b[6~');
    expect((await screen()).join('\n')).toContain('N5');
  });

  it('zooms with z through AttachSession and repaints in full on Ctrl+]', async () => {
    const { app, out, resizes } = await setup();
    out.text = '';
    await app.handle('z');
    expect(out.text).toContain('SERIALIZED p1');
    out.text = '';
    await app.handle('\x1d');
    expect(out.text).toContain('\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?25l\x1b[2J');
    expect(out.text.lastIndexOf('\x1b[?1000h')).toBeGreaterThan(out.text.lastIndexOf('\x1b[?1000l'));
    expect(out.text).toContain('agent one screen');
    expect(resizes.at(-1)).toEqual(['p1', 71, 21]);
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

  it('removes an idle worktree after y and shows backend refusals as notices', async () => {
    const { app, calls, deps, text } = await setup([...TWO, emptyDesk('d3', 'c')]);
    await app.handle('jj');
    await app.handle('d');
    expect(await text()).toContain('워크트리를 지울까요? c (브랜치는 남아요) (y/N)');
    await app.handle('y');
    expect(calls).toEqual([['removeWorktree', 'd3']]);
    deps.removeWorktree = async () => {
      throw new BackendError('변경사항이 있는 워크트리는 지울 수 없어요', 'dirty');
    };
    await app.handle('d');
    await app.handle('y');
    expect(await text()).toContain('⚠ 변경사항이 있는 워크트리는 지울 수 없어요');
  });

  it('refuses d at once, without asking, on the main checkout and on a worktree with an agent', async () => {
    const main = { ...emptyDesk('d0', 'm'), isMain: true };
    const { app, calls, text } = await setup([...TWO, main]);
    await app.handle('d');
    let t = await text();
    expect(t).toContain('에이전트가 실행 중인 워크트리는 지울 수 없어요 (x로 먼저 종료)');
    expect(t).not.toContain('(y/N)');
    await app.handle('y');
    await app.handle('jj');
    await app.handle('d');
    t = await text();
    expect(t).toContain('메인 체크아웃은 지울 수 없어요');
    expect(t).not.toContain('(y/N)');
    await app.handle('y');
    expect(calls).toEqual([]);
  });

  it('never takes the answer to a confirmation from the chunk that opened it', async () => {
    const { app, calls, text } = await setup([...TWO, emptyDesk('d3', 'c')]);
    await app.handle('xy'); // a pasted "xy" on a terminal without bracketed paste
    expect(calls).toEqual([]);
    await app.handle('n');
    await app.handle('jjdy');
    expect(calls).toEqual([]);
    expect(await text()).toContain('워크트리를 지울까요? c');
    await app.handle('y');
    expect(calls).toEqual([['removeWorktree', 'd3']]);
    await app.handle('d');
    await app.handle('y');
    expect(calls).toEqual([['removeWorktree', 'd3'], ['removeWorktree', 'd3']]);
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
    expect(resizes.at(-1)).toEqual(['p1', 91, 27]);
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

/** An SGR mouse report at 0-based screen cell (x, y): `M` press/drag/wheel, `m` release. */
const mouse = (b: number, x: number, y: number, end: 'M' | 'm' = 'M') => `\x1b[<${b};${x + 1};${y + 1}${end}`;
const WIDE: [number, number] = [160, 30];
// 160x30, preset 2: list rows a/b at y 3/4; pane bodies at row 2, cols 29 and 95, each 65x27.
const P0 = 29;
const P1 = 95;
const lastSize = (resizes: [string, number, number][], pty: string) => resizes.filter(([p]) => p === pty).at(-1)?.slice(1);

async function twoPanes(agentText?: Record<string, string>) {
  const s = await setup(TWO, agentText, undefined, WIDE);
  await s.app.handle('2');
  await s.app.handle('\t');
  await s.app.handle('j');
  return s;
}

describe('App v3: presets, panes and mouse', () => {
  it('turns on mouse reporting at start', async () => {
    const { out } = await setup();
    expect(out.text).toContain('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  });

  it('shows two panes with 2, puts the second agent in pane 2 and sizes each to its pane', async () => {
    const { screen, resizes, app } = await twoPanes();
    const scr = await screen();
    expect(scr[1]).toContain('app/a · claude');
    expect(scr[1]).toContain('app/b · claude');
    expect(scr.join('\n')).toContain('agent one screen');
    expect(scr.join('\n')).toContain('agent two screen');
    expect(lastSize(resizes, 'p1')).toEqual([65, 27]);
    expect(lastSize(resizes, 'p2')).toEqual([65, 27]);
    await app.handle('1');
    expect(lastSize(resizes, 'p1')).toEqual([131, 27]);
  });

  it('swaps panes when the selected agent is shown in the other one, never showing it twice', async () => {
    const { app, screen, selectedLine, resizes } = await twoPanes();
    await app.handle('\t'); // back to pane 1: the list follows to its agent
    expect(await selectedLine()).toMatch(/▸ a\b/);
    await app.handle('j');
    const head = (await screen())[1];
    expect(head.indexOf('app/b · claude')).toBeLessThan(head.indexOf('app/a · claude'));
    expect(head.split('app/a · claude')).toHaveLength(2);
    expect(head.split('app/b · claude')).toHaveLength(2);
    expect(lastSize(resizes, 'p1')).toEqual([65, 27]);
    expect(lastSize(resizes, 'p2')).toEqual([65, 27]);
  });

  it('types only into the focused pane and redraws the other shown agent when it prints', async () => {
    const { app, writes, emit, text } = await twoPanes();
    await app.handle('\r');
    await app.handle('hi');
    expect(writes).toEqual([['p2', 'hi']]);
    await emit('p1', ' more');
    app.flush();
    expect(await text()).toContain('agent one screen more');
  });

  it('selects a row and focuses a pane by click, and never lets mouse bytes reach an agent', async () => {
    const { app, writes, selectedLine, text } = await setup(TWO, undefined, undefined, WIDE);
    await app.handle('2');
    await app.handle('\t');
    await app.handle(mouse(0, 3, 4));
    expect(await selectedLine()).toMatch(/▸ b\b/);
    await app.handle(mouse(0, 3, 4, 'm'));
    await app.handle('\t');
    expect(await selectedLine()).toMatch(/▸ a\b/);
    await app.handle(mouse(0, P1 + 2, 3) + 'x');
    expect(await text()).toContain('패널 입력 중');
    expect(await selectedLine()).toMatch(/▸ b\b/);
    expect(writes).toEqual([['p2', 'x']]);
    await app.handle('\x1b[<0;98;');
    await app.handle('4my');
    await app.handle('\x1b[<64;98;4');
    await app.handle('Mz');
    expect(writes.map(([p, d]) => [p, d])).toEqual([['p2', 'x'], ['p2', 'y'], ['p2', 'z']]);
    await app.handle('\x1d');
    await app.handle('\x1b[<0;4;');
    await app.handle('4M');
    expect(await selectedLine()).toMatch(/▸ a\b/);
    expect(writes.map(([, d]) => d).join('')).not.toContain('<');
  });

  it('drops the rest of a chunk when typing finds the agent gone, mouse reports included', async () => {
    const { app, deps, text, selectedLine } = await setup();
    await app.handle('\r');
    (deps.host as { has: (id: string) => boolean }).has = () => false;
    await app.handle('ab' + mouse(65, 3, 5) + '2');
    const t = await text();
    expect(t).toContain('에이전트가 종료됐어요');
    expect(t).not.toContain('창이 작아서');
    expect(await selectedLine()).toMatch(/▸ a\b/);
  });

  it('takes what follows a click on the list, in the same chunk, as list keys', async () => {
    const { app, writes, selectedLine, text } = await setup();
    await app.handle('\r');
    await app.handle('a' + mouse(0, 3, 3) + 'j');
    expect(writes).toEqual([['p1', 'a']]);
    expect(await selectedLine()).toMatch(/▸ b\b/);
    expect(await text()).toContain('q 나가기');
  });

  it('keeps a cut-off report that followed a click on the list for list input (no stray keys)', async () => {
    const { app, writes, text, selectedLine, resizes } = await setup(TWO, undefined, undefined, WIDE);
    await app.handle('\r');
    await app.handle(mouse(0, 3, 4) + '\x1b[<0;');
    await app.handle('3;14m'); // as list keys, '1' and '4' would switch presets
    expect(writes).toEqual([]);
    expect(await selectedLine()).toMatch(/▸ b\b/);
    expect(lastSize(resizes, 'p2')).toEqual([131, 27]);
    expect(resizes.some(([, c]) => c !== 131)).toBe(false);
    expect(await text()).toContain('q 나가기');
  });

  it('sends a paste flushed for lack of its end marker through the same mouse filter', async () => {
    const { app, writes } = await setup();
    await app.handle('\r');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await app.handle('\x1b[200~a\x1b[<0;5;5Mb');
      expect(writes).toEqual([]);
      vi.advanceTimersByTime(1000);
    } finally {
      vi.useRealTimers();
    }
    await wait(0);
    // Inside a paste the bytes stay as pasted (carry-in D); nothing else is sent.
    expect(writes).toEqual([['p1', 'a\x1b[<0;5;5Mb']]);
  });

  it('types an escape cut off after a click on another pane into that pane, whole', async () => {
    const { app, writes } = await twoPanes();
    await app.handle('\t');
    await app.handle('\r'); // typing into a (pane 1)
    await app.handle(mouse(0, P1 + 2, 3) + '\x1b[');
    await app.handle('A');
    expect(writes).toEqual([['p2', '\x1b[A']]);
  });

  it('refuses x, d and a on an empty focused pane instead of acting on another pane\'s agent', async () => {
    const { app, calls, text } = await setup(TWO, undefined, undefined, WIDE);
    await app.handle('2');
    await app.handle('\t');
    for (const k of ['x', 'd', 'a']) {
      await app.handle(k);
      const t = await text();
      expect(t).toContain('이 칸은 비어 있어요');
      expect(t).not.toContain('(y/N)');
      await app.handle('y');
    }
    expect(calls).toEqual([]);
    await app.handle('j');
    await app.handle('x');
    expect(await text()).toContain('에이전트를 종료할까요? app/b · claude (y/N)');
  });

  it('fits the list help in 100 columns, q first', async () => {
    const { screen } = await setup();
    const help = (await screen()).at(-1)!.trimEnd();
    expect(help.startsWith(' q 나가기')).toBe(true);
    expect(help.endsWith('d 삭제')).toBe(true);
  });

  it('drops a held partial mouse report in panel focus once the long wait runs out (never typed)', async () => {
    const { app, writes } = await setup(TWO, undefined, undefined, undefined, 5);
    await app.handle('\r');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await app.handle('\x1b[<0;5');
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
    await wait(0);
    expect(writes).toEqual([]);
  });

  it('waits long for the rest of a split mouse report in panel focus: the tail is never typed', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `say OK ${i}`).join('\r\n');
    const { app, writes, copies } = await setup(TWO, { p1: lines, p2: '' }, undefined, undefined, 50);
    await app.handle(mouse(0, P0 + 4, 2) + mouse(32, P0 + 5, 2)); // a drag: panel focus
    const spy = vi.spyOn(app as unknown as { mouse: (e: MouseEvent) => void }, 'mouse');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await app.handle('\x1b[<0;35');
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      await app.handle(';3m');
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
    await wait(0);
    expect(writes).toEqual([]);
    expect(spy.mock.calls.map(([e]) => e.kind)).toEqual(['release']);
    expect(copies).toEqual(['OK']);
  });

  it('waits long for the rest of a split mouse report in list focus: no stray list keys', async () => {
    const { app, writes, resizes } = await setup(TWO, undefined, undefined, undefined, 50);
    const spy = vi.spyOn(app as unknown as { mouse: (e: MouseEvent) => void }, 'mouse');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await app.handle('\x1b[<0;3');
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      await app.handle(';14m'); // as list keys, '1' and '4' would switch presets
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
    await wait(0);
    expect(writes).toEqual([]);
    expect(resizes.every(([, c, r]) => c === 71 && r === 21)).toBe(true);
    expect(spy.mock.calls.map(([e]) => e.kind)).toEqual(['release']);
  });

  it('drops a held partial mouse report in list focus once the long wait runs out', async () => {
    const { app, writes, resizes, selectedLine } = await setup(TWO, undefined, undefined, undefined, 50);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await app.handle('\x1b[<0;3');
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
    await wait(0);
    await app.handle('j');
    expect(writes).toEqual([]);
    expect(resizes.every(([, c, r]) => c === 71 && r === 21)).toBe(true);
    expect(await selectedLine()).toMatch(/▸ b\b/);
  });

  it('says the copy was handed to the terminal when only OSC 52 was possible', async () => {
    const { app, text } = await setup(TWO, { p1: 'say OK now', p2: '' }, undefined, undefined, undefined, { copyText: async () => 'osc52' });
    await app.handle(mouse(0, P0 + 4, 2) + mouse(32, P0 + 5, 2) + mouse(0, P0 + 5, 2, 'm'));
    await wait(0);
    const t = await text();
    expect(t).toContain('복사를 터미널에 맡겼어요 (터미널이 지원하면 복사돼요)');
    expect(t).not.toContain('복사했어요');
  });

  it('clears the selection on a terminal resize (xterm reflows), and a drag cut by a resize copies nothing', async () => {
    const { app, copies, inverseAt, resize } = await setup(TWO, { p1: 'say OK now', p2: '' });
    await app.handle(mouse(0, P0 + 4, 2) + mouse(32, P0 + 5, 2) + mouse(0, P0 + 5, 2, 'm'));
    await wait(0);
    expect(copies).toEqual(['OK']);
    expect(await inverseAt(P0 + 4, 2)).toBe(true);
    resize(100, 25);
    expect(await inverseAt(P0 + 4, 2)).toBe(false);
    await app.handle(mouse(0, P0 + 4, 2) + mouse(32, P0 + 5, 2));
    resize(100, 24);
    await app.handle(mouse(0, P0 + 5, 2, 'm'));
    await wait(0);
    expect(copies).toEqual(['OK']);
  });

  it('returns the focused pane to live output when text is sent to its agent', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `L${i}`).join('\r\n');
    const { app, writes, text } = await setup(TWO, { p1: lines, p2: '' });
    await app.handle('\r');
    await app.handle(mouse(64, P0 + 5, 10));
    expect(await text()).toContain('↑ 기록 보는 중');
    await app.handle('x');
    expect(writes).toEqual([['p1', 'x']]);
    const t = await text();
    expect(t).not.toContain('↑ 기록 보는 중');
    expect(t).toContain('L39');
  });

  it('keeps the scroll of the pane Tab leaves', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `L${i}`).join('\r\n');
    const { app, screen } = await twoPanes({ p1: '', p2: lines });
    await app.handle('\x1b[5~'); // pane 2 (agent b) scrolled back
    expect((await screen())[1]).toContain('↑ 기록 보는 중');
    await app.handle('\x1b[Z'); // Shift+Tab leaves pane 2
    expect((await screen())[1]).toContain('↑ 기록 보는 중');
    await app.handle('\t'); // back to pane 2
    await app.handle('\t'); // Tab leaves pane 2
    expect((await screen())[1]).toContain('↑ 기록 보는 중');
  });

  it('never forwards mouse reports that follow z in the same chunk to the zoomed agent', async () => {
    const { app, writes } = await setup();
    await app.handle('z' + mouse(0, 40, 5) + 'x' + mouse(0, 41, 5, 'm') + '\x1b[<0;4');
    expect(writes).toEqual([['p1', 'x']]);
  });

  it('leaves mouse reporting off when the mouse is disabled, at start and after zoom', async () => {
    const { app, out } = await setup(TWO, undefined, undefined, undefined, undefined, { mouse: false });
    await app.handle('z');
    await app.handle('\x1d');
    expect(out.text).not.toContain('\x1b[?1000h');
    expect(out.text).not.toContain('\x1b[?1006h');
    expect(out.text).toContain('\x1b[?2004h');
  });

  it('keeps mouse-looking bytes inside a bracketed paste as pasted text', async () => {
    const { app, writes, emit } = await setup();
    await emit('p1', '\x1b[?2004h');
    await app.handle('\r');
    await app.handle('\x1b[200~a\x1b[<0;5;5Mb\x1b[201~');
    expect(writes).toEqual([['p1', '\x1b[200~a\x1b[<0;5;5Mb\x1b[201~']]);
  });

  it('copies a drag selection on release, keeps the highlight until the next key, and copies nothing on a click', async () => {
    const { app, copies, text, inverseAt, writes } = await setup(TWO, { p1: 'say OK now', p2: '' });
    await app.handle(mouse(0, P0 + 4, 2));
    await app.handle(mouse(32, P0 + 5, 2));
    await app.handle(mouse(0, P0 + 5, 2, 'm'));
    await wait(0);
    expect(copies).toEqual(['OK']);
    expect(await text()).toContain('복사했어요 (2자)');
    expect([await inverseAt(P0 + 3, 2), await inverseAt(P0 + 4, 2), await inverseAt(P0 + 5, 2), await inverseAt(P0 + 6, 2)]).toEqual([false, true, true, false]);
    await app.handle('q'); // typed into the agent: clears the highlight
    expect(writes).toEqual([['p1', 'q']]);
    expect(await inverseAt(P0 + 4, 2)).toBe(false);
    await app.handle(mouse(0, P0 + 8, 2) + mouse(0, P0 + 8, 2, 'm'));
    await wait(0);
    expect(copies).toEqual(['OK']);
    expect(writes.map(([, d]) => d).join('')).not.toContain('<');
  });

  it('says so when the copy fails', async () => {
    const { app, deps, text } = await setup(TWO, { p1: 'say OK now', p2: '' });
    deps.copyText = async () => {
      throw new Error('no clipboard');
    };
    await app.handle(mouse(0, P0 + 4, 2) + mouse(32, P0 + 5, 2) + mouse(0, P0 + 5, 2, 'm'));
    await wait(0);
    expect(await text()).toContain('⚠ 복사하지 못했어요');
  });

  it('keeps a drag selection inside its pane and scrolls that pane past its edge', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `L${i}`).join('\r\n');
    const { app, copies, screen } = await twoPanes({ p1: lines, p2: 'other pane' });
    await app.handle('\t'); // pane 1 (agent a) focused
    await app.handle(mouse(0, P0, 4));
    await app.handle(mouse(32, P1 + 3, 0)); // into the other pane and above the top edge
    expect((await screen())[1]).toContain('↑ 기록 보는 중');
    await app.handle(mouse(0, P1 + 3, 0, 'm'));
    await wait(0);
    expect(copies).toHaveLength(1);
    expect(copies[0]).not.toContain('other');
    // 60 lines in 27 rows: L33 on top. Pressed on L35 col 0; the drag scrolled once and reached
    // the last column of L32 (blank), so the copy is that empty tail, L33, L34 and L35's first cell.
    expect(copies[0].split('\n')).toEqual(['', 'L33', 'L34', 'L']);
  });

  it('scrolls only the pane under the wheel, without taking typing focus', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `L${i}`).join('\r\n');
    const { app, screen, text } = await twoPanes({ p1: lines, p2: 'pane two' });
    expect(await text()).toContain('L39');
    await app.handle(mouse(64, P0 + 5, 10));
    const scr = await screen();
    expect(scr[1].split('↑ 기록 보는 중')).toHaveLength(2);
    expect(scr[1].indexOf('↑ 기록 보는 중')).toBeLessThan(scr[1].indexOf('app/b · claude'));
    expect(scr.join('\n')).not.toContain('L39');
    expect(scr.at(-1)).toContain('q 나가기');
    await app.handle(mouse(65, P0 + 5, 10));
    expect(await text()).toContain('L39');
    expect(await text()).not.toContain('↑ 기록 보는 중');
  });

  it('moves the list selection with the wheel over the list', async () => {
    const { app, selectedLine, text } = await setup();
    await app.handle(mouse(65, 3, 5));
    expect(await selectedLine()).toMatch(/▸ b\b/);
    expect(await text()).toContain('agent two screen');
    await app.handle(mouse(64, 3, 5));
    expect(await selectedLine()).toMatch(/▸ a\b/);
  });

  it('falls back to fewer panes on a small terminal and says so once', async () => {
    const { app, text, resize, resizes } = await setup(TWO, undefined, undefined, [100, 36]);
    await app.handle('4');
    const t = await text();
    expect(t.split('창이 작아서 2칸으로 보여요')).toHaveLength(2);
    expect(lastSize(resizes, 'p1')).toEqual([71, 15]);
    await app.handle('\x1b[B');
    expect(await text()).not.toContain('창이 작아서');
    resize(101, 36);
    expect(await text()).not.toContain('창이 작아서');
  });

  it('enters panel focus by clicking a pane only when it has a live agent', async () => {
    const { app, text } = await setup(TWO, undefined, undefined, WIDE);
    await app.handle('2');
    await app.handle(mouse(0, P1 + 2, 5));
    const t = await text();
    expect(t).toContain('q 나가기');
    expect(t).toContain('목록에서 고르면 여기 보여요');
  });
});
