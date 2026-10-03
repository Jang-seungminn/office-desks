import type { SearchResult } from '../../bridge/src/model';

// Search every agent conversation Orca has indexed. Hits from agents in the office open their
// chat at the matching message; other sessions show their resume command.

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Orca marks matches as [[text]]; show them highlighted, everything else escaped. */
export function snippetHtml(snippet: string): string {
  return esc(snippet).replace(/\[\[(.+?)\]\]/g, '<mark>$1</mark>');
}

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export class SearchDialog {
  private results: SearchResult[] = [];
  onOpen: (deskId: string, agentId: string, query: string) => void = () => {};

  constructor(private readonly el: HTMLElement) {}

  open(): void {
    this.el.innerHTML = `
      <div class="dialog search">
        <button type="button" class="close" data-close title="닫기">✕</button>
        <h2>🔍 대화 검색</h2>
        <form class="search-row"><input name="q" maxlength="200" placeholder="에이전트와 나눈 대화에서 찾기 (예: 로그인 버그)" /><button type="submit" class="primary">검색</button></form>
        <p class="muted hint">Orca가 기록한 모든 Claude·Codex 세션을 찾습니다.</p>
        <ul class="results"></ul>
      </div>`;
    this.el.hidden = false;
    const form = this.el.querySelector('form')!;
    const input = form.querySelector('input')!;
    input.focus();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.search(input.value.trim());
    });
    this.el.onclick = (e) => {
      const t = e.target as HTMLElement;
      if (e.target === this.el || t.closest('[data-close]')) return this.close();
      const copy = t.closest<HTMLElement>('[data-copy]');
      if (copy) {
        void navigator.clipboard?.writeText(copy.dataset.copy!).then(() => (copy.textContent = '복사됨'));
        return;
      }
      const li = t.closest<HTMLElement>('[data-i]');
      const r = li ? this.results[Number(li.dataset.i)] : null;
      if (r?.deskId && r.agentId) {
        this.onOpen(r.deskId, r.agentId, input.value.trim());
        this.close();
      }
    };
    this.el.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    };
  }

  close(): void {
    this.el.hidden = true;
    this.el.innerHTML = '';
    this.el.onclick = null;
    this.el.onkeydown = null;
  }

  private async search(q: string): Promise<void> {
    const list = this.el.querySelector<HTMLElement>('.results')!;
    if (!q) return;
    list.innerHTML = '<li class="muted">찾는 중…</li>';
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = (await res.json()) as { results?: SearchResult[]; error?: string };
      if (!res.ok) throw new Error(data.error);
      this.results = data.results ?? [];
      list.innerHTML = this.results.length
        ? this.results
            .map(
              (r, i) => `<li data-i="${i}" class="${r.agentId ? 'live' : 'past'}">
                <div class="r-head"><b>${esc(r.project || r.title)}</b> <span class="muted">${esc(r.agent)} · ${esc(when(r.updatedAt))}</span>
                  ${r.agentId ? '<span class="tag live">사무실에 있음 · 열기</span>' : '<span class="tag">지난 세션</span>'}</div>
                <div class="r-title muted">${esc(r.title)}</div>
                <div class="r-snip">${snippetHtml(r.snippet)}</div>
                ${r.resumeCommand ? `<div class="r-resume"><code>${esc(r.resumeCommand)}</code> <button type="button" data-copy="${esc(r.resumeCommand)}">복사</button></div>` : ''}
              </li>`,
            )
            .join('')
        : '<li class="muted">찾은 대화가 없습니다.</li>';
    } catch (err) {
      list.innerHTML = `<li class="muted">⚠️ ${esc((err as Error).message || '검색하지 못했습니다 (Orca Settings → Agent Session History 확인)')}</li>`;
    }
  }
}
