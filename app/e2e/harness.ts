// Starts and stops the Rust E2E harness (crates/od-app/examples/e2e_harness.rs): the app's own
// in-process server on a scratch world, with the fake `claude` as its only agent.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HarnessInfo {
  port: number;
  token: string;
  /** The scratch root (deleted when the harness exits). */
  root: string;
  /** A committed git repo inside the root: what the fake folder picker returns. */
  repo: string;
  /** `OD_FAKE_AGENT_OUT`: each fake agent appends `{"pid",…}` to `agents.jsonl` here. */
  out: string;
}

/** Never the real office-desks ports. */
export const FORBIDDEN_PORTS = [4317, 4318, 4319, 4320];

const BIN = fileURLToPath(
  new URL('../../target/debug/examples/e2e_harness' + (process.platform === 'win32' ? '.exe' : ''), import.meta.url),
);

/** The PID of every fake agent the harness started so far (oldest first). */
export function agentPids(out: string): number[] {
  let text = '';
  try {
    text = readFileSync(join(out, 'agents.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l).pid as number);
}

/** Signal 0 only checks that the PID exists; it never kills anything. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function startHarness(): Promise<{ info: HarnessInfo; stop(): Promise<void> }> {
  if (!existsSync(BIN)) throw new Error(`e2e harness not built (${BIN}); run: cargo build -p od-app --example e2e_harness`);
  // No shell, no args. stderr goes to ours (server logs); stdout carries one JSON line.
  const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'], shell: false });
  let exited = false;
  const exit = new Promise<void>((resolve) => child.once('exit', () => {
    exited = true;
    resolve();
  }));

  const line = await new Promise<string>((resolve, reject) => {
    let buf = '';
    let done = false;
    child.stdout!.setEncoding('utf8');
    // Keep draining after the first line, so nothing the harness prints later can block it.
    child.stdout!.on('data', (chunk: string) => {
      if (done) return;
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        done = true;
        resolve(buf.slice(0, nl).trim());
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!done) reject(new Error(`e2e harness exited (${code}) before printing its port`));
    });
  });
  const info = JSON.parse(line) as HarnessInfo;
  if (!Number.isInteger(info.port) || info.port <= 0 || FORBIDDEN_PORTS.includes(info.port)) {
    child.stdin!.end();
    throw new Error(`e2e harness bound a forbidden port: ${info.port}`);
  }

  async function stop(): Promise<void> {
    // The harness deletes its scratch root (agents.jsonl included) when it exits: read it first.
    const pids = agentPids(info.out);
    child.stdin!.end();
    const timedOut = await Promise.race([
      exit.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), 15_000).unref()),
    ]);
    if (timedOut && !exited) {
      child.kill(); // this PID only
      throw new Error('harness did not exit');
    }
    if (child.exitCode !== 0) throw new Error(`harness exited with ${child.exitCode ?? child.signalCode}`);
    if (pids.length === 0) throw new Error('no fake agent ever started: the shutdown check would prove nothing');
    for (const pid of pids) {
      if (alive(pid)) throw new Error(`agent ${pid} still running after shutdown`);
    }
    console.log(`[e2e] harness exited 0; all ${pids.length} fake agents are gone`);
  }

  return { info, stop };
}
