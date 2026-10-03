import type { OfficeAgent } from '../../../bridge/src/model';
import { rankOf, tenure } from '../rank';
import { esc } from './util';

// The agent as an employee: title, department, how long it's been around and what it has done.

export function employeeCard(a: OfficeAgent, department: string | null, awards = 0): string {
  const rank = rankOf(a.stats);
  const dept = department ? `<span class="dept">${esc(department)}</span>` : '<span class="dept none">미배정</span>';
  if (!a.stats || !rank) {
    return `<div class="employee-card">${dept} <span class="muted">근무 기록 없음 (대화 기록을 찾으면 표시돼요)</span></div>`;
  }
  const s = a.stats;
  const since = tenure(s.hiredAt);
  const toNext = rank.next !== null ? `${rank.nextTitle}까지 ${rank.next - s.instructions}건` : '최고 직급';
  return `<div class="employee-card">
    <div class="ec-top"><span class="rank">${esc(rank.title)}</span>${dept}${since ? `<span class="muted" title="이 세션을 시작한 날 기준">${esc(since)}</span>` : ''}${awards ? `<span class="award" title="오늘의 우수사원으로 뽑힌 횟수">🏆 우수사원 ${awards}회</span>` : ''}</div>
    <div class="ec-perf">지시 <b>${s.instructions}</b>건 <span class="muted">(오늘 ${s.instructionsToday})</span> · 도구 <b>${s.toolCalls}</b>회 · 외주 <b>${s.subagents}</b>명</div>
    <div class="ec-xp" title="${esc(toNext)}"><span class="xp"><span class="xp-fill" data-pct="${Math.round(rank.progress * 100)}"></span></span><span class="muted">${esc(toNext)}</span></div>
  </div>`;
}

/** CSP forbids inline style attributes: set the progress bar width through the CSSOM. */
export function applyCardWidths(root: HTMLElement): void {
  for (const f of root.querySelectorAll<HTMLElement>('.employee-card .xp-fill')) f.style.width = `${f.dataset.pct}%`;
}
