// Keys typed into the panel, encoded for the agent's terminal modes. We draw the agent's screen
// ourselves, so modes it switched on (bracketed paste, application cursor keys) exist only in its
// headless terminal; the real terminal always sends normal arrows and wrapped pastes.

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Arrows and Home/End: `ESC [ x` normally, `ESC O x` in application cursor mode. */
function arrows(s: string, app: boolean): string {
  return app ? s.replace(/\x1b\[([ABCDHF])/g, '\x1bO$1') : s.replace(/\x1bO([ABCDHF])/g, '\x1b[$1');
}

export function encodePanelInput(chunk: string, modes: { bracketedPasteMode: boolean; applicationCursorKeysMode: boolean }): string {
  let out = '';
  let rest = chunk;
  while (rest) {
    const start = rest.indexOf(PASTE_START);
    if (start < 0) {
      out += arrows(rest, modes.applicationCursorKeysMode);
      break;
    }
    out += arrows(rest.slice(0, start), modes.applicationCursorKeysMode);
    const end = rest.indexOf(PASTE_END, start + PASTE_START.length);
    const body = rest.slice(start + PASTE_START.length, end < 0 ? undefined : end);
    out += modes.bracketedPasteMode ? PASTE_START + body + PASTE_END : body;
    rest = end < 0 ? '' : rest.slice(end + PASTE_END.length);
  }
  return out;
}
