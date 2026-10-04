import { describe, expect, it } from 'vitest';
import type { OfficeSnapshot } from '../src/model.js';
import { OfficePoller } from '../src/poller.js';

const office = (n: number): OfficeSnapshot => ({ desks: Array.from({ length: n }, (_, i) => ({ id: `d${i}`, agents: [] }) as never), updatedAt: Date.now(), error: null });

describe('OfficePoller', () => {
  it('notifies only on change and keeps last desks on error', async () => {
    let fail = false;
    const poller = new OfficePoller(async () => {
      if (fail) throw new Error('orca down');
      return office(1);
    });
    const seen: string[] = [];
    poller.onChange((s) => seen.push(s.error ?? `desks:${s.desks.length}`));

    await poller.refresh();
    await poller.refresh();
    expect(seen).toEqual(['desks:1']);

    fail = true;
    await poller.refresh();
    expect(seen).toEqual(['desks:1', 'orca down']);
    expect(poller.current.desks).toHaveLength(1);
  });

  it('runs enrichment before change detection and shares an in-flight poll', async () => {
    let polls = 0;
    const poller = new OfficePoller(
      async () => {
        polls++;
        return office(1);
      },
      1500,
      async (s) => {
        s.desks[0].name = 'enriched';
      },
    );
    await Promise.all([poller.refresh(), poller.refresh()]);
    expect(polls).toBe(1);
    expect(poller.current.desks[0].name).toBe('enriched');
  });
});
