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
  private statusListeners = new Set<(connected: boolean) => void>();

  constructor(
    private url: string = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    private make: (u: string) => WebSocket = (u) => new WebSocket(u),
  ) {}

  onSnapshot(fn: (s: OfficeSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called with true on open and false on close or stop. */
  onStatus(fn: (connected: boolean) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setConnected(c: boolean): void {
    if (this.connected === c) return;
    this.connected = c;
    for (const fn of this.statusListeners) fn(c);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.delay = MIN_DELAY;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.close();
    }
    this.setConnected(false);
  }

  private open(): void {
    let ws: WebSocket;
    try {
      ws = this.make(this.url);
    } catch {
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.delay = MIN_DELAY;
      this.setConnected(true);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      if (typeof ev.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg?.type === 'snapshot' && msg.snapshot && typeof msg.snapshot === 'object') {
        this.snapshot = msg.snapshot;
        for (const fn of this.listeners) fn(msg.snapshot);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setConnected(false);
      this.schedule();
    };
  }

  private schedule(): void {
    if (this.stopped) return;
    const d = this.delay;
    this.delay = Math.min(this.delay * 2, MAX_DELAY);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this.open();
    }, d);
  }
}
