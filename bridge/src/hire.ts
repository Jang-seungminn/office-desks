import type { HireRequest, OfficeDesk } from './model.js';

// Validation and argv for starting work from the UI. Values only ever go in as --flag=value,
// names/branches can't start with '-', and only repos/worktrees Orca already reports qualify.

export const KNOWN_AGENTS = ['claude', 'codex', 'gemini', 'opencode', 'pi', 'omp', 'grok', 'cursor'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const MAX_PROMPT = 8000;

export type HirePlan = { kind: 'worktree' | 'agent'; args: string[]; promptAfter: string | null } | { error: string };

export function planHire(body: HireRequest, desks: OfficeDesk[]): HirePlan {
  if (!KNOWN_AGENTS.includes(body.agent)) return { error: '지원하지 않는 에이전트입니다' };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length > MAX_PROMPT) return { error: '첫 지시가 너무 깁니다' };

  if (body.deskId !== undefined) {
    const desk = desks.find((d) => d.id === body.deskId);
    if (!desk) return { error: '알 수 없는 워크트리입니다' };
    // A new terminal running the agent; the first prompt is sent once its TUI is ready.
    return {
      kind: 'agent',
      args: ['terminal', 'create', `--worktree=id:${desk.id}`, `--command=${body.agent}`, `--title=${body.agent}`],
      promptAfter: prompt || null,
    };
  }

  const repo = desks.find((d) => d.repoId === body.repoId);
  if (!repo) return { error: '알 수 없는 프로젝트입니다' };
  if (!NAME.test(body.name ?? '')) return { error: '이름은 영문·숫자로 시작하고 영문·숫자·. _ - 만 쓸 수 있어요 (60자 이내)' };
  if (desks.some((d) => d.repoId === body.repoId && d.name === body.name)) return { error: '같은 이름의 워크트리가 이미 있어요' };
  if (body.baseBranch && !BRANCH.test(body.baseBranch)) return { error: '기준 브랜치 이름이 올바르지 않아요' };
  const args = ['worktree', 'create', `--repo=id:${repo.repoId}`, `--name=${body.name}`, '--no-parent', `--agent=${body.agent}`];
  if (body.baseBranch) args.push(`--base-branch=${body.baseBranch}`);
  if (prompt) args.push(`--prompt=${prompt}`);
  return { kind: 'worktree', args, promptAfter: null };
}
