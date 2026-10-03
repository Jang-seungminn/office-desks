import type { OfficeSnapshot } from './model.js';
import type { OrcaRunner } from './orcaCli.js';
import { toSnapshot, type OrcaTerminalRow, type OrcaWorktreeRow } from './stateMapper.js';

/** Terminal rows only change when terminals open/close or retitle: refresh them sparingly. */
const TERMINALS_MAX_AGE_MS = 15_000;
/** With nobody watching, check Orca rarely (each check spawns a CLI process). */
export const IDLE_INTERVAL_MS = 10_000;

/**
 * Orca has no event stream, so poll `worktree ps` (+ `terminal list` when needed) and only
 * notify listeners when the office actually changed (updatedAt is ignored in the comparison).
 */
export class OfficePoller {
  private snapshot: OfficeSnapshot = { desks: [], updatedAt: 0, error: null };
  private lastKey = '';
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private listeners = new Set<(s: OfficeSnapshot) => void>();
  private terminals: { rows: OrcaTerminalRow[]; at: number } | null = null;
  private idle = false;

  constructor(
    private readonly orca: OrcaRunner,
    private readonly intervalMs = 1500,
    /** Adds data Orca doesn't have (e.g. running subagents) before change detection. */
    private readonly enrich?: (s: OfficeSnapshot) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Slow down while no browser is connected; speed up (and refresh at once) when one is. */
  setIdle(idle: boolean): void {
    if (idle === this.idle) return;
    this.idle = idle;
    if (!idle && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.start();
    }
  }

  get current(): OfficeSnapshot {
    return this.snapshot;
  }

  onChange(fn: (s: OfficeSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    const loop = async () => {
      await this.refresh();
      this.timer = setTimeout(loop, this.idle ? IDLE_INTERVAL_MS : this.intervalMs);
    };
    void loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Poll now; concurrent callers share the in-flight poll. */
  refresh(): Promise<void> {
    this.inFlight ??= this.poll().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async poll(): Promise<void> {
    let next: OfficeSnapshot;
    try {
      const ps = (await this.orca(['worktree', 'ps'])) as { worktrees?: OrcaWorktreeRow[] };
      const worktrees = ps?.worktrees ?? [];
      next = toSnapshot(worktrees, await this.terminalRows(worktrees));
      if (this.enrich) await this.enrich(next).catch(() => undefined);
    } catch (err) {
      // Keep the last known office on screen and surface the error.
      next = { ...this.snapshot, updatedAt: Date.now(), error: (err as Error).message };
    }
    const key = JSON.stringify({ desks: next.desks, error: next.error });
    this.snapshot = next;
    if (key !== this.lastKey) {
      this.lastKey = key;
      for (const fn of this.listeners) fn(next);
    }
  }

  /** Cached `terminal list`, refreshed when stale or when an agent shows up in a pane we don't know. */
  private async terminalRows(worktrees: OrcaWorktreeRow[]): Promise<OrcaTerminalRow[]> {
    const known = new Set((this.terminals?.rows ?? []).map((t) => `${t.tabId}:${t.leafId}`));
    const unknownPane = worktrees.some((w) => (w.agents ?? []).some((a) => a.paneKey && !known.has(a.paneKey)));
    const stale = !this.terminals || this.now() - this.terminals.at > TERMINALS_MAX_AGE_MS;
    if (stale || unknownPane) {
      const r = (await this.orca(['terminal', 'list'])) as { terminals?: OrcaTerminalRow[] };
      this.terminals = { rows: r?.terminals ?? [], at: this.now() };
    }
    return this.terminals!.rows;
  }
}
