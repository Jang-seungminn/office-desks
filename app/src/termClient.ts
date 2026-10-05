// The client side of od-server's `/term/<agent id>` WebSocket (protocol: crates/od-server/src/term.rs).
//
// The URL carries the term token in its query. The token comes from `host.termConfig()` and stays
// in memory: never log the URL, the socket or its events, and never put either in the DOM.
import type { TermConfig } from './host';

/** The largest input frame sent; the server caps a client message at 1 MiB. */
export const INPUT_CHUNK = 65536;
export type TermStatus = 'connecting' | 'open' | 'reconnecting' | 'exited' | 'closed' | 'failed';
export interface TermHandlers {
  output(bytes: Uint8Array): void;
  reset(): void; // before a reattach: the next frame is a fresh snapshot
  status(s: TermStatus, code?: number | null): void;
}

/** The server's resize clamp (`MAX_COLS`, `MAX_ROWS`). */
export const MAX_COLS = 1000;
export const MAX_ROWS = 500;
const SLOW_CONSUMER = 1013;
const GOING_AWAY = 1001;
const NORMAL = 1000;
const CONNECTING = 0; // WebSocket.CONNECTING (not read from the global, which tests replace)
/** Retriable closes in a row (no open in between); the last one gives up. */
const MAX_TRIES = 3;
const RETRY_DELAY = 500;

export function termUrl(cfg: TermConfig, agentId: string): string {
  return `ws://127.0.0.1:${cfg.port}/term/${encodeURIComponent(agentId)}?token=${encodeURIComponent(cfg.token)}`;
}

export function validSize(cols: number, rows: number): boolean {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && cols <= MAX_COLS && rows >= 1 && rows <= MAX_ROWS;
}

export class TermSocket {
  private ws: WebSocket | null = null;
  private isOpen = false;
  private everOpened = false;
  private tries = 0;
  private done = false; // close() was called, the agent exited, or we gave up
  private timer: ReturnType<typeof setTimeout> | null = null;
  private want: [number, number] | null = null; // the last valid size asked for
  private sent: string | null = null; // the last resize frame sent on this socket

  constructor(
    private readonly cfg: TermConfig,
    private readonly agentId: string,
    private readonly h: TermHandlers,
    private readonly make: (u: string) => WebSocket = (u) => new WebSocket(u),
  ) {
    this.h.status('connecting');
    this.connect();
  }

  private connect(): void {
    this.timer = null;
    this.isOpen = false;
    this.sent = null;
    const ws = this.make(termUrl(this.cfg, this.agentId));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws || this.done) return;
      this.isOpen = true;
      this.everOpened = true;
      this.tries = 0;
      this.h.status('open');
      if (this.want) this.sendResize(...this.want);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws || this.done) return;
      const data: unknown = e.data;
      if (typeof data === 'string') {
        this.text(data);
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        this.h.output(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
    };
    // The close event follows; nothing here (an error event can't say anything the close won't).
    ws.onerror = () => {};
    ws.onclose = (e: CloseEvent) => {
      if (this.ws !== ws) return;
      this.isOpen = false;
      this.ws = null;
      this.closed(e.code);
    };
  }

  private text(data: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'exit') {
      const code = (msg as { code?: unknown }).code;
      this.done = true;
      this.h.status('exited', typeof code === 'number' ? code : null);
    }
  }

  private closed(code: number): void {
    if (this.done) return; // our own close, or the 1000 after an exit
    if (code === GOING_AWAY) {
      this.done = true;
      this.h.status('closed');
      return;
    }
    if (code !== SLOW_CONSUMER && !this.everOpened) {
      this.done = true;
      this.h.status('failed');
      return;
    }
    this.tries += 1;
    if (this.tries >= MAX_TRIES) {
      this.done = true;
      this.h.status('failed');
      return;
    }
    this.h.reset();
    this.h.status('reconnecting');
    if (code === SLOW_CONSUMER) this.connect();
    else this.timer = setTimeout(() => this.connect(), RETRY_DELAY);
  }

  /** Keyboard and paste input: UTF-8 in binary frames of at most INPUT_CHUNK bytes, in order. */
  input(data: string): void {
    this.sendBytes(new TextEncoder().encode(data));
  }

  /** xterm's onBinary: one byte per char (mouse reports in some modes). */
  inputBinary(data: string): void {
    this.sendBytes(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff));
  }

  private sendBytes(bytes: Uint8Array): void {
    const ws = this.ws;
    if (!ws || !this.isOpen) return; // dropped, not queued
    for (let i = 0; i < bytes.length; i += INPUT_CHUNK) ws.send(bytes.subarray(i, i + INPUT_CHUNK));
  }

  resize(cols: number, rows: number): void {
    if (!validSize(cols, rows)) return;
    this.want = [cols, rows];
    if (this.isOpen) this.sendResize(cols, rows);
  }

  private sendResize(cols: number, rows: number): void {
    const frame = JSON.stringify({ type: 'resize', cols, rows });
    if (frame === this.sent || !this.ws) return;
    this.sent = frame;
    this.ws.send(frame);
  }

  /** Detach (1000). The agent keeps running. */
  close(): void {
    this.done = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    this.isOpen = false;
    if (!ws) return;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    const shut = () => {
      try {
        ws.close(NORMAL);
      } catch {
        // already closing
      }
    };
    // Closing a socket still connecting makes Chromium log "closed before the connection is
    // established" with the full URL, token included: let it open first, then close it.
    if (ws.readyState === CONNECTING) {
      ws.onopen = shut;
    } else {
      ws.onopen = null;
      shut();
    }
  }
}
