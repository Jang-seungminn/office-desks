import { describe, expect, it } from 'vitest';
import { Frame } from '../src/tui/frame.js';
import type { LobbyRow } from '../src/tui/lobby.js';
import { drawSidebar } from '../src/tui/sidebar.js';

const row = (repo: string, desk: string, agentId: string | null, state: string | null): LobbyRow => ({
  deskId: `${repo}::/${desk}`, repoId: repo, repo, desk, agentId, agentType: agentId ? 'claude' : null, state, activity: '',
});
const line = (f: Frame, y: number, cols: number) => Array.from({ length: cols }, (_, x) => f.get(y, x).ch).join('');

describe('drawSidebar', () => {
  const rows = [row('api', 'api', null, null), row('app', 'app', 'a1', 'waiting'), row('app', 'fix-login', 'b1', 'typing')];

  it('draws repo headings, rows with glyphs, and highlights the selection', () => {
    const f = new Frame(24, 6);
    drawSidebar(f, { row: 0, col: 0, rows: 6, cols: 24 }, rows, 2, true);
    expect(line(f, 0, 24).trimEnd()).toBe(' api');
    expect(line(f, 1, 24)).toContain('api');
    expect(line(f, 2, 24).trimEnd()).toBe(' app');
    expect(line(f, 3, 24)).toMatch(/app.*!/);
    expect(line(f, 4, 24)).toMatch(/^ ▸ fix-login.*✎/);
    expect(f.get(4, 3).style.inverse).toBe(true); // focused selection is reversed
    expect(f.get(3, 22).style.fg).toEqual({ mode: 'palette', index: 1 }); // waiting glyph is red
  });

  it('scrolls to keep the selection visible and shows the empty hint', () => {
    const many = Array.from({ length: 20 }, (_, i) => row('app', `w${i}`, `x${i}`, 'done'));
    const f = new Frame(24, 5);
    drawSidebar(f, { row: 0, col: 0, rows: 5, cols: 24 }, many, 15, false);
    expect(Array.from({ length: 5 }, (_, y) => line(f, y, 24)).some((l) => l.includes('w15'))).toBe(true);
    const e = new Frame(24, 3);
    drawSidebar(e, { row: 0, col: 0, rows: 3, cols: 24 }, [], 0, true);
    expect(line(e, 0, 24)).toContain('p로 프로젝트');
  });
});
