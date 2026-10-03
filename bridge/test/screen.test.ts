import { describe, expect, it } from 'vitest';
import { charBytes } from '../src/keys.js';
import { composerState } from '../src/screen.js';

const rule = '─'.repeat(60);
const composer = ['⏺ Done.', '', `${rule} command context logging ─`, '❯ ', rule, '  ⏵⏵ auto mode on · 1 shell'];

describe('composerState', () => {
  it('sees the Claude input box framed by rules', () => {
    expect(composerState(composer, 'claude')).toBe('ready');
    expect(composerState(['x', rule, '❯ first line', '  second line', rule, 'footer'], 'claude')).toBe('ready');
  });

  it('flags dialogs that replace the input box', () => {
    const usage = ['Settings  Status  Config  Usage', '', 'Current session  ███░░ 12% used', 'Esc to cancel'];
    expect(composerState(usage, 'claude')).toBe('menu');
    const permission = ['Bash command', '  rm -rf build', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel'];
    expect(composerState(permission, 'claude')).toBe('menu');
  });

  it('does not guess for other agents or blank screens', () => {
    expect(composerState(['anything'], 'codex')).toBe('unknown');
    expect(composerState(['', ''], 'claude')).toBe('unknown');
  });
});

describe('charBytes', () => {
  it('accepts one printable character only', () => {
    expect(charBytes('a')).toBe('a');
    expect(charBytes('한')).toBe('한');
    expect(charBytes(' ')).toBe(' ');
    expect(charBytes('\x1b')).toBeNull();
    expect(charBytes('ab')).toBeNull();
    expect(charBytes('\n')).toBeNull();
  });
});
