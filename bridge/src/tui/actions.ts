import type { HireResult, HireSpec } from '../backend/types.js';
import { validateHire } from '../hire.js';
import type { OfficeSnapshot } from '../model.js';
import type { LobbyRow } from './lobby.js';
import { Form } from './prompt.js';

// What the list's forms and confirmations do: the questions they ask and the backend calls they
// make. Each returns the notice to show; a thrown error becomes a ⚠️ notice in the App.

export type FormKind = 'repo' | 'agent' | 'work';
export type ConfirmKind = 'quit' | 'stop' | 'remove';

export interface ActionDeps {
  snapshot(): OfficeSnapshot;
  hire(spec: HireSpec): Promise<HireResult>;
  addRepo(path: string): Promise<void>;
  stopAgent(agentId: string): Promise<void>;
  removeWorktree(deskId: string): Promise<void>;
}

const AGENT_FIELD = { label: '에이전트 (claude/codex/gemini)', initial: 'claude' };
const PROMPT_FIELD = { label: '첫 지시 (선택)', optional: true };
const FORMS: Record<FormKind, (row: LobbyRow | null) => Form> = {
  repo: () => new Form([{ label: 'git 저장소 경로' }]),
  agent: () => new Form([AGENT_FIELD, PROMPT_FIELD]),
  work: (row) => new Form([{ label: `새 워크트리 이름 (${row?.repo ?? ''})` }, AGENT_FIELD, PROMPT_FIELD]),
};
const BUSY: Record<FormKind | ConfirmKind, string> = {
  repo: '추가하는 중…',
  agent: '만드는 중…',
  work: '만드는 중…',
  quit: '',
  stop: '종료하는 중…',
  remove: '지우는 중…',
};

export function newForm(kind: FormKind, row: LobbyRow | null): Form {
  return FORMS[kind](row);
}

export function busyNotice(kind: FormKind | ConfirmKind): string {
  return BUSY[kind];
}

export async function submitForm(deps: ActionDeps, kind: FormKind, v: string[], row: LobbyRow | null): Promise<string> {
  if (kind === 'repo') {
    await deps.addRepo(v[0]);
    return '프로젝트를 추가했어요';
  }
  const spec = validateHire(
    kind === 'agent' ? { deskId: row?.deskId, agent: v[0], prompt: v[1] } : { repoId: row?.repoId, name: v[0], agent: v[1], prompt: v[2] },
    deps.snapshot().desks,
  );
  if ('error' in spec) throw new Error(spec.error);
  const res = await deps.hire(spec);
  return res.warning ?? '에이전트를 띄웠어요';
}

export function confirmQuestion(kind: ConfirmKind, row: LobbyRow | null, rows: LobbyRow[]): string {
  if (kind === 'stop') return `에이전트를 종료할까요? ${row?.repo}/${row?.desk} · ${row?.agentType ?? '?'} (y/N)`;
  if (kind === 'remove') return `워크트리를 지울까요? ${row?.desk} (브랜치는 남아요) (y/N)`;
  return `에이전트 ${rows.filter((r) => r.agentId).length}개가 함께 종료됩니다. 종료할까요? (y/N)`;
}

/** Stop an agent or remove a worktree (quit is the App's own business). */
export async function runConfirmed(deps: ActionDeps, kind: 'stop' | 'remove', row: LobbyRow): Promise<string> {
  if (kind === 'stop') {
    await deps.stopAgent(row.agentId!);
    return '에이전트를 종료했어요';
  }
  await deps.removeWorktree(row.deskId);
  return '워크트리를 지웠어요';
}
