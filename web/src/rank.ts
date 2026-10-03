import type { AgentStats } from '../../bridge/src/model';

// Job titles for the office tycoon: an agent climbs the ladder with the instructions it handles.

const LADDER: [min: number, title: string][] = [
  [0, '인턴'],
  [5, '사원'],
  [20, '주임'],
  [50, '대리'],
  [100, '과장'],
  [200, '차장'],
  [400, '부장'],
  [800, '이사'],
];

export interface Rank {
  title: string;
  /** Instructions needed for the next title, null at the top. */
  next: number | null;
  nextTitle: string | null;
  /** 0–1 progress toward the next title. */
  progress: number;
}

export function rankOf(stats: AgentStats | null): Rank | null {
  if (!stats) return null;
  const n = stats.instructions;
  let i = 0;
  while (i + 1 < LADDER.length && n >= LADDER[i + 1][0]) i++;
  const [min, title] = LADDER[i];
  const next = LADDER[i + 1]?.[0] ?? null;
  return { title, next, nextTitle: LADDER[i + 1]?.[1] ?? null, progress: next === null ? 1 : (n - min) / (next - min) };
}

/** "오늘 입사" / "3일차" from the session start. */
export function tenure(hiredAt: string | null, now = new Date()): string | null {
  if (!hiredAt) return null;
  const start = new Date(hiredAt);
  if (Number.isNaN(start.getTime())) return null;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(start)) / 86_400_000);
  return days <= 0 ? '오늘 입사' : `${days + 1}일차`;
}
