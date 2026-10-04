import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import xtermHeadless from '@xterm/headless';
import * as pty from 'node-pty';
import { BackendError } from '../backend/types.js';
import { resolveWindowsCommand, unsafeForCmdShim } from '../orcaCli.js';

const { Terminal } = xtermHeadless;
type HeadlessTerminal = InstanceType<typeof Terminal>;

const COLS = 120;
const ROWS = 40;
const GONE = '이 에이전트 터미널은 이미 종료됐어요';

/**
 * node-pty's prebuilt spawn-helper can arrive without its execute bit (npm 11 skips install
 * scripts), and then every spawn fails with "posix_spawnp failed". Fix it before first use.
 */
export function ensureSpawnHelper(
  root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json')),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): void {
  if (platform === 'win32') return;
  for (const dir of [path.join(root, 'prebuilds', `${platform}-${arch}`), path.join(root, 'build', 'Release')]) {
    const helper = path.join(dir, 'spawn-helper');
    if (!existsSync(helper)) continue;
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      try {
        chmodSync(helper, 0o755);
      } catch {
        throw new Error(`node-pty's spawn-helper is not executable. Run: chmod +x "${helper}"`);
      }
    }
  }
}

/**
 * Windows: a .cmd shim (npm-installed CLIs) must run through cmd.exe, which re-parses arguments.
 * node-pty would quote each spaced argument itself, and cmd without /s then strips the wrong
 * quotes. So hand node-pty one finished command line: `/d /s /c "<shim> <args>"`, where /s
 * strips exactly the outer pair and each part with a space (or empty) is wrapped in quotes.
 * Arguments cmd could reinterpret (" % & | < > ^ !) are refused, so quoting is all it takes.
 */
export function resolveSpawn(
  file: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  resolveWin: typeof resolveWindowsCommand = resolveWindowsCommand,
): { file: string; args: string[] | string } {
  if (platform !== 'win32') return { file, args };
  const r = resolveWin(file);
  if (!r.viaCmd) return { file: r.file, args };
  if ([r.file, ...args].some(unsafeForCmdShim)) throw new BackendError(`${file}.cmd로는 이 인자를 안전하게 넘길 수 없어요`, 'unsafe_for_cmd');
  const q = (a: string) => (a === '' || /\s/.test(a) ? `"${a}"` : a);
  return { file: 'cmd.exe', args: `/d /s /c "${[r.file, ...args].map(q).join(' ')}"` };
}

export interface PtyOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

interface Session {
  proc: pty.IPty;
  term: HeadlessTerminal;
}

/** Agent processes in pseudo-terminals, each mirrored into a headless xterm we can read like a screen. */
export class PtyHost {
  private sessions = new Map<string, Session>();
  private exitListeners = new Set<(id: string, exitCode: number) => void>();

  constructor() {
    ensureSpawnHelper();
  }

  spawn(id: string, opts: PtyOptions): void {
    const cols = opts.cols ?? COLS;
    const rows = opts.rows ?? ROWS;
    const { file, args } = resolveSpawn(opts.file, opts.args);
    const term = new Terminal({ cols, rows, allowProposedApi: true });
    const proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: opts.cwd, env: opts.env });
    proc.onData((d) => term.write(d));
    // TUIs query the terminal (cursor position, device attributes) and wait for the answer.
    term.onData((d) => {
      if (this.sessions.get(id)?.proc === proc) proc.write(d);
    });
    proc.onExit(({ exitCode }) => {
      if (this.sessions.get(id)?.proc !== proc) return;
      this.sessions.delete(id);
      term.dispose();
      for (const fn of this.exitListeners) fn(id, exitCode);
    });
    this.sessions.set(id, { proc, term });
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new BackendError(GONE, 'terminal_not_writable');
    s.proc.write(data);
  }

  screenLines(id: string): string[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    const buf = s.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < s.term.rows; y++) lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
    return lines;
  }

  onExit(fn: (id: string, exitCode: number) => void): () => void {
    this.exitListeners.add(fn);
    return () => this.exitListeners.delete(fn);
  }

  kill(id: string): void {
    this.sessions.get(id)?.proc.kill();
  }

  async dispose(): Promise<void> {
    if (!this.sessions.size) return;
    const done = new Promise<void>((resolve) => {
      const off = this.onExit(() => {
        if (!this.sessions.size) {
          off();
          resolve();
        }
      });
    });
    for (const s of this.sessions.values()) s.proc.kill();
    await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
  }
}
