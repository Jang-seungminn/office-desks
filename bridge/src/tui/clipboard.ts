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

const defaultRun: Runner = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${file} exited with ${code}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });

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
      await (opts.run ?? defaultRun)(cmd.file, cmd.args, encodeForClipboard(text, cmd.utf16));
      return 'command';
    } catch {
      // fall through to OSC 52
    }
  }
  if (opts.writeOsc) {
    opts.writeOsc(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
    return 'osc52';
  }
  throw new Error('복사하지 못했어요');
}
