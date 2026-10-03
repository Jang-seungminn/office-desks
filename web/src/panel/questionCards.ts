import type { QuestionState } from '../../../bridge/src/model';
import { postJson } from '../api';
import { esc } from './util';

/** AskUserQuestion cards in the chat: pick options, send the answer, show the outcome. */
export class QuestionCards {
  private questions: QuestionState[] = [];
  /** Selections on unanswered cards, per toolUseId: chosen option indexes per question. */
  private picks = new Map<string, number[][]>();
  private warning: string | null = null;

  constructor(
    private readonly convo: HTMLElement,
    private readonly agentId: () => string | null,
  ) {}

  /** New data from the bridge (and the untested-version warning, if any). */
  set(questions: QuestionState[], warning: string | null): void {
    this.questions = questions;
    this.warning = warning;
    this.update();
  }

  reset(): void {
    this.questions = [];
    this.picks.clear();
  }

  get hasPending(): boolean {
    return this.questions.some((q) => q.status === 'pending');
  }

  /** (Re)draw cards whose status or selection changed; keeps in-progress selections. */
  update(): void {
    for (const card of this.convo.querySelectorAll<HTMLElement>('.question-card')) {
      const q = this.questions.find((x) => x.toolUseId === card.dataset.tool);
      if (!q) continue;
      const key = `${q.status}|${JSON.stringify(this.picks.get(q.toolUseId) ?? [])}|${this.warning ?? ''}`;
      if (card.dataset.key === key) continue;
      card.dataset.key = key;
      card.dataset.status = q.status;
      card.innerHTML = this.html(q);
    }
  }

  toggle(toolUseId: string, qi: number, oi: number): void {
    const q = this.questions.find((x) => x.toolUseId === toolUseId);
    if (!q || q.status !== 'pending') return;
    const picks = this.picks.get(toolUseId) ?? q.questions.map(() => [] as number[]);
    const cur = picks[qi] ?? [];
    picks[qi] = q.questions[qi].multiSelect ? (cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi].sort()) : [oi];
    this.picks.set(toolUseId, picks);
    this.update();
  }

  async answer(card: HTMLElement): Promise<void> {
    const toolUseId = card.dataset.tool!;
    const agentId = this.agentId();
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

  private html(q: QuestionState): string {
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
    const warn = q.status === 'pending' && this.warning ? `<p class="q-warn">⚠️ ${esc(this.warning)}</p>` : '';
    return `<div class="q-head">${head}</div>${warn}${body}${foot}`;
  }
}
