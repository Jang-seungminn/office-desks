// SGR (1006) mouse reports: ESC [ < b ; x ; y M (press/drag/wheel) or m (release), 1-based cells.

export type MouseKind = 'press' | 'release' | 'drag' | 'move' | 'wheelUp' | 'wheelDown';

export interface MouseEvent {
  kind: MouseKind;
  x: number;
  y: number;
  button: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export const MOUSE_SGR = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

export function parseMouse(seq: string): MouseEvent | null {
  const m = MOUSE_SGR.exec(seq);
  if (!m) return null;
  const b = Number(m[1]);
  const base = b & 3;
  const mods = { shift: !!(b & 4), alt: !!(b & 8), ctrl: !!(b & 16) };
  const at = { x: Number(m[2]) - 1, y: Number(m[3]) - 1 };
  let kind: MouseKind;
  if (b & 64) {
    if (base > 1) return null; // horizontal wheel
    kind = base === 0 ? 'wheelUp' : 'wheelDown';
  } else if (m[4] === 'm') kind = 'release';
  else if (b & 32) kind = base === 3 ? 'move' : 'drag';
  else kind = 'press';
  return { kind, ...at, button: base, ...mods };
}
