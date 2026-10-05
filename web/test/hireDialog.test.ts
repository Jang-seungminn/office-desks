// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeSnapshot } from '../../bridge/src/model';
import { setBackendInfo } from '../src/backend';
import { HireDialog } from '../src/hireDialog';

const desk = (repoId: string, repo: string) => ({ id: `${repoId}::/p/${repo}`, repoId, repo, name: repo, agents: [] });
const office = (desks: ReturnType<typeof desk>[]) => ({ desks, updatedAt: 0, error: null }) as unknown as OfficeSnapshot;

function setup(snapshot: OfficeSnapshot) {
  const el = document.createElement('div');
  document.body.append(el);
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response('{"ok":true}', { status: 200 });
    }),
  );
  return { el, calls, dialog: new HireDialog(el, () => snapshot) };
}

function enterInRepoPath(el: HTMLElement, value: string, isComposing = false): KeyboardEvent {
  const input = el.querySelector<HTMLInputElement>('input[name=repoPath]')!;
  input.value = value;
  const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing });
  input.dispatchEvent(ev);
  return ev;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('HireDialog project path', () => {
  beforeEach(() => {
    setBackendInfo({ name: 'native', capabilities: { usage: false, search: false, board: true, hire: true, changes: true, transcripts: true, focus: false, repos: true, stop: true, remove: true } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('Enter in the path field adds the project, not the hire, when projects exist', async () => {
    const { el, calls, dialog } = setup(office([desk('r1', 'app')]));
    dialog.open();
    const ev = enterInRepoPath(el, '/p/other');
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(calls).toEqual(['/api/repos']);
  });

  it('Enter adds the project with no projects yet, and ignores the Enter that ends IME composition', async () => {
    const { el, calls, dialog } = setup(office([]));
    dialog.open();
    enterInRepoPath(el, '/p/한글', true);
    await flush();
    expect(calls).toEqual([]);
    enterInRepoPath(el, '/p/app');
    await flush();
    expect(calls).toEqual(['/api/repos']);
  });

  it('reopens after adding with the same options, but not once the dialog was closed', async () => {
    const { el, dialog } = setup(office([desk('r1', 'app'), desk('r2', 'web')]));
    dialog.open({ repoId: 'r2' });
    vi.useFakeTimers();
    enterInRepoPath(el, '/p/other');
    await vi.advanceTimersByTimeAsync(0);
    el.querySelector<HTMLSelectElement>('select[name=repoId]')!.value = 'r1';
    await vi.advanceTimersByTimeAsync(2000);
    expect(el.querySelector<HTMLSelectElement>('select[name=repoId]')!.value).toBe('r2');

    enterInRepoPath(el, '/p/more');
    await vi.advanceTimersByTimeAsync(0);
    dialog.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(el.hidden).toBe(true);
    expect(el.innerHTML).toBe('');
  });
});
