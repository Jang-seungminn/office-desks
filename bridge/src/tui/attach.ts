import type { PtyLike } from '../backend/native.js';
import { isAttachEscape } from './keys.js';
import { CLEAR, HOME, moveTo, POP_TITLE, PUSH_TITLE, RESET_MODES, SHOW_CURSOR } from './screen.js';
import { fit } from './text.js';

// One agent's real terminal on the whole screen (like `tmux attach`). The last row is ours:
// a status line with the way back. Output is passed through byte for byte.
//
// The agent's PTY is one row shorter than the real terminal, so the real terminal gets a scroll
// region over those rows: scrolling (a repaint with scrollback, output past the last row) then
// stays above the status line instead of shifting the whole screen. Agent output that drops the
// region (a reset, a full-height region, a screen switch, a terminal reset) gets it re-set.

export interface TermOut {
  write(s: string): unknown;
  columns: number;
  rows: number;
}

export type AttachHost = Pick<PtyLike, 'has' | 'write' | 'onData' | 'onExit' | 'resize' | 'serialize' | 'setReplies'>;

const STATUS_THROTTLE_MS = 100;
// The last margin-affecting sequence in a chunk: DECSTBM (not XTRESTORE `CSI ? … r`), an
// alternate/normal screen switch, RIS or DECSTR.
const MARGINS = /\x1b\[(\d*)(?:;(\d*))?r|\x1b\[\?(?:1049|1047|47)[hl]|\x1bc|\x1b\[!p/g;
const TAIL = 16;

/**
 * Does this output leave the real terminal without our region (rows 1..agentRows)? Sequences
 * ending at or before `from` (the carried-over tail) were handled with the previous chunk.
 */
export function dropsRegion(output: string, agentRows: number, from = 0): boolean {
  let last: RegExpExecArray | null = null;
  for (const m of output.matchAll(MARGINS)) if (m.index + m[0].length > from) last = m;
  if (!last) return false;
  if (!last[0].endsWith('r')) return true;
  const bottom = Number(last[2] || 0);
  return bottom === 0 || bottom > agentRows;
}

export class AttachSession {
  private offData: (() => void) | null = null;
  private offExit: (() => void) | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private active = false;
  private tail = '';
  private statusRow = 0;

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
    this.out.write(PUSH_TITLE + RESET_MODES);
    this.repaint();
    this.offData = this.host.onData(this.ptyId, (d) => {
      this.out.write(d);
      const seen = this.tail + d;
      const from = this.tail.length;
      this.tail = seen.slice(-TAIL);
      if (dropsRegion(seen, this.agentRows(), from)) this.out.write(this.keepRegion());
      this.scheduleStatus();
    });
    this.offExit = this.host.onExit((id) => {
      if (id === this.ptyId) this.leave('exited');
    });
    // An already-exited PTY never emits an exit event. Note: onLeave may fire synchronously here.
    if (!this.host.has(this.ptyId)) this.leave('exited');
  }

  input(chunk: string): void {
    if (!this.active) return;
    if (isAttachEscape(chunk)) {
      const cut = Math.min(...['\x1d', '\x1b[93;5u', '\x1b[27;5;93~'].map((f) => chunk.indexOf(f)).filter((i) => i >= 0));
      try {
        if (cut > 0) this.forward(chunk.slice(0, cut));
      } finally {
        this.leave('escape');
      }
      return;
    }
    this.forward(chunk);
  }

  /** The PTY may have died between has() and write(); never let that propagate. */
  private forward(data: string): void {
    try {
      if (this.host.has(this.ptyId)) this.host.write(this.ptyId, data);
    } catch {
      // exit event will follow
    }
  }

  /** The real terminal changed size: new region, old status row gone, full repaint. */
  resized(): void {
    if (!this.active) return;
    this.resizeAgent();
    this.tail = '';
    this.out.write(`\x1b[?6l${moveTo(this.statusRow, 1)}\x1b[2K`);
    this.repaint();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.offData?.();
    this.offExit?.();
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.host.setReplies(this.ptyId, true);
    this.out.write(RESET_MODES + POP_TITLE);
  }

  private leave(reason: 'escape' | 'exited'): void {
    if (!this.active) return;
    this.stop();
    this.onLeave(reason);
  }

  private agentRows(): number {
    return Math.max(2, this.out.rows - 1);
  }

  /** Region set, screen cleared, the agent's screen (with scrollback) painted, status drawn. */
  private repaint(): void {
    this.statusRow = this.out.rows;
    const region = `\x1b[1;${this.agentRows()}r`;
    // The serialized screen may switch to the alternate buffer, which drops margins in some terminals.
    this.out.write(region + CLEAR + HOME + this.host.serialize(this.ptyId) + this.keepRegion() + SHOW_CURSOR);
    this.drawStatus();
  }

  /** Set our region without moving the agent's cursor (DECSTBM homes it). */
  private keepRegion(): string {
    return `\x1b7\x1b[1;${this.agentRows()}r\x1b8`;
  }

  /** The process may have exited a moment ago with its exit event still in flight. */
  private resizeAgent(): void {
    try {
      this.host.resize(this.ptyId, this.out.columns, this.agentRows());
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
    this.out.write(`\x1b7\x1b[?6l${moveTo(this.out.rows, 1)}\x1b[0;7m${text}\x1b[0m\x1b8`);
  }
}
