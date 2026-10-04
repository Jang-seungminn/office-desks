import { describe, expect, it } from 'vitest';
import { parseMouse } from '../src/tui/mouse.js';

describe('parseMouse', () => {
  it('reads presses, releases, drags, wheel and modifiers (0-based coordinates)', () => {
    expect(parseMouse('\x1b[<0;10;5M')).toEqual({ kind: 'press', x: 9, y: 4, button: 0, shift: false, alt: false, ctrl: false });
    expect(parseMouse('\x1b[<0;10;5m')).toMatchObject({ kind: 'release', button: 0 });
    expect(parseMouse('\x1b[<32;11;5M')).toMatchObject({ kind: 'drag', x: 10, y: 4, button: 0 });
    expect(parseMouse('\x1b[<35;1;1M')).toMatchObject({ kind: 'move' });
    expect(parseMouse('\x1b[<64;3;3M')).toMatchObject({ kind: 'wheelUp', x: 2, y: 2 });
    expect(parseMouse('\x1b[<65;3;3M')).toMatchObject({ kind: 'wheelDown' });
    expect(parseMouse('\x1b[<20;1;1M')).toMatchObject({ kind: 'press', shift: true, ctrl: true });
    expect(parseMouse('\x1b[<66;1;1M')).toBeNull(); // horizontal wheel: ignored
    expect(parseMouse('\x1b[A')).toBeNull();
  });
});
