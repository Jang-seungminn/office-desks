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
