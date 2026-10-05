import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentTerminal, ensureSpawnHelper, PtyHost, resolveSpawn, watchCursor } from '../src/native/ptyHost.js';
import { scratch } from './scratch.js';

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

  it('streams output to subscribers, resizes, serializes the screen and mutes query replies', async () => {
    host = new PtyHost();
    host.spawn('a2', { file: process.execPath, args: ['-e', ECHO], cwd: process.cwd(), env: { ...process.env } as Record<string, string> });
    let seen = '';
    const off = host.onData('a2', (d) => (seen += d));
    await until(() => host!.screenLines('a2').some((l) => l.includes('ready')));
    host.write('a2', 'hi\r');
    await until(() => seen.includes('got:hi'));
    off();
    host.write('a2', 'again\r');
    await until(() => host!.screenLines('a2').some((l) => l.includes('got:again')));
    expect(seen).not.toContain('got:again');

    expect(host.size('a2')).toEqual({ cols: 120, rows: 40 });
    host.resize('a2', 80, 20);
    expect(host.size('a2')).toEqual({ cols: 80, rows: 20 });
    expect(host.screenLines('a2')).toHaveLength(20);

    const s = host.serialize('a2');
    expect(s).toContain('got:hi');
    expect(host.serialize('nope')).toBe('');

    expect(() => host!.setReplies('a2', false)).not.toThrow();
    expect(() => host!.setReplies('a2', true)).not.toThrow();
    expect(() => host!.resize('nope', 10, 10)).not.toThrow();
  }, 15_000);

  it('exposes the headless terminal and live ids, and ignores same-size resizes', async () => {
    host = new PtyHost();
    host.spawn('t1', { file: process.execPath, args: ['-e', ECHO], cwd: process.cwd(), env: { ...process.env } as Record<string, string> });
    await until(() => host!.screenLines('t1').some((l) => l.includes('ready')));
    expect(host.ids()).toEqual(['t1']);
    const t = host.terminal('t1')!;
    expect(t.cols).toBe(120);
    // ConPTY may start with a blank line or a clear: find the row rather than assume row 0.
    const y = host.screenLines('t1').findIndex((l) => l.includes('ready'));
    const x = host.screenLines('t1')[y].indexOf('ready');
    const buf = t.buffer.active;
    expect(buf.getLine(buf.viewportY + y)!.getCell(x)!.getChars()).toBe('r');
    host.resize('t1', 120, 40); // same size: no-op (no throw, no reflow)
    expect(host.size('t1')).toEqual({ cols: 120, rows: 40 });
    expect(host.terminal('nope')).toBeNull();
  }, 15_000);

  it('ignores a resize the PTY refuses (exited, exit event not yet fired)', async () => {
    host = new PtyHost();
    host.spawn('t2', { file: process.execPath, args: ['-e', ECHO], cwd: process.cwd(), env: { ...process.env } as Record<string, string> });
    await until(() => host!.screenLines('t2').some((l) => l.includes('ready')));
    const session = (host as unknown as { sessions: Map<string, { proc: { resize(c: number, r: number): void } }> }).sessions.get('t2')!;
    session.proc.resize = () => {
      throw new Error('EBADF: ioctl(2) failed');
    };
    expect(() => host!.resize('t2', 80, 20)).not.toThrow();
  }, 15_000);
});

describe('resolveSpawn', () => {
  it('runs a Windows .cmd shim through cmd.exe and refuses arguments cmd.exe would reinterpret', () => {
    const shim = () => ({ file: 'C:\\npm\\claude.cmd', viaCmd: true });
    // One command line for node-pty: /s strips exactly the outer quotes, the rest reaches the shim as is.
    expect(resolveSpawn('claude', ['--session-id', 'u'], 'win32', shim)).toEqual({ file: 'cmd.exe', args: '/d /s /c "C:\\npm\\claude.cmd --session-id u"' });
    expect(resolveSpawn('claude', ['--x', ''], 'win32', shim)).toEqual({ file: 'cmd.exe', args: '/d /s /c "C:\\npm\\claude.cmd --x """' });
    expect(() => resolveSpawn('claude', ['a&b'], 'win32', shim)).toThrow();
    expect(resolveSpawn('claude', ['x'], 'win32', () => ({ file: 'C:\\c\\claude.exe', viaCmd: false }))).toEqual({ file: 'C:\\c\\claude.exe', args: ['x'] });
    expect(resolveSpawn('claude', ['x'], 'darwin')).toEqual({ file: 'claude', args: ['x'] });
  });

  it('quotes a shim and arguments with spaces so cmd.exe keeps them whole', () => {
    const shim = () => ({ file: 'C:\\Users\\First Last\\npm\\claude.cmd', viaCmd: true });
    const args = ['--session-id', 'u', '--settings', 'C:\\Users\\First Last\\.office-desks\\agents\\a.json'];
    expect(resolveSpawn('claude', args, 'win32', shim)).toEqual({
      file: 'cmd.exe',
      args: '/d /s /c ""C:\\Users\\First Last\\npm\\claude.cmd" --session-id u --settings "C:\\Users\\First Last\\.office-desks\\agents\\a.json""',
    });
  });
});

describe('ensureSpawnHelper', () => {
  it.skipIf(process.platform === 'win32')('makes a prebuilt spawn-helper executable', () => {
    const root = scratch('od-pty-');
    const dir = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`);
    mkdirSync(dir, { recursive: true });
    const helper = path.join(dir, 'spawn-helper');
    writeFileSync(helper, '');
    chmodSync(helper, 0o644);
    ensureSpawnHelper(root);
    expect(statSync(helper).mode & 0o111).not.toBe(0);
  });
});

describe('PtyHost reply muting', () => {
  it('forwards headless terminal replies to the process only while replies are on', async () => {
    const host = new PtyHost();
    try {
      host.spawn('m1', { file: process.execPath, args: ['-e', "process.stdin.setRawMode(true);process.stdout.write('ready\\r\\n');process.stdin.on('data',d=>process.stdout.write('in:'+JSON.stringify(String(d))+'\\r\\n'))"], cwd: process.cwd(), env: { ...process.env } as Record<string, string> });
      await until(() => host.screenLines('m1').some((l) => l.includes('ready')));
      // A Device Attributes query written *to the terminal* makes xterm answer on its input side.
      host.setReplies('m1', false);
      (host as unknown as { feed(id: string, d: string): void }).feed('m1', '\x1b[c');
      await new Promise((r) => setTimeout(r, 400));
      expect(host.screenLines('m1').join('\n')).not.toContain('in:');
      host.setReplies('m1', true);
      (host as unknown as { feed(id: string, d: string): void }).feed('m1', '\x1b[c');
      const end = Date.now() + 5000;
      while (!host.screenLines('m1').join('\n').includes('in:') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      expect(host.screenLines('m1').join('\n')).toContain('in:');
    } finally {
      await host.dispose();
    }
  }, 15_000);
});

describe('agent cursor visibility (DECTCEM)', () => {
  const put = (t: ReturnType<typeof agentTerminal>, s: string) => new Promise<void>((r) => t.write(s, r));

  it('follows ?25l / ?25h (also among other modes), resets, and leaves the modes to xterm', async () => {
    const t = agentTerminal(20, 4);
    const cursor = watchCursor(t);
    expect(cursor.hidden).toBe(false);
    await put(t, '\x1b[?25l');
    expect(cursor.hidden).toBe(true);
    await put(t, '\x1b[?2004;25h');
    expect(cursor.hidden).toBe(false);
    expect(t.modes.bracketedPasteMode).toBe(true);
    await put(t, '\x1b[?1;25l');
    expect(cursor.hidden).toBe(true);
    expect(t.modes.applicationCursorKeysMode).toBe(false);
    await put(t, '\x1bc');
    expect(cursor.hidden).toBe(false);
    await put(t, '\x1b[?25l\x1b[!p');
    expect(cursor.hidden).toBe(false);
  });

  it('is exposed per PTY by PtyHost', async () => {
    const host = new PtyHost();
    try {
      host.spawn('c1', { file: process.execPath, args: ['-e', ECHO], cwd: process.cwd(), env: { ...process.env } as Record<string, string> });
      await until(() => host.screenLines('c1').some((l) => l.includes('ready')));
      expect(host.cursorHidden('c1')).toBe(false);
      host.feed('c1', '\x1b[?25l');
      await until(() => host.cursorHidden('c1'));
      expect(host.cursorHidden('nope')).toBe(false);
    } finally {
      await host.dispose();
    }
  }, 15_000);
});
