import type { Award, AwardBoard, Department, OfficeAgent, OfficeDesk, OfficeSnapshot, OrgChart, UsageSnapshot } from '../../bridge/src/model';
import { postJson } from './api';
import { THEME_LABEL } from './arrange';
import { rankOf } from './rank';

// The CEO's office: company numbers at a glance (staff, today's work, plan usage as the budget),
// today's best employees, and the org chart itself (departments and which projects sit where).

type Theme = Department['theme'];
const THEMES = Object.keys(THEME_LABEL) as Theme[];
const ACTIVE = new Set(['typing', 'reading', 'running']);
/** Same score as the bridge's employee of the day (awards.ts). */
const score = (a: OfficeAgent) => (a.stats ? a.stats.instructionsToday * 10 + a.stats.toolCallsToday : 0);

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

interface Draft {
  id: string;
  name: string;
  theme: Theme;
}

export class CeoDialog {
  /** Departments and assignments being edited; saved as a whole. */
  private depts: Draft[] = [];
  private assign = new Map<string, string>(); // repoId → dept id ('' = 미배정)
  onPick: (deskId: string, agentId: string) => void = () => {};

  constructor(
    private readonly el: HTMLElement,
    private readonly data: () => { snapshot: OfficeSnapshot | null; org: OrgChart; usage: UsageSnapshot | null; awards: AwardBoard | null },
  ) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.querySelector('.dialog.ceo')) {
        e.stopPropagation();
        this.close();
      }
    });
  }

  open(): void {
    const { org } = this.data();
    this.depts = org.departments.map((d) => ({ id: d.id, name: d.name, theme: d.theme }));
    this.assign = new Map(org.departments.flatMap((d) => d.repoIds.map((r) => [r, d.id] as [string, string])));
    this.el.innerHTML = `
      <div class="dialog ceo">
        <button type="button" class="close" data-close title="닫기">✕</button>
        <h2>🏢 사장실</h2>
        <section class="company"></section>
        <section class="honors"></section>
        <section class="mvp"></section>
        <section class="org">
          <h3>조직도 <span class="muted">부서를 만들고 프로젝트를 배치하세요. 저장하면 자리가 바뀝니다.</span></h3>
          <ul class="depts"></ul>
          <button type="button" class="add-dept" data-add>➕ 부서 만들기</button>
          <h3>프로젝트 배치</h3>
          <ul class="repos"></ul>
        </section>
        <div class="row"><span class="msg"></span><button type="button" data-close>닫기</button><button type="button" class="primary" data-save>저장</button></div>
      </div>`;
    this.el.hidden = false;
    this.renderCompany();
    this.renderOrg();
    const dialog = this.el.querySelector<HTMLElement>('.dialog.ceo')!;
    dialog.addEventListener('click', (e) => this.onClick(e));
    dialog.addEventListener('input', (e) => this.onInput(e));
    dialog.addEventListener('change', (e) => this.onInput(e));
    // A click on the dimmed backdrop closes it too.
    this.el.onclick = (e) => {
      if (e.target === this.el) this.close();
    };
    dialog.querySelector<HTMLButtonElement>('[data-save]')!.focus();
  }

  close(): void {
    this.el.hidden = true;
    this.el.innerHTML = '';
    this.el.onclick = null;
  }

  get isOpen(): boolean {
    return !this.el.hidden && Boolean(this.el.querySelector('.dialog.ceo'));
  }

  /** Live numbers changed (snapshot / usage): refresh them without touching unsaved edits. */
  refresh(): void {
    if (this.isOpen) this.renderCompany();
  }

  private renderCompany(): void {
    const { snapshot, usage } = this.data();
    const desks = snapshot?.desks ?? [];
    const agents = desks.flatMap((d) => d.agents);
    const working = agents.filter((a) => ACTIVE.has(a.state)).length;
    const waiting = agents.filter((a) => a.state === 'waiting').length;
    const today = agents.reduce((n, a) => n + (a.stats?.instructionsToday ?? 0), 0);
    const subs = agents.reduce((n, a) => n + a.subagentsRunning, 0);
    const budget = (usage?.providers ?? []).flatMap((p) => p.windows.map((w) => ({ label: w.label, pct: w.usedPercent, reset: w.resetDescription })));
    const company = this.el.querySelector<HTMLElement>('.company')!;
    company.innerHTML = `
      <div class="kpis">
        <div><b>${agents.length}</b><span>직원</span></div>
        <div><b>${working}</b><span>일하는 중</span></div>
        <div class="${waiting ? 'warn' : ''}"><b>${waiting}</b><span>결재 대기</span></div>
        <div><b>${today}</b><span>오늘 지시</span></div>
        <div><b>${subs}</b><span>외주(서브에이전트)</span></div>
      </div>
      ${
        budget.length
          ? `<div class="budget"><span class="muted">예산 (요금제 사용량)</span>${budget
              .map(
                (b) => `<div class="b-row"><span>${esc(b.label)}</span><span class="bar"><span class="fill ${b.pct >= 85 ? 'high' : b.pct >= 60 ? 'mid' : 'low'}" data-pct="${b.pct}"></span></span><span>${b.pct}%${b.reset ? ` <span class="muted">· ${esc(b.reset)} 리셋</span>` : ''}</span></div>`,
              )
              .join('')}</div>`
          : ''
      }`;
    // CSP forbids inline style attributes; widths go through the CSSOM.
    for (const f of company.querySelectorAll<HTMLElement>('.fill')) f.style.width = `${f.dataset.pct}%`;

    this.renderHonors(desks);

    const ranked = desks
      .flatMap((d) => d.agents.map((a) => ({ d, a })))
      .filter(({ a }) => a.stats)
      .filter(({ a }) => a.stats!.instructionsToday > 0)
      .sort((x, y) => score(y.a) - score(x.a) || y.a.stats!.instructions - x.a.stats!.instructions)
      .slice(0, 3);
    const mvp = this.el.querySelector<HTMLElement>('.mvp')!;
    mvp.innerHTML = ranked.length
      ? `<h3>오늘 순위</h3><ol>${ranked.map(({ d, a }, i) => this.mvpRow(d, a, i)).join('')}</ol>`
      : '';
  }

  /** Employee of the day: today's race so far and the hall of fame. */
  private renderHonors(desks: OfficeDesk[]): void {
    const { awards } = this.data();
    const el = this.el.querySelector<HTMLElement>('.honors')!;
    if (!awards || (!awards.leader && !awards.hall.length)) {
      el.innerHTML = '<h3>🏆 오늘의 우수사원</h3><p class="muted">오늘 일한 직원이 생기면 1위가 여기에 보이고, 날이 바뀌면 그날의 우수사원으로 뽑힙니다.</p>';
      return;
    }
    const live = new Set(desks.flatMap((d) => d.agents.map((a) => a.id)));
    const row = (a: Award, tag: string) => {
      const who = `<span class="who">${esc(a.name)}</span> <span class="muted">${esc(a.repo)}</span>`;
      const body = `<span class="medal">${tag}</span>${who}<span class="score">지시 ${a.instructions} · 도구 ${a.toolCalls}</span>`;
      const desk = desks.find((d) => d.agents.some((x) => x.id === a.agentId));
      return live.has(a.agentId) && desk
        ? `<li><button type="button" class="link" data-desk="${esc(desk.id)}" data-agent="${esc(a.agentId)}">${body}</button></li>`
        : `<li><div class="gone">${body}</div></li>`;
    };
    const day = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
    el.innerHTML = `<h3>🏆 오늘의 우수사원 <span class="muted">점수 = 오늘 지시 × 10 + 도구 사용</span></h3><ol>
      ${awards.leader ? row(awards.leader, '👑 오늘 1위') : '<li class="muted">오늘은 아직 일한 직원이 없어요</li>'}
      ${awards.hall.slice(0, 7).map((a) => row(a, `🏆 ${day(a.date)}`)).join('')}
    </ol>`;
  }

  private mvpRow(d: OfficeDesk, a: OfficeAgent, i: number): string {
    const rank = rankOf(a.stats);
    const who = a.terminalTitle ?? d.name;
    return `<li><button type="button" class="link" data-desk="${esc(d.id)}" data-agent="${esc(a.id)}">
      <span class="medal">${['🥇', '🥈', '🥉'][i]}</span>
      <span class="who">${esc(who)}</span>
      <span class="muted">${esc(rank?.title ?? '')} · ${esc(d.repo || d.name)}</span>
      <span class="score">${score(a)}점</span></button></li>`;
  }

  private renderOrg(): void {
    const { snapshot, org } = this.data();
    const list = this.el.querySelector<HTMLElement>('.depts')!;
    list.innerHTML = this.depts.length
      ? this.depts
          .map(
            (d, i) => `<li data-i="${i}">
              <input data-field="name" maxlength="20" value="${esc(d.name)}" aria-label="부서 이름" />
              <select data-field="theme" aria-label="인테리어">${THEMES.map((t) => `<option value="${t}"${t === d.theme ? ' selected' : ''}>${THEME_LABEL[t]}</option>`).join('')}</select>
              <button type="button" data-move="-1" title="위로"${i === 0 ? ' disabled' : ''}>▲</button>
              <button type="button" data-move="1" title="아래로"${i === this.depts.length - 1 ? ' disabled' : ''}>▼</button>
              <button type="button" data-remove title="부서 없애기 (프로젝트는 미배정으로)">🗑</button>
            </li>`,
          )
          .join('')
      : '<li class="muted empty">아직 부서가 없어요. 부서를 만들면 사무실이 부서별로 바뀝니다.</li>';

    // Projects Orca knows, plus ones still assigned but gone from Orca (so they can be cleared).
    const live = new Map((snapshot?.desks ?? []).map((d) => [d.repoId, d.repo || d.name]));
    const stale = org.departments.flatMap((d) => d.repoIds).filter((r) => !live.has(r) && this.assign.has(r));
    const counts = new Map<string, number>();
    for (const d of snapshot?.desks ?? []) counts.set(d.repoId, (counts.get(d.repoId) ?? 0) + 1);
    const options = (current: string) =>
      `<option value="">미배정</option>${this.depts.map((d) => `<option value="${esc(d.id)}"${d.id === current ? ' selected' : ''}>${esc(d.name || '(이름 없음)')}</option>`).join('')}`;
    const repos = this.el.querySelector<HTMLElement>('.repos')!;
    repos.innerHTML = [
      ...[...live.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(
          ([id, name]) => `<li><span class="r-name">${esc(name)} <span class="muted">워크트리 ${counts.get(id) ?? 0}</span></span>
            <select data-repo="${esc(id)}" aria-label="${esc(name)} 부서">${options(this.assign.get(id) ?? '')}</select></li>`,
        ),
      ...stale.map(
        (id) => `<li class="stale"><span class="r-name muted">${esc(id.split(/[\\/]/).pop() ?? id)} (Orca에 없음)</span>
          <button type="button" data-unassign="${esc(id)}">배치 해제</button></li>`,
      ),
    ].join('') || '<li class="muted empty">Orca 프로젝트를 기다리는 중…</li>';
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const row = t.closest<HTMLElement>('li[data-i]');
    if (row && t.dataset.field) {
      const d = this.depts[Number(row.dataset.i)];
      if (t.dataset.field === 'name') d.name = t.value;
      else if (e.type === 'change') {
        d.theme = t.value as Theme;
      }
      // Renaming updates the department names in the project selects.
      if (t.dataset.field === 'name' && e.type === 'change') this.renderReposOnly();
      return;
    }
    if (t.dataset.repo !== undefined && e.type === 'change') {
      if (t.value) this.assign.set(t.dataset.repo, t.value);
      else this.assign.delete(t.dataset.repo);
    }
  }

  /** Re-render the project list but keep focus/edits in the department inputs. */
  private renderReposOnly(): void {
    const names = new Map(this.depts.map((d) => [d.id, d.name || '(이름 없음)']));
    for (const sel of this.el.querySelectorAll<HTMLSelectElement>('select[data-repo]')) {
      for (const opt of sel.options) if (opt.value) opt.textContent = names.get(opt.value) ?? opt.value;
    }
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('[data-close]')) return this.close();
    if (t.closest('[data-save]')) return void this.save();
    const pick = t.closest<HTMLElement>('[data-agent]');
    if (pick) {
      this.close();
      this.onPick(pick.dataset.desk!, pick.dataset.agent!);
      return;
    }
    if (t.closest('[data-add]')) {
      const used = new Set(this.depts.map((d) => d.name));
      let n = this.depts.length + 1;
      while (used.has(`새 부서 ${n}`)) n++;
      this.depts.push({ id: `d-${Math.random().toString(36).slice(2, 10)}`, name: `새 부서 ${n}`, theme: THEMES[this.depts.length % THEMES.length] });
      this.renderOrg();
      const inputs = this.el.querySelectorAll<HTMLInputElement>('.depts input');
      inputs[inputs.length - 1]?.select();
      return;
    }
    const unassign = t.closest<HTMLElement>('[data-unassign]');
    if (unassign) {
      this.assign.delete(unassign.dataset.unassign!);
      this.renderOrg();
      return;
    }
    const row = t.closest<HTMLElement>('li[data-i]');
    if (!row) return;
    const i = Number(row.dataset.i);
    const move = t.closest<HTMLElement>('[data-move]');
    if (move) {
      const j = i + Number(move.dataset.move);
      if (j < 0 || j >= this.depts.length) return;
      [this.depts[i], this.depts[j]] = [this.depts[j], this.depts[i]];
      this.renderOrg();
      return;
    }
    if (t.closest('[data-remove]')) {
      const gone = this.depts.splice(i, 1)[0];
      for (const [repo, dept] of this.assign) if (dept === gone.id) this.assign.delete(repo);
      this.renderOrg();
    }
  }

  private async save(): Promise<void> {
    const msg = this.el.querySelector<HTMLElement>('.msg')!;
    const btn = this.el.querySelector<HTMLButtonElement>('[data-save]')!;
    const { org } = this.data();
    // Keep each department's existing project order; newly assigned projects go at the end.
    const departments = this.depts.map((d) => {
      const before = org.departments.find((o) => o.id === d.id)?.repoIds ?? [];
      const mine = [...this.assign].filter(([, dept]) => dept === d.id).map(([repo]) => repo);
      const repoIds = [...before.filter((r) => mine.includes(r)), ...mine.filter((r) => !before.includes(r))];
      return { id: d.id, name: d.name.trim(), theme: d.theme, repoIds };
    });
    const blank = departments.find((d) => !d.name);
    if (blank) {
      msg.textContent = '⚠️ 이름 없는 부서가 있어요';
      return;
    }
    btn.disabled = true;
    msg.textContent = '저장하는 중…';
    try {
      await postJson('/api/org', { departments });
      msg.textContent = '✅ 저장했어요';
      btn.disabled = false;
    } catch (err) {
      msg.textContent = `⚠️ ${(err as Error).message}`;
      btn.disabled = false;
    }
  }
}
