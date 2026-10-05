import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveWindowsCommand } from '../orcaCli.js';

// The environment a spawned agent gets. If the bridge itself runs inside Claude Code or Orca,
// their per-session markers must not leak: a child that inherits CLAUDE_CODE_CHILD_SESSION
// stops saving its transcript, and ORCA_* would route its hooks into Orca. User settings such
// as CLAUDE_CODE_USE_BEDROCK or CLAUDE_CODE_OAUTH_TOKEN must pass through untouched.

const SESSION_MARKERS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
]);

function dropped(key: string, value: string): boolean {
  if (SESSION_MARKERS.has(key) || key.startsWith('CLAUDE_CODE_MESSAGING_') || key.startsWith('ORCA_')) return true;
  // Orca points Codex at its own runtime home; a user's own CODEX_HOME stays.
  return key === 'CODEX_HOME' && /codex-runtime-home/.test(value);
}

export function agentEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !dropped(k, v)) env[k] = v;
  return { ...env, ...extra };
}

/**
 * Where `cmd` would run from on the agent's PATH, or null. node-pty doesn't fail a spawn for a
 * missing command on macOS (the child just exits 1), so we look first.
 */
export function findCommand(cmd: string, env: Record<string, string>, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') {
    const r = resolveWindowsCommand(cmd, env);
    return path.win32.isAbsolute(r.file) && existsSync(r.file) ? r.file : null;
  }
  const dirs = cmd.includes('/') ? [''] : (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const f = d ? path.join(d, cmd) : cmd;
    try {
      accessSync(f, constants.X_OK);
      if (statSync(f).isFile()) return f;
    } catch {
      /* not here */
    }
  }
  return null;
}
