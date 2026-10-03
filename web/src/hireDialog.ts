import type { OfficeSnapshot } from '../../bridge/src/model';
import { postJson } from './api';

// "Start new work" dialog: a new worktree with an agent, or one more agent in a worktree.

const AGENTS: [string, string][] = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['gemini', 'Gemini'],
];

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export class HireDialog {
  constructor(
    private readonly el: HTMLElement,
    private readonly snapshot: () => OfficeSnapshot | null,
  ) {
    el.addEventListener('click', (e) => {
      if (e.target === el || (e.target as HTMLElement).closest('[data-close]')) this.close();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });
  }

  /** New worktree (optionally preselecting a repo) or, with deskId, an agent for that worktree. */
  open(opts: { repoId?: string; deskId?: string } = {}): void {
    const desks = this.snapshot()?.desks ?? [];
    const target = opts.deskId ? desks.find((d) => d.id === opts.deskId) : null;
    const repos = [...new Map(desks.map((d) => [d.repoId, d.repo || d.name])).entries()];
    const agentOptions = AGENTS.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
    this.el.innerHTML = `
      <form class="dialog" autocomplete="off">
        <button type="button" class="close" data-close title="닫기">✕</button>
        <h2>${target ? `🧑 ${esc(target.name)}에 에이전트 추가` : '➕ 새 작업 시작'}</h2>
        <p class="muted">${target ? '이 워크트리에 새 터미널을 열고 에이전트를 띄웁니다.' : '새 워크트리(브랜치)를 만들고 그 안에서 에이전트를 띄웁니다.'}</p>
        ${
          target
            ? ''
            : `<label>프로젝트<select name="repoId">${repos
                .map(([id, name]) => `<option value="${esc(id)}"${id === opts.repoId ? ' selected' : ''}>${esc(name)}</option>`)
                .join('')}</select></label>
               <label>워크트리 이름 <span class="muted">(브랜치 이름이 됩니다)</span><input name="name" required maxlength="60" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]*" placeholder="fix-login-redirect" /></label>
               <label>기준 브랜치 <span class="muted">(비우면 저장소 기본값)</span><input name="baseBranch" maxlength="120" placeholder="origin/main" /></label>`
        }
        <label>에이전트<select name="agent">${agentOptions}</select></label>
        <label>첫 지시 <span class="muted">(선택)</span><textarea name="prompt" rows="4" placeholder="무엇을 해야 하는지 적어 주세요"></textarea></label>
        <div class="row"><span class="msg"></span><button type="button" data-close>취소</button><button type="submit" class="primary">${target ? '에이전트 띄우기' : '만들기'}</button></div>
      </form>`;
    this.el.hidden = false;
    const form = this.el.querySelector('form')!;
    (form.querySelector<HTMLInputElement>('input[name=name]') ?? form.querySelector('textarea'))!.focus();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit(form, target?.id);
    });
  }

  close(): void {
    this.el.hidden = true;
    this.el.innerHTML = '';
  }

  private async submit(form: HTMLFormElement, deskId?: string): Promise<void> {
    const data = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
    const msg = form.querySelector<HTMLElement>('.msg')!;
    const btn = form.querySelector<HTMLButtonElement>('button.primary')!;
    btn.disabled = true;
    msg.textContent = deskId ? '에이전트를 띄우는 중…' : '워크트리를 만드는 중… (조금 걸릴 수 있어요)';
    try {
      const body = deskId
        ? { deskId, agent: data.agent, prompt: data.prompt }
        : { repoId: data.repoId, name: data.name.trim(), baseBranch: data.baseBranch.trim() || undefined, agent: data.agent, prompt: data.prompt };
      const res = await postJson<{ warning?: string }>('/api/hire', body);
      if (res.warning) {
        msg.textContent = `⚠️ ${res.warning}`;
        btn.disabled = false;
        return;
      }
      this.close();
    } catch (err) {
      msg.textContent = `⚠️ ${(err as Error).message}`;
      btn.disabled = false;
    }
  }
}
