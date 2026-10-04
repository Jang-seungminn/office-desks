import { createOrcaRunner } from '../orcaCli.js';
import type { SessionVerifier } from '../sessionResolver.js';
import { DemoBackend } from './demo.js';
import { OrcaBackend } from './orca.js';
import type { OfficeBackend } from './types.js';

/** OFFICE_DESKS_BACKEND wins; OFFICE_DESKS_DEMO (set by `--demo`) means demo; otherwise Orca. */
export function createBackend(env: NodeJS.ProcessEnv, verify?: SessionVerifier): OfficeBackend {
  const kind = env.OFFICE_DESKS_BACKEND?.trim() || (env.OFFICE_DESKS_DEMO ? 'demo' : 'orca');
  if (kind === 'demo') return new DemoBackend(verify);
  if (kind === 'orca') return new OrcaBackend(createOrcaRunner(), verify);
  throw new Error(`Unknown OFFICE_DESKS_BACKEND "${kind}" (use orca or demo)`);
}
