import type { OfficeAgent, OfficeDesk, OfficeSnapshot } from '../../bridge/src/model';
import { shortcutLabel } from './keymap';
import { projects, STATE_LABEL } from './tree';

export interface SidebarDeps {
  openAgent(desk: OfficeDesk, agent: OfficeAgent): void;
  newWork(repoId: string): void;
  addAgent(desk: OfficeDesk): void;
  stop(desk: OfficeDesk, agent: OfficeAgent): void;
  remove(desk: OfficeDesk): void;
  addProject(): void;
  openOffice(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(text: string, cls: string, onClick: (e: MouseEvent) => void, title?: string): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/** Project tree. Every string from the snapshot is set via textContent. */
export class Sidebar {
  hidden = false;
  selectedRepoId: string | null = null;
  private banner = el('div', 'sidebar-banner');
  private conn = el('div', 'sidebar-banner');
  private tree = el('div', 'sidebar-body');
  private last: OfficeSnapshot | null = null;
  private connected = true;

  constructor(private root: HTMLElement, private deps: SidebarDeps) {
    const head = el('div', 'sidebar-head');
    head.append(
      el('h1', undefined, '공방'),
      btn('＋ 프로젝트', 'add-project', () => deps.addProject()),
      btn('🏢 사무실', 'open-office', () => deps.openOffice()),
    );
    this.banner.hidden = true;
    this.conn.hidden = true;
    root.replaceChildren(head, this.conn, this.banner, this.tree);
  }

  toggle(): void {
    this.hidden = !this.hidden;
    document.body.classList.toggle('sidebar-hidden', this.hidden);
  }

  setConnected(c: boolean): void {
    this.connected = c;
    this.conn.hidden = c;
    this.conn.textContent = c ? '' : '공방 서버에 다시 연결하는 중…';
  }

  render(s: OfficeSnapshot | null): void {
    this.last = s;
    this.banner.hidden = !s?.error;
    this.banner.textContent = s?.error ? `⚠️ ${s.error}` : '';
    const ps = projects(s);
    if (ps.length === 0) {
      this.tree.replaceChildren(el('div', 'empty', '프로젝트가 없어요 — ＋ 프로젝트로 git 저장소 폴더를 골라 주세요'));
      return;
    }
    const nodes: HTMLElement[] = [];
    for (const p of ps) {
      const sec = el('section', 'project');
      sec.dataset.repo = p.repoId;
      const h = el('div', 'project-head');
      const sc = shortcutLabel('newWork');
      h.append(
        el('span', 'project-name', `📁 ${p.name}`),
        btn('＋ 새 작업', 'new-work', () => {
          this.selectedRepoId = p.repoId;
          this.deps.newWork(p.repoId);
        }, `새 작업 (${sc})`),
      );
      sec.append(h);
      for (const d of p.desks) {
        const w = el('div', 'worktree');
        w.dataset.desk = d.id;
        const wh = el('div', 'worktree-head');
        const label = el('span', 'worktree-name', `${d.isMain ? '🏠' : '🌿'} ${d.name}`);
        wh.append(label, el('span', 'muted branch', d.branch));
        const actions = el('span', 'worktree-actions');
        actions.append(
          btn('🧑 에이전트 추가', 'add-agent', () => {
            this.selectedRepoId = p.repoId;
            this.deps.addAgent(d);
          }),
        );
        if (!d.isMain) actions.append(btn('🗑 워크트리 삭제', 'remove-worktree danger', () => {
          this.selectedRepoId = p.repoId;
          this.deps.remove(d);
        }));
        wh.append(actions);
        w.append(wh);
        if (d.agents.length === 0) w.append(el('div', 'muted empty-seat', '빈 자리'));
        for (const a of d.agents) {
          const row = el('div', 'agent');
          row.dataset.agent = a.id;
          row.tabIndex = 0;
          row.setAttribute('role', 'button');
          const open = (): void => {
            this.selectedRepoId = p.repoId;
            this.deps.openAgent(d, a);
          };
          row.addEventListener('click', open);
          row.addEventListener('keydown', (e) => {
            if (e.target === row && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              open();
            }
          });
          row.append(
            el('span', 'agent-type', a.agentType),
            el('span', `state state-${a.state}`, STATE_LABEL[a.state] ?? String(a.state)),
            btn('⏹ 중지', 'stop-agent danger', (e) => {
              e.stopPropagation();
              this.deps.stop(d, a);
            }),
          );
          w.append(row);
        }
        sec.append(w);
      }
      nodes.push(sec);
    }
    this.tree.replaceChildren(...nodes);
  }
}
