// Terminal column widths: Hangul/CJK/fullwidth take two columns, combining marks none.
// Good enough for names and status text; exotic emoji may still render differently per terminal.

const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

export function charWidth(cp: number): 0 | 1 | 2 {
  if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f) return 0;
  for (const [a, b] of WIDE) if (cp >= a && cp <= b) return 2;
  return 1;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Exactly `width` columns: padded with spaces, or cut with '…' (never half a wide char). */
export function fit(s: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(s) <= width) return s + ' '.repeat(width - displayWidth(s));
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…' + ' '.repeat(width - w - 1);
}
