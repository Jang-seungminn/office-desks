// In-page modals (never window.confirm: unverified under wry/WKWebView). Every string goes in via textContent.
export interface ConfirmOpts { title: string; body: string; confirm: string; danger?: boolean }
export interface WorkValues { name: string; baseBranch: string; agent: string; prompt: string }
export interface AgentValues { agent: string; prompt: string }

const AGENTS: [string, string][] = [['claude', 'Claude Code'], ['codex', 'Codex'], ['gemini', 'Gemini']];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function modalRoot(): HTMLElement {
  let r = document.getElementById('modal-root');
  if (!r) {
    r = el('div');
    r.id = 'modal-root';
    document.body.append(r);
  }
  return r;
}

function field(label: string, input: HTMLElement): HTMLElement {
  const l = el('label', 'field');
  l.append(el('span', 'field-label', label), input);
  return l;
}

function input(attrs: Record<string, string>): HTMLInputElement {
  const i = el('input');
  i.type = 'text';
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
  return i;
}

function agentSelect(): HTMLSelectElement {
  const s = el('select');
  for (const [v, t] of AGENTS) {
    const o = el('option', undefined, t);
    o.value = v;
    s.append(o);
  }
  return s;
}

function textarea(placeholder: string): HTMLTextAreaElement {
  const t = el('textarea');
  t.rows = 4;
  t.placeholder = placeholder;
  return t;
}

/** Generic shell. `build` fills the form; `read` returns the result (or null to refuse, e.g. invalid). */
function open<T>(
  title: string,
  submitLabel: string,
  build: (form: HTMLElement) => void,
  read: () => T | null,
  opts: { danger?: boolean; noForm?: boolean } = {},
): Promise<T | null> {
  return new Promise((resolve) => {
    const root = modalRoot();
    const backdrop = el('div', 'modal-backdrop');
    const box = el('div', 'modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const head = el('div', 'modal-head');
    const close = el('button', 'modal-close', '✕');
    close.type = 'button';
    close.title = '닫기';
    head.append(el('h2', undefined, title), close);
    const form = el('form', 'modal-form');
    form.noValidate = true; // submit() trims, then validates itself
    build(form);
    const foot = el('div', 'modal-foot');
    const cancel = el('button', 'modal-cancel', '취소');
    cancel.type = 'button';
    const ok = el('button', opts.danger ? 'modal-ok danger' : 'modal-ok', submitLabel);
    ok.type = 'submit';
    foot.append(cancel, ok);
    form.append(foot);
    box.append(head, form);
    backdrop.append(box);

    const prevFocus = document.activeElement as HTMLElement | null;
    let done = false;
    const finish = (v: T | null): void => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      prevFocus?.focus?.();
      resolve(v);
    };
    const submit = (): void => {
      for (const i of form.querySelectorAll<HTMLInputElement>('input')) i.value = i.value.trim();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      const v = read();
      if (v !== null) finish(v);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    // Enter in a text input submits, except while an IME composition is active.
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.isComposing || e.keyCode === 229) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if ((e.target as HTMLElement).tagName === 'INPUT') {
        e.preventDefault();
        submit();
      }
    });
    cancel.addEventListener('click', () => finish(null));
    close.addEventListener('click', () => finish(null));
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) finish(null);
    });
    root.append(backdrop);
    const first = form.querySelector<HTMLElement>('input, textarea, select');
    (first ?? (opts.danger ? cancel : ok)).focus();
  });
}

export async function confirmModal(o: ConfirmOpts): Promise<boolean> {
  const r = await open<true>(
    o.title,
    o.confirm,
    (f) => f.append(el('p', 'modal-body', o.body)),
    () => true,
    { danger: o.danger },
  );
  return r === true;
}

export function workModal(repoName: string): Promise<WorkValues | null> {
  let name!: HTMLInputElement, base!: HTMLInputElement, agent!: HTMLSelectElement, prompt!: HTMLTextAreaElement;
  return open<WorkValues>(
    `➕ 새 작업 시작 — ${repoName}`,
    '만들기',
    (f) => {
      name = input({ required: '', maxlength: '60', pattern: '[A-Za-z0-9][A-Za-z0-9._\\-]*', placeholder: 'fix-login-redirect' });
      base = input({ maxlength: '120', placeholder: 'origin/main' });
      agent = agentSelect();
      prompt = textarea('무엇을 해야 하는지 적어 주세요');
      f.append(
        field('워크트리 이름 (브랜치 이름이 됩니다)', name),
        field('기준 브랜치 (비우면 저장소 기본값)', base),
        field('에이전트', agent),
        field('첫 지시 (선택)', prompt),
      );
    },
    () => ({ name: name.value.trim(), baseBranch: base.value.trim(), agent: agent.value, prompt: prompt.value.trim() }),
  );
}

export function agentModal(deskName: string): Promise<AgentValues | null> {
  let agent!: HTMLSelectElement, prompt!: HTMLTextAreaElement;
  return open<AgentValues>(
    `🧑 ${deskName}에 에이전트 추가`,
    '에이전트 띄우기',
    (f) => {
      agent = agentSelect();
      prompt = textarea('무엇을 해야 하는지 적어 주세요');
      f.append(field('에이전트', agent), field('첫 지시 (선택)', prompt));
    },
    () => ({ agent: agent.value, prompt: prompt.value.trim() }),
  );
}

export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  let host = document.getElementById('toast-root');
  if (!host) {
    host = el('div');
    host.id = 'toast-root';
    document.body.append(host);
  }
  const t = el('div', kind === 'error' ? 'toast error' : 'toast', text);
  host.append(t);
  setTimeout(() => t.remove(), 4000);
}
