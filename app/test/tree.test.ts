import { describe, expect, it } from 'vitest';
import type { CharacterState } from '../../bridge/src/model';
import { projects, STATE_LABEL, tabTitle } from '../src/tree';

import { desk, agent, snap } from './fixtures';

describe('tree', () => {
  it('groups, sorts and names projects', () => {
    const s = snap([
      desk({ id: '1', repoId: 'z', repo: 'zeta', name: 'b' }),
      desk({ id: '2', repoId: 'z', repo: 'zeta', name: 'main', isMain: true }),
      desk({ id: '3', repoId: 'z', repo: 'zeta', name: 'a' }),
      desk({ id: '4', repoId: 'y', repo: 'alpha', name: 'only' }),
    ]);
    const ps = projects(s);
    expect(ps.map((p) => p.name)).toEqual(['alpha', 'zeta']);
    expect(ps[1].desks.map((d) => d.name)).toEqual(['main', 'a', 'b']);
  });
  it('null gives []', () => expect(projects(null)).toEqual([]));
  it('labels every state', () => {
    const all: CharacterState[] = ['typing', 'reading', 'running', 'waiting', 'done', 'away'];
    for (const st of all) expect(STATE_LABEL[st]).toBeTruthy();
  });
  it('tabTitle', () => expect(tabTitle(desk({ name: 'wt1' }), agent({}))).toBe('wt1 · claude'));
});
