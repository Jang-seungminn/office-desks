import type { HireSpec } from './backend/types.js';
import type { HireRequest, OfficeDesk } from './model.js';

// Validation for starting work from the UI. Names/branches can't start with '-', and only
// repos/worktrees the backend already reports qualify. The backend turns the spec into commands.

export const KNOWN_AGENTS = ['claude', 'codex', 'gemini', 'opencode', 'pi', 'omp', 'grok', 'cursor'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const MAX_PROMPT = 8000;

export function validateHire(body: HireRequest, desks: OfficeDesk[]): HireSpec | { error: string } {
  if (!KNOWN_AGENTS.includes(body.agent)) return { error: '지원하지 않는 에이전트입니다' };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length > MAX_PROMPT) return { error: '첫 지시가 너무 깁니다' };

  if (body.deskId !== undefined) {
    const desk = desks.find((d) => d.id === body.deskId);
    if (!desk) return { error: '알 수 없는 워크트리입니다' };
    return { kind: 'agent', deskId: desk.id, agent: body.agent, prompt: prompt || null };
  }

  const repo = desks.find((d) => d.repoId === body.repoId);
  if (!repo) return { error: '알 수 없는 프로젝트입니다' };
  if (!NAME.test(body.name ?? '')) return { error: '이름은 영문·숫자로 시작하고 영문·숫자·. _ - 만 쓸 수 있어요 (60자 이내)' };
  if (desks.some((d) => d.repoId === body.repoId && d.name === body.name)) return { error: '같은 이름의 워크트리가 이미 있어요' };
  if (body.baseBranch && !BRANCH.test(body.baseBranch)) return { error: '기준 브랜치 이름이 올바르지 않아요' };
  return { kind: 'worktree', repoId: repo.repoId, name: body.name!, agent: body.agent, baseBranch: body.baseBranch || null, prompt: prompt || null };
}
