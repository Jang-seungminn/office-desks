import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crossSpawn from 'cross-spawn';

/**
 * Resolve the Orca CLI executable, following Orca's own rules:
 * ORCA_CLI_COMMAND wins (managed WSL sessions), Linux uses `orca-ide` because bare
 * `orca` there is usually the GNOME screen reader, everything else uses `orca`.
 */
export function resolveOrcaCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const fromEnv = env.ORCA_CLI_COMMAND?.trim();
  if (fromEnv) return fromEnv;
  if (platform === 'linux') return 'orca-ide';
  return 'orca';
}

export class OrcaCliError extends Error {
  constructor(
    message: string,
    readonly code: string = 'orca_cli_error',
  ) {
    super(message);
  }
}

export type OrcaRunner = (args: string[]) => Promise<unknown>;

/**
 * Characters cmd.exe interprets even inside quotes. A `.cmd` shim that forwards `%*`
 * re-parses its arguments, so these could break out and run commands (BatBadBut).
 */
const CMD_META = /["%&|<>^!\r\n`]/;

export function unsafeForCmdShim(arg: string): boolean {
  return CMD_META.test(arg);
}

export interface ResolvedCommand {
  file: string;
  /** True when Windows would have to run it through cmd.exe (.cmd/.bat shim). */
  viaCmd: boolean;
}

/** On Windows find the real file behind a bare command name, preferring a native .exe. */
export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): ResolvedCommand {
  const isShim = (f: string) => /\.(cmd|bat)$/i.test(f);
  if (path.win32.extname(command)) return { file: command, viaCmd: isShim(command) };
  const dirs = path.win32.isAbsolute(command) ? [''] : (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const ext of ['.exe', '.com', '.cmd', '.bat']) {
    for (const d of dirs) {
      const f = d ? path.win32.join(d, command + ext) : command + ext;
      if (exists(f)) return { file: f, viaCmd: isShim(f) };
    }
  }
  return { file: command, viaCmd: true };
}

/** Run `orca <args> --json` and return the parsed `result` payload. Args are never shell-joined. */
export function createOrcaRunner(command = resolveOrcaCommand(), timeoutMs = 15_000): OrcaRunner {
  const win = process.platform === 'win32' ? resolveWindowsCommand(command) : null;
  return (args) =>
    new Promise((resolve, reject) => {
      // Windows: a native .exe is spawned directly (no shell, Node quotes argv safely). A .cmd
      // shim needs cmd.exe, which re-parses arguments, so refuse anything it could interpret.
      if (win?.viaCmd && args.some(unsafeForCmdShim)) {
        reject(
          new OrcaCliError(
            'Windows의 orca.cmd로는 줄바꿈이나 " % & | < > ^ ! 문자를 안전하게 보낼 수 없습니다. ORCA_CLI_COMMAND에 orca.exe 경로를 지정해 주세요',
            'unsafe_for_cmd',
          ),
        );
        return;
      }
      const child = win && !win.viaCmd
        ? nodeSpawn(win.file, [...args, '--json'], { windowsHide: true, shell: false })
        : crossSpawn(win?.file ?? command, [...args, '--json'], { windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));

      const timer = setTimeout(() => {
        child.kill();
        reject(new OrcaCliError(`orca ${args[0]} ${args[1] ?? ''} timed out`, 'timeout'));
      }, timeoutMs);

      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new OrcaCliError(
            err.code === 'ENOENT' ? `Orca CLI "${command}" not found on PATH` : err.message,
            err.code === 'ENOENT' ? 'not_found' : 'spawn_error',
          ),
        );
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        let parsed: { ok?: boolean; result?: unknown; error?: { message?: string; code?: string } };
        try {
          parsed = JSON.parse(stdout.trim());
        } catch {
          reject(new OrcaCliError(oneLine(stderr || stdout) || `orca exited with ${code}`, 'bad_output'));
          return;
        }
        if (parsed.ok === false || code !== 0) {
          reject(
            new OrcaCliError(
              parsed.error?.message ?? (oneLine(stderr) || `orca exited with ${code}`),
              parsed.error?.code ?? 'orca_error',
            ),
          );
          return;
        }
        resolve(parsed.result);
      });
    });
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 300);
}
