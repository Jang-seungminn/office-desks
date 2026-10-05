import os from 'node:os';
import path from 'node:path';

/** Where Office Desks keeps its files. OFFICE_DESKS_HOME lets tests and trials use a fresh one. */
export function officeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OFFICE_DESKS_HOME?.trim() || path.join(os.homedir(), '.office-desks');
}
