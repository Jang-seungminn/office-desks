import type { Department, OfficeDesk, OrgChart } from '../../bridge/src/model';

// How the office is laid out: three floors by what the worktree is doing, newest on the left.
//   working — some agent is typing/reading/running, or has a report you haven't opened yet
//   waiting — agents present but idle and already looked at
//   idle    — no agent at all
// Inside a floor, worktrees of the same repo share a room. "Newest" uses the time the agent
// entered its current state, not its last output, so desks don't reshuffle on every keystroke.

export type ZoneKey = 'working' | 'waiting' | 'idle';

export interface Room {
  repoId: string;
  repo: string;
  desks: OfficeDesk[];
  /** Worktrees this repo has across all floors. */
  total: number;
}

export interface Zone {
  /** A status floor, or `dept:<id>` / `dept:none` when the office is organised by department. */
  key: ZoneKey | `dept:${string}`;
  label: string;
  /** Pixel icon drawn before the label (see sprites.ts). */
  icon: string;
  rooms: Room[];
  count: number;
  /** Department floors only: interior theme and a status tally for the sign. */
  theme?: Department['theme'] | 'none';
  tally?: { working: number; waiting: number; resting: number };
}

const ACTIVE = new Set(['typing', 'reading', 'running']);
const ZONES: [ZoneKey, string, string][] = [
  ['working', '작업 중 · 새 보고', 'fire'],
  ['waiting', '대기', 'cup'],
  ['idle', '휴면', 'zzz'],
];

const NONE: ReadonlySet<string> = new Set();

/** `unseen`: agents with a finished/waiting report not yet opened — they stay on the top floor. */
export function zoneOf(desk: OfficeDesk, unseen: ReadonlySet<string> = NONE): ZoneKey {
  if (desk.agents.some((a) => ACTIVE.has(a.state) || unseen.has(a.id))) return 'working';
  return desk.agents.length ? 'waiting' : 'idle';
}

export function recency(desk: OfficeDesk, unseen: ReadonlySet<string> = NONE): number {
  const zone = zoneOf(desk, unseen);
  const relevant = zone === 'working' ? desk.agents.filter((a) => ACTIVE.has(a.state) || unseen.has(a.id)) : desk.agents;
  const since = Math.max(0, ...relevant.map((a) => a.since ?? 0));
  return since || desk.lastActivityAt || 0;
}

export function arrangeOffice(desks: OfficeDesk[], unseen: ReadonlySet<string> = NONE): Zone[] {
  const totals = new Map<string, number>();
  for (const d of desks) totals.set(d.repoId, (totals.get(d.repoId) ?? 0) + 1);

  return ZONES.map(([key, label, icon]) => {
    const here = desks
      .filter((d) => zoneOf(d, unseen) === key)
      .sort((a, b) => recency(b, unseen) - recency(a, unseen) || a.name.localeCompare(b.name));
    const rooms = new Map<string, Room>();
    for (const d of here) {
      const room = rooms.get(d.repoId) ?? { repoId: d.repoId, repo: d.repo || d.name, desks: [], total: totals.get(d.repoId) ?? 1 };
      room.desks.push(d);
      rooms.set(d.repoId, room);
    }
    // Rooms keep the order of their newest desk (Map keeps insertion order).
    return { key, label, icon, rooms: [...rooms.values()], count: here.length };
  }).filter((z) => z.count > 0);
}

/** Fixed seat order inside a repo: main checkout first, then by name (never by activity). */
function bySeat(a: OfficeDesk, b: OfficeDesk): number {
  return Number(b.isMain) - Number(a.isMain) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function tally(desks: OfficeDesk[]): NonNullable<Zone['tally']> {
  const agents = desks.flatMap((d) => d.agents);
  return {
    working: agents.filter((a) => ACTIVE.has(a.state)).length,
    waiting: agents.filter((a) => a.state === 'waiting').length,
    resting: agents.filter((a) => a.state === 'done' || a.state === 'away').length,
  };
}

/**
 * The office organised by the user's departments: one floor per department in their order,
 * projects in the order they were assigned, and projects nobody assigned on a last "미배정" floor.
 * Seats never move with status; status shows on the characters and the department sign.
 */
export function arrangeOrg(desks: OfficeDesk[], org: OrgChart): Zone[] {
  const byRepo = new Map<string, OfficeDesk[]>();
  for (const d of desks) byRepo.set(d.repoId, [...(byRepo.get(d.repoId) ?? []), d]);
  const roomOf = (repoId: string): Room | null => {
    const here = byRepo.get(repoId);
    if (!here) return null; // assigned, but Orca no longer has it
    const sorted = [...here].sort(bySeat);
    return { repoId, repo: sorted[0].repo || sorted[0].name, desks: sorted, total: sorted.length };
  };
  const assigned = new Set<string>();
  const zones: Zone[] = org.departments.map((dept) => {
    const rooms = dept.repoIds.filter((r) => !assigned.has(r) && assigned.add(r)).map(roomOf).filter((r): r is Room => r !== null);
    const here = rooms.flatMap((r) => r.desks);
    return { key: `dept:${dept.id}`, label: dept.name, icon: THEME_ICON[dept.theme], rooms, count: here.length, theme: dept.theme, tally: tally(here) };
  });
  const rest = [...byRepo.keys()]
    .filter((r) => !assigned.has(r))
    .map(roomOf)
    .filter((r): r is Room => r !== null)
    .sort((a, b) => a.repo.localeCompare(b.repo));
  if (rest.length) {
    const here = rest.flatMap((r) => r.desks);
    zones.push({ key: 'dept:none', label: '미배정', icon: 'folder', rooms: rest, count: here.length, theme: 'none', tally: tally(here) });
  }
  return zones;
}

export const THEME_ICON: Record<Department['theme'], string> = {
  dev: 'chip',
  design: 'brush',
  research: 'flask',
  ops: 'gear',
  etc: 'star',
};

export const THEME_LABEL: Record<Department['theme'], string> = {
  dev: '개발',
  design: '디자인·기획',
  research: '연구',
  ops: '운영·인프라',
  etc: '기타',
};

/** Whichever layout is in effect: departments once any exist, status floors before that. */
export function arrange(desks: OfficeDesk[], org: OrgChart | null, unseen: ReadonlySet<string> = NONE): Zone[] {
  return org?.departments.length ? arrangeOrg(desks, org) : arrangeOffice(desks, unseen);
}
