// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { agentModal, confirmModal, workModal } from '../src/modal';

beforeEach(() => {
  document.body.innerHTML = '';
});
const q = <T extends Element>(s: string) => document.querySelector<T>(s)!;
const byText = (t: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === t)!;
const opts = { title: 't', body: 'b', confirm: '확인', danger: true };

describe('modals', () => {
  it('confirm true / cancel / escape', async () => {
    let p = confirmModal(opts);
    expect(q('.modal-ok').classList.contains('danger')).toBe(true);
    byText('확인').click();
    expect(await p).toBe(true);
    expect(document.querySelector('.modal')).toBeNull();
    p = confirmModal(opts);
    byText('취소').click();
    expect(await p).toBe(false);
    p = confirmModal(opts);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await p).toBe(false);
    p = confirmModal(opts);
    byText('✕').click();
    expect(await p).toBe(false);
  });
  it('confirm body is text', async () => {
    const p = confirmModal({ ...opts, body: '<b>x</b>' });
    expect(document.querySelector('.modal b')).toBeNull();
    byText('취소').click();
    await p;
  });
  it('workModal returns trimmed fields; null on cancel', async () => {
    let p = workModal('repo');
    expect(q('h2').textContent).toBe('➕ 새 작업 시작 — repo');
    const [name, base] = document.querySelectorAll<HTMLInputElement>('input');
    name.value = '  fix-it ';
    base.value = ' origin/dev ';
    q<HTMLTextAreaElement>('textarea').value = ' go ';
    byText('만들기').click();
    expect(await p).toEqual({ name: 'fix-it', baseBranch: 'origin/dev', agent: 'claude', prompt: 'go' });
    p = workModal('repo');
    byText('취소').click();
    expect(await p).toBeNull();
  });
  it('workModal refuses an invalid name', async () => {
    const p = workModal('repo');
    q<HTMLInputElement>('input').value = '-bad name';
    q<HTMLFormElement>('form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(document.querySelector('.modal')).not.toBeNull();
    byText('취소').click();
    expect(await p).toBeNull();
  });
  it('Enter submits unless composing', async () => {
    const p = agentModal('wt');
    const ta = q<HTMLTextAreaElement>('textarea');
    expect(q('h2').textContent).toBe('🧑 wt에 에이전트 추가');
    ta.value = 'hi';
    const sel = q<HTMLSelectElement>('select');
    sel.value = 'codex';
    const inp = document.createElement('input');
    q('form').prepend(inp);
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(document.querySelector('.modal')).not.toBeNull();
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(await p).toEqual({ agent: 'codex', prompt: 'hi' });
  });
});
