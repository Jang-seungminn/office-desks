import Phaser from 'phaser';
import type { OfficeSnapshot } from '../../bridge/src/model';
import { connectOffice, type ConnectionState } from './api';
import { OfficeScene, type Selection } from './officeScene';
import { Panel } from './panel';
import './style.css';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const scene = new OfficeScene();
new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#c8b48e',
  pixelArt: true,
  // Don't let Phaser listen on window: clicks on the panel would otherwise hit desks under it.
  input: { windowEvents: false },
  scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
  scene,
});

let snapshot: OfficeSnapshot | null = null;
let connection: ConnectionState = 'connecting';
const statusBar = document.getElementById('status-bar')!;
const panel = new Panel(document.getElementById('panel')!, () => {
  panel.close();
  scene.setSelection(null);
});

function select(sel: Selection): void {
  scene.setSelection(sel);
  panel.open(sel, snapshot);
  tooltip.hidden = true;
}
scene.onSelect = select;

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
    ${agent ? `${esc(agent.agentType)} · ${esc(agent.activity)}` : '<span class="dim">빈 자리</span>'}
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
statusBar.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('[data-waiting]')) return;
  const waiting = (snapshot?.desks ?? []).flatMap((d) => d.agents.filter((a) => a.state === 'waiting').map((a) => ({ deskId: d.id, agentId: a.id })));
  if (!waiting.length) return;
  select(waiting[waitingCursor++ % waiting.length]);
});

function renderStatus(): void {
  const agents = snapshot?.desks.flatMap((d) => d.agents) ?? [];
  const count = (s: string) => agents.filter((a) => a.state === s).length;
  const waiting = count('waiting');
  const busy = count('typing') + count('reading') + count('running');
  const conn = { open: '🟢 연결됨', connecting: '🟡 연결 중', closed: '🔴 브리지 끊김' }[connection];
  statusBar.innerHTML = `
    <span>${conn}</span>
    <span>🏢 워크트리 ${snapshot?.desks.length ?? 0}</span>
    <span>⌨️ 일하는 중 ${busy}</span>
    ${waiting ? `<button class="alert" data-waiting title="확인이 필요한 에이전트로 이동">🙋 확인 필요 ${waiting}</button>` : '<span>🙋 확인 필요 0</span>'}
    ${snapshot?.error ? `<span class="alert" title="${esc(snapshot.error)}">⚠️ Orca 오류</span>` : ''}`;
  document.title = waiting ? `(${waiting}) Office Desks` : 'Office Desks';
}

connectOffice(
  (s) => {
    snapshot = s;
    scene.setSnapshot(s);
    panel.refresh(s);
    renderStatus();
  },
  (c) => {
    connection = c;
    renderStatus();
  },
);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightbox.hidden) {
    lightbox.hidden = true;
    return;
  }
  if (e.key === 'Escape') {
    panel.close();
    scene.setSelection(null);
  }
});
