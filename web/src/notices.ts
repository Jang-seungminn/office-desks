import type { OfficeSnapshot } from '../../bridge/src/model';

// "You have a report": an agent finished its turn or needs you, and you haven't opened it in
// this UI since. Read state lives in this browser (localStorage) — a per-viewer convenience.
// Orca's own unread flag also counts, until you open the agent here.

export type AttentionKind = 'done' | 'waiting';

export interface Attention {
  agentId: string;
  deskId: string;
  kind: AttentionKind;
}

interface Stored {
  /** When this browser first ran the office: older reports don't count as new. */
  initAt: number;
  seen: Record<string, number>;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'office-desks:seen';
const ACTIVE = new Set(['typing', 'reading', 'running']);

export class Notices {
  private data: Stored;
  /** First time we saw Orca's unread flag on for a desk (cleared when Orca clears it). */
  private unreadSince = new Map<string, number>();
  private lastStates = new Map<string, string>();

  constructor(
    private readonly store: KeyValueStore | null,
    private readonly now: () => number = Date.now,
  ) {
    let parsed: Stored | null = null;
    try {
      parsed = JSON.parse(store?.getItem(KEY) ?? 'null');
    } catch {
      parsed = null;
    }
    this.data = parsed && typeof parsed.initAt === 'number' && parsed.seen ? parsed : { initAt: now(), seen: {} };
    this.save();
  }

  private save(): void {
    try {
      // Keep the record small: forget the oldest entries.
      const entries = Object.entries(this.data.seen).sort((a, b) => b[1] - a[1]).slice(0, 300);
      this.data.seen = Object.fromEntries(entries);
      this.store?.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* private mode / blocked storage: read state just won't survive a reload */
    }
  }

  markSeen(agentId: string): void {
    this.data.seen[agentId] = this.now();
    this.save();
  }

  /** Agents with a report you haven't opened yet. */
  attention(snapshot: OfficeSnapshot): Attention[] {
    const out: Attention[] = [];
    for (const desk of snapshot.desks) {
      if (desk.unread && !this.unreadSince.has(desk.id)) this.unreadSince.set(desk.id, this.now());
      if (!desk.unread) this.unreadSince.delete(desk.id);
      for (const a of desk.agents) {
        const seen = Math.max(this.data.seen[a.id] ?? 0, this.data.initAt);
        const fresh = (a.state === 'done' || a.state === 'waiting') && (a.since ?? 0) > seen;
        const orcaUnread = (this.unreadSince.get(desk.id) ?? 0) > (this.data.seen[a.id] ?? 0);
        if (fresh || orcaUnread) out.push({ agentId: a.id, deskId: desk.id, kind: a.state === 'waiting' ? 'waiting' : 'done' });
      }
    }
    return out;
  }

  /** Agents that just stopped working (finished or now waiting on you) since the last snapshot. */
  transitions(snapshot: OfficeSnapshot): Attention[] {
    const out: Attention[] = [];
    const next = new Map<string, string>();
    for (const desk of snapshot.desks) {
      for (const a of desk.agents) {
        next.set(a.id, a.state);
        const prev = this.lastStates.get(a.id);
        const stopped = (a.state === 'done' && prev !== undefined && ACTIVE.has(prev)) || (a.state === 'waiting' && prev !== undefined && prev !== 'waiting');
        if (stopped) out.push({ agentId: a.id, deskId: desk.id, kind: a.state === 'waiting' ? 'waiting' : 'done' });
      }
    }
    this.lastStates = next;
    return out;
  }
}
