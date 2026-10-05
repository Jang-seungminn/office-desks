import './style.css';
import { addAgentFlow, addProjectFlow, hooks, newWorkFlow, onSnapshot, removeFlow, stopFlow } from './actions';
import { OfficeFeed } from './feed';
import { installDebug } from './debug';
import { openOffice, platform, termConfig } from './host';
import { installKeys } from './keymap';
import { toast } from './modal';
import { Sidebar } from './sidebar';
import { Workspace } from './workspace';

const root = document.getElementById('app')!;
const aside = document.createElement('aside');
aside.className = 'sidebar';
const main = document.createElement('main');
main.className = 'workspace';
root.replaceChildren(aside, main);

const feed = new OfficeFeed();
hooks.snapshot = () => feed.snapshot;
let workspace: Workspace | null = null;
let noHost = false;
let early: Parameters<typeof hooks.openAgent> | null = null; // a click before the config arrived
const NO_HOST = '공방 앱 안에서 열어 주세요';
hooks.openAgent = (desk, agent) => {
  if (workspace) workspace.open(desk, agent);
  else if (noHost) toast('⚠️ ' + NO_HOST, 'error');
  else early = [desk, agent];
};

// The term token comes once, by IPC, and stays in memory (the Workspace keeps it). Opened in a
// plain browser there is no IPC: no terminals.
termConfig().then(
  (cfg) => {
    workspace = new Workspace(main, cfg);
    installDebug(workspace);
    if (feed.snapshot) workspace.prune(feed.snapshot);
    if (early) workspace.open(...early);
    early = null;
  },
  () => {
    noHost = true;
    early = null;
    main.classList.add('no-host');
    main.textContent = NO_HOST;
  },
);

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
  workspace?.prune(s);
  onSnapshot(s);
});
feed.onStatus((c) => sidebar.setConnected(c));
feed.start();

installKeys(window, platform(), (a) => {
  switch (a.kind) {
    case 'newWork': {
      const repo = sidebar.selectedRepoId ?? feed.snapshot?.desks[0]?.repoId;
      if (repo) void newWorkFlow(repo);
      break;
    }
    case 'closeTab': workspace?.close(); break; // never closes the window
    case 'switchTab': workspace?.switchTo(a.index); break;
    case 'split': workspace?.toggleSplit(); break;
    case 'sidebar': sidebar.toggle(); workspace?.fit(); break;
    case 'copy': {
      const t = workspace?.copy() ?? '';
      if (t) void navigator.clipboard.writeText(t).catch(() => {});
      break;
    }
    case 'paste':
      navigator.clipboard.readText().then(
        (t) => workspace?.paste(t),
        () => toast('⚠️ 클립보드를 읽지 못했어요', 'error'),
      );
      break;
  }
});
