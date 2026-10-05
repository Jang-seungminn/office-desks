import './style.css';
import { addAgentFlow, addProjectFlow, hooks, newWorkFlow, onSnapshot, removeFlow, stopFlow } from './actions';
import { OfficeFeed } from './feed';
import { openOffice } from './host';
import { toast } from './modal';
import { Sidebar } from './sidebar';

const root = document.getElementById('app')!;
const aside = document.createElement('aside');
aside.className = 'sidebar';
const workspace = document.createElement('main');
workspace.className = 'workspace';
workspace.textContent = '왼쪽에서 에이전트를 골라 터미널을 여세요';
root.replaceChildren(aside, workspace);

const feed = new OfficeFeed();
hooks.snapshot = () => feed.snapshot;
hooks.openAgent = (desk, agent) => console.debug('open agent (Task 7)', desk.id, agent.id);

export const sidebar = new Sidebar(aside, {
  openAgent: (d, a) => hooks.openAgent(d, a),
  newWork: (id) => void newWorkFlow(id),
  addAgent: (d) => void addAgentFlow(d),
  stop: (d, a) => void stopFlow(d, a),
  remove: (d) => void removeFlow(d),
  addProject: () => void addProjectFlow(),
  openOffice: () => {
    openOffice().catch(() => toast('⚠️ 사무실을 열 수 없어요', 'error'));
  },
});

sidebar.render(null);
feed.onSnapshot((s) => {
  sidebar.render(s);
  onSnapshot(s);
});
feed.onStatus((c) => sidebar.setConnected(c));
feed.start();
