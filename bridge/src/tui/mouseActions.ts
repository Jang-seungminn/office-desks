import type { Layout } from './layout.js';
import { MOUSE_SGR, parseMouse, type MouseEvent } from './mouse.js';

// Pure helpers for the mouse: where on the screen a report landed, how a drag stays in its pane,
// and taking mouse reports out of panel-focus input so they never reach an agent.

export type Hit =
  | { area: 'list'; y: number }
  | { area: 'head'; pane: number }
  | { area: 'pane'; pane: number; x: number; y: number } // body-relative cell
  | { area: 'none' };

const inside = (r: { row: number; col: number; rows: number; cols: number }, x: number, y: number) =>
  x >= r.col && x < r.col + r.cols && y >= r.row && y < r.row + r.rows;

export function hitTest(L: Layout, x: number, y: number): Hit {
  if (inside(L.list, x, y)) return { area: 'list', y };
  for (const [pane, p] of L.panes.entries()) {
    if (inside(p.body, x, y)) return { area: 'pane', pane, x: x - p.body.col, y: y - p.body.row };
    if (inside(p.head, x, y)) return { area: 'head', pane };
  }
  return { area: 'none' };
}

/** A drag point pulled into pane `pane`'s body; `edge` is -1/1 when it went past the top/bottom. */
export function clampToBody(L: Layout, pane: number, x: number, y: number): { x: number; y: number; edge: -1 | 0 | 1 } {
  const b = L.panes[pane].body;
  const edge = y < b.row ? -1 : y >= b.row + b.rows ? 1 : 0;
  return {
    x: Math.max(0, Math.min(b.cols - 1, x - b.col)),
    y: Math.max(0, Math.min(b.rows - 1, y - b.row)),
    edge,
  };
}

export type Part = { kind: 'text'; text: string } | { kind: 'mouse'; raw: string; event: MouseEvent | null };

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Input split into text and mouse reports, in order. Inside a bracketed paste nothing is taken
 * out: pasted bytes stay exactly as pasted, even ones that look like a mouse report.
 */
export function splitMouse(data: string): Part[] {
  const parts: Part[] = [];
  let text = '';
  let pasting = false;
  let i = 0;
  while (i < data.length) {
    if (data.startsWith(PASTE_START, i) || data.startsWith(PASTE_END, i)) {
      pasting = data.startsWith(PASTE_START, i);
      text += data.slice(i, i + PASTE_START.length);
      i += PASTE_START.length;
      continue;
    }
    const m = !pasting && data.charCodeAt(i) === 0x1b ? MOUSE_SGR.exec(data.slice(i)) : null;
    if (m) {
      if (text) parts.push({ kind: 'text', text });
      text = '';
      parts.push({ kind: 'mouse', raw: m[0], event: parseMouse(m[0]) });
      i += m[0].length;
      continue;
    }
    text += data[i++];
  }
  if (text) parts.push({ kind: 'text', text });
  return parts;
}

/** A partial mouse report (held for its rest, which never came): never typed into an agent. */
export const PARTIAL_MOUSE = /^\x1b\[<[0-9;]*$/;
