import { describe, expect, it } from 'vitest';
import { decodeKeys } from '../src/tui/keys.js';
import { Form } from '../src/tui/prompt.js';

const type = (f: Form, s: string) => {
  let r = null;
  for (const k of decodeKeys(s)) r = f.key(k) ?? r;
  return r;
};

describe('Form', () => {
  it('collects fields in order, with defaults and multibyte backspace', () => {
    const f = new Form([{ label: '이름' }, { label: '에이전트', initial: 'claude' }, { label: '첫 지시', optional: true }]);
    expect(type(f, 'fix-로그인\x7f\x7f\x7fg\r')).toBeNull();
    expect(f.line()).toBe('에이전트: claude█');
    expect(type(f, '\r')).toBeNull();
    expect(type(f, '\r')).toEqual({ done: 'submit', values: ['fix-g', 'claude', ''] });
  });

  it('does not accept an empty required field, and Esc or Ctrl+C cancels', () => {
    const f = new Form([{ label: '경로' }]);
    expect(type(f, '\r')).toBeNull();
    expect(f.line()).toBe('경로: █');
    expect(type(f, '\x1b')).toEqual({ done: 'cancel' });
    expect(type(new Form([{ label: 'x' }]), 'ab\x03')).toEqual({ done: 'cancel' });
  });
});
