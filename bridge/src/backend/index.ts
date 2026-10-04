import path from 'node:path';
import { officeHome } from '../home.js';
import { PtyHost } from '../native/ptyHost.js';
import { Registry } from '../native/registry.js';
import { createOrcaRunner, type OrcaRunner } from '../orcaCli.js';
import type { SessionVerifier } from '../sessionResolver.js';
import { DemoBackend } from './demo.js';
import { NativeBackend } from './native.js';
import { OrcaBackend } from './orca.js';
import type { OfficeBackend } from './types.js';

/** Is an Orca app running whose CLI answers? Then the office sits on top of it. */
export async function probeOrca(run: OrcaRunner = createOrcaRunner(undefined, 3000)): Promise<boolean> {
  try {
    const r = (await run(['status'])) as { runtime?: { reachable?: boolean } };
    return r?.runtime?.reachable === true;
  } catch {
    return false;
  }
}

export async function createNativeBackend(env: NodeJS.ProcessEnv, port: number): Promise<NativeBackend> {
  const home = officeHome(env);
  const registry = new Registry(path.join(home, 'state.json'));
  await registry.load();
  return new NativeBackend({
    pty: new PtyHost(),
    registry,
    home,
    env,
    hookUrl: (agentId, token) => `http://127.0.0.1:${port}/hook/${encodeURIComponent(agentId)}?token=${token}`,
  });
}

/**
 * OFFICE_DESKS_BACKEND (orca | native | demo) wins; OFFICE_DESKS_DEMO (`--demo`) means demo;
 * otherwise Orca when it is running, else our own native backend.
 */
export async function createBackend(
  env: NodeJS.ProcessEnv,
  verify: SessionVerifier | undefined,
  opts: { port: number; probeOrca?: () => Promise<boolean> },
): Promise<OfficeBackend> {
  const kind = env.OFFICE_DESKS_BACKEND?.trim() || (env.OFFICE_DESKS_DEMO ? 'demo' : (await (opts.probeOrca ?? probeOrca)()) ? 'orca' : 'native');
  if (kind === 'demo') return new DemoBackend(verify);
  if (kind === 'orca') return new OrcaBackend(createOrcaRunner(), verify);
  if (kind === 'native') return createNativeBackend(env, opts.port);
  throw new Error(`Unknown OFFICE_DESKS_BACKEND "${kind}" (use orca, native or demo)`);
}
