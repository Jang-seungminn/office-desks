import { createWriteStream, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { format } from 'node:util';
import { NativeBackend } from '../backend/native.js';
import { officeHome } from '../home.js';
import { App } from './app.js';
import { restoreSequence } from './screen.js';

const PORT_RANGE = 20;

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** An empty OFFICE_DESKS_PORT counts as unset. */
export function portFromEnv(env: NodeJS.ProcessEnv): { port: number; explicit: boolean } {
  const raw = env.OFFICE_DESKS_PORT?.trim();
  return raw ? { port: Number(raw), explicit: true } : { port: 4317, explicit: false };
}

/** An explicit --port is kept as is; otherwise the first free port from the default up. */
export async function pickPort(preferred: number, explicit: boolean, isFree: (p: number) => Promise<boolean> = portFree): Promise<number> {
  if (explicit) return preferred;
  for (let p = preferred; p < preferred + PORT_RANGE; p++) if (await isFree(p)) return p;
  throw new Error(`포트 ${preferred}~${preferred + PORT_RANGE - 1}이 모두 사용 중이에요. --port로 지정해 주세요`);
}

/** Hand the terminal back exactly once, whatever ends the process. */
export function installRestore(out: { write(s: string): unknown }, setRaw: (on: boolean) => void): () => void {
  let done = false;
  // After SIGHUP the terminal is gone: writes and raw mode may throw, and cleanup must go on.
  const restore = () => {
    if (done) return;
    done = true;
    try {
      out.write(restoreSequence());
    } catch {
      // nothing to restore on
    }
    try {
      setRaw(false);
    } catch {
      // ditto
    }
  };
  process.once('exit', restore);
  return restore;
}

/** Why the TUI can't run here (no terminal on stdin/stdout), or null. */
export function notTtyMessage(stdin: { isTTY?: boolean }, stdout: { isTTY?: boolean }): string | null {
  if (stdin.isTTY && stdout.isTTY) return null;
  return 'office-desks: 터미널 앱은 터미널에서만 열 수 있어요 (입력/출력이 터미널이 아니에요). 웹만 쓰려면 --no-tui로 실행하세요';
}

export interface ExitSteps {
  close(): void;
  restore(): void;
  dispose(): Promise<void>;
  exit(code: number): void;
  report(message: string): void;
}

/**
 * The single way out of the TUI (quit, crash, signal), taken once: the first caller's exit code
 * stands. The terminal comes back first, then agents and their settings files are cleaned up.
 */
export function createExit(steps: ExitSteps): (code: number, message?: string) => void {
  let exiting = false;
  return (code, message) => {
    if (exiting) return;
    exiting = true;
    try {
      steps.close(); // stops an attached session, which writes to the terminal
    } catch {
      // the terminal may be gone (SIGHUP)
    }
    try {
      steps.restore();
    } catch {
      // the terminal may be gone (SIGHUP)
    }
    if (message) {
      try {
        steps.report(message);
      } catch {
        // ditto
      }
    }
    void steps
      .dispose()
      .catch(() => {})
      .finally(() => steps.exit(code));
  };
}

export async function runTui(): Promise<void> {
  let port: number;
  const stdin = process.stdin;
  const stdout = process.stdout;
  const noTty = notTtyMessage(stdin, stdout);
  if (noTty) {
    process.stderr.write(noTty + '\n');
    process.exit(1);
  }
  let logPath: string | null = null;
  let loaded: typeof import('../server.js') | undefined;
  try {
    const { port: preferred, explicit } = portFromEnv(process.env);
    port = await pickPort(preferred, explicit);
    process.env.OFFICE_DESKS_PORT = String(port);
    process.env.OFFICE_DESKS_BACKEND ||= 'native';
    process.env.OFFICE_DESKS_TUI = '1';

    // Only the TUI may draw on this terminal: everything else goes to a log file.
    const home = officeHome();
    mkdirSync(home, { recursive: true });
    logPath = path.join(home, 'office-desks.log');
    const log = createWriteStream(logPath, { flags: 'a' });
    log.on('error', () => {});
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      console[level] = (...args: unknown[]) => void log.write(`${new Date().toISOString()} ${level} ${format(...args)}\n`);
    }
    // Node's own warnings would print over the screen too.
    process.removeAllListeners('warning');
    process.on('warning', (w) => console.warn(w));

    loaded = await import('../server.js');
    await loaded.ready;
  } catch (err) {
    const more = logPath ? `\n자세한 로그: ${logPath}` : '';
    process.stderr.write(`office-desks: ${(err as Error).message}${more}\n`);
    await loaded?.backend.dispose().catch(() => {});
    process.exit(1);
  }
  const server = loaded;
  const backend = server.backend;
  if (!(backend instanceof NativeBackend)) {
    process.stderr.write('office-desks: 터미널 앱은 native 백엔드에서만 돌아요 (--backend orca는 --no-tui와 함께 쓰세요)\n');
    await backend.dispose().catch(() => {});
    process.exit(1);
  }

  const restore = installRestore(stdout, (on) => stdin.isTTY && stdin.setRawMode(on));
  let app: App | null = null;
  const finish = createExit({
    close: () => app?.close(),
    restore,
    dispose: () => backend.dispose(),
    exit: (code) => process.exit(code),
    report: (m) => process.stderr.write(m),
  });
  const crash = (err: unknown) => finish(1, `office-desks: ${(err as Error)?.stack ?? String(err)}\n`);
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  // A closed terminal window (SIGHUP) must still stop the agents. server.ts leaves signals to us.
  stdout.on('error', () => {});
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => finish(0));

  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  app = new App(
    {
      snapshot: () => server.poller.current,
      onSnapshot: (fn) => server.poller.onChange(() => fn()),
      refresh: () => server.poller.refresh(),
      hire: (spec) => backend.hire(spec),
      addRepo: (p) => backend.addRepo(p),
      terminalOf: (id) => backend.terminalOf(id),
      host: backend.pty,
      url: `http://127.0.0.1:${port}`,
    },
    stdin,
    stdout,
  );
  server.poller.setIdle(false); // the lobby is a live viewer
  app.start();
  await app.done;
  finish(0); // a no-op when a crash or a signal got there first
}
