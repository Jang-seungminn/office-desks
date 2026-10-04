import type { OfficeSnapshot } from '../model.js';
import { fit } from './text.js';

// The lobby: every agent (and every empty worktree) as one row, grouped by project.

export interface LobbyRow {
  deskId: string;
  repoId: string;
  repo: string;
  desk: string;
  agentId: string | null;
  agentType: string | null;
  state: string | null;
  activity: string;
}

export interface LobbyView {
  rows: LobbyRow[];
  selected: number;
  url: string;
  notice: string | null;
  /** Replaces the key help (used by prompts). */
  footer?: string;
}

const MIN_COLS = 60;
const MIN_LINES = 10;
const HELP = 'q 종료 · ↑↓ 이동 · Enter 붙기 · a 에이전트 추가 · n 새 작업 · p 프로젝트 추가';
const GLYPH: Record<string, [string, string]> = {
  typing: ['✎', '33'],
  reading: ['◎', '36'],
  running: ['▶', '35'],
  waiting: ['!', '31;1'],
  done: ['✓', '32'],
  away: ['·', '90'],
};
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const color = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`;

export function lobbyRows(s: OfficeSnapshot): LobbyRow[] {
  const desks = [...s.desks].sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
  return desks.flatMap((d) => {
    const base = { deskId: d.id, repoId: d.repoId, repo: d.repo || d.name, desk: d.name };
    if (!d.agents.length) return [{ ...base, agentId: null, agentType: null, state: null, activity: '(에이전트 없음)' } as LobbyRow];
    return d.agents.map((a) => ({ ...base, agentId: a.id, agentType: a.agentType, state: a.state, activity: a.activity } as LobbyRow));
  });
}

export function renderLobby(v: LobbyView, cols: number, lines: number): string[] {
  if (cols < MIN_COLS || lines < MIN_LINES) {
    const out = Array.from({ length: lines }, () => ' '.repeat(Math.max(cols, 0)));
    out[Math.floor(lines / 2)] = fit(' 창을 키워 주세요', cols);
    return out;
  }
  const busy = v.rows.filter((r) => r.state === 'typing' || r.state === 'reading' || r.state === 'running').length;
  const waiting = v.rows.filter((r) => r.state === 'waiting').length;
  const counts = `✎ ${busy}  ! ${waiting} `;
  const title = ` Office Desks · native · 웹 ${v.url}`;
  const header = fit(title, cols - counts.length) + counts;
  const rule = dim('─'.repeat(cols));

  // Body: repo headings plus rows, scrolled so the selection stays visible.
  const body: { text: string; row: number | null }[] = [];
  let lastRepo: string | null = null;
  v.rows.forEach((r, i) => {
    if (r.repo !== lastRepo) {
      body.push({ text: fit(` ${r.repo}`, cols), row: null });
      lastRepo = r.repo;
    }
    const mark = i === v.selected ? ' ▸ ' : '   ';
    const [g, c] = r.state ? (GLYPH[r.state] ?? ['?', '0']) : [' ', '0'];
    const name = fit(r.desk, 18);
    const type = fit(r.agentType ?? '', 8);
    const rest = cols - 3 - 18 - 1 - 8 - 1 - 2;
    body.push({ text: `${mark}${name} ${type} ${color(c, g)} ${fit(r.activity, rest)}`, row: i });
  });
  if (!v.rows.length) body.push({ text: fit('   프로젝트가 없어요 — p로 git 저장소를 추가하세요', cols), row: null });

  const height = lines - 4 - (v.notice ? 1 : 0);
  const selLine = Math.max(0, body.findIndex((b) => b.row === v.selected));
  const start = Math.min(Math.max(0, selLine - height + 1), Math.max(0, body.length - height));
  const visible = body.slice(start, start + height).map((b) => b.text);
  while (visible.length < height) visible.push(' '.repeat(cols));

  return [
    header,
    rule,
    ...visible,
    rule,
    ...(v.notice ? [fit(` ${v.notice}`, cols)] : []),
    fit(` ${v.footer ?? HELP}`, cols),
  ];
}
