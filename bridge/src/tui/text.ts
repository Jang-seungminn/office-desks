// Terminal column widths: Hangul/CJK/fullwidth and emoji take two columns, combining marks none.
// A character followed by VS16 (U+FE0F, "show as emoji") is drawn two columns wide, so ⚠️ is 2.
// Good enough for names and status text; exotic emoji may still render differently per terminal.

const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  // Inside U+2600–27BF only the East Asian Wide ones: ✓ ✎ ⚠ stay one column (⚠️ is 2 via VS16).
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4],
  [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e],
  [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f1e6, 0x1f1ff], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];
const VS16 = 0xfe0f;

export function charWidth(cp: number): 0 | 1 | 2 {
  if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === VS16) return 0;
  for (const [a, b] of WIDE) if (cp >= a && cp <= b) return 2;
  return 1;
}

/** Characters with what follows them glued on (VS16), each with its column width. */
function clusters(s: string): [string, number][] {
  const out: [string, number][] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const last = out.at(-1);
    if (cp === VS16 && last) {
      last[0] += ch;
      last[1] = 2;
    } else out.push([ch, charWidth(cp)]);
  }
  return out;
}

export function displayWidth(s: string): number {
  return clusters(s).reduce((w, [, cw]) => w + cw, 0);
}

// CSI, OSC/DCS/APC/PM strings (to BEL or ST), and any other ESC + one char.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]?|\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[^[\]PX^_]?/g;

/** Text safe to draw: no escape sequences or control characters; tabs and newlines become spaces. */
export function clean(s: string): string {
  return s.replace(ESCAPES, '').replace(/[\t\r\n]/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/** Exactly `width` columns: cleaned, then padded with spaces or cut with '…' (never half a wide char). */
export function fit(s: string, width: number): string {
  if (width <= 0) return '';
  s = clean(s);
  const total = displayWidth(s);
  if (total <= width) return s + ' '.repeat(width - total);
  let out = '';
  let w = 0;
  for (const [ch, cw] of clusters(s)) {
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…' + ' '.repeat(width - w - 1);
}
