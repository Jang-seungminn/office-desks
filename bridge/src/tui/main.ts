import { createWriteStream, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const restore = () => {
    if (done) return;
    done = true;
    out.write(restoreSequence());
    setRaw(false);
  };
  process.once('exit', restore);
  return restore;
}

export async function runTui(): Promise<void> {
  let port: number;
  const stdin = process.stdin;
  const stdout = process.stdout;
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
  let crashed = false;
  const crash = (err: unknown) => {
    if (crashed) return;
    crashed = true;
    app?.close();
    restore();
    process.stderr.write(`office-desks: ${(err as Error)?.stack ?? String(err)}\n`);
    void backend.dispose().finally(() => process.exit(1));
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);

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
  restore();
  await backend.dispose();
  process.exit(0);
}

// `tsx src/tui/main.ts` / `node dist/tui/main.js` run it; the bin imports runTui instead.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runTui();
}
