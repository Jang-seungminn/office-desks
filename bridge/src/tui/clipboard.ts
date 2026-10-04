// Copy text to the system clipboard without a shell: pbcopy / clip.exe / wl-copy / xclip,
// then an OSC 52 escape as the last resort.
import { spawn } from 'node:child_process';
import { writeFile as fsWriteFile } from 'node:fs/promises';
import { findCommand } from '../native/env.js';

export type Runner = (file: string, args: string[], input: Buffer) => Promise<void>;

export interface CopyOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
  has?: (cmd: string) => boolean;
  writeOsc?: (seq: string) => void;
  timeoutMs?: number; // default runner: kill the child and reject after this long (default 3000)
  writeFile?: (path: string, text: string) => Promise<void>;
}

export function clipboardCommand(
  platform: NodeJS.Platform,
  has: (cmd: string) => boolean,
): { file: string; args: string[]; utf16: boolean } | null {
  if (platform === 'darwin') return { file: 'pbcopy', args: [], utf16: false };
  if (platform === 'win32') return { file: 'clip.exe', args: [], utf16: true };
  if (has('wl-copy')) return { file: 'wl-copy', args: [], utf16: false };
  if (has('xclip')) return { file: 'xclip', args: ['-selection', 'clipboard'], utf16: false };
  return null;
}

/** clip.exe reads UTF-16LE when the input starts with a BOM. */
export function encodeForClipboard(text: string, utf16: boolean): Buffer {
  return utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : Buffer.from(text, 'utf8');
}

/** Spawns without a shell; rejects (and kills the child) if it hasn't closed within timeoutMs. */
export function spawnRunner(timeoutMs = 3000): Runner {
  return (file, args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error(`${file} timed out`));
      }, timeoutMs);
      child.on('error', (e) => finish(e));
      child.on('close', (code) => finish(code === 0 ? undefined : new Error(`${file} exited with ${code}`)));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
}

const MAX_OSC_BASE64 = 100_000;

export async function copyText(text: string, opts: CopyOptions = {}): Promise<'file' | 'command' | 'osc52'> {
  const env = opts.env ?? process.env;
  // Test-only hook: OFFICE_DESKS_COPY_FILE makes the copy land in a file instead of the real clipboard.
  const hook = env.OFFICE_DESKS_COPY_FILE;
  if (hook) {
    await (opts.writeFile ?? fsWriteFile)(hook, text);
    return 'file';
  }
  const has = opts.has ?? ((cmd: string) => !!findCommand(cmd, env as Record<string, string>));
  const cmd = clipboardCommand(opts.platform ?? process.platform, has);
  if (cmd) {
    try {
      await (opts.run ?? spawnRunner(opts.timeoutMs))(cmd.file, cmd.args, encodeForClipboard(text, cmd.utf16));
      return 'command';
    } catch {
      // fall through to OSC 52
    }
  }
  if (opts.writeOsc) {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    if (b64.length > MAX_OSC_BASE64) throw new Error('복사하지 못했어요');
    try {
      opts.writeOsc(`\x1b]52;c;${b64}\x07`);
    } catch {
      throw new Error('복사하지 못했어요');
    }
    return 'osc52';
  }
  throw new Error('복사하지 못했어요');
}
