// Read-only smoke test of the Node Orca backend against the user's running Orca (R3 Task 8).
// Run it by hand, on the user's machine, and only after the user said yes:
//   npx tsx bridge/scripts/orca-smoke.ts --user-approved-read-only
// Every CLI call goes through readOnly(), which runs only `orca status`, `orca worktree ps`,
// `orca terminal list` and `orca terminal read`. Anything else is refused, recorded and makes
// the script exit 2. It prints one JSON object to stdout and never prints screen text.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeOrca } from '../src/backend/index.js';
import { OrcaBackend } from '../src/backend/orca.js';
import { createOrcaRunner, type OrcaRunner } from '../src/orcaCli.js';
import { composerState } from '../src/screen.js';

export const FLAG = '--user-approved-read-only';
export const REFUSAL =
  'This runs only: orca status, orca worktree ps, orca terminal list, orca terminal read. Ask the user first, then pass --user-approved-read-only.';

/** The only argv prefixes readOnly() lets through. */
export const ALLOWED: readonly (readonly string[])[] = [['status'], ['worktree', 'ps'], ['terminal', 'list'], ['terminal', 'read']];

/** Calls per allowed prefix and every refused argv, shared by all readOnly() wrappers. */
export interface SmokeLog {
  calls: Record<string, number>;
  refused: string[];
}

export function newLog(): SmokeLog {
  return { calls: Object.fromEntries(ALLOWED.map((p) => [p.join(' '), 0])), refused: [] };
}

/** Wraps a runner and lets only the ALLOWED prefixes through; anything else is recorded and rejected. */
export function readOnly(inner: OrcaRunner, log: SmokeLog): OrcaRunner {
  return (args) => {
    const prefix = ALLOWED.find((p) => args.length >= p.length && p.every((w, i) => args[i] === w));
    if (!prefix) {
      const joined = args.join(' ');
      log.refused.push(joined);
      return Promise.reject(new Error(`smoke: refused ${joined}`));
    }
    const key = prefix.join(' ');
    log.calls[key] = (log.calls[key] ?? 0) + 1;
    return inner(args);
  };
}

const code = (err: unknown) => (err as { code?: string })?.code ?? 'error';

async function main(argv: string[]): Promise<number> {
  // The gate comes first: without the flag no runner is built and no orca command runs.
  if (!argv.includes(FLAG)) {
    console.log(REFUSAL);
    return 1;
  }

  const log = newLog();
  const probe = readOnly(createOrcaRunner(undefined, 3000), log);
  const ro = readOnly(createOrcaRunner(undefined, 15_000), log);

  // 1. Is Orca there at all?
  if (!(await probeOrca(probe))) {
    console.log(JSON.stringify({ reachable: false }));
    return log.refused.length ? 2 : 0;
  }

  // 2. No verifier, so session searches are never needed; findSession is never called.
  const backend = new OrcaBackend(ro);

  // 3. Two snapshots back to back: the second must not list terminals again unless a pane is new.
  const errors: string[] = [];
  let snapshot: Awaited<ReturnType<OrcaBackend['snapshot']>> | null = null;
  for (const round of [1, 2]) {
    try {
      snapshot = await backend.snapshot();
    } catch (err) {
      errors.push(`snapshot ${round}: ${code(err)}`);
    }
    console.error(`[orca-smoke] after snapshot ${round}: ${JSON.stringify(log.calls)}`);
  }

  const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const desks = (snapshot?.desks ?? [])
    .map((d) => ({ id: d.id, agents: d.agents.map((a) => ({ id: a.id, terminalHandle: a.terminalHandle, agentType: a.agentType })).sort(byId) }))
    .sort(byId);

  // 4. Up to 3 screens: line counts and composer states only, never the text.
  const screens: { handle: string; lines: number | null; composer: string | null }[] = [];
  const withHandles = desks.flatMap((d) => d.agents).filter((a) => a.terminalHandle).slice(0, 3);
  for (const a of withHandles) {
    const handle = a.terminalHandle!;
    try {
      const lines = await backend.readScreen(handle);
      screens.push({ handle, lines: lines.length, composer: composerState(lines, a.agentType) });
    } catch (err) {
      errors.push(`readScreen ${handle}: ${code(err)}`);
      screens.push({ handle, lines: null, composer: null });
    }
  }

  // 5. One JSON object.
  console.log(JSON.stringify({ reachable: true, desks, calls: log.calls, screens, refused: log.refused }));
  for (const e of errors) console.error(`[orca-smoke] ${e}`);
  return log.refused.length ? 2 : errors.length ? 1 : 0;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (exit) => {
      process.exitCode = exit;
    },
    (err) => {
      console.error(`[orca-smoke] ${code(err)}`);
      process.exitCode = 1;
    },
  );
}
