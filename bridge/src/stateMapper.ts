import { normalizePr } from './gitInfo.js';
import type { CharacterState, OfficeAgent, OfficeDesk, OfficeSnapshot } from './model.js';

// Minimal shapes of the Orca CLI JSON we rely on. Everything is optional so a
// newer/older Orca that drops a field degrades instead of crashing.
export interface OrcaAgentRow {
  paneKey?: string;
  agentType?: string;
  state?: string;
  toolName?: string | null;
  toolInput?: string | null;
  prompt?: string | null;
  lastAssistantMessage?: string | null;
  stateStartedAt?: number | null;
}

export interface OrcaWorktreeRow {
  worktreeId?: string;
  repoId?: string;
  repo?: string;
  path?: string;
  branch?: string;
  displayName?: string;
  status?: string;
  workspaceStatus?: string | null;
  comment?: string;
  preview?: string;
  isActive?: boolean;
  isArchived?: boolean;
  unread?: boolean;
  lastActivityAt?: number;
  linkedPR?: unknown;
  isMainWorktree?: boolean;
  parentWorktreeId?: string | null;
  agents?: OrcaAgentRow[];
}

export interface OrcaTerminalRow {
  handle?: string;
  title?: string;
  tabId?: string;
  leafId?: string;
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch']);
const RUN_TOOLS = new Set(['Bash', 'BashOutput', 'Monitor']);

/** "✳ Fix login bug" → "Fix login bug"; drops spinner/status glyphs agents put in front. */
export function cleanTitle(title: string | undefined): string | null {
  const t = (title ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return t.length ? t : null;
}

function oneLine(s: string | null | undefined, max = 80): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function mapAgentState(rawState: string | undefined, toolName: string | null | undefined): CharacterState {
  switch (rawState) {
    case 'waiting':
    case 'permission':
    case 'blocked':
      return 'waiting';
    case 'done':
    case 'idle':
      return 'done';
    case 'working':
      if (toolName && READ_TOOLS.has(toolName)) return 'reading';
      if (toolName && RUN_TOOLS.has(toolName)) return 'running';
      return 'typing';
    default:
      return 'away';
  }
}

function describe(state: CharacterState, a: OrcaAgentRow): string {
  const tool = a.toolName ?? '';
  const input = oneLine(a.toolInput, 60);
  switch (state) {
    case 'waiting':
      return tool ? `확인 필요: ${tool}` : '확인 필요';
    case 'done':
      return '완료 · 다음 지시 대기';
    case 'away':
      return '자리 비움';
    default:
      if (!tool) return '생각 중…';
      return input ? `${tool}: ${input}` : tool;
  }
}

export function toSnapshot(
  worktrees: OrcaWorktreeRow[],
  terminals: OrcaTerminalRow[],
  now: number = Date.now(),
): OfficeSnapshot {
  const termByPane = new Map<string, OrcaTerminalRow>();
  for (const t of terminals) {
    if (t.handle && t.tabId && t.leafId) termByPane.set(`${t.tabId}:${t.leafId}`, t);
  }

  const desks: OfficeDesk[] = worktrees
    .filter((w) => w.worktreeId && !w.isArchived)
    .map((w) => {
      const agents: OfficeAgent[] = (w.agents ?? []).map((a, i) => {
        const id = a.paneKey ?? `${w.worktreeId}#${i}`;
        const raw = a.state ?? 'unknown';
        const state = mapAgentState(raw, a.toolName);
        const term = a.paneKey ? termByPane.get(a.paneKey) : undefined;
        return {
          id,
          terminalHandle: term?.handle ?? null,
          agentType: a.agentType ?? 'agent',
          terminalTitle: cleanTitle(term?.title),
          subagentsRunning: 0,
          model: null,
          effort: null,
          state,
          rawState: raw,
          activity: describe(state, a),
          prompt: a.prompt ?? null,
          lastMessage: a.lastAssistantMessage ?? null,
          since: a.stateStartedAt ?? null,
        };
      });
      const branch = (w.branch ?? '').replace(/^refs\/heads\//, '');
      // Orca defaults displayName to the branch; a repo name is more telling than "main" twice.
      const name = w.displayName && w.displayName !== branch ? w.displayName : w.repo || branch || 'worktree';
      return {
        id: w.worktreeId!,
        repoId: w.repoId ?? w.worktreeId!.split('::')[0],
        isMain: Boolean(w.isMainWorktree),
        parentId: w.parentWorktreeId ?? null,
        name,
        repo: w.repo ?? '',
        branch,
        path: w.path ?? '',
        status: w.status ?? 'unknown',
        workspaceStatus: w.workspaceStatus ?? null,
        comment: (w.comment ?? '').trim(), // a lone space is how a comment gets cleared (see /api/worktree)
        preview: oneLine(w.preview, 120),
        isActive: Boolean(w.isActive),
        unread: Boolean(w.unread),
        lastActivityAt: typeof w.lastActivityAt === 'number' ? w.lastActivityAt : null,
        changes: null,
        pr: normalizePr(w.linkedPR),
        agents,
      };
    })
    // Stable desk order regardless of Orca's activity-based sort, so desks don't shuffle around.
    .sort((a, b) => a.id.localeCompare(b.id));

  return { desks, updatedAt: now, error: null };
}
