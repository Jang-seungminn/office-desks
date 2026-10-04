import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSpawnHelper, PtyHost, resolveSpawn } from '../src/native/ptyHost.js';

const ECHO = "process.stdin.setEncoding('utf8');process.stdout.write('ready\\r\\n');process.stdin.on('data',d=>process.stdout.write('got:'+d.trim()+'\\r\\n'))";

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('PtyHost', () => {
  let host: PtyHost | null = null;
  afterEach(async () => {
    await host?.dispose();
    host = null;
  });

  it('runs a program in a PTY, renders its screen, takes input and reports exit', async () => {
    host = new PtyHost();
    const exits: string[] = [];
    host.onExit((id) => exits.push(id));
    host.spawn('a1', { file: process.execPath, args: ['-e', ECHO], cwd: process.cwd(), env: { ...process.env } as Record<string, string> });
    await until(() => host!.screenLines('a1').some((l) => l.includes('ready')));
    host.write('a1', 'hello\r');
    await until(() => host!.screenLines('a1').some((l) => l.includes('got:hello')));
    host.kill('a1');
    await until(() => exits.includes('a1'));
    expect(host.has('a1')).toBe(false);
    expect(() => host!.write('a1', 'x')).toThrow(expect.objectContaining({ code: 'terminal_not_writable' }));
    expect(host.screenLines('a1')).toEqual([]);
  }, 15_000);
});

describe('resolveSpawn', () => {
  it('runs a Windows .cmd shim through cmd.exe and refuses arguments cmd.exe would reinterpret', () => {
    const shim = () => ({ file: 'C:\\npm\\claude.cmd', viaCmd: true });
    expect(resolveSpawn('claude', ['--session-id', 'u'], 'win32', shim)).toEqual({ file: 'cmd.exe', args: ['/d', '/c', 'C:\\npm\\claude.cmd', '--session-id', 'u'] });
    expect(() => resolveSpawn('claude', ['a&b'], 'win32', shim)).toThrow();
    expect(resolveSpawn('claude', ['x'], 'win32', () => ({ file: 'C:\\c\\claude.exe', viaCmd: false }))).toEqual({ file: 'C:\\c\\claude.exe', args: ['x'] });
    expect(resolveSpawn('claude', ['x'], 'darwin')).toEqual({ file: 'claude', args: ['x'] });
  });
});

describe('ensureSpawnHelper', () => {
  it.skipIf(process.platform === 'win32')('makes a prebuilt spawn-helper executable', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'od-pty-'));
    const dir = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`);
    mkdirSync(dir, { recursive: true });
    const helper = path.join(dir, 'spawn-helper');
    writeFileSync(helper, '');
    chmodSync(helper, 0o644);
    ensureSpawnHelper(root);
    expect(statSync(helper).mode & 0o111).not.toBe(0);
  });
});
