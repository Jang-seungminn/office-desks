import { describe, expect, it } from 'vitest';
import { OfficePoller } from '../src/poller.js';

describe('OfficePoller', () => {
  it('notifies only on change and keeps last desks on error', async () => {
    let fail = false;
    const ps = { worktrees: [{ worktreeId: 'r::/a', displayName: 'a', agents: [] }] };
    const poller = new OfficePoller(async (args) => {
      if (fail) throw new Error('orca down');
      return args[0] === 'worktree' ? ps : { terminals: [] };
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
});

describe('OfficePoller CLI usage', () => {
  it('lists terminals only when stale or when an unknown pane appears', async () => {
    let now = 0;
    const calls: string[] = [];
    let panes = ['t1:l1'];
    const poller = new OfficePoller(
      async (args) => {
        calls.push(args.join(' '));
        if (args[0] === 'worktree') return { worktrees: [{ worktreeId: 'r::/a', agents: panes.map((p) => ({ paneKey: p, state: 'working' })) }] };
        return { terminals: panes.map((p) => ({ handle: `h-${p}`, tabId: p.split(':')[0], leafId: p.split(':')[1] })) };
      },
      1500,
      undefined,
      () => now,
    );
    await poller.refresh();
    now = 1500;
    await poller.refresh();
    now = 3000;
    await poller.refresh();
    expect(calls.filter((c) => c === 'terminal list')).toHaveLength(1);
    panes = ['t1:l1', 't2:l2']; // a new agent appears
    now = 4500;
    await poller.refresh();
    expect(calls.filter((c) => c === 'terminal list')).toHaveLength(2);
    expect(poller.current.desks[0].agents[1].terminalHandle).toBe('h-t2:l2');
    now = 4500 + 16_000; // stale
    await poller.refresh();
    expect(calls.filter((c) => c === 'terminal list')).toHaveLength(3);
  });
});
