import { describe, expect, it } from 'vitest';
import { resolveOrcaCommand, resolveWindowsCommand, unsafeForCmdShim } from '../src/orcaCli.js';

describe('resolveOrcaCommand', () => {
  it('prefers ORCA_CLI_COMMAND', () => {
    expect(resolveOrcaCommand({ ORCA_CLI_COMMAND: ' orca-wsl ' }, 'win32')).toBe('orca-wsl');
  });
  it('uses orca on macOS and Windows', () => {
    expect(resolveOrcaCommand({}, 'darwin')).toBe('orca');
    expect(resolveOrcaCommand({}, 'win32')).toBe('orca');
  });
  it('uses orca-ide on Linux', () => {
    expect(resolveOrcaCommand({}, 'linux')).toBe('orca-ide');
  });
});

describe('Windows command resolution', () => {
  const env = { PATH: 'C:\\tools;C:\\Orca\\bin' };
  it('prefers a native exe over a cmd shim', () => {
    const files = new Set(['C:\\Orca\\bin\\orca.cmd', 'C:\\Orca\\bin\\orca.exe']);
    expect(resolveWindowsCommand('orca', env, (f) => files.has(f))).toEqual({ file: 'C:\\Orca\\bin\\orca.exe', viaCmd: false });
  });
  it('marks a cmd-only install as needing cmd.exe', () => {
    const files = new Set(['C:\\Orca\\bin\\orca.cmd']);
    expect(resolveWindowsCommand('orca', env, (f) => files.has(f))).toEqual({ file: 'C:\\Orca\\bin\\orca.cmd', viaCmd: true });
  });
  it('flags arguments cmd.exe would interpret', () => {
    for (const bad of ['"&calc&"', '100%', 'a|b', 'x<y', 'hi!', 'two\nlines', 'a^b']) expect(unsafeForCmdShim(bad)).toBe(true);
    expect(unsafeForCmdShim('--text=plain 한글 message (ok), yes?')).toBe(false);
  });
});
