import type { OfficeSnapshot, ServerMessage } from '../../bridge/src/model';

const MIN_DELAY = 1000;
const MAX_DELAY = 5000;

/** Snapshot feed over /ws. Other message types are ignored. */
export class OfficeFeed {
  snapshot: OfficeSnapshot | null = null;
  connected = false;
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delay = MIN_DELAY;
  private stopped = true;
  private listeners = new Set<(s: OfficeSnapshot) => void>();

  constructor(
    private url: string = `ws://${location.host}/ws`,
    private make: (u: string) => WebSocket = (u) => new WebSocket(u),
  ) {}

  onSnapshot(fn: (s: OfficeSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private open(): void {
    const ws = this.make(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.delay = MIN_DELAY;
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg?.type === 'snapshot') {
        this.snapshot = msg.snapshot;
        for (const fn of this.listeners) fn(msg.snapshot);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      if (this.stopped) return;
      const d = this.delay;
      this.delay = Math.min(this.delay * 2, MAX_DELAY);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.stopped) this.open();
      }, d);
    };
  }
}
