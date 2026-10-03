import type {
  ConversationMessage,
  ConversationResponse,
  QuestionState,
  ChangeSummary,
  FileDiffResponse,
  SubagentInfo,
  ImageUpload,
  OfficeAgent,
  OfficeDesk,
  OfficeSnapshot,
  SlashCommand,
  TerminalKey,
  TerminalScreen,
} from '../../bridge/src/model';
import { ApiError, postJson } from './api';
import { renderMarkdown } from './markdown';
import { modelLine } from './format';
import type { Selection } from './officeScene';

const STATE_LABEL: Record<string, string> = {
  typing: '⌨️ 작업 중',
  reading: '🔎 읽는 중',
  running: '▶️ 명령 실행 중',
  waiting: '🙋 확인 필요',
  done: '☕ 완료 · 대기',
  away: '💤 자리 비움',
};

const CONVERSATION_POLL_MS = 2000;
const TERMINAL_POLL_MS = 1000;
const MENU_CHECK_MS = 2500;
const SLASH_MENU_SIZE = 8;
// Keys offered under the terminal view, for TUI menus and permission prompts.
const KEYS: [TerminalKey, string][] = [
  ['up', '↑'],
  ['down', '↓'],
  ['left', '←'],
  ['right', '→'],
  ['enter', 'Enter'],
  ['esc', 'Esc'],
  ['tab', 'Tab'],
  ['shift-tab', '⇧Tab'],
  ['space', 'Space'],
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['y', 'y'],
  ['n', 'n'],
  ['ctrl-c', 'Ctrl+C'],
];
const SOURCE_LABEL: Record<SlashCommand['source'], string> = { builtin: '기본', user: '내 스킬', project: '프로젝트', plugin: '플러그인' };
const MAX_ATTACH = 6;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// Paths of images sent from this UI (see bridge/src/uploads.ts), shown inline instead of as text.
const UPLOAD_PATH = /^\s*\S*office-desks(?:-\d+)?[\\/]uploads[\\/]([\w-]+\.(?:png|jpg|gif|webp))\s*$/gm;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function ago(ts: number | null): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}초 전부터`;
  if (s < 3600) return `${Math.round(s / 60)}분 전부터`;
  return `${Math.round(s / 3600)}시간 전부터`;
}

function clock(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function readAsUpload(file: File): Promise<ImageUpload & { url: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ mediaType: file.type, data: url.slice(url.indexOf(',') + 1), url });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Side panel: seat details, the agent's whole conversation, and a command box into its Orca terminal. */
export class Panel {
  private selection: Selection | null = null;
  private desk: OfficeDesk | null = null;
  private agent: OfficeAgent | null = null;
  private readonly info: HTMLDivElement;
  private readonly convo: HTMLDivElement;
  private readonly compose: HTMLFormElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly attachments: HTMLDivElement;
  private readonly fileInput: HTMLInputElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly focusBtn: HTMLButtonElement;
  private readonly feedback: HTMLDivElement;
  private pending: (ImageUpload & { url: string })[] = [];
  // Conversation stream state: which session file we're showing and how many messages are rendered.
  private convoFileId: string | null = null;
  private convoCount = 0;
  private convoTimer: number | null = null;
  private convoFor: string | null = null;
  /** When set, the conversation view shows this subagent's transcript instead of the main one. */
  private subView: SubagentInfo | null = null;
  private subagents: SubagentInfo[] = [];
  private questions: QuestionState[] = [];
  /** Selections on unanswered question cards, per toolUseId: chosen option indexes per question. */
  private picks = new Map<string, number[][]>();
  private readonly tabs: HTMLDivElement;
  private readonly term: HTMLDivElement;
  private readonly screen: HTMLPreElement;
  private readonly slashMenu: HTMLDivElement;
  private tab: 'convo' | 'term' | 'changes' = 'convo';
  private readonly changesEl: HTMLDivElement;
  private changesTimer: number | null = null;
  private openFile: string | null = null;
  private termTimer: number | null = null;
  private menuMode = false;
  private autoSwitched = false;
  private readonly menuBanner: HTMLDivElement;
  private readonly toLatest: HTMLButtonElement;
  private unseen = 0;
  private commands: SlashCommand[] = [];
  private slashItems: SlashCommand[] = [];
  private slashIndex = 0;

  constructor(
    private readonly el: HTMLElement,
    private readonly onClose: () => void,
  ) {
    el.innerHTML = `
      <button class="close" title="닫기 (Esc)">✕</button>
      <div class="info"></div>
      <div class="tabs" role="tablist">
        <button type="button" data-tab="convo" class="active">💬 대화</button>
        <button type="button" data-tab="term">🖥️ 터미널<span class="tab-alert" hidden>!</span></button>
        <button type="button" data-tab="changes">📝 변경<span class="tab-count"></span></button>
      </div>
      <div class="convo"></div>
      <button type="button" class="to-latest" hidden>⬇ 최신으로</button>
      <div class="changes" hidden>
        <ul class="file-list"></ul>
        <div class="diff-view" hidden><div class="diff-head"></div><pre class="diff"></pre></div>
      </div>
      <div class="term" hidden>
        <p class="term-hint">화면을 <b>클릭하면</b> 키보드가 에이전트에게 바로 전달돼요 (↑↓ Enter Esc, 글자). 바깥을 클릭하면 해제</p>
        <pre class="screen" tabindex="0"></pre>
        <div class="keys">${KEYS.map(([k, label]) => `<button type="button" data-key="${k}">${label}</button>`).join('')}</div>
      </div>
      <form class="compose">
        <div class="menu-banner" hidden>
          <span class="menu-text"></span>
          <button type="button" data-menu="esc">Esc로 닫기</button>
        </div>
        <div class="slash-menu" hidden></div>
        <div class="attachments"></div>
        <textarea rows="3" placeholder="메시지 입력 · Enter 전송, Shift+Enter 줄바꿈 · 이미지는 붙여넣기/드래그"></textarea>
        <div class="row">
          <label class="attach" title="이미지 첨부">🖼️<input type="file" accept="${ACCEPTED.join(',')}" multiple hidden /></label>
          <div class="feedback"></div>
          <button type="button" class="focus">Orca에서 열기</button>
          <button type="submit" class="primary">보내기</button>
        </div>
      </form>`;
    this.info = el.querySelector('.info')!;
    this.convo = el.querySelector('.convo')!;
    this.compose = el.querySelector('.compose')!;
    this.textarea = el.querySelector('textarea')!;
    this.attachments = el.querySelector('.attachments')!;
    this.fileInput = el.querySelector('input[type=file]')!;
    this.sendBtn = el.querySelector('button.primary')!;
    this.focusBtn = el.querySelector('button.focus')!;
    this.feedback = el.querySelector('.feedback')!;
    this.tabs = el.querySelector('.tabs')!;
    this.term = el.querySelector('.term')!;
    this.screen = el.querySelector('.screen')!;
    this.slashMenu = el.querySelector('.slash-menu')!;
    this.menuBanner = el.querySelector('.menu-banner')!;
    this.changesEl = el.querySelector('.changes')!;
    this.changesEl.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('[data-file]');
      if (li) void this.showDiff(li.dataset.file!);
      if ((e.target as HTMLElement).closest('[data-close-diff]')) this.showDiff(null);
    });
    this.toLatest = el.querySelector('.to-latest')!;
    this.toLatest.addEventListener('click', () => {
      this.convo.scrollTo({ top: this.convo.scrollHeight, behavior: 'smooth' });
    });
    this.convo.addEventListener('scroll', () => this.updateToLatest());
    this.screen.addEventListener('keydown', (e) => this.onScreenKey(e));
    this.convo.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-back]')) return this.openSubagent(null);
      const q = t.closest<HTMLElement>('[data-queue]')?.dataset.queue;
      if (q === 'send-now' || q === 'cancel') return void this.queueAction(q);
      const opt = t.closest<HTMLElement>('.question-card .opt');
      if (opt) {
        const card = opt.closest<HTMLElement>('.question-card')!;
        return this.toggleOption(card.dataset.tool!, Number(opt.dataset.q), Number(opt.dataset.o));
      }
      if (t.closest('[data-to-term]')) return this.showTab('term');
      const send = t.closest<HTMLElement>('.question-card [data-answer]');
      if (send) return void this.sendAnswer(send.closest<HTMLElement>('.question-card')!);
      const card = t.closest<HTMLElement>('.subagent-card.openable');
      if (card) this.openSubagent(card.dataset.tool ?? null);
    });
    this.menuBanner.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-menu=esc]')) void this.pressKey('esc');
    });

    this.info.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-stop]')) void this.stopAgent();
      if (t.closest('[data-hire-here]') && this.desk) this.onHire(this.desk.id);
      if (t.closest('[data-edit-comment]')) this.editComment();
      if (t.closest('[data-save-comment]')) void this.saveComment();
      if (t.closest('[data-cancel-comment]')) this.cancelComment();
    });
    this.info.addEventListener('change', (e) => {
      const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('[data-board-status]');
      if (sel) void this.updateWorktree({ workspaceStatus: sel.value });
    });
    this.tabs.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab;
      if (t === 'convo' || t === 'term' || t === 'changes') this.showTab(t);
    });
    this.term.addEventListener('click', (e) => {
      const key = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key as TerminalKey | undefined;
      if (key) void this.pressKey(key);
    });
    this.textarea.addEventListener('input', () => this.updateSlashMenu());
    this.textarea.addEventListener('click', () => this.updateSlashMenu());
    this.textarea.addEventListener('blur', () => window.setTimeout(() => this.hideSlashMenu(), 150));
    this.slashMenu.addEventListener('mousedown', (e) => {
      const i = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i;
      if (i !== undefined) {
        e.preventDefault();
        this.acceptSlash(Number(i));
      }
    });

    el.querySelector('.close')!.addEventListener('click', () => this.onClose());
    this.compose.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.send();
    });
    this.textarea.addEventListener('keydown', (e) => {
      if (!this.slashMenu.hidden && this.slashItems.length && !e.isComposing) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const n = this.slashItems.length;
          this.slashIndex = (this.slashIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
          this.renderSlashMenu();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.hideSlashMenu();
          return;
        }
        const exact = this.slashItems[this.slashIndex]?.name === this.slashQuery();
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !exact)) {
          e.preventDefault();
          this.acceptSlash(this.slashIndex);
          return;
        }
      }
      // Enter sends, Shift+Enter is a newline; never send while a Korean/Japanese IME is composing.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        void this.send();
      }
    });
    this.textarea.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => ACCEPTED.includes(f.type));
      if (files.length) {
        e.preventDefault();
        void this.attach(files);
      }
    });
    this.compose.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.compose.classList.add('dragging');
    });
    this.compose.addEventListener('dragleave', () => this.compose.classList.remove('dragging'));
    this.compose.addEventListener('drop', (e) => {
      e.preventDefault();
      this.compose.classList.remove('dragging');
      void this.attach([...(e.dataTransfer?.files ?? [])]);
    });
    this.fileInput.addEventListener('change', () => {
      void this.attach([...(this.fileInput.files ?? [])]);
      this.fileInput.value = '';
    });
    this.attachments.addEventListener('click', (e) => {
      const i = (e.target as HTMLElement).closest<HTMLElement>('[data-remove]')?.dataset.remove;
      if (i !== undefined) {
        this.pending.splice(Number(i), 1);
        this.renderAttachments();
      }
    });
    this.focusBtn.addEventListener('click', () => void this.focus());
    this.feedback.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-retry]')?.dataset.retry;
      if (id) void this.send(id);
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(sel: Selection, snapshot: OfficeSnapshot | null): void {
    const changed = sel.deskId !== this.selection?.deskId || sel.agentId !== this.selection?.agentId;
    this.selection = sel;
    if (changed) {
      this.textarea.value = '';
      this.pending = [];
      this.renderAttachments();
      this.feedback.textContent = '';
      this.subView = null;
      this.editingComment = false;
      this.openFile = null;
      this.changesEl.querySelector<HTMLElement>('.diff-view')!.hidden = true;
      this.subagents = [];
      this.questions = [];
      this.picks.clear();
      this.resetConversation('<p class="muted">대화를 불러오는 중…</p>');
      this.screen.textContent = '';
      this.commands = [];
      this.hideSlashMenu();
      this.showTab('convo');
      if (sel.agentId) void this.loadCommands(sel.agentId);
    }
    this.el.hidden = false;
    this.refresh(snapshot);
    this.startConversation();
    if (changed || this.termTimer === null) {
      this.menuMode = false;
      this.menuBanner.hidden = true;
      this.startTerminal();
    }
    this.textarea.focus();
  }

  close(): void {
    this.selection = null;
    this.el.hidden = true;
    this.stopConversation();
    this.stopTerminal();
    this.stopChanges();
  }

  /** Re-render the header only, so the conversation scroll and a half-typed command survive live updates. */
  private lastSnapshot: OfficeSnapshot | null = null;
  /** Opens the "add an agent to this worktree" dialog. */
  onHire: (deskId: string) => void = () => {};
  /** While the comment is being edited, header refreshes must not wipe the input. */
  private editingComment = false;

  /** Orca board column as a dropdown (default columns plus whatever is set now). */
  private statusSelect(current: string | null): string {
    const labels: Record<string, string> = { todo: '할 일', 'in-progress': '진행 중', 'in-review': '리뷰 중', completed: '완료' };
    const ids = [...new Set([...Object.keys(labels), ...(current ? [current] : [])])];
    return `<select class="board-status" data-board-status title="Orca 보드 상태">${ids
      .map((id) => `<option value="${esc(id)}"${id === current ? ' selected' : ''}>📋 ${esc(labels[id] ?? id)}</option>`)
      .join('')}</select>`;
  }

  private async updateWorktree(update: { workspaceStatus?: string; comment?: string }): Promise<void> {
    if (!this.desk) return;
    try {
      await postJson('/api/worktree', { deskId: this.desk.id, ...update });
      this.feedback.textContent = '✅ Orca에 저장했습니다';
    } catch (err) {
      this.feedback.textContent = `⚠️ ${(err as Error).message}`;
    }
  }

  private editComment(): void {
    const row = this.info.querySelector<HTMLElement>('[data-comment-row]');
    if (!row || !this.desk) return;
    this.editingComment = true;
    row.innerHTML = `💬 <input class="comment-input" maxlength="200" placeholder="워크트리 코멘트 (Orca 카드에 표시)" />
      <button type="button" class="link" data-save-comment>저장</button><button type="button" class="link" data-cancel-comment>취소</button>`;
    const input = row.querySelector<HTMLInputElement>('input')!;
    input.value = this.desk.comment;
    input.focus();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) void this.saveComment();
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.cancelComment();
      }
    });
  }

  private async saveComment(): Promise<void> {
    const input = this.info.querySelector<HTMLInputElement>('.comment-input');
    if (!input) return;
    this.editingComment = false;
    await this.updateWorktree({ comment: input.value });
    this.refresh(this.lastSnapshot);
  }

  private cancelComment(): void {
    this.editingComment = false;
    this.refresh(this.lastSnapshot);
  }

  refresh(snapshot: OfficeSnapshot | null): void {
    this.lastSnapshot = snapshot;
    if (!this.selection || this.editingComment) return;
    this.desk = snapshot?.desks.find((d) => d.id === this.selection!.deskId) ?? null;
    this.agent = this.desk?.agents.find((a) => a.id === this.selection!.agentId) ?? null;
    const d = this.desk;
    const a = this.agent;
    if (!d) {
      this.info.innerHTML = `<h2>사라진 자리</h2><p class="muted">이 워크트리는 더 이상 Orca에 없습니다.</p>`;
    } else {
      this.info.innerHTML = `
        <h2>${esc(d.name)}</h2>
        <p class="muted">${d.branch ? `<code>${esc(d.branch)}</code> · ` : ''}<span class="path">${esc(d.path)}</span></p>
        <p>
          ${!a ? `<button type="button" class="hire-here" data-hire-here>🧑 에이전트 추가</button> ` : ''}${a ? `<span class="pill">${esc(a.agentType)}</span>${modelLine(a.model, a.effort) ? ` <span class="pill model">${esc(modelLine(a.model, a.effort)!)}</span>` : ''} <span class="state state-${a.state}">${STATE_LABEL[a.state] ?? a.state}</span> <span class="muted">${esc(ago(a.since))}</span>` : '<span class="pill">빈 자리</span>'}
          ${this.statusSelect(d.workspaceStatus)}
        </p>
        ${a ? `<div class="activity-row"><p class="activity">${esc(a.activity)}</p>${this.stopButton(a)}</div>` : ''}
        <p class="comment" data-comment-row>💬 <span class="comment-text">${d.comment ? esc(d.comment) : '<span class="muted">코멘트 없음</span>'}</span>
          <button type="button" class="link" data-edit-comment>편집</button></p>
        ${d.pr ? `<p class="pr">🔀 ${d.pr.url ? `<a href="${esc(d.pr.url)}" target="_blank" rel="noopener noreferrer">PR${d.pr.number ? ` #${d.pr.number}` : ''}</a>` : `PR${d.pr.number ? ` #${d.pr.number}` : ''}`}${d.pr.title ? ` · ${esc(d.pr.title)}` : ''}${d.pr.state ? ` <span class="pill">${esc(d.pr.state)}</span>` : ''}</p>` : ''}`;
    }
    const files = d?.changes?.files ?? 0;
    this.tabs.querySelector<HTMLElement>('.tab-count')!.textContent = files ? ` ${files}` : '';
    const handle = a?.terminalHandle ?? null;
    // A waiting agent usually shows a menu or permission prompt in its terminal.
    this.tabs.querySelector<HTMLElement>('.tab-alert')!.hidden = a?.state !== 'waiting';
    this.tabs.hidden = !d;
    for (const b of this.tabs.querySelectorAll<HTMLElement>('[data-tab="convo"], [data-tab="term"]')) b.hidden = !a;
    if (!a && d && this.tab !== 'changes') this.showTab('changes');
    this.sendBtn.disabled = !handle;
    this.focusBtn.disabled = !handle;
    this.textarea.disabled = !handle;
    if (!a && this.selection.agentId === null) {
      this.convo.innerHTML = '<p class="muted">이 워크트리에서 실행 중인 에이전트가 없습니다.</p>';
    }
  }

  // --- tabs, terminal mirror & menu mode ---

  private showTab(tab: 'convo' | 'term' | 'changes'): void {
    this.tab = tab;
    for (const b of this.tabs.querySelectorAll<HTMLElement>('[data-tab]')) b.classList.toggle('active', b.dataset.tab === tab);
    this.convo.hidden = tab !== 'convo';
    this.term.hidden = tab !== 'term';
    this.changesEl.hidden = tab !== 'changes';
    if (tab === 'changes') this.startChanges();
    else this.stopChanges();
    this.updateToLatest();
    // Never move keyboard focus to the terminal by itself: keys typed there go straight to the
    // agent, so only an explicit click on the screen turns that on.
    if (tab === 'term') this.startTerminal();
  }

  /**
   * Poll the agent's rendered screen while the panel is open: fast when the terminal tab is
   * visible, slower otherwise, just to notice dialogs (/usage, /config, permission prompts)
   * that take over the agent's keyboard.
   */
  private startTerminal(): void {
    this.stopTerminal();
    const agentId = this.selection?.agentId;
    if (!agentId) return;
    const tick = async () => {
      try {
        const res = await fetch(`/api/terminal?agentId=${encodeURIComponent(agentId)}`);
        const data = (await res.json()) as TerminalScreen;
        if (this.selection?.agentId !== agentId) return;
        // Trim trailing blank rows so the prompt sits at the bottom of the view.
        const lines = [...data.lines];
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        if (this.tab === 'term') {
          this.screen.textContent = data.found ? lines.join('\n') : '터미널을 찾을 수 없습니다.';
          this.screen.scrollTop = this.screen.scrollHeight;
        }
        this.setMenuMode(data.composer === 'menu');
      } catch {
        /* retry next tick */
      }
      if (this.selection?.agentId === agentId && !this.el.hidden) {
        this.termTimer = window.setTimeout(tick, this.tab === 'term' ? TERMINAL_POLL_MS : MENU_CHECK_MS);
      }
    };
    this.termTimer = window.setTimeout(tick, 0);
  }

  private stopTerminal(): void {
    if (this.termTimer !== null) window.clearTimeout(this.termTimer);
    this.termTimer = null;
  }

  // --- changes (git) ---

  private startChanges(): void {
    this.stopChanges();
    const deskId = this.selection?.deskId;
    if (!deskId) return;
    const tick = async () => {
      await this.loadChanges(deskId);
      if (this.tab === 'changes' && this.selection?.deskId === deskId) this.changesTimer = window.setTimeout(tick, 5000);
    };
    void tick();
  }

  private stopChanges(): void {
    if (this.changesTimer !== null) window.clearTimeout(this.changesTimer);
    this.changesTimer = null;
  }

  private async loadChanges(deskId: string): Promise<void> {
    const list = this.changesEl.querySelector<HTMLElement>('.file-list')!;
    try {
      const res = await fetch(`/api/changes?deskId=${encodeURIComponent(deskId)}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as ChangeSummary;
      if (this.selection?.deskId !== deskId) return;
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
    const view = this.changesEl.querySelector<HTMLElement>('.diff-view')!;
    this.openFile = file;
    for (const li of this.changesEl.querySelectorAll<HTMLElement>('[data-file]')) li.classList.toggle('open', li.dataset.file === file);
    if (!file || !this.selection) {
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
      const res = await fetch(`/api/diff?deskId=${encodeURIComponent(this.selection.deskId)}&file=${encodeURIComponent(file)}`);
      const data = (await res.json()) as FileDiffResponse & { error?: string };
      if (!res.ok) throw new Error(data.error);
      // One span per line, text only: diffs are untrusted content.
      pre.textContent = '';
      for (const line of data.diff.split('\n')) {
        const span = document.createElement('span');
        span.className = line.startsWith('+') && !line.startsWith('+++') ? 'l-add' : line.startsWith('-') && !line.startsWith('---') ? 'l-del' : line.startsWith('@@') ? 'l-hunk' : '';
        span.textContent = `${line}\n`;
        pre.append(span);
      }
      if (data.truncated) pre.append('\n… (너무 길어 잘렸습니다)');
      if (!data.diff) pre.textContent = '(내용 없음 · 바이너리 파일일 수 있습니다)';
    } catch (err) {
      pre.textContent = `⚠️ ${(err as Error).message || 'diff를 불러오지 못했습니다'}`;
    }
  }

  /** A dialog owns the agent's keyboard: show it, route keys to it, and hold back messages. */
  private setMenuMode(on: boolean): void {
    // An open AskUserQuestion dialog is answered from its card in the chat, not the terminal.
    const asking = on && this.questions.some((q) => q.status === 'pending') && !this.subView;
    const label = asking
      ? '🙋 에이전트가 질문했어요. 대화창의 질문 카드에서 답해 주세요.'
      : '🧭 에이전트 화면에 메뉴가 열려 있어요. 지금 보내는 메시지는 전달되지 않습니다.';
    this.menuBanner.querySelector('.menu-text')!.textContent = this.screenWarning ? `${label} (⚠️ 검증되지 않은 Claude Code 버전)` : label;
    if (on === this.menuMode) return;
    this.menuMode = on;
    this.menuBanner.hidden = !on;
    this.term.classList.toggle('menu-mode', on);
    if (on && asking) {
      this.convo.querySelector('.question-card[data-status="pending"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else if (on) {
      this.autoSwitched = this.tab === 'convo';
      this.showTab('term');
    } else if (this.autoSwitched) {
      this.autoSwitched = false;
      this.showTab('convo');
      this.textarea.focus();
    }
  }

  private async pressKey(key: TerminalKey | { char: string }): Promise<void> {
    const handle = this.agent?.terminalHandle;
    if (!handle) return;
    try {
      await postJson('/api/keys', typeof key === 'string' ? { terminalHandle: handle, key } : { terminalHandle: handle, char: key.char });
      this.startTerminal(); // refresh right away
    } catch (err) {
      this.feedback.textContent = `⚠️ ${(err as Error).message}`;
    }
  }

  /** Keyboard passthrough while the terminal view has focus. */
  private onScreenKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    const named: Record<string, TerminalKey> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      Enter: 'enter',
      Escape: 'esc',
      Backspace: 'backspace',
      ' ': 'space',
    };
    let key: TerminalKey | { char: string } | null = null;
    if (e.key === 'Tab') key = e.shiftKey ? 'shift-tab' : 'tab';
    else if (e.ctrlKey && e.key.toLowerCase() === 'c') key = 'ctrl-c';
    else if (named[e.key]) key = named[e.key];
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) key = { char: e.key };
    if (!key) return;
    e.preventDefault();
    e.stopPropagation(); // Esc goes to the agent, not to closing the panel
    void this.pressKey(key);
  }

  // --- slash commands ---

  private async loadCommands(agentId: string): Promise<void> {
    try {
      const res = await fetch(`/api/commands?agentId=${encodeURIComponent(agentId)}`);
      const list = (await res.json()) as SlashCommand[];
      if (this.selection?.agentId === agentId) this.commands = list;
    } catch {
      this.commands = [];
    }
  }

  /** The `/word` being typed, if the caret is still inside the first token of the message. */
  private slashQuery(): string | null {
    const v = this.textarea.value;
    if (!v.startsWith('/')) return null;
    const end = v.search(/\s/);
    const tokenEnd = end === -1 ? v.length : end;
    if (this.textarea.selectionStart > tokenEnd) return null;
    return v.slice(1, tokenEnd);
  }

  private updateSlashMenu(): void {
    const q = this.slashQuery();
    if (q === null || !this.commands.length) return this.hideSlashMenu();
    const ql = q.toLowerCase();
    // Rank: name prefix, then prefix after a plugin namespace ("brain" → superpowers:brainstorming),
    // then substring, then description match.
    const rank = (c: SlashCommand): number => {
      const n = c.name.toLowerCase();
      if (n.startsWith(ql)) return 0;
      if (n.split(':').some((part) => part.startsWith(ql))) return 1;
      if (n.includes(ql)) return 2;
      if (ql.length > 2 && c.description.toLowerCase().includes(ql)) return 3;
      return 9;
    };
    const ranked = this.commands.map((c) => [rank(c), c] as const).filter(([r]) => r < 9);
    ranked.sort((x, y) => x[0] - y[0] || x[1].name.length - y[1].name.length);
    const starts = ranked.map(([, c]) => c);
    const rest: SlashCommand[] = [];
    this.slashItems = [...starts, ...rest].slice(0, 50);
    this.slashIndex = 0;
    if (!this.slashItems.length) return this.hideSlashMenu();
    this.renderSlashMenu();
  }

  private renderSlashMenu(): void {
    const start = Math.max(0, Math.min(this.slashIndex - SLASH_MENU_SIZE + 1, this.slashItems.length - SLASH_MENU_SIZE));
    const view = this.slashItems.slice(start, start + SLASH_MENU_SIZE);
    this.slashMenu.innerHTML =
      view
        .map((c, k) => {
          const i = start + k;
          return `<div class="item${i === this.slashIndex ? ' active' : ''}" data-i="${i}">
            <span class="name">/${esc(c.name)}</span><span class="src">${SOURCE_LABEL[c.source]}</span>
            <span class="desc">${esc(c.description)}</span></div>`;
        })
        .join('') + `<div class="hint">↑↓ 이동 · Tab/Enter 선택 · Esc 닫기 · ${this.slashItems.length}개</div>`;
    this.slashMenu.hidden = false;
  }

  private hideSlashMenu(): void {
    this.slashMenu.hidden = true;
    this.slashItems = [];
  }

  private acceptSlash(i: number): void {
    const c = this.slashItems[i];
    if (!c) return;
    const v = this.textarea.value;
    const end = v.search(/\s/);
    const rest = end === -1 ? '' : v.slice(end).replace(/^\s+/, '');
    this.textarea.value = `/${c.name} ${rest}`;
    const caret = c.name.length + 2;
    this.textarea.setSelectionRange(caret, caret);
    this.hideSlashMenu();
    this.textarea.focus();
  }

  // --- conversation ---

  private resetConversation(html: string): void {
    this.unseen = 0;
    this.convoFileId = null;
    this.convoCount = 0;
    this.convo.innerHTML = html;
  }

  private startConversation(): void {
    const agentId = this.selection?.agentId ?? null;
    if (this.convoFor === agentId && this.convoTimer !== null) return;
    this.stopConversation();
    this.convoFor = agentId;
    if (!agentId) return;
    const tick = async () => {
      await this.loadConversation(agentId);
      if (this.convoFor === agentId) this.convoTimer = window.setTimeout(tick, CONVERSATION_POLL_MS);
    };
    this.convoTimer = window.setTimeout(tick, 0);
  }

  private stopConversation(): void {
    if (this.convoTimer !== null) window.clearTimeout(this.convoTimer);
    this.convoTimer = null;
    this.convoFor = null;
  }

  private async loadConversation(agentId: string): Promise<void> {
    let data: ConversationResponse;
    try {
      const sub = this.subView?.agentId ? `&sub=${encodeURIComponent(this.subView.agentId)}` : '';
      const res = await fetch(`/api/conversation?agentId=${encodeURIComponent(agentId)}&after=${this.convoCount}${sub}`);
      data = (await res.json()) as ConversationResponse;
    } catch {
      return; // bridge hiccup; next tick retries
    }
    if (this.convoFor !== agentId) return;
    this.subagents = data.subagents ?? [];
    this.updateSubagentCards();
    this.screenWarning =
      data.screenSupport === 'untested'
        ? `Claude Code ${data.claudeVersion}은(는) 화면 해석이 검증되지 않은 버전이에요. 질문 카드와 메뉴 감지가 틀릴 수 있으니 이상하면 터미널 탭을 써 주세요.`
        : null;
    this.questions = data.questions ?? [];
    this.updateQuestionCards();
    this.renderPending(data.pending ?? []);
    // We may have jumped to the terminal before learning the dialog is a question: come back to its card.
    if (this.menuMode && this.autoSwitched && this.tab === 'term' && this.questions.some((q) => q.status === 'pending')) {
      this.autoSwitched = false;
      this.showTab('convo');
      this.setMenuMode(true);
    }

    if (!data.found) {
      if (this.convoFileId === null && this.convoCount === 0 && this.convo.dataset.reason === data.reason) return;
      const fallback = this.agent?.lastMessage
        ? `<div class="msg msg-assistant"><div class="meta">마지막 메시지</div><div class="md">${renderMarkdown(this.agent.lastMessage)}</div></div>`
        : '';
      this.resetConversation(`<p class="muted">${esc(data.reason ?? '대화 기록을 찾지 못했습니다.')}</p>${fallback}`);
      this.convo.dataset.reason = data.reason ?? '';
      return;
    }
    delete this.convo.dataset.reason;

    if (data.fileId !== this.convoFileId || data.after !== this.convoCount) {
      // New session (or our view is out of sync): start over from the first message.
      if (data.after !== 0) {
        this.convoFileId = null;
        this.convoCount = 0;
        return this.loadConversation(agentId);
      }
      this.convo.innerHTML = this.subView
        ? `<div class="sub-header"><button type="button" data-back>← 메인 대화</button>
             <span>🤖 <b>${esc(this.subView.description)}</b> <span class="muted">${esc(this.subView.agentType)}</span></span></div>`
        : data.title
          ? `<p class="convo-title">📝 ${esc(data.title)}</p>`
          : '';
      if (!data.messages.length) this.convo.innerHTML += '<p class="muted empty">아직 대화가 없습니다.</p>';
      this.convoFileId = data.fileId;
      this.convoCount = 0;
    }
    if (!data.messages.length) return;

    const el = this.convo;
    const atBottom = this.convoCount === 0 || el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    el.querySelector('.empty')?.remove();
    this.appendMessages(data.messages, agentId, this.convoCount);
    this.renderPending(data.pending ?? [], true);
    if (!atBottom && this.convoCount > 0) this.unseen += data.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;
    this.convoCount = data.after + data.messages.length;
    if (atBottom) el.scrollTop = el.scrollHeight;
    this.updateToLatest();
  }

  /** Show "jump to latest" while scrolled up, with a count of messages that arrived meanwhile. */
  private updateToLatest(): void {
    const el = this.convo;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottom) this.unseen = 0;
    this.toLatest.hidden = atBottom || el.hidden;
    this.toLatest.textContent = this.unseen ? `⬇ 새 메시지 ${this.unseen}` : '⬇ 최신으로';
    // Float just above the compose box, whatever its current height.
    this.toLatest.style.bottom = `${this.compose.offsetHeight + 14}px`;
  }

  private pendingKey = '';
  /** Set when the agent runs a Claude Code version our screen parsing wasn't tested against. */
  private screenWarning: string | null = null;
  /** "Stop" needs a second click within a few seconds, so a stray click can't interrupt an agent. */
  private stopArmedUntil = 0;

  private stopButton(a: OfficeAgent): string {
    if (!a.terminalHandle || !['typing', 'reading', 'running'].includes(a.state)) return '';
    const armed = Date.now() < this.stopArmedUntil;
    return `<button type="button" class="stop${armed ? ' armed' : ''}" data-stop title="에이전트의 현재 작업을 중단합니다 (Esc)">${armed ? '한 번 더 누르면 중단' : '⏹ 중단'}</button>`;
  }

  private async stopAgent(): Promise<void> {
    const handle = this.agent?.terminalHandle;
    if (!handle) return;
    if (Date.now() >= this.stopArmedUntil) {
      this.stopArmedUntil = Date.now() + 4000;
      this.refresh(this.lastSnapshot);
      window.setTimeout(() => this.refresh(this.lastSnapshot), 4100);
      return;
    }
    this.stopArmedUntil = 0;
    try {
      await postJson('/api/keys', { terminalHandle: handle, key: 'esc' });
      this.feedback.textContent = '⏹ 중단했습니다';
    } catch (err) {
      this.feedback.textContent = `⚠️ ${(err as Error).message}`;
    }
    this.refresh(this.lastSnapshot);
  }

  private async queueAction(action: 'send-now' | 'cancel'): Promise<void> {
    const handle = this.agent?.terminalHandle;
    if (!handle) return;
    try {
      await postJson('/api/queue', { terminalHandle: handle, action });
      this.feedback.textContent = action === 'send-now' ? '⚡ 대기 메시지를 지금 보냈습니다 (진행 중이던 작업은 멈춤)' : '🗑 대기 메시지를 취소했습니다';
    } catch (err) {
      this.feedback.textContent = `⚠️ ${(err as Error).message}`;
    }
  }

  /** Messages queued while the agent works: shown at the very end until the agent picks them up. */
  private renderPending(pending: { text: string; ts: string | null }[], force = false): void {
    const key = JSON.stringify(pending);
    let box = this.convo.querySelector<HTMLElement>('.pending-queue');
    if (!force && key === this.pendingKey && box) return;
    this.pendingKey = key;
    if (!pending.length) {
      box?.remove();
      return;
    }
    if (!box) {
      box = document.createElement('div');
      box.className = 'pending-queue';
    }
    box.innerHTML = '';
    if (this.agent?.agentType === 'claude') {
      const bar = document.createElement('div');
      bar.className = 'pending-actions';
      bar.innerHTML = `<span>⏳ 대기 중인 메시지 ${pending.length}개</span>
        <button type="button" data-queue="send-now" title="진행 중인 작업을 멈추고 지금 보냅니다 (Ctrl+Enter)">⚡ 지금 보내기</button>
        <button type="button" data-queue="cancel" title="대기 중인 메시지를 지웁니다">🗑 취소</button>`;
      box.append(bar);
    }
    for (const p of pending) {
      const div = document.createElement('div');
      div.className = 'msg msg-user msg-pending';
      div.innerHTML = '<div class="meta">나 · ⏳ 전달 대기 중</div><div class="md"></div>';
      div.querySelector('.md')!.textContent = p.text;
      box.append(div);
    }
    this.convo.append(box); // always last
  }

  /** (Re)draw question cards whose status changed; keeps in-progress selections. */
  private updateQuestionCards(): void {
    for (const card of this.convo.querySelectorAll<HTMLElement>('.question-card')) {
      const q = this.questions.find((x) => x.toolUseId === card.dataset.tool);
      if (!q) continue;
      const key = `${q.status}|${JSON.stringify(this.picks.get(q.toolUseId) ?? [])}`;
      if (card.dataset.key === key) continue;
      card.dataset.key = key;
      card.dataset.status = q.status;
      card.innerHTML = this.questionHtml(q);
    }
  }

  private questionHtml(q: QuestionState): string {
    const picks = this.picks.get(q.toolUseId) ?? q.questions.map(() => []);
    const head = { pending: '🙋 에이전트의 질문', answered: '✅ 답변함', cancelled: '✖ 취소된 질문' }[q.status];
    const body = q.questions
      .map((item, qi) => {
        const answer = q.answers[item.question];
        const options =
          q.status === 'pending'
            ? `<div class="options">${item.options
                .map(
                  (o, oi) => `<button type="button" class="opt${picks[qi]?.includes(oi) ? ' picked' : ''}" data-q="${qi}" data-o="${oi}">
                    <span class="mark">${item.multiSelect ? (picks[qi]?.includes(oi) ? '☑' : '☐') : picks[qi]?.includes(oi) ? '◉' : '○'}</span>
                    <span class="label">${esc(o.label)}</span>${o.description ? `<span class="hint">${esc(o.description)}</span>` : ''}</button>`,
                )
                .join('')}</div>`
            : answer
              ? `<p class="answer">→ ${esc(answer)}</p>`
              : '';
        return `<div class="q">${item.header ? `<span class="chip">${esc(item.header)}</span>` : ''}${item.multiSelect && q.status === 'pending' ? '<span class="multi">여러 개 선택</span>' : ''}
          <p class="text">${esc(item.question)}</p>${options}</div>`;
      })
      .join('');
    const ready = q.questions.every((item, qi) => (item.multiSelect ? (picks[qi]?.length ?? 0) > 0 : picks[qi]?.length === 1));
    const foot =
      q.status === 'pending'
        ? `<div class="q-foot"><span class="q-msg"></span><button type="button" class="to-term" data-to-term hidden>🖥️ 터미널에서 답하기</button><button type="button" class="send-answer" data-answer ${ready ? '' : 'disabled'}>답변 보내기</button></div>`
        : '';
    const warn = q.status === 'pending' && this.screenWarning ? `<p class="q-warn">⚠️ ${esc(this.screenWarning)}</p>` : '';
    return `<div class="q-head">${head}</div>${warn}${body}${foot}`;
  }

  private toggleOption(toolUseId: string, qi: number, oi: number): void {
    const q = this.questions.find((x) => x.toolUseId === toolUseId);
    if (!q || q.status !== 'pending') return;
    const picks = this.picks.get(toolUseId) ?? q.questions.map(() => [] as number[]);
    const cur = picks[qi] ?? [];
    picks[qi] = q.questions[qi].multiSelect ? (cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi].sort()) : [oi];
    this.picks.set(toolUseId, picks);
    this.updateQuestionCards();
  }

  private async sendAnswer(card: HTMLElement): Promise<void> {
    const toolUseId = card.dataset.tool!;
    const agentId = this.selection?.agentId;
    const picks = this.picks.get(toolUseId);
    const msg = card.querySelector<HTMLElement>('.q-msg');
    const btn = card.querySelector<HTMLButtonElement>('[data-answer]');
    if (!agentId || !picks) return;
    if (btn) btn.disabled = true;
    if (msg) msg.textContent = '터미널에 답을 입력하는 중…';
    try {
      await postJson('/api/answer', { agentId, toolUseId, choices: picks });
      if (msg) msg.textContent = '✅ 보냈습니다';
    } catch (err) {
      if (msg) msg.textContent = `⚠️ ${(err as Error).message}`;
      if (btn) btn.disabled = false;
      // Way out when the dialog couldn't be driven: answer it in the terminal view.
      const toTerm = card.querySelector<HTMLElement>('[data-to-term]');
      if (toTerm) toTerm.hidden = false;
    }
  }

  /** Refresh status badges on subagent cards (status changes long after the card was appended). */
  private updateSubagentCards(): void {
    const label = { running: '진행 중', done: '완료', failed: '실패' } as const;
    for (const card of this.convo.querySelectorAll<HTMLElement>('.subagent-card')) {
      const info = this.subagents.find((s) => s.toolUseId === card.dataset.tool);
      if (!info) continue;
      card.dataset.status = info.status;
      card.classList.toggle('openable', Boolean(info.agentId));
      card.title = info.agentId ? '눌러서 이 서브에이전트의 대화 보기' : '';
      card.querySelector('.badge')!.textContent = `${label[info.status]} · ${info.agentType}`;
    }
  }

  private openSubagent(toolUseId: string | null): void {
    const info = toolUseId ? this.subagents.find((s) => s.toolUseId === toolUseId && s.agentId) : null;
    if (toolUseId && !info) return;
    this.subView = info ?? null;
    this.resetConversation('<p class="muted">대화를 불러오는 중…</p>');
    this.stopConversation();
    this.startConversation();
  }

  /** Append messages, folding runs of tool calls into one collapsible line (continuing the last run). */
  private appendMessages(messages: ConversationMessage[], agentId: string, firstIndex: number): void {
    messages.forEach((m, k) => {
      if (m.role === 'question' && m.toolUseId) {
        const card = document.createElement('div');
        card.className = 'question-card';
        card.dataset.tool = m.toolUseId;
        this.convo.append(card);
        this.updateQuestionCards();
        return;
      }
      if (m.role === 'subagent' && m.toolUseId) {
        const card = document.createElement('div');
        card.className = 'subagent-card';
        card.dataset.tool = m.toolUseId;
        card.innerHTML = `<span class="who">🤖 서브에이전트</span> <span class="desc"></span> <span class="badge"></span>`;
        card.querySelector('.desc')!.textContent = m.text;
        this.convo.append(card);
        this.updateSubagentCards();
        return;
      }
      if (m.role === 'tool') {
        let group = this.convo.lastElementChild;
        if (!group?.matches('details.tools')) {
          group = document.createElement('details');
          group.className = 'tools';
          group.innerHTML = '<summary></summary><ol></ol>';
          this.convo.append(group);
        }
        const list = group.querySelector('ol')!;
        const li = document.createElement('li');
        li.textContent = m.text;
        list.append(li);
        group.querySelector('summary')!.textContent = `🔧 도구 ${list.childElementCount}회 · ${m.text}`;
        return;
      }
      const index = firstIndex + k;
      const imgs = (m.images ?? []).map(
        (i) => `<img class="shot" loading="lazy" src="/api/conversation/image?agentId=${encodeURIComponent(agentId)}&i=${i}" alt="이미지 ${i + 1}" />`,
      );
      const uploads: string[] = [];
      const text = m.text.replace(UPLOAD_PATH, (_line, name: string) => {
        uploads.push(`<img class="shot" loading="lazy" src="/api/uploads/${encodeURIComponent(name)}" alt="첨부 이미지" />`);
        return '';
      });
      const localImage = (p: string) =>
        /^(\/|[A-Za-z]:[\\/])/.test(p) ? `/api/local-image?agentId=${encodeURIComponent(agentId)}&path=${encodeURIComponent(p)}` : null;
      const div = document.createElement('div');
      div.className = `msg msg-${m.role}`;
      div.dataset.index = String(index);
      div.innerHTML = `<div class="meta">${m.role === 'user' ? (m.queued ? '나 · 작업 중 추가' : '나') : '에이전트'} <time>${clock(m.ts)}</time></div>
        ${text.trim() ? `<div class="md">${renderMarkdown(text, { localImage })}</div>` : ''}
        ${[...imgs, ...uploads].length ? `<div class="shots">${[...imgs, ...uploads].join('')}</div>` : ''}`;
      this.convo.append(div);
    });
  }

  // --- compose ---

  private async attach(files: File[]): Promise<void> {
    const images = files.filter((f) => ACCEPTED.includes(f.type));
    if (!images.length) {
      this.feedback.textContent = '⚠️ png, jpg, gif, webp 이미지만 첨부할 수 있습니다';
      return;
    }
    const room = MAX_ATTACH - this.pending.length;
    if (images.length > room) this.feedback.textContent = `⚠️ 이미지는 ${MAX_ATTACH}장까지 첨부됩니다`;
    for (const f of images.slice(0, room)) {
      if (f.size > 10 * 1024 * 1024) {
        this.feedback.textContent = '⚠️ 10MB를 넘는 이미지는 첨부할 수 없습니다';
        continue;
      }
      this.pending.push(await readAsUpload(f));
    }
    this.renderAttachments();
    this.textarea.focus();
  }

  private renderAttachments(): void {
    this.attachments.innerHTML = this.pending
      .map((p, i) => `<span class="thumb"><img src="${p.url}" alt="" /><button type="button" data-remove="${i}" title="빼기">✕</button></span>`)
      .join('');
    this.attachments.hidden = this.pending.length === 0;
  }

  private async send(retryId?: string): Promise<void> {
    const handle = this.agent?.terminalHandle;
    const text = this.textarea.value.trim();
    if (!handle || (!retryId && !text && !this.pending.length)) return;
    this.sendBtn.disabled = true;
    this.feedback.textContent = retryId ? '다시 보내는 중…' : '보내는 중…';
    try {
      if (retryId) await postJson('/api/send/retry', { requestId: retryId });
      else {
        await postJson('/api/send', {
          terminalHandle: handle,
          text,
          images: this.pending.map(({ mediaType, data }) => ({ mediaType, data })),
        });
      }
      this.textarea.value = '';
      this.pending = [];
      this.renderAttachments();
      this.hideSlashMenu();
      this.feedback.textContent = '✅ 전달됨';
      // Built-in slash commands (/config, /model, …) answer with a menu in the terminal, not in the chat.
      const cmd = /^\/([\w:-]+)/.exec(text)?.[1];
      if (cmd && this.commands.find((c) => c.name === cmd)?.source === 'builtin') this.showTab('term');
    } catch (err) {
      const e = err as ApiError;
      if (e.code === 'agent_busy' && e.requestId) {
        // Orca held the prompt back; offer a safe retry of the very same message.
        this.feedback.innerHTML = `⏳ ${esc(e.message)} <button type="button" class="retry" data-retry="${esc(e.requestId)}">다시 보내기</button>`;
      } else if (/메뉴가 열려/.test(e.message)) {
        // The bridge refused because a dialog is open: show it so it can be closed first.
        this.setMenuMode(true);
        this.feedback.textContent = '⚠️ 메뉴를 닫은 뒤 다시 보내주세요 (입력한 내용은 그대로 있어요)';
      } else {
        this.feedback.textContent = `⚠️ ${e.message}`;
      }
    } finally {
      this.sendBtn.disabled = false;
    }
  }

  private async focus(): Promise<void> {
    const handle = this.agent?.terminalHandle;
    if (!handle) return;
    try {
      await postJson('/api/focus', { terminalHandle: handle });
      this.feedback.textContent = '↗ Orca에서 열었습니다';
    } catch (err) {
      this.feedback.textContent = `⚠️ ${(err as Error).message}`;
    }
  }
}
