import type { OfficeAgent, OfficeDesk, OfficeSnapshot } from '../../bridge/src/model';
import { addRepo, ApiError, hire, removeWorktree, stopAgent } from './api';
import { pickFolder } from './host';
import { agentModal, confirmModal, toast, workModal } from './modal';
import { projects, tabTitle } from './tree';

/** Wired by main.ts (Task 7 supplies the real opener). */
export const hooks: {
  openAgent: (desk: OfficeDesk, agent: OfficeAgent) => void;
  snapshot: () => OfficeSnapshot | null;
} = { openAgent: () => {}, snapshot: () => null };

const PENDING_TTL = 30_000;
// One slot: a newer flow replaces the older one explicitly.
type Pending =
  | { kind: 'work'; repoId: string; name: string; at: number; seen: boolean }
  | { kind: 'agent'; deskId: string; known: Set<string>; at: number };
let pending: Pending | null = null;
const inflight = new Set<string>();

async function guarded(key: string, fn: () => Promise<void>): Promise<void> {
  if (inflight.has(key)) return;
  inflight.add(key);
  try {
    await fn();
  } finally {
    inflight.delete(key);
  }
}

const HAS_AGENTS = '먼저 에이전트를 ⏹ 중지해 주세요 (실행 중인 에이전트가 있어요)';

function fail(e: unknown): void {
  const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
  toast('⚠️ ' + msg, 'error');
}

/** Called on each snapshot: opens the agent that a hire flow is waiting for. */
export function onSnapshot(s: OfficeSnapshot): void {
  const p = pending;
  if (!p) return;
  if (Date.now() - p.at > PENDING_TTL) {
    pending = null;
    return;
  }
  if (p.kind === 'work') {
    const d = s.desks.find((x) => x.repoId === p.repoId && x.name === p.name);
    if (!d) {
      if (p.seen) pending = null; // it appeared and vanished again
      return;
    }
    p.seen = true;
    if (d.agents.length > 0) {
      pending = null;
      hooks.openAgent(d, d.agents[0]);
    }
  } else {
    const d = s.desks.find((x) => x.id === p.deskId);
    if (!d) {
      pending = null;
      return;
    }
    const a = d.agents.find((x) => !p.known.has(x.id));
    if (a) {
      pending = null;
      hooks.openAgent(d, a);
    }
  }
}

export async function addProjectFlow(): Promise<void> {
  try {
    const path = await pickFolder();
    if (path === null) return;
    await addRepo(path);
    toast('✅ 프로젝트를 추가했어요');
  } catch (e) {
    fail(e);
  }
}

export function newWorkFlow(repoId: string): Promise<void> {
  return guarded(`work:${repoId}`, () => newWork(repoId));
}
async function newWork(repoId: string): Promise<void> {
  const p = projects(hooks.snapshot()).find((x) => x.repoId === repoId);
  const v = await workModal(p?.name ?? repoId);
  if (!v) return;
  try {
    const r = await hire({ agent: v.agent, repoId, name: v.name, baseBranch: v.baseBranch || undefined, prompt: v.prompt || undefined });
    toast('✅ 만들었어요. 에이전트가 자리에 앉는 중…');
    if (r.warning) toast(r.warning);
    pending = { kind: 'work', repoId, name: v.name, at: Date.now(), seen: false };
    const s = hooks.snapshot();
    if (s) onSnapshot(s);
  } catch (e) {
    pending = null;
    fail(e);
  }
}

export function addAgentFlow(desk: OfficeDesk): Promise<void> {
  return guarded(`agent:${desk.id}`, () => addAgent(desk));
}
async function addAgent(desk: OfficeDesk): Promise<void> {
  const v = await agentModal(desk.name);
  if (!v) return;
  const known = new Set(
    (hooks.snapshot()?.desks.find((d) => d.id === desk.id) ?? desk).agents.map((a) => a.id),
  );
  try {
    const r = await hire({ agent: v.agent, deskId: desk.id, prompt: v.prompt || undefined });
    toast('✅ 에이전트를 불렀어요');
    if (r.warning) toast(r.warning);
    pending = { kind: 'agent', deskId: desk.id, known, at: Date.now() };
  } catch (e) {
    pending = null;
    fail(e);
  }
}

export function stopFlow(desk: OfficeDesk, agent: OfficeAgent): Promise<void> {
  return guarded(`stop:${agent.id}`, () => stop(desk, agent));
}
async function stop(desk: OfficeDesk, agent: OfficeAgent): Promise<void> {
  const ok = await confirmModal({
    title: '에이전트를 멈출까요?',
    body: `${tabTitle(desk, agent)} 에이전트를 종료합니다. 터미널이 닫히고 하던 일은 멈춰요.`,
    confirm: '⏹ 중지',
    danger: true,
  });
  if (!ok) return;
  try {
    await stopAgent(agent.id);
  } catch (e) {
    fail(e);
  }
}

export function removeFlow(desk: OfficeDesk): Promise<void> {
  return guarded(`rm:${desk.id}`, () => remove(desk));
}
async function remove(desk: OfficeDesk): Promise<void> {
  const ok = await confirmModal({
    title: '워크트리를 지울까요?',
    body: `‘${desk.name}’ 폴더를 지웁니다 (브랜치 ${desk.branch}는 남아요). 변경사항이 있으면 지우지 않아요.`,
    confirm: '🗑 지우기',
    danger: true,
  });
  if (!ok) return;
  try {
    await removeWorktree(desk.id);
    toast('🗑 워크트리를 지웠어요');
  } catch (e) {
    if (e instanceof ApiError && e.code === 'has_agents') toast('⚠️ ' + HAS_AGENTS, 'error');
    else fail(e);
  }
}
