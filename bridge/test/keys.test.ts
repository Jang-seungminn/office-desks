import { describe, expect, it } from 'vitest';
import { decodeKeys, isAttachEscape } from '../src/tui/keys.js';

describe('decodeKeys', () => {
  it('decodes arrows, enter, escape, backspace, ctrl-c, ctrl-] and text', () => {
    expect(decodeKeys('\x1b[A\x1b[B\x1bOA\r\x7f\x03\x1d')).toEqual([
      { name: 'up' },
      { name: 'down' },
      { name: 'up' },
      { name: 'enter' },
      { name: 'backspace' },
      { name: 'ctrl-c' },
      { name: 'ctrl-]' },
    ]);
    expect(decodeKeys('\x1b')).toEqual([{ name: 'escape' }]);
    expect(decodeKeys('a한\n')).toEqual([{ name: 'char', ch: 'a' }, { name: 'char', ch: '한' }, { name: 'enter' }]);
    expect(decodeKeys('\x08\t')).toEqual([{ name: 'backspace' }, { name: 'tab' }]);
  });
});

describe('decodeKeys: paging and paste markers', () => {
  it('decodes PgUp/PgDn and bracketed paste markers', () => {
    expect(decodeKeys('\x1b[5~\x1b[6~')).toEqual([{ name: 'pgup' }, { name: 'pgdn' }]);
    expect(decodeKeys('\x1b[200~ab\x1b[201~')).toEqual([
      { name: 'paste-start' },
      { name: 'char', ch: 'a' },
      { name: 'char', ch: 'b' },
      { name: 'paste-end' },
    ]);
  });
});

describe('isAttachEscape', () => {
  it('recognizes Ctrl+] as a raw byte, kitty CSI-u and modifyOtherKeys', () => {
    expect(isAttachEscape('\x1d')).toBe(true);
    expect(isAttachEscape('\x1b[93;5u')).toBe(true);
    expect(isAttachEscape('\x1b[27;5;93~')).toBe(true);
    expect(isAttachEscape('x\x1dy')).toBe(true);
    expect(isAttachEscape(']')).toBe(false);
    expect(isAttachEscape('\x1b[A')).toBe(false);
  });
});

describe('mouse and shift-tab keys', () => {
  it('decodes SGR mouse sequences and Shift+Tab, never as typed text', () => {
    expect(decodeKeys('\x1b[<0;10;5Ma\x1b[Z')).toEqual([
      { name: 'mouse', event: { kind: 'press', x: 9, y: 4, button: 0, shift: false, alt: false, ctrl: false } },
      { name: 'char', ch: 'a' },
      { name: 'shift-tab' },
    ]);
    expect(decodeKeys('\x1b[<66;1;1M')).toEqual([]); // ignored, not garbage
  });
});
