import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SubagentInfo } from './model.js';
import type { SubagentCall } from './transcript.js';

// Claude Code writes each subagent's conversation next to the session transcript:
//   <dir>/<session>.jsonl
//   <dir>/<session>/subagents/agent-<id>.jsonl   (+ agent-<id>.meta.json with the toolUseId)

export function subagentDir(transcriptPath: string): string {
  return path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents');
}

/** toolUseId → agentId, from the meta files. */
export async function subagentIds(transcriptPath: string): Promise<Map<string, string>> {
  const dir = subagentDir(transcriptPath);
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  await Promise.all(
    names.map(async (n) => {
      const m = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/.exec(n);
      if (!m) return;
      try {
        const meta = JSON.parse(await readFile(path.join(dir, n), 'utf8')) as { toolUseId?: string };
        if (meta.toolUseId) out.set(meta.toolUseId, m[1]);
      } catch {
        /* half-written meta: pick it up next time */
      }
    }),
  );
  return out;
}

export function subagentInfos(calls: SubagentCall[], ids: Map<string, string>): SubagentInfo[] {
  return calls.map((c) => ({ ...c, agentId: ids.get(c.toolUseId) ?? null }));
}

/** Transcript file for one subagent; the id is validated so it can't escape the folder. */
export function subagentFile(transcriptPath: string, agentId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) return null;
  return path.join(subagentDir(transcriptPath), `agent-${agentId}.jsonl`);
}
