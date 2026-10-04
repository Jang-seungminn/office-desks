import { describe, expect, it } from 'vitest';
import { AttachSession, type AttachHost } from '../src/tui/attach.js';
import { RESET_MODES } from '../src/tui/screen.js';

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
});
