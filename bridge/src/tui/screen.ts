// Escape sequences the TUI writes. RESET_MODES turns off input modes an attached agent may
// have switched on in the user's terminal (bracketed paste, focus/mouse reports, kitty and
// modifyOtherKeys keyboards, a scroll region), so the lobby and the shell get plain keys back.

export const ALT_ON = '\x1b[?1049h';
export const ALT_OFF = '\x1b[?1049l';
export const CLEAR = '\x1b[2J';
export const HOME = '\x1b[H';
export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';
export const RESET_MODES = '\x1b[0m\x1b[r\x1b[?2004l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[>4;0m\x1b[<99u\x1b[?6l\x1b[?1005l\x1b[?1015l\x1b[?7h\x1b[?1l\x1b>';

export function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

/** Everything needed to hand the terminal back in a usable state. */
export function restoreSequence(): string {
  return RESET_MODES + SHOW_CURSOR + ALT_OFF;
}
