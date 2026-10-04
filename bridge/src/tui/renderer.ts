import { compose, type View } from './compose.js';
import { diff, type Frame } from './frame.js';
import { HIDE_CURSOR, moveTo, SHOW_CURSOR } from './screen.js';

// Draws the App's View: composes a frame and writes only what changed since the last one, then
// places the real cursor. Agent output is coalesced into one draw per `delayMs`; keys, snapshots
// and resizes draw at once. `view()` returning null (zoomed, closed) means: draw nothing.

const RENDER_MS = 16;

export class Renderer {
  private last: Frame | null = null;
  private lastCursor = '';
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly out: { write(s: string): unknown; columns: number; rows: number },
    private readonly view: () => View | null,
    private readonly delayMs = RENDER_MS,
  ) {}

  /** Draw now; this supersedes a scheduled draw. */
  draw(): void {
    this.cancel();
    const v = this.stopped ? null : this.view();
    if (!v) return;
    const { frame, cursor } = compose(v, this.out.columns, this.out.rows);
    const paint = diff(this.last, frame);
    // A cursor the agent hid is still moved there (an IME composes at it), just not shown.
    const place = cursor ? moveTo(cursor.row + 1, cursor.col + 1) + (cursor.hidden ? HIDE_CURSOR : SHOW_CURSOR) : HIDE_CURSOR;
    this.last = frame;
    if (!paint && place === this.lastCursor) return;
    this.lastCursor = place;
    // A visible cursor would jump around while cells are painted.
    this.out.write((cursor ? HIDE_CURSOR : '') + paint + place);
  }

  /** Draw soon (agent output), once for any number of calls until then. */
  schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => this.draw(), this.delayMs);
  }

  /** Draw a scheduled draw now (tests). */
  flush(): void {
    if (this.timer) this.draw();
  }

  /** The screen was cleared or resized: the next draw paints everything. */
  invalidate(): void {
    this.last = null;
    this.lastCursor = '';
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Never draw again. */
  stop(): void {
    this.stopped = true;
    this.cancel();
  }
}
