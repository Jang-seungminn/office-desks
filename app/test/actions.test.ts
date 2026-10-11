// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';

vi.mock('../src/modal', () => ({ confirmModal: vi.fn(), workModal: vi.fn(), agentModal: vi.fn(), toast: vi.fn() }));
vi.mock('../src/api', async (orig) => ({ ...(await orig<typeof import('../src/api')>()), removeWorktree: vi.fn(), stopAgent: vi.fn(), hire: vi.fn(), addRepo: vi.fn() }));
vi.mock('../src/host', () => ({ pickFolder: vi.fn() }));

import * as api from '../src/api';
import { pickFolder } from '../src/host';
import { addAgentFlow, addProjectFlow, hooks, newWorkFlow, onSnapshot, removeFlow, stopFlow } from '../src/actions';
import * as modal from '../src/modal';
import { agent, desk, snap } from './fixtures';

const d = desk({ id: 'w', name: 'wt1', branch: 'wt1' });
beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
const toasts = () => (modal.toast as any).mock.calls;

describe('flows', () => {
  it('remove: cancelled never calls the API', async () => {
    (modal.confirmModal as any).mockResolvedValue(false);
    await removeFlow(d);
    expect(api.removeWorktree).not.toHaveBeenCalled();
  });
  it('remove: dirty shows the server message', async () => {
    (modal.confirmModal as any).mockResolvedValue(true);
    (api.removeWorktree as any).mockRejectedValue(new ApiError('변경사항이 있는 워크트리는 지울 수 없어요', 409, 'dirty'));
    await removeFlow(d);
    expect(toasts()).toEqual([['⚠️ 변경사항이 있는 워크트리는 지울 수 없어요', 'error']]);
  });
  it('remove: has_agents is rewritten', async () => {
    (modal.confirmModal as any).mockResolvedValue(true);
    (api.removeWorktree as any).mockRejectedValue(new ApiError('에이전트가 실행 중인 워크트리는 지울 수 없어요 (x로 먼저 종료)', 409, 'has_agents'));
    await removeFlow(d);
    expect(toasts()[0][0]).toBe('⚠️ 먼저 에이전트를 ⏹ 중지해 주세요 (실행 중인 에이전트가 있어요)');
  });
  it('remove: success', async () => {
    (modal.confirmModal as any).mockResolvedValue(true);
    (api.removeWorktree as any).mockResolvedValue(undefined);
    await removeFlow(d);
    expect(api.removeWorktree).toHaveBeenCalledWith('w');
    expect(toasts()[0][0]).toBe('🗑 워크트리를 지웠어요');
  });
  it('stop: confirm then API; error to toast', async () => {
    (modal.confirmModal as any).mockResolvedValue(true);
    (api.stopAgent as any).mockRejectedValue(new ApiError('실패', 500));
    await stopFlow(d, agent({ id: 'a1' }));
    expect((modal.confirmModal as any).mock.calls[0][0].body).toContain('wt1 · claude');
    expect(api.stopAgent).toHaveBeenCalledWith('a1');
    expect(toasts()[0]).toEqual(['⚠️ 실패', 'error']);
  });
  it('add project: cancelled picker does nothing; ApiError toasts', async () => {
    (pickFolder as any).mockResolvedValue(null);
    await addProjectFlow();
    expect(api.addRepo).not.toHaveBeenCalled();
    (pickFolder as any).mockResolvedValue('/x');
    (api.addRepo as any).mockRejectedValue(new ApiError('git 저장소가 아니에요', 400));
    await addProjectFlow();
    expect(toasts()[0]).toEqual(['⚠️ git 저장소가 아니에요', 'error']);
  });
  it('new work opens the agent once it appears', async () => {
    const open = vi.fn();
    hooks.openAgent = open;
    hooks.snapshot = () => snap([]);
    (modal.workModal as any).mockResolvedValue({ name: 'fix', baseBranch: '', agent: 'claude', prompt: '' });
    (api.hire as any).mockResolvedValue({ ok: true, warning: 'w!' });
    await newWorkFlow('r1');
    expect(api.hire).toHaveBeenCalledWith({ agent: 'claude', repoId: 'r1', name: 'fix', baseBranch: undefined, prompt: undefined });
    expect(toasts().map((t: any) => t[0])).toEqual(['✅ 만들었어요. 에이전트가 자리에 앉는 중…', 'w!']);
    onSnapshot(snap([desk({ name: 'fix', agents: [] })]));
    expect(open).not.toHaveBeenCalled();
    const nd = desk({ name: 'fix', agents: [agent({ id: 'n' })] });
    onSnapshot(snap([nd]));
    expect(open).toHaveBeenCalledWith(nd, nd.agents[0]);
    onSnapshot(snap([nd]));
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('add agent opens the first new agent', async () => {
    const open = vi.fn();
    hooks.openAgent = open;
    const before = desk({ id: 'w', agents: [agent({ id: 'old' })] });
    hooks.snapshot = () => snap([before]);
    (modal.agentModal as any).mockResolvedValue({ agent: 'codex', prompt: '' });
    (api.hire as any).mockResolvedValue({ ok: true });
    await addAgentFlow(before);
    expect(api.hire).toHaveBeenCalledWith({ agent: 'codex', deskId: 'w', prompt: undefined });
    onSnapshot(snap([before]));
    expect(open).not.toHaveBeenCalled();
    const after = desk({ id: 'w', agents: [agent({ id: 'old' }), agent({ id: 'new' })] });
    onSnapshot(snap([after]));
    expect(open).toHaveBeenCalledWith(after, after.agents[1]);
  });
  it('stop: cancel makes no API call; confirm comes before the API', async () => {
    (modal.confirmModal as any).mockResolvedValueOnce(false);
    await stopFlow(d, agent({ id: 'a1' }));
    expect(api.stopAgent).not.toHaveBeenCalled();
    (modal.confirmModal as any).mockResolvedValueOnce(true);
    (api.stopAgent as any).mockResolvedValue(undefined);
    await stopFlow(d, agent({ id: 'a1' }));
    const c = (modal.confirmModal as any).mock.invocationCallOrder.at(-1);
    expect(c).toBeLessThan((api.stopAgent as any).mock.invocationCallOrder[0]);
  });
  it('double click: the second stop is ignored while the first is in flight', async () => {
    let release!: (v: boolean) => void;
    (modal.confirmModal as any).mockReturnValue(new Promise<boolean>((r) => (release = r)));
    (api.stopAgent as any).mockResolvedValue(undefined);
    const a = stopFlow(d, agent({ id: 'a1' }));
    await stopFlow(d, agent({ id: 'a1' }));
    expect(modal.confirmModal).toHaveBeenCalledTimes(1);
    release(true);
    await a;
    expect(api.stopAgent).toHaveBeenCalledTimes(1);
    (modal.confirmModal as any).mockResolvedValue(false);
    await stopFlow(d, agent({ id: 'a1' })); // key cleared in finally
    expect(modal.confirmModal).toHaveBeenCalledTimes(2);
  });
  it('pending open expires after 30 s; hire error clears it', async () => {
    vi.useFakeTimers();
    const open = vi.fn();
    hooks.openAgent = open;
    hooks.snapshot = () => snap([]);
    (modal.workModal as any).mockResolvedValue({ name: 'fix', baseBranch: '', agent: 'claude', prompt: '' });
    (api.hire as any).mockResolvedValue({ ok: true });
    await newWorkFlow('r1');
    vi.advanceTimersByTime(31_000);
    onSnapshot(snap([desk({ name: 'fix', agents: [agent({ id: 'n' })] })]));
    expect(open).not.toHaveBeenCalled();
    await newWorkFlow('r1');
    (api.hire as any).mockRejectedValue(new ApiError('안 돼요', 400));
    await newWorkFlow('r1');
    onSnapshot(snap([desk({ name: 'fix', agents: [agent({ id: 'n' })] })]));
    expect(open).not.toHaveBeenCalled();
  });
});
