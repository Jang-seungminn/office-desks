// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { INPUT_CHUNK, TermSocket, termUrl, type TermHandlers } from '../src/termClient';

class FakeWs {
  static all: FakeWs[] = [];
  binaryType = 'blob';
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  send(d: string | Uint8Array) {
    if (this.readyState !== 1) throw new Error('send while not open');
    this.sent.push(typeof d === 'string' ? d : new Uint8Array(d)); // a copy, like the wire
  }
  close(code?: number) {
    this.closedWith = code ?? 1005;
    this.readyState = 2;
  }
  // server side
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  binary(bytes: number[]) {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }
  text(s: string) {
    this.onmessage?.({ data: s });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  get frames() {
    return this.sent.filter((x): x is Uint8Array => typeof x !== 'string');
  }
  get texts() {
    return this.sent.filter((x): x is string => typeof x === 'string');
  }
}

const cfg = { port: 51234, token: 'ab' };
let h: { output: Mock<TermHandlers['output']>; reset: Mock<TermHandlers['reset']>; status: Mock<TermHandlers['status']> };
const make = (u: string) => new FakeWs(u) as unknown as WebSocket;
const last = () => FakeWs.all[FakeWs.all.length - 1];
const statuses = () => h.status.mock.calls.map((c) => c[0]);

beforeEach(() => {
  FakeWs.all = [];
  h = { output: vi.fn<TermHandlers['output']>(), reset: vi.fn<TermHandlers['reset']>(), status: vi.fn<TermHandlers['status']>() };
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('termUrl', () => {
  it('encodes the agent id and the token', () => {
    expect(termUrl({ port: 51234, token: 'ab' }, 'wt:1/2')).toBe('ws://127.0.0.1:51234/term/wt%3A1%2F2?token=ab');
    expect(termUrl({ port: 1, token: 'a&b=c' }, 'x')).toBe('ws://127.0.0.1:1/term/x?token=a%26b%3Dc');
  });
});

describe('TermSocket', () => {
  it('connects with arraybuffer frames and reports connecting, then open', () => {
    new TermSocket(cfg, 'wt:1/2', h, make);
    expect(FakeWs.all).toHaveLength(1);
    expect(last().binaryType).toBe('arraybuffer');
    expect(statuses()).toEqual(['connecting']);
    last().open();
    expect(statuses()).toEqual(['connecting', 'open']);
  });

  it('sends a 3 MiB paste as 48 binary frames of at most 64 KiB, in order', () => {
    const t = new TermSocket(cfg, 'a', h, make);
    last().open();
    const text = '가'.repeat(1_048_576);
    t.input(text);
    const frames = last().frames;
    expect(frames).toHaveLength(48);
    expect(INPUT_CHUNK).toBe(65536);
    for (const f of frames) expect(f.byteLength).toBeLessThanOrEqual(65536);
    const want = new TextEncoder().encode(text);
    expect(want.byteLength).toBe(3_145_728);
    const got = new Uint8Array(frames.reduce((n, f) => n + f.byteLength, 0));
    let at = 0;
    for (const f of frames) {
      got.set(f, at);
      at += f.byteLength;
    }
    expect(got.byteLength).toBe(want.byteLength);
    let diff = -1;
    for (let i = 0; i < want.length && diff < 0; i++) if (got[i] !== want[i]) diff = i;
    expect(diff).toBe(-1);
    expect(last().texts).toHaveLength(0);
  });

  it('sends onBinary input one byte per char', () => {
    const t = new TermSocket(cfg, 'a', h, make);
    last().open();
    t.inputBinary('\x1b[M\xff\x80');
    expect(Array.from(last().frames[0])).toEqual([0x1b, 0x5b, 0x4d, 0xff, 0x80]);
  });

  it('drops input before open', () => {
    const t = new TermSocket(cfg, 'a', h, make);
    t.input('hello');
    t.inputBinary('x');
    last().open();
    expect(last().sent).toHaveLength(0);
  });

  it('sends a resize once, and only inside the server clamp', () => {
    const t = new TermSocket(cfg, 'a', h, make);
    last().open();
    t.resize(80, 24);
    t.resize(80, 24);
    t.resize(0, 24);
    t.resize(1001, 24);
    t.resize(80, 0);
    t.resize(80, 501);
    t.resize(80.5, 24);
    t.resize(NaN, 24);
    expect(last().texts).toEqual(['{"type":"resize","cols":80,"rows":24}']);
    t.resize(1000, 500);
    expect(last().texts[1]).toBe('{"type":"resize","cols":1000,"rows":500}');
  });

  it('sends the size asked for before open once it opens', () => {
    const t = new TermSocket(cfg, 'a', h, make);
    t.resize(100, 30);
    expect(last().sent).toHaveLength(0);
    last().open();
    expect(last().texts).toEqual(['{"type":"resize","cols":100,"rows":30}']);
  });

  it('passes binary frames to output unchanged', () => {
    new TermSocket(cfg, 'a', h, make);
    last().open();
    last().binary([1, 2, 255, 0]);
    expect(h.output).toHaveBeenCalledTimes(1);
    expect(Array.from(h.output.mock.calls[0][0] as Uint8Array)).toEqual([1, 2, 255, 0]);
  });

  it('reports the exit code, and the 1000 after it does not reconnect', () => {
    new TermSocket(cfg, 'a', h, make);
    last().open();
    last().text('{"type":"exit","code":3}');
    expect(h.status).toHaveBeenLastCalledWith('exited', 3);
    last().drop(1000);
    vi.advanceTimersByTime(5000);
    expect(FakeWs.all).toHaveLength(1);
    expect(statuses()).toEqual(['connecting', 'open', 'exited']);
  });

  it('reports an exit with a null code', () => {
    new TermSocket(cfg, 'a', h, make);
    last().open();
    last().text('{"type":"exit","code":null}');
    expect(h.status).toHaveBeenLastCalledWith('exited', null);
  });

  it('ignores unknown or broken text frames', () => {
    new TermSocket(cfg, 'a', h, make);
    last().open();
    last().text('not json');
    last().text('{"type":"other"}');
    expect(statuses()).toEqual(['connecting', 'open']);
    expect(h.output).not.toHaveBeenCalled();
  });

  it('on 1013 resets, reports reconnecting, reconnects at once and re-sends the last size', () => {
    const t = new TermSocket(cfg, 'a', h, make);
    last().open();
    t.resize(80, 24);
    const first = last();
    first.drop(1013);
    expect(h.reset).toHaveBeenCalledTimes(1);
    expect(h.status).toHaveBeenLastCalledWith('reconnecting');
    expect(h.reset.mock.invocationCallOrder[0]).toBeLessThan(h.status.mock.invocationCallOrder.at(-1)!);
    expect(FakeWs.all).toHaveLength(2);
    expect(last().url).toBe(first.url);
    last().open();
    expect(h.status).toHaveBeenLastCalledWith('open');
    expect(last().texts).toEqual(['{"type":"resize","cols":80,"rows":24}']);
  });

  it('fails on the third 1013 in a row without an open in between', () => {
    new TermSocket(cfg, 'a', h, make);
    last().open();
    last().drop(1013);
    last().drop(1013);
    expect(FakeWs.all).toHaveLength(3);
    last().drop(1013);
    expect(h.status).toHaveBeenLastCalledWith('failed');
    expect(FakeWs.all).toHaveLength(3);
    vi.advanceTimersByTime(5000);
    expect(FakeWs.all).toHaveLength(3);
  });

  it('an open resets the 1013 count', () => {
    new TermSocket(cfg, 'a', h, make);
    for (let i = 0; i < 5; i++) {
      last().open();
      last().drop(1013);
    }
    expect(FakeWs.all).toHaveLength(6);
    expect(statuses()).not.toContain('failed');
  });

  it('on 1001 reports closed and does not reconnect', () => {
    new TermSocket(cfg, 'a', h, make);
    last().open();
    last().drop(1001);
    vi.advanceTimersByTime(5000);
    expect(h.status).toHaveBeenLastCalledWith('closed');
    expect(FakeWs.all).toHaveLength(1);
    expect(h.reset).not.toHaveBeenCalled();
  });

  it('fails on an error and 1006 before the first open', () => {
    new TermSocket(cfg, 'a', h, make);
    last().onerror?.();
    last().drop(1006);
    vi.advanceTimersByTime(5000);
    expect(h.status).toHaveBeenLastCalledWith('failed');
    expect(FakeWs.all).toHaveLength(1);
  });

  it('after an open, a network loss reconnects after 500 ms', () => {
    new TermSocket(cfg, 'a', h, make);
    last().open();
    last().drop(1006);
    expect(h.status).toHaveBeenLastCalledWith('reconnecting');
    expect(h.reset).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(499);
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(2);
    last().drop(1006); // the server is gone: one more try, then give up
    vi.advanceTimersByTime(500);
    last().drop(1006);
    expect(h.status).toHaveBeenLastCalledWith('failed');
    vi.advanceTimersByTime(5000);
    expect(FakeWs.all).toHaveLength(3);
  });

  it('close() closes with 1000 and never reconnects', () => {
    const t = new TermSocket(cfg, 'a', h, make);
    last().open();
    t.close();
    expect(last().closedWith).toBe(1000);
    last().drop(1000);
    vi.advanceTimersByTime(5000);
    expect(FakeWs.all).toHaveLength(1);
    expect(statuses()).toEqual(['connecting', 'open']);
    t.input('x');
    expect(last().sent).toHaveLength(0);
  });

  it('close() while connecting closes with 1000 once open (no URL in the console)', () => {
    const t = new TermSocket(cfg, 'a', h, make);
    t.close();
    expect(last().closedWith).toBeNull();
    last().open();
    expect(last().closedWith).toBe(1000);
    expect(last().sent).toHaveLength(0);
    expect(statuses()).toEqual(['connecting']);
  });

  it('close() during a reconnect delay cancels it', () => {
    const t = new TermSocket(cfg, 'a', h, make);
    last().open();
    last().drop(1006);
    t.close();
    vi.advanceTimersByTime(5000);
    expect(FakeWs.all).toHaveLength(1);
  });
});
