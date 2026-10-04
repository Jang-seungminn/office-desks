import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Award, AwardBoard, OfficeDesk } from './model.js';
import { officeHome } from './home.js';

// Employee of the day: whoever did the most work today (instructions handled weigh 10, each
// tool call 1). The leader is tracked through the day; when the date changes it goes into the
// hall of fame. Kept in a small file so restarts don't lose it.

const HALL_MAX = 90;

export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function awardsFile(home?: string): string {
  return home ? path.join(home, '.office-desks', 'awards.json') : path.join(officeHome(), 'awards.json');
}

/** Today's best candidate among the agents in the office (none if nobody worked today). */
export function bestToday(desks: OfficeDesk[], date: string): Award | null {
  let best: Award | null = null;
  for (const desk of desks) {
    for (const a of desk.agents) {
      const s = a.stats;
      if (!s || s.instructionsToday === 0) continue;
      const score = s.instructionsToday * 10 + s.toolCallsToday;
      if (best && score <= best.score) continue;
      best = {
        date,
        agentId: a.id,
        deskId: desk.id,
        name: a.terminalTitle ?? desk.name,
        repo: desk.repo || desk.name,
        repoId: desk.repoId,
        agentType: a.agentType,
        instructions: s.instructionsToday,
        toolCalls: s.toolCallsToday,
        score,
      };
    }
  }
  return best;
}

export class AwardBook {
  private board: AwardBoard = { leader: null, hall: [] };
  private loaded = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<AwardBoard>;
      this.board = { leader: raw.leader ?? null, hall: Array.isArray(raw.hall) ? raw.hall.slice(0, HALL_MAX) : [] };
    } catch {
      /* first run */
    }
    this.loaded = true;
  }

  get current(): AwardBoard {
    return this.board;
  }

  /**
   * Fold in the office as it is now. Returns true when the board changed (worth saving and
   * broadcasting). A leader from an earlier day is crowned into the hall first.
   */
  update(desks: OfficeDesk[], now = new Date()): boolean {
    if (!this.loaded) return false;
    const date = localDate(now);
    let changed = false;
    const leader = this.board.leader;
    if (leader && leader.date !== date) {
      if (!this.board.hall.some((h) => h.date === leader.date)) this.board.hall = [leader, ...this.board.hall].slice(0, HALL_MAX);
      this.board.leader = null;
      changed = true;
    }
    const best = bestToday(desks, date);
    const cur = this.board.leader;
    // The leader only gets replaced by a higher score (agents that close don't lose their lead),
    // or refreshed when the same agent keeps working.
    if (best && (!cur || best.score > cur.score || (best.agentId === cur.agentId && best.score !== cur.score))) {
      this.board.leader = best;
      changed = true;
    }
    return changed;
  }

  async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const body = JSON.stringify(this.board, null, 2);
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    try {
      await rename(tmp, this.file);
    } catch {
      await writeFile(this.file, body, { mode: 0o600 });
      await rm(tmp, { force: true });
    }
  }
}
