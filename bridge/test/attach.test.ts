import { describe, expect, it } from 'vitest';
import serializeAddon from '@xterm/addon-serialize';
import xtermHeadless from '@xterm/headless';
import { AttachSession, dropsRegion, type AttachHost } from '../src/tui/attach.js';
import { POP_TITLE, PUSH_TITLE, RESET_MODES } from '../src/tui/screen.js';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializeAddon;

function fakeHost() {
  const data = new Set<(d: string) => void>();
  const exits = new Set<(id: string, code: number) => void>();
  const host = {
    alive: true,
    writes: [] as string[],
    sizes: [] as [number, number][],
    replies: [] as boolean[],
    has: () => host.alive,
    write: (_id: string, d: string) => void host.writes.push(d),
    onData: (_id: string, fn: (d: string) => void) => (data.add(fn), () => data.delete(fn)),
    onExit: (fn: (id: string, code: number) => void) => (exits.add(fn), () => exits.delete(fn)),
    resize: (_id: string, c: number, r: number) => void host.sizes.push([c, r]),
    serialize: () => 'SCREEN',
    setReplies: (_id: string, on: boolean) => void host.replies.push(on),
    emit: (d: string) => data.forEach((fn) => fn(d)),
    exit: () => {
      host.alive = false;
      exits.forEach((fn) => fn('p1', 0));
    },
    listeners: () => data.size,
  };
  return host;
}

function fakeOut(columns = 100, rows = 30) {
  const out = { columns, rows, text: '', write: (s: string) => ((out.text += s), true) };
  return out;
}

describe('AttachSession', () => {
  it('sizes the agent to the terminal minus the status row, repaints, streams and forwards keys', async () => {
    const host = fakeHost();
    const out = fakeOut();
    const left: string[] = [];
    const s = new AttachSession(host as unknown as AttachHost, 'p1', out, 'app/fix · claude', (r) => left.push(r));
    s.start();
    expect(host.sizes).toEqual([[100, 29]]);
    expect(host.replies).toEqual([false]);
    expect(out.text).toContain('SCREEN');
    host.emit('hello');
    expect(out.text).toContain('hello');
    await new Promise((r) => setTimeout(r, 150));
    expect(out.text).toContain('Ctrl+] 로비');
    s.input('ls\r');
    expect(host.writes).toEqual(['ls\r']);
    out.columns = 80;
    out.rows = 20;
    s.resized();
    expect(host.sizes.at(-1)).toEqual([80, 19]);
  });

  it('leaves on Ctrl+] in any encoding, sending nothing after the escape to the agent', () => {
    for (const esc of ['\x1d', '\x1b[93;5u', '\x1b[27;5;93~']) {
      const host = fakeHost();
      const out = fakeOut();
      const left: string[] = [];
      const s = new AttachSession(host as unknown as AttachHost, 'p1', out, 's', (r) => left.push(r));
      s.start();
      s.input(`ab${esc}cd`);
      expect(host.writes).toEqual(['ab']);
      expect(left).toEqual(['escape']);
      expect(host.listeners()).toBe(0);
      expect(host.replies).toEqual([false, true]);
      expect(out.text).toContain(RESET_MODES);
    }
  });

  it('returns to the lobby when the agent exits, once', () => {
    const host = fakeHost();
    const left: string[] = [];
    const s = new AttachSession(host as unknown as AttachHost, 'p1', fakeOut(), 's', (r) => left.push(r));
    s.start();
    host.exit();
    s.stop();
    expect(left).toEqual(['exited']);
    expect(() => s.input('x')).not.toThrow();
    expect(host.writes).toEqual([]);
  });

  it('survives a PTY that dies mid-write and still leaves on escape', () => {
    const host = fakeHost();
    host.write = () => {
      throw new Error('dead');
    };
    const left: string[] = [];
    const s = new AttachSession(host as unknown as AttachHost, 'p1', fakeOut(), 's', (r) => left.push(r));
    s.start();
    expect(() => s.input('x')).not.toThrow();
    expect(() => s.input('ab\x1d')).not.toThrow();
    expect(left).toEqual(['escape']);
    expect(host.replies).toEqual([false, true]);
  });

  it('turns origin mode off before moving to the status row', () => {
    const host = fakeHost();
    const out = fakeOut();
    new AttachSession(host as unknown as AttachHost, 'p1', out, 's', () => {}).start();
    const i = out.text.indexOf('\x1b[?6l');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(out.text.indexOf('\x1b[30;1H')).toBeGreaterThan(i);
  });

  it('leaves immediately when the PTY already exited before start', () => {
    const host = fakeHost();
    host.alive = false;
    const left: string[] = [];
    new AttachSession(host as unknown as AttachHost, 'p1', fakeOut(), 's', (r) => left.push(r)).start();
    expect(left).toEqual(['exited']);
    expect(host.replies).toEqual([false, true]);
  });
});

describe('AttachSession on a real terminal', () => {
  // The user's terminal and the agent's screen are both headless xterms; the attach view must
  // show the agent's rows 1..rows-1 exactly, with our status line alone on the last row.
  function rig(cols: number, rows: number) {
    const agent = new Terminal({ cols, rows: rows - 1, allowProposedApi: true, scrollback: 1000 });
    const serializer = new SerializeAddon();
    agent.loadAddon(serializer);
    const real = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
    const listeners = new Set<(d: string) => void>();
    const host = {
      has: () => true,
      write: () => {},
      onData: (_id: string, fn: (d: string) => void) => (listeners.add(fn), () => listeners.delete(fn)),
      onExit: () => () => {},
      resize: (_id: string, c: number, r: number) => agent.resize(c, r),
      serialize: () => serializer.serialize(),
      setReplies: () => {},
    };
    const out = { columns: cols, rows, write: (s: string) => (real.write(s), true) };
    const flush = (t: InstanceType<typeof Terminal>) => new Promise<void>((r) => t.write('', r));
    const feedAgent = async (d: string) => {
      await new Promise<void>((r) => agent.write(d, r));
      listeners.forEach((fn) => fn(d));
      await flush(real);
    };
    const line = (t: InstanceType<typeof Terminal>, y: number) => t.buffer.active.getLine(t.buffer.active.baseY + y)?.translateToString(true) ?? '';
    const check = async () => {
      await flush(agent);
      await flush(real);
      const r = out.rows;
      for (let y = 0; y < r - 1; y++) expect(line(real, y), `row ${y + 1}`).toBe(line(agent, y));
      expect(line(real, r - 1)).toContain('Ctrl+] 로비');
      expect([real.buffer.active.cursorX, real.buffer.active.cursorY]).toEqual([agent.buffer.active.cursorX, agent.buffer.active.cursorY]);
    };
    return { agent, real, host, out, feedAgent, check, flush };
  }

  it('repaints scrollback without shifting the agent under the status row', async () => {
    const { agent, host, out, check, flush } = rig(40, 10);
    agent.write(Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\r\n'));
    await flush(agent);
    new AttachSession(host as unknown as AttachHost, 'p1', out, 'app/x · claude', () => {}).start();
    await check();
  });

  it('keeps aligned while output grows past the agent last row', async () => {
    const { agent, host, out, feedAgent, check, flush } = rig(40, 10);
    agent.write('hello');
    await flush(agent);
    new AttachSession(host as unknown as AttachHost, 'p1', out, 's', () => {}).start();
    for (let i = 0; i < 25; i++) await feedAgent(`\r\nout ${i}`);
    await check();
    // An agent that resets its scroll region, or leaves the alternate screen, must not undo ours.
    await feedAgent('\x1b[r\x1b[?1049h\x1b[?1049l');
    for (let i = 0; i < 15; i++) await feedAgent(`\r\nmore ${i}`);
    await check();
  });

  it('re-sets the region and repaints on resize', async () => {
    const { agent, real, host, out, feedAgent, check, flush } = rig(40, 10);
    agent.write(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n'));
    await flush(agent);
    const s = new AttachSession(host as unknown as AttachHost, 'p1', out, 's', () => {});
    s.start();
    await flush(real);
    real.resize(40, 14);
    out.rows = 14;
    s.resized();
    await check();
    for (let i = 0; i < 20; i++) await feedAgent(`\r\nafter ${i}`);
    await check();
    real.resize(40, 8);
    out.rows = 8;
    s.resized();
    for (let i = 0; i < 5; i++) await feedAgent(`\r\nsmall ${i}`);
    await check();
  });
});

describe('dropsRegion', () => {
  it('spots output that leaves the terminal without our region, and respects narrower ones', () => {
    expect(dropsRegion('plain text', 9)).toBe(false);
    expect(dropsRegion('\x1b[r', 9)).toBe(true);
    expect(dropsRegion('\x1b[1;0r', 9)).toBe(true);
    expect(dropsRegion('\x1b[1;10r', 9)).toBe(true);
    expect(dropsRegion('\x1b[1;9r', 9)).toBe(false);
    expect(dropsRegion('\x1b[r\x1b[3;5r', 9)).toBe(false);
    expect(dropsRegion('\x1b[?1049h', 9)).toBe(true);
    expect(dropsRegion('\x1bc', 9)).toBe(true);
    expect(dropsRegion('\x1b[!p', 9)).toBe(true);
    expect(dropsRegion('\x1b[?6r', 9)).toBe(false); // XTRESTORE, not margins
  });

  it('re-sets the region when the reset is split across chunks', () => {
    const host = fakeHost();
    const out = fakeOut(100, 30);
    new AttachSession(host as unknown as AttachHost, 'p1', out, 's', () => {}).start();
    out.text = '';
    host.emit('abc\x1b[');
    expect(out.text).not.toContain('\x1b[1;29r');
    host.emit('r');
    expect(out.text).toContain('\x1b7\x1b[1;29r\x1b8');
  });

  it('re-sets the region once per reset, not again for the chunks that follow', () => {
    const host = fakeHost();
    const out = fakeOut(100, 30);
    new AttachSession(host as unknown as AttachHost, 'p1', out, 's', () => {}).start();
    out.text = '';
    host.emit('\x1b[r');
    host.emit('x');
    host.emit('y');
    expect(out.text.split('\x1b[1;29r')).toHaveLength(2);
  });

  it('pushes the window title on attach and pops it on leave', () => {
    const host = fakeHost();
    const out = fakeOut();
    const s = new AttachSession(host as unknown as AttachHost, 'p1', out, 's', () => {});
    s.start();
    expect(out.text.startsWith(PUSH_TITLE)).toBe(true);
    s.input('\x1d');
    expect(out.text.endsWith(POP_TITLE)).toBe(true);
    expect(RESET_MODES).toContain('\x1b[>4m');
    expect(RESET_MODES).toContain('\x1b[4l');
  });
});
