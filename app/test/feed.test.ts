import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfficeFeed } from '../src/feed';

class FakeWs {
  static all: FakeWs[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  drop() {
    this.onclose?.();
  }
  send(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}

const make = (u: string) => new FakeWs(u) as unknown as WebSocket;
const snap = { desks: [] } as any;

beforeEach(() => {
  FakeWs.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('OfficeFeed', () => {
  it('emits only snapshot frames', () => {
    const feed = new OfficeFeed('ws://x/ws', make);
    const got: unknown[] = [];
    feed.onSnapshot((s) => got.push(s));
    feed.start();
    const ws = FakeWs.all[0];
    ws.open();
    expect(feed.connected).toBe(true);
    ws.send({ type: 'backend', backend: {} });
    ws.send({ type: 'snapshot', snapshot: snap });
    ws.send({ type: 'org', org: {} });
    expect(got).toEqual([snap]);
    expect(feed.snapshot).toEqual(snap);
  });

  it('reconnects with 1s, 2s, 4s, 5s, 5s and resets after an open', () => {
    const feed = new OfficeFeed('ws://x/ws', make);
    feed.start();
    for (const d of [1000, 2000, 4000, 5000, 5000]) {
      const n = FakeWs.all.length;
      FakeWs.all[n - 1].drop();
      expect(feed.connected).toBe(false);
      vi.advanceTimersByTime(d - 1);
      expect(FakeWs.all.length).toBe(n);
      vi.advanceTimersByTime(1);
      expect(FakeWs.all.length).toBe(n + 1);
    }
    FakeWs.all[FakeWs.all.length - 1].open();
    const n = FakeWs.all.length;
    FakeWs.all[n - 1].drop();
    vi.advanceTimersByTime(999);
    expect(FakeWs.all.length).toBe(n);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all.length).toBe(n + 1);
  });

  it('stop() closes and never reconnects', () => {
    const feed = new OfficeFeed('ws://x/ws', make);
    feed.start();
    const ws = FakeWs.all[0];
    ws.open();
    feed.stop();
    expect(ws.closed).toBe(true);
    ws.drop();
    vi.advanceTimersByTime(60000);
    expect(FakeWs.all.length).toBe(1);
    expect(feed.connected).toBe(false);
  });

  it('ignores malformed, binary and non-object snapshot frames', () => {
    const feed = new OfficeFeed('ws://x/ws', make);
    const got: unknown[] = [];
    feed.onSnapshot((s) => got.push(s));
    feed.start();
    const ws = FakeWs.all[0];
    ws.open();
    ws.onmessage!({ data: 'not json' });
    ws.onmessage!({ data: new ArrayBuffer(4) });
    ws.send({ type: 'snapshot', snapshot: null });
    ws.send({ type: 'snapshot', snapshot: 'x' });
    expect(got).toEqual([]);
  });

  it('a stale socket cannot affect the feed', () => {
    const feed = new OfficeFeed('ws://x/ws', make);
    const got: unknown[] = [];
    feed.onSnapshot((s) => got.push(s));
    feed.start();
    const old = FakeWs.all[0];
    old.drop();
    vi.advanceTimersByTime(1000);
    const cur = FakeWs.all[1];
    old.open();
    expect(feed.connected).toBe(false);
    old.send({ type: 'snapshot', snapshot: snap });
    expect(got).toEqual([]);
    cur.open();
    expect(feed.connected).toBe(true);
  });

  it('stop() detaches handlers; start twice opens one socket', () => {
    const feed = new OfficeFeed('ws://x/ws', make);
    feed.start();
    feed.start();
    expect(FakeWs.all.length).toBe(1);
    const ws = FakeWs.all[0];
    feed.stop();
    expect([ws.onopen, ws.onmessage, ws.onclose]).toEqual([null, null, null]);
  });

  it('onStatus reports open and close; a throwing make() reschedules', () => {
    let fail = true;
    const feed = new OfficeFeed('ws://x/ws', (u) => {
      if (fail) throw new Error('boom');
      return make(u);
    });
    const st: boolean[] = [];
    feed.onStatus((c) => st.push(c));
    feed.start();
    expect(FakeWs.all.length).toBe(0);
    fail = false;
    vi.advanceTimersByTime(1000);
    expect(FakeWs.all.length).toBe(1);
    FakeWs.all[0].open();
    FakeWs.all[0].drop();
    expect(st).toEqual([true, false]);
  });
});
