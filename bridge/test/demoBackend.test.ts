import { describe, expect, it } from 'vitest';
import { DemoBackend } from '../src/backend/demo.js';

describe('DemoBackend', () => {
  it('only offers what the demo can fake', () => {
    expect(new DemoBackend().capabilities).toEqual({ usage: true, search: false, board: false, hire: false, changes: false, transcripts: false, focus: false, repos: false });
    expect(new DemoBackend().messages.hireDisabled).toBe('데모 모드에서는 만들 수 없어요');
  });

  it('fills model, effort, stats and change counts itself', async () => {
    const s = await new DemoBackend().snapshot();
    const p1 = s.desks.flatMap((d) => d.agents).find((a) => a.id === 'p1:leaf');
    expect(p1).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh', subagentsRunning: 2 });
    expect(p1?.stats?.instructions).toBeGreaterThan(0);
    const withAgents = s.desks.filter((d) => d.agents.length);
    expect(withAgents.every((d) => d.changes && d.changes.files > 0)).toBe(true);
    expect(s.desks.filter((d) => !d.agents.length).every((d) => d.changes === null)).toBe(true);
  });

  it('serves demo usage and a demo screen', async () => {
    const b = new DemoBackend();
    expect((await b.usage())?.providers[0].provider).toBe('claude');
    expect((await b.readScreen('demo_p1')).length).toBeGreaterThan(0);
  });
});
