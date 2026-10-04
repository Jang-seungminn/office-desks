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
