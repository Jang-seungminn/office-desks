import type { PtyLike } from '../backend/native.js';
import { isAttachEscape } from './keys.js';
import { CLEAR, HOME, moveTo, RESET_MODES, SHOW_CURSOR } from './screen.js';
import { fit } from './text.js';

// One agent's real terminal on the whole screen (like `tmux attach`). The last row is ours:
// a status line with the way back. Output is passed through byte for byte.

export interface TermOut {
  write(s: string): unknown;
  columns: number;
  rows: number;
}

export type AttachHost = Pick<PtyLike, 'has' | 'write' | 'onData' | 'onExit' | 'resize' | 'serialize' | 'setReplies'>;

const STATUS_THROTTLE_MS = 100;

export class AttachSession {
  private offData: (() => void) | null = null;
  private offExit: (() => void) | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private active = false;

  constructor(
    private readonly host: AttachHost,
    private readonly ptyId: string,
    private readonly out: TermOut,
    private readonly status: string,
    private readonly onLeave: (reason: 'escape' | 'exited') => void,
  ) {}

  start(): void {
    this.active = true;
    this.resizeAgent();
    this.host.setReplies(this.ptyId, false);
    this.out.write(RESET_MODES + CLEAR + HOME + this.host.serialize(this.ptyId) + SHOW_CURSOR);
    this.drawStatus();
    this.offData = this.host.onData(this.ptyId, (d) => {
      this.out.write(d);
      this.scheduleStatus();
    });
    this.offExit = this.host.onExit((id) => {
      if (id === this.ptyId) this.leave('exited');
    });
  }

  input(chunk: string): void {
    if (!this.active) return;
    if (isAttachEscape(chunk)) {
      const cut = Math.min(...['\x1d', '\x1b[93;5u', '\x1b[27;5;93~'].map((f) => chunk.indexOf(f)).filter((i) => i >= 0));
      if (cut > 0 && this.host.has(this.ptyId)) this.host.write(this.ptyId, chunk.slice(0, cut));
      this.leave('escape');
      return;
    }
    if (this.host.has(this.ptyId)) this.host.write(this.ptyId, chunk);
  }

  resized(): void {
    if (!this.active) return;
    this.resizeAgent();
    this.drawStatus();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.offData?.();
    this.offExit?.();
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.host.setReplies(this.ptyId, true);
    this.out.write(RESET_MODES);
  }

  private leave(reason: 'escape' | 'exited'): void {
    if (!this.active) return;
    this.stop();
    this.onLeave(reason);
  }

  /** The process may have exited a moment ago with its exit event still in flight. */
  private resizeAgent(): void {
    try {
      this.host.resize(this.ptyId, this.out.columns, Math.max(2, this.out.rows - 1));
    } catch {
      // exit event will follow and return us to the lobby
    }
  }

  private scheduleStatus(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      if (this.active) this.drawStatus();
    }, STATUS_THROTTLE_MS);
  }

  /** Save cursor, paint the last row in reverse video, restore cursor. */
  private drawStatus(): void {
    const text = fit(` ${this.status} · Ctrl+] 로비`, this.out.columns);
    this.out.write(`\x1b7${moveTo(this.out.rows, 1)}\x1b[0;7m${text}\x1b[0m\x1b8`);
  }
}
