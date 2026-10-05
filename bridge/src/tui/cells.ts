// One terminal cell and its look, as the TUI compositor needs it: read from a headless xterm,
// compared between frames, and written back as SGR.

export type Color = { mode: 'default' } | { mode: 'palette'; index: number } | { mode: 'rgb'; rgb: number };

export interface Style {
  fg: Color;
  bg: Color;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface Cell {
  ch: string;
  /** 2 for a wide char, 0 for the column a wide char covers. */
  width: 0 | 1 | 2;
  style: Style;
}

const DEFAULT_COLOR: Color = { mode: 'default' };
export const DEFAULT_STYLE: Style = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, bold: false, dim: false, italic: false, underline: false, inverse: false };
export const BLANK: Cell = { ch: ' ', width: 1, style: DEFAULT_STYLE };

export function style(patch: Partial<Style>): Style {
  return { ...DEFAULT_STYLE, ...patch };
}

const sameColor = (a: Color, b: Color) =>
  a.mode === b.mode && (a.mode === 'default' || (a.mode === 'palette' ? a.index === (b as typeof a).index : a.rgb === (b as typeof a).rgb));

export function sameStyle(a: Style, b: Style): boolean {
  return (
    sameColor(a.fg, b.fg) && sameColor(a.bg, b.bg) && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse
  );
}

function colorCodes(c: Color, bg: boolean): number[] {
  if (c.mode === 'default') return [];
  if (c.mode === 'rgb') return [bg ? 48 : 38, 2, (c.rgb >> 16) & 255, (c.rgb >> 8) & 255, c.rgb & 255];
  if (c.index < 8) return [(bg ? 40 : 30) + c.index];
  if (c.index < 16) return [(bg ? 100 : 90) + c.index - 8];
  return [bg ? 48 : 38, 5, c.index];
}

/** The whole style from a reset; simple and always correct (frames change few runs). */
export function sgr(s: Style): string {
  const codes = [0];
  if (s.bold) codes.push(1);
  if (s.dim) codes.push(2);
  if (s.italic) codes.push(3);
  if (s.underline) codes.push(4);
  if (s.inverse) codes.push(7);
  codes.push(...colorCodes(s.fg, false), ...colorCodes(s.bg, true));
  return `\x1b[${codes.join(';')}m`;
}

export interface XtermCellLike {
  getChars(): string;
  getWidth(): number;
  getFgColorMode(): number;
  getFgColor(): number;
  getBgColorMode(): number;
  getBgColor(): number;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isInverse(): number;
}

// xterm's color modes: 0 default, 1<<24 16-color, 2<<24 256-color, 3<<24 RGB.
function xtermColor(mode: number, value: number): Color {
  const m = mode >>> 24;
  if (m === 1 || m === 2) return { mode: 'palette', index: value };
  if (m === 3) return { mode: 'rgb', rgb: value };
  return DEFAULT_COLOR;
}

export function cellFromXterm(c: XtermCellLike): Cell {
  const width = c.getWidth() as 0 | 1 | 2;
  const s: Style = {
    fg: xtermColor(c.getFgColorMode(), c.getFgColor()),
    bg: xtermColor(c.getBgColorMode(), c.getBgColor()),
    bold: !!c.isBold(),
    dim: !!c.isDim(),
    italic: !!c.isItalic(),
    underline: !!c.isUnderline(),
    inverse: !!c.isInverse(),
  };
  const ch = c.getChars();
  return { ch: width === 0 ? '' : ch || ' ', width, style: sameStyle(s, DEFAULT_STYLE) ? DEFAULT_STYLE : s };
}
