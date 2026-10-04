import { mkdtempSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { clipboardCommand, copyText, encodeForClipboard, spawnRunner } from '../src/tui/clipboard.js';

const only = (...cmds: string[]) => (c: string) => cmds.includes(c);

describe('clipboardCommand', () => {
  it('picks the platform command', () => {
    expect(clipboardCommand('darwin', only())).toEqual({ file: 'pbcopy', args: [], utf16: false });
    expect(clipboardCommand('win32', only())).toEqual({ file: 'clip.exe', args: [], utf16: true });
    expect(clipboardCommand('linux', only('wl-copy', 'xclip'))).toEqual({ file: 'wl-copy', args: [], utf16: false });
    expect(clipboardCommand('linux', only('xclip'))).toEqual({ file: 'xclip', args: ['-selection', 'clipboard'], utf16: false });
    expect(clipboardCommand('linux', only())).toBeNull();
  });
});

describe('encodeForClipboard', () => {
  it('encodes UTF-16LE with BOM or UTF-8', () => {
    expect(encodeForClipboard('한', true)).toEqual(Buffer.from([0xff, 0xfe, 0x5c, 0xd5]));
    expect(encodeForClipboard('한', false)).toEqual(Buffer.from('한', 'utf8'));
  });
});

describe('copyText', () => {
  it('writes the test hook file and never runs a command', async () => {
    const tmp = path.join(mkdtempSync(path.join(tmpdir(), 'od-copy-')), 'out.txt');
    const run = vi.fn();
    const r = await copyText('안녕', { platform: 'darwin', env: { OFFICE_DESKS_COPY_FILE: tmp }, run, has: () => true, writeFile });
    expect(r).toBe('file');
    expect(readFileSync(tmp, 'utf8')).toBe('안녕');
    expect(run).not.toHaveBeenCalled();
  });

  it('runs pbcopy on darwin', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const r = await copyText('한', { platform: 'darwin', env: {}, run, has: () => true });
    expect(r).toBe('command');
    expect(run).toHaveBeenCalledWith('pbcopy', [], Buffer.from('한', 'utf8'));
  });

  it('sends UTF-16LE with BOM to clip.exe on win32', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await copyText('한', { platform: 'win32', env: {}, run, has: () => true });
    expect(run).toHaveBeenCalledWith('clip.exe', [], Buffer.from([0xff, 0xfe, 0x5c, 0xd5]));
  });

  it('falls back to OSC 52 when the command fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('x'));
    const writeOsc = vi.fn();
    const r = await copyText('한', { platform: 'darwin', env: {}, run, has: () => true, writeOsc });
    expect(r).toBe('osc52');
    expect(writeOsc).toHaveBeenCalledWith(`\x1b]52;c;${Buffer.from('한', 'utf8').toString('base64')}\x07`);
  });

  it('falls back to OSC 52 when no command exists', async () => {
    const run = vi.fn();
    const writeOsc = vi.fn();
    expect(await copyText('a', { platform: 'linux', env: {}, run, has: () => false, writeOsc })).toBe('osc52');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects when nothing works and there is no OSC writer', async () => {
    const run = vi.fn().mockRejectedValue(new Error('x'));
    await expect(copyText('a', { platform: 'darwin', env: {}, run, has: () => true })).rejects.toThrow('복사하지 못했어요');
  });
});

describe('hardening', () => {
  it('kills a child that never exits and rejects', async () => {
    const run = spawnRunner(150);
    await expect(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], Buffer.from('x'))).rejects.toThrow('timed out');
  });

  it('turns a throwing writeOsc into the Korean error', async () => {
    const writeOsc = () => {
      throw new Error('EPIPE');
    };
    await expect(copyText('a', { platform: 'linux', env: {}, has: () => false, writeOsc })).rejects.toThrow('복사하지 못했어요');
  });

  it('refuses OSC 52 payloads over ~100 KB of base64', async () => {
    const writeOsc = vi.fn();
    await expect(copyText('a'.repeat(80_000), { platform: 'linux', env: {}, has: () => false, writeOsc })).rejects.toThrow('복사하지 못했어요');
    expect(writeOsc).not.toHaveBeenCalled();
  });
});
