import { describe, expect, it } from 'vitest';
import { toUsage } from '../src/usage.js';

describe('toUsage', () => {
  it('keeps ok providers with their windows in Orca order and drops everything else', () => {
    const u = toUsage(
      {
        claude: {
          provider: 'claude',
          status: 'ok',
          fableWeekly: { usedPercent: 9, windowMinutes: 10080, resetsAt: 2, resetDescription: 'Fri 3:59 AM' },
          weekly: { usedPercent: 21, windowMinutes: 10080, resetsAt: 2, resetDescription: 'Fri 3:59 AM' },
          session: { usedPercent: 80, windowMinutes: 300, resetsAt: 1, resetDescription: '3:39 PM' },
          usageMetadata: { source: 'oauth' },
        },
        codex: { provider: 'codex', status: 'unavailable', session: null, error: 'Codex CLI not found' },
        minimaxCookieConfigured: false,
      },
      5,
    );
    expect(u.updatedAt).toBe(5);
    expect(u.providers).toHaveLength(1);
    expect(u.providers[0].windows.map((w) => [w.label, w.usedPercent, w.resetDescription])).toEqual([
      ['5시간', 80, '3:39 PM'],
      ['주간', 21, 'Fri 3:59 AM'],
      ['Fable 주간', 9, 'Fri 3:59 AM'],
    ]);
    expect(JSON.stringify(u)).not.toContain('oauth');
  });

  it('labels model-specific windows it has not seen before', () => {
    const u = toUsage({ claude: { provider: 'claude', status: 'ok', opusWeekly: { usedPercent: 120, windowMinutes: 10080 } } });
    expect(u.providers[0].windows[0]).toMatchObject({ label: 'Opus 주간', usedPercent: 100 });
  });
});
