import type { CharacterState, OfficeAgent, OfficeDesk, OfficeSnapshot } from '../../bridge/src/model';

export const STATE_LABEL: Record<CharacterState, string> = {
  typing: '⌨️ 작업 중',
  reading: '🔎 읽는 중',
  running: '▶️ 명령 실행 중',
  waiting: '🙋 확인 필요',
  done: '☕ 완료 · 대기',
  away: '💤 자리 비움',
};

export interface Project { repoId: string; name: string; desks: OfficeDesk[] }

const ko = (a: string, b: string): number => a.localeCompare(b, 'ko');

export function projects(s: OfficeSnapshot | null): Project[] {
  if (!s) return [];
  const groups = new Map<string, OfficeDesk[]>();
  for (const d of s.desks) {
    const g = groups.get(d.repoId);
    if (g) g.push(d);
    else groups.set(d.repoId, [d]);
  }
  const out: Project[] = [];
  for (const [repoId, desks] of groups) {
    const main = desks.find((d) => d.isMain);
    const sorted = [...desks].sort((a, b) => (a.isMain === b.isMain ? ko(a.name, b.name) : a.isMain ? -1 : 1));
    out.push({ repoId, name: (main ?? desks[0]).repo, desks: sorted });
  }
  return out.sort((a, b) => ko(a.name, b.name));
}

export function tabTitle(desk: OfficeDesk, agent: OfficeAgent): string {
  return `${desk.name} · ${agent.agentType}`;
}
