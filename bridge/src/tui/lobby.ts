import type { OfficeSnapshot } from '../model.js';

// The list's rows: every agent (and every empty worktree) as one row, grouped by project.

export interface LobbyRow {
  deskId: string;
  repoId: string;
  repo: string;
  desk: string;
  agentId: string | null;
  agentType: string | null;
  state: string | null;
  activity: string;
}

export function lobbyRows(s: OfficeSnapshot): LobbyRow[] {
  const desks = [...s.desks].sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
  return desks.flatMap((d) => {
    const base = { deskId: d.id, repoId: d.repoId, repo: d.repo || d.name, desk: d.name };
    if (!d.agents.length) return [{ ...base, agentId: null, agentType: null, state: null, activity: '(에이전트 없음)' } as LobbyRow];
    return d.agents.map((a) => ({ ...base, agentId: a.id, agentType: a.agentType, state: a.state, activity: a.activity } as LobbyRow));
  });
}
