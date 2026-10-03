import type { ChangeSummary, FileDiffResponse } from '../../../bridge/src/model';
import { esc } from './util';

/** The "📝 변경" tab: uncommitted files of a worktree and a coloured diff of one of them. */
export class ChangesView {
  private timer: number | null = null;
  private deskId: string | null = null;
  private openFile: string | null = null;

  constructor(private readonly el: HTMLElement) {
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const li = t.closest<HTMLElement>('[data-file]');
      if (li) void this.showDiff(li.dataset.file!);
      if (t.closest('[data-close-diff]')) void this.showDiff(null);
    });
  }

  /** Show (and keep refreshing every 5s) the changes of a worktree. */
  start(deskId: string): void {
    this.stop();
    this.deskId = deskId;
    const tick = async () => {
      await this.load(deskId);
      if (this.deskId === deskId) this.timer = window.setTimeout(tick, 5000);
    };
    void tick();
  }

  stop(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.deskId = null;
  }

  /** Forget the open diff (another worktree was selected). */
  reset(): void {
    this.openFile = null;
    this.el.querySelector<HTMLElement>('.diff-view')!.hidden = true;
  }

  private async load(deskId: string): Promise<void> {
    const list = this.el.querySelector<HTMLElement>('.file-list')!;
    try {
      const res = await fetch(`/api/changes?deskId=${encodeURIComponent(deskId)}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as ChangeSummary;
      if (this.deskId !== deskId) return;
      const icon = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' } as const;
      list.innerHTML = data.files.length
        ? `<li class="sum">파일 ${data.files.length}개 · <span class="add">+${data.added}</span> <span class="del">−${data.deleted}</span> <span class="muted">(커밋 전 변경, HEAD 기준)</span></li>` +
          data.files
            .map(
              (f) => `<li data-file="${esc(f.path)}" class="${f.path === this.openFile ? 'open' : ''}"><span class="st st-${f.status}">${icon[f.status]}</span>
                <span class="fp">${esc(f.path)}</span><span class="add">+${f.added}</span><span class="del">−${f.deleted}</span></li>`,
            )
            .join('')
        : '<li class="muted">커밋되지 않은 변경이 없습니다.</li>';
    } catch {
      list.innerHTML = '<li class="muted">변경 사항을 읽지 못했습니다 (git 저장소가 아니거나 git이 없음).</li>';
    }
  }

  private async showDiff(file: string | null): Promise<void> {
    const view = this.el.querySelector<HTMLElement>('.diff-view')!;
    this.openFile = file;
    for (const li of this.el.querySelectorAll<HTMLElement>('[data-file]')) li.classList.toggle('open', li.dataset.file === file);
    if (!file || !this.deskId) {
      view.hidden = true;
      return;
    }
    const head = view.querySelector<HTMLElement>('.diff-head')!;
    const pre = view.querySelector<HTMLPreElement>('.diff')!;
    head.innerHTML = `<b></b> <button type="button" data-close-diff>닫기</button>`;
    head.querySelector('b')!.textContent = file;
    pre.textContent = '불러오는 중…';
    view.hidden = false;
    try {
      const res = await fetch(`/api/diff?deskId=${encodeURIComponent(this.deskId)}&file=${encodeURIComponent(file)}`);
      const data = (await res.json()) as FileDiffResponse & { error?: string };
      if (!res.ok) throw new Error(data.error);
      // One span per line, text only: diffs are untrusted content.
      pre.textContent = '';
      for (const line of data.diff.split('\n')) {
        const span = document.createElement('span');
        span.className =
          line.startsWith('+') && !line.startsWith('+++') ? 'l-add' : line.startsWith('-') && !line.startsWith('---') ? 'l-del' : line.startsWith('@@') ? 'l-hunk' : '';
        span.textContent = `${line}\n`;
        pre.append(span);
      }
      if (data.truncated) pre.append('\n… (너무 길어 잘렸습니다)');
      if (!data.diff) pre.textContent = '(내용 없음 · 바이너리 파일일 수 있습니다)';
    } catch (err) {
      pre.textContent = `⚠️ ${(err as Error).message || 'diff를 불러오지 못했습니다'}`;
    }
  }
}
