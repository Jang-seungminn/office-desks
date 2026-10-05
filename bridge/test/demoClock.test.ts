import { afterEach, describe, expect, it, vi } from 'vitest';
import { scratch } from './scratch.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('demo clock (OFFICE_DESKS_DEMO_EPOCH)', () => {
  it('freezes the demo office at the given epoch', async () => {
    vi.stubEnv('OFFICE_DESKS_DEMO_EPOCH', '1790856000000');
    // The demo writes its transcripts under os.tmpdir(): keep them in a scratch folder.
    const tmp = scratch('od-demo-clock-');
    vi.stubEnv('TMPDIR', tmp);
    vi.stubEnv('TMP', tmp);
    vi.stubEnv('TEMP', tmp);
    vi.resetModules();
    const { DemoBackend } = await import('../src/backend/demo.js');
    const b = new DemoBackend();
    const first = await b.snapshot();
    await new Promise((r) => setTimeout(r, 20));
    const second = await b.snapshot();
    expect(second.desks).toEqual(first.desks);
    const p1 = first.desks.flatMap((d) => d.agents).find((a) => a.id === 'p1:leaf');
    expect(p1?.stats?.hiredAt).toBe('2026-08-22T12:00:00.000Z');
  });
});
