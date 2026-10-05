import './style.css';
import { OfficeFeed } from './feed';
import { openOffice } from './host';

const root = document.getElementById('app')!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const sidebar = el('aside', 'sidebar');
const head = el('div', 'sidebar-head');
head.append(el('h1', undefined, '공방'));
const addBtn = el('button', undefined, '＋ 프로젝트');
const officeBtn = el('button', undefined, '🏢 사무실');
officeBtn.addEventListener('click', () => void openOffice().catch(() => {}));
head.append(addBtn, officeBtn);
const body = el('div', 'sidebar-body', '연결 중…');
sidebar.append(head, body);

const workspace = el('main', 'workspace', '왼쪽에서 에이전트를 골라 터미널을 여세요');
root.replaceChildren(sidebar, workspace);

const feed = new OfficeFeed();
feed.onSnapshot(() => {
  body.textContent = '';
});
feed.start();
