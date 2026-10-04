import type { OfficeSnapshot } from './model.js';

/** With nobody watching, check rarely (each check spawns a CLI process). */
export const IDLE_INTERVAL_MS = 10_000;

/**
 * The backend has no event stream, so poll its snapshot and only notify listeners when the
 * office actually changed (updatedAt is ignored in the comparison).
 */
export class OfficePoller {
  private snapshot: OfficeSnapshot = { desks: [], updatedAt: 0, error: null };
  private lastKey = '';
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private listeners = new Set<(s: OfficeSnapshot) => void>();
  private idle = false;

  constructor(
    private readonly source: () => Promise<OfficeSnapshot>,
    private readonly intervalMs = 1500,
    /** Adds data the backend doesn't have (e.g. running subagents) before change detection. */
    private readonly enrich?: (s: OfficeSnapshot) => Promise<void>,
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
      next = await this.source();
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
}
