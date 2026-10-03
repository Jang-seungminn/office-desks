import Phaser from 'phaser';
import type { OfficeSnapshot } from '../../bridge/src/model';
import { connectOffice, type ConnectionState } from './api';
import { OfficeScene, type Selection } from './officeScene';
import { Panel } from './panel';
import { modelLine } from './format';
import { loadPixelFonts } from './fonts';
import { HireDialog } from './hireDialog';
import { SearchDialog } from './searchDialog';
import { Notices, type Attention } from './notices';
import type { UsageSnapshot } from '../../bridge/src/model';
import './style.css';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const scene = new OfficeScene();
// `?debug` exposes the scene for poking at it from the browser console.
if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __office: OfficeScene }).__office = scene;
// Canvas text is drawn once with whatever font is ready, so load the pixel fonts first.
void loadPixelFonts().then(() => new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#c8b48e',
  pixelArt: true,
  // Don't let Phaser listen on window: clicks on the panel would otherwise hit desks under it.
  input: { windowEvents: false },
  scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
  scene,
}));

let snapshot: OfficeSnapshot | null = null;
let connection: ConnectionState = 'connecting';
const statusBar = document.getElementById('status-bar')!;
statusBar.innerHTML = '<div class="status-left"></div><div class="usage"></div>';
const statusLeft = statusBar.querySelector<HTMLElement>('.status-left')!;
const usageEl = statusBar.querySelector<HTMLElement>('.usage')!;

/** Plan usage like Orca's status bar: 5-hour session, weekly, Fable weekly. */
function renderUsage(u: UsageSnapshot): void {
  const claude = u.providers[0];
  scene.setUsageLine(claude ? claude.windows.slice(0, 2).map((w) => `${w.label} ${w.usedPercent}%`).join(' · ') : null);
  usageEl.innerHTML = u.providers
    .flatMap((p) =>
      p.windows.map((w) => {
        const level = w.usedPercent >= 85 ? 'high' : w.usedPercent >= 60 ? 'mid' : 'low';
        const reset = w.resetDescription ? ` · ${esc(w.resetDescription)} 리셋` : '';
        return `<span class="meter" title="${esc(p.provider)} ${esc(w.label)} 사용량 ${w.usedPercent}%${reset}">
          <span class="name">${esc(w.label)}</span>
          <span class="bar"><span class="fill ${level}" data-pct="${w.usedPercent}"></span></span>
          <span class="pct">${w.usedPercent}%</span>${w.resetDescription ? `<span class="reset">${esc(w.resetDescription)}</span>` : ''}
        </span>`;
      }),
    )
    .join('');
  // CSP forbids inline style attributes; set widths through the CSSOM instead.
  for (const f of usageEl.querySelectorAll<HTMLElement>('.fill')) f.style.width = `${f.dataset.pct}%`;
}
const panel = new Panel(document.getElementById('panel')!, () => {
  panel.close();
  scene.setSelection(null);
  openSelection = null;
});

function select(sel: Selection): void {
  openSelection = sel;
  scene.setSelection(sel);
  panel.open(sel, snapshot);
  tooltip.hidden = true;
  if (sel.agentId) {
    notices.markSeen(sel.agentId);
    refreshAttention();
  }
}

// --- "new report" badges and desktop notifications ---
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
const notices = new Notices(storage());
let attention: Attention[] = [];
let openSelection: Selection | null = null;

function refreshAttention(): void {
  if (!snapshot) return;
  // Whatever you're looking at right now counts as read.
  if (openSelection?.agentId && document.visibilityState === 'visible' && panel.isOpen) notices.markSeen(openSelection.agentId);
  attention = notices.attention(snapshot);
  scene.setAttention(new Map(attention.map((a) => [a.agentId, a.kind])));
  renderStatus();
}

function notify(changes: Attention[]): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  for (const c of changes) {
    if (document.visibilityState === 'visible' && panel.isOpen && openSelection?.agentId === c.agentId) continue;
    const desk = snapshot?.desks.find((d) => d.id === c.deskId);
    const agent = desk?.agents.find((a) => a.id === c.agentId);
    if (!desk || !agent) continue;
    const body = (agent.lastMessage ?? agent.activity).replace(/[#*`_>]/g, '').replace(/\s+/g, ' ').slice(0, 140);
    const n = new Notification(`${desk.name}: ${c.kind === 'waiting' ? '확인이 필요해요' : '작업 완료'}`, { body, tag: c.agentId });
    n.onclick = () => {
      window.focus();
      select({ deskId: c.deskId, agentId: c.agentId });
      n.close();
    };
  }
}
document.addEventListener('visibilitychange', refreshAttention);
scene.onSelect = (sel) => {
  openSelection = sel;
  select(sel);
};

const hire = new HireDialog(document.getElementById('modal')!, () => snapshot);
panel.onHire = (deskId) => hire.open({ deskId });
const searchBox = new SearchDialog(document.getElementById('modal')!);
searchBox.onOpen = (deskId, agentId, query) => {
  select({ deskId, agentId });
  panel.highlight(query);
};

// Hover tooltip: full names and activity that the desk labels have to shorten.
const tooltip = document.getElementById('tooltip')!;
scene.onHover = (info) => {
  const desk = info && snapshot?.desks.find((d) => d.id === info.deskId);
  if (!info || !desk) {
    tooltip.hidden = true;
    return;
  }
  const agent = desk.agents.find((a) => a.id === info.agentId);
  tooltip.innerHTML = `<b>${esc(desk.name)}</b>${desk.branch ? ` <span class="dim">⎇ ${esc(desk.branch)}</span>` : ''}<br>
    ${agent ? `${esc(agent.agentType)}${modelLine(agent.model, agent.effort) ? ` <span class="dim">(${esc(modelLine(agent.model, agent.effort)!)})</span>` : ''} · ${esc(agent.activity)}` : '<span class="dim">빈 자리</span>'}
    ${agent?.subagentsRunning ? `<br>🤖 서브에이전트 ${agent.subagentsRunning}명 작업 중` : ''}
    ${desk.comment ? `<br>💬 ${esc(desk.comment)}` : ''}<br><span class="dim">클릭해서 대화 보기</span>`;
  tooltip.hidden = false;
  const x = Math.min(info.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
  const y = Math.min(info.clientY + 16, window.innerHeight - tooltip.offsetHeight - 40);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
};

// Leaving the canvas for the panel/status bar must also drop the hover state.
for (const id of ['panel', 'status-bar']) document.getElementById(id)!.addEventListener('mouseenter', () => (tooltip.hidden = true));

// Click a screenshot in the conversation to see it full size.
const lightbox = document.getElementById('lightbox')!;
document.getElementById('panel')!.addEventListener('click', (e) => {
  const img = (e.target as HTMLElement).closest<HTMLImageElement>('.convo img');
  if (!img) return;
  lightbox.querySelector('img')!.src = img.src;
  lightbox.hidden = false;
});
lightbox.addEventListener('click', () => (lightbox.hidden = true));

// The "needs you" counter cycles through agents that are waiting on the human.
let waitingCursor = 0;
let reportCursor = 0;
statusLeft.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-search]')) {
    searchBox.open();
    return;
  }
  if (t.closest('[data-hire]')) {
    hire.open({ repoId: openSelection ? snapshot?.desks.find((d) => d.id === openSelection!.deskId)?.repoId : undefined });
    return;
  }
  if (t.closest('[data-bell]')) {
    void Notification.requestPermission().then(renderStatus);
    return;
  }
  if (t.closest('[data-bell-test]')) {
    // If this doesn't appear, the OS is blocking the browser's notifications (e.g. macOS Focus / System Settings).
    new Notification('Office Desks 테스트 알림', { body: '이 알림이 보이면 에이전트 완료 알림도 받을 수 있어요.' });
    return;
  }
  if (t.closest('[data-reports]') && attention.length) {
    const a = attention[reportCursor++ % attention.length];
    openSelection = { deskId: a.deskId, agentId: a.agentId };
    select(openSelection);
    return;
  }
  if (!t.closest('[data-waiting]')) return;
  const waiting = (snapshot?.desks ?? []).flatMap((d) => d.agents.filter((a) => a.state === 'waiting').map((a) => ({ deskId: d.id, agentId: a.id })));
  if (!waiting.length) return;
  openSelection = waiting[waitingCursor++ % waiting.length];
  select(openSelection);
});

function renderStatus(): void {
  const agents = snapshot?.desks.flatMap((d) => d.agents) ?? [];
  const count = (s: string) => agents.filter((a) => a.state === s).length;
  const waiting = count('waiting');
  const busy = count('typing') + count('reading') + count('running');
  const conn = { open: '🟢 연결됨', connecting: '🟡 연결 중', closed: '🔴 브리지 끊김' }[connection];
  statusLeft.innerHTML = `
    <span>${conn}</span>
    <button class="hire" data-hire title="새 워크트리를 만들고 에이전트를 띄웁니다">➕ 새 작업</button>
    <button class="search" data-search title="모든 에이전트 대화 검색 (단축키 Ctrl/⌘+K)">🔍 검색</button>
    <span>🏢 워크트리 ${snapshot?.desks.length ?? 0}</span>
    <span>⌨️ 일하는 중 ${busy}</span>
    ${attention.length ? `<button class="report" data-reports title="완료하거나 확인을 요청한 에이전트로 이동">📬 새 보고 ${attention.length}</button>` : ''}
    ${!('Notification' in window) ? '' : Notification.permission === 'default' ? '<button class="bell" data-bell title="에이전트가 끝나면 데스크톱 알림">🔔 알림 켜기</button>' : Notification.permission === 'granted' ? '<button class="bell on" data-bell-test title="눌러서 테스트 알림 보내기">🔔 알림 켜짐</button>' : '<span class="bell-off" title="브라우저 설정에서 이 사이트의 알림을 허용해야 합니다">🔕 알림 차단됨</span>'}
    ${waiting ? `<button class="alert" data-waiting title="확인이 필요한 에이전트로 이동">🙋 확인 필요 ${waiting}</button>` : '<span>🙋 확인 필요 0</span>'}
    ${snapshot?.error ? `<span class="alert" title="${esc(snapshot.error)}">⚠️ Orca 오류</span>` : ''}`;
  const badge = new Set([...attention.map((a) => a.agentId), ...agents.filter((a) => a.state === 'waiting').map((a) => a.id)]).size;
  document.title = badge ? `(${badge}) Office Desks` : 'Office Desks';
}

connectOffice(
  (s) => {
    snapshot = s;
    scene.setSnapshot(s);
    panel.refresh(s);
    notify(notices.transitions(s));
    refreshAttention();
  },
  (c) => {
    connection = c;
    renderStatus();
  },
  renderUsage,
);

// Clicking empty office floor closes the panel (clicking another desk switches to it).
scene.onBackground = () => {
  panel.close();
  scene.setSelection(null);
  openSelection = null;
};

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchBox.open();
    return;
  }
  if (e.key === 'Escape' && !lightbox.hidden) {
    lightbox.hidden = true;
    return;
  }
  if (e.key === 'Escape') {
    panel.close();
    scene.setSelection(null);
    openSelection = null;
  }
});
