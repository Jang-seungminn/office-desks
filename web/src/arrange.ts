import type { OfficeDesk } from '../../bridge/src/model';

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
  key: ZoneKey;
  label: string;
  /** Pixel icon drawn before the label (see sprites.ts). */
  icon: string;
  rooms: Room[];
  count: number;
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
