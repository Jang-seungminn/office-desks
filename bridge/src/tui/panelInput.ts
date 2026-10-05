// Raw input while the panel has focus: everything goes to the agent except Ctrl+] (in any of its
// encodings), which ends panel focus. A paste whose end marker hasn't arrived yet, or an escape
// sequence cut off at the end of a chunk, is held until the rest comes, so the agent gets it whole
// (and encodePanelInput sees it whole). Held bytes are flushed through `onTimeout` if the rest
// never comes: an escape after `escWaitMs` (a lone ESC is a real key), a paste after `pasteWaitMs`.

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const ESCAPE_FORMS = ['\x1d', '\x1b[93;5u', '\x1b[27;5;93~'];
const INCOMPLETE_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*|O)?$/;
const PASTE_WAIT_MS = 1000;

export class PanelInput {
  private held = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onTimeout: (held: string) => void,
    private readonly escWaitMs: number,
    private readonly pasteWaitMs = PASTE_WAIT_MS,
  ) {}

  /** Bytes for the agent now, and whether Ctrl+] ended panel focus (what followed it is dropped). */
  feed(chunk: string): { send: string; leave: boolean } {
    const data = this.held + chunk;
    this.reset();
    const cuts = ESCAPE_FORMS.map((f) => data.indexOf(f)).filter((i) => i >= 0);
    if (cuts.length) return { send: dropOrphanEnds(data.slice(0, Math.min(...cuts))), leave: true };
    const start = data.lastIndexOf(PASTE_START);
    if (start >= 0 && data.indexOf(PASTE_END, start) < 0) return this.hold(data, start, this.pasteWaitMs);
    const cut = INCOMPLETE_ESCAPE.exec(data);
    if (cut) return this.hold(data, cut.index, this.escWaitMs);
    return { send: dropOrphanEnds(data), leave: false };
  }

  /** Drop whatever is held (panel focus ended). */
  reset(): void {
    this.held = '';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private hold(data: string, from: number, ms: number): { send: string; leave: boolean } {
    this.held = data.slice(from);
    this.timer = setTimeout(() => {
      const held = this.held;
      this.reset();
      if (held) this.onTimeout(held);
    }, ms);
    return { send: dropOrphanEnds(data.slice(0, from)), leave: false };
  }
}

/**
 * Drop a paste end marker with no paste open before it. That happens when the safety flush already
 * sent a paste whose end was late (encodePanelInput closed it): the rest of that paste then reaches
 * the agent as plain typing, which beats waiting forever, and the late marker must not follow raw.
 */
function dropOrphanEnds(data: string): string {
  let out = '';
  let open = false;
  let i = 0;
  while (i < data.length) {
    if (data.startsWith(PASTE_START, i)) {
      open = true;
      out += PASTE_START;
      i += PASTE_START.length;
    } else if (data.startsWith(PASTE_END, i)) {
      if (open) out += PASTE_END;
      open = false;
      i += PASTE_END.length;
    } else out += data[i++];
  }
  return out;
}
