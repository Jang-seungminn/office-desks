// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar, type SidebarDeps } from '../src/sidebar';
import { agent, desk, snap } from './fixtures';

let deps: { [K in keyof SidebarDeps]: ReturnType<typeof vi.fn> };
let root: HTMLElement;
let sb: Sidebar;
const main = desk({ id: 'm', isMain: true, name: 'main' });
const wt = desk({ id: 'w', name: 'wt1', agents: [agent({ id: 'a1', state: 'waiting' })] });

beforeEach(() => {
  document.body.className = '';
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById('root')!;
  deps = { openAgent: vi.fn(), newWork: vi.fn(), addAgent: vi.fn(), stop: vi.fn(), remove: vi.fn(), addProject: vi.fn(), openOffice: vi.fn() };
  sb = new Sidebar(root, deps as unknown as SidebarDeps);
  sb.render(snap([main, wt]));
});
const btn = (t: string, scope: ParentNode = root) => [...scope.querySelectorAll('button')].find((b) => b.textContent === t)!;

describe('Sidebar', () => {
  it('renders the tree', () => {
    const t = root.textContent!;
    for (const s of ['📁 repo', '🏠 main', '🌿 wt1', '🙋 확인 필요', '빈 자리']) expect(t).toContain(s);
    const mainEl = root.querySelector('[data-desk="m"]')!;
    expect(btn('🗑 워크트리 삭제', mainEl)).toBeUndefined();
    expect(btn('🗑 워크트리 삭제', root.querySelector('[data-desk="w"]')!)).toBeTruthy();
  });
  it('shows names as text only', () => {
    sb.render(snap([desk({ name: '<img src=x onerror=alert(1)>' })]));
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it('clicks', () => {
    const open = root.querySelector<HTMLElement>('button[data-agent="a1"]')!;
    const row = open.closest<HTMLElement>('.agent')!;
    open.click();
    expect(deps.openAgent).toHaveBeenCalledWith(wt, wt.agents[0]);
    deps.openAgent.mockClear();
    btn('⏹ 중지', row).click();
    expect(deps.stop).toHaveBeenCalledWith(wt, wt.agents[0]);
    expect(deps.openAgent).not.toHaveBeenCalled();
    btn('🗑 워크트리 삭제').click();
    expect(deps.remove).toHaveBeenCalledWith(wt);
    btn('＋ 새 작업').click();
    expect(deps.newWork).toHaveBeenCalledWith('r1');
    expect(sb.selectedRepoId).toBe('r1');
    btn('🧑 에이전트 추가', root.querySelector('[data-desk="w"]')!).click();
    expect(deps.addAgent).toHaveBeenCalledWith(wt);
  });
  it('toggles', () => {
    sb.toggle();
    expect(sb.hidden).toBe(true);
    expect(document.body.classList.contains('sidebar-hidden')).toBe(true);
    sb.toggle();
    expect(sb.hidden).toBe(false);
    expect(document.body.classList.contains('sidebar-hidden')).toBe(false);
  });
  it('empty, error and disconnected states', () => {
    sb.render(snap([], '깨짐'));
    expect(root.textContent).toContain('프로젝트가 없어요');
    expect(root.textContent).toContain('⚠️ 깨짐');
    sb.setConnected(false);
    expect(root.textContent).toContain('공방 서버에 다시 연결하는 중…');
    sb.setConnected(true);
    expect(root.textContent).not.toContain('다시 연결하는 중');
  });
  it('keeps focus across a re-render and skips unchanged snapshots', () => {
    const stop = root.querySelector<HTMLElement>('button.stop-agent')!;
    stop.focus();
    const treeBefore = root.querySelector('section');
    sb.render({ ...snap([main, wt]), updatedAt: 999 });
    expect(root.querySelector('section')).toBe(treeBefore); // unchanged: no rebuild
    expect(document.activeElement).toBe(stop);
    sb.render(snap([main, desk({ ...wt, comment: 'x', agents: [agent({ id: 'a1', state: 'typing' })] })]));
    expect(root.querySelector('section')).not.toBe(treeBefore);
    const now = document.activeElement as HTMLElement;
    expect(now).not.toBe(stop);
    expect(now.classList.contains('stop-agent')).toBe(true);
    expect(now.dataset.stop).toBe('a1');
    expect(root.textContent).toContain('작업 중');
  });
});
