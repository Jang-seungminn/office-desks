import { describe, expect, it } from 'vitest';
import { rankOf, tenure } from '../src/rank';

const stats = (instructions: number) => ({ instructions, instructionsToday: 0, toolCalls: 0, subagents: 0, hiredAt: null });

describe('rank', () => {
  it('climbs the ladder with instructions', () => {
    expect(rankOf(null)).toBeNull();
    expect(rankOf(stats(0))).toEqual({ title: '인턴', next: 5, nextTitle: '사원', progress: 0 });
    expect(rankOf(stats(35))).toMatchObject({ title: '주임', next: 50, progress: 0.5 });
    expect(rankOf(stats(5000))).toEqual({ title: '이사', next: null, nextTitle: null, progress: 1 });
  });

  it('counts days since the session started', () => {
    const now = new Date(2026, 9, 3, 10);
    expect(tenure(new Date(2026, 9, 3, 1).toISOString(), now)).toBe('오늘 입사');
    expect(tenure(new Date(2026, 9, 1, 23).toISOString(), now)).toBe('3일차');
    expect(tenure(null, now)).toBeNull();
  });
});
