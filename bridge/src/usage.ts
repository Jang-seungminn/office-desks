import type { OrcaRunner } from './orcaCli.js';
import type { UsageProvider, UsageSnapshot, UsageWindow } from './model.js';

// Plan usage limits as Orca shows them in its status bar, from `orca account list`.
// Only the rate-limit numbers are passed on; account emails and ids stay in the bridge.

const WINDOW_LABELS: Record<string, string> = {
  session: '5시간',
  weekly: '주간',
  monthly: '월간',
  fableWeekly: 'Fable 주간',
};

interface RawWindow {
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: number;
  resetDescription?: string;
}

function label(key: string, w: RawWindow): string {
  if (WINDOW_LABELS[key]) return WINDOW_LABELS[key];
  // Model-specific limits Orca may add later, e.g. "opusWeekly" → "Opus 주간".
  const m = /^([a-z]+)(Weekly|Monthly)$/.exec(key);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2] === 'Weekly' ? '주간' : '월간'}`;
  return w.windowMinutes ? `${Math.round(w.windowMinutes / 60)}시간` : key;
}

export function toUsage(rateLimits: Record<string, unknown> | undefined, now = Date.now()): UsageSnapshot {
  const providers: UsageProvider[] = [];
  for (const [key, raw] of Object.entries(rateLimits ?? {})) {
    const p = raw as Record<string, unknown> | null;
    if (!p || typeof p !== 'object' || p.status !== 'ok') continue;
    const windows: UsageWindow[] = [];
    for (const [wk, wv] of Object.entries(p)) {
      const w = wv as RawWindow | null;
      if (!w || typeof w !== 'object' || typeof w.usedPercent !== 'number') continue;
      windows.push({
        key: wk,
        label: label(wk, w),
        usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
        resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null,
        resetDescription: typeof w.resetDescription === 'string' ? w.resetDescription : null,
      });
    }
    // session first, then weekly, then the model-specific ones
    const order = (k: string) => (k === 'session' ? 0 : k === 'weekly' ? 1 : k === 'monthly' ? 2 : 3);
    windows.sort((a, b) => order(a.key) - order(b.key));
    if (windows.length) providers.push({ provider: String(p.provider ?? key), windows });
  }
  return { providers, updatedAt: now };
}

export async function fetchUsage(orca: OrcaRunner): Promise<UsageSnapshot> {
  const r = (await orca(['account', 'list'])) as { rateLimits?: Record<string, unknown> };
  return toUsage(r?.rateLimits);
}
