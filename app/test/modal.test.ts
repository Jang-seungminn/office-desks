// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { agentModal, confirmModal, isModalOpen, workModal } from '../src/modal';

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
  it('does not stack modals', async () => {
    const p = workModal('repo');
    expect(isModalOpen()).toBe(true);
    expect(await confirmModal(opts)).toBe(false);
    expect(await agentModal('x')).toBeNull();
    expect(document.querySelectorAll('.modal')).toHaveLength(1);
    expect(q('.modal').getAttribute('aria-labelledby')).toBe(q('h2').id);
    byText('취소').click();
    await p;
    expect(isModalOpen()).toBe(false);
  });
  it('traps Tab inside the box', async () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    const p = confirmModal(opts);
    const ok = q<HTMLElement>('.modal-ok');
    const close = byText('✕');
    ok.focus();
    const tab = (shiftKey = false) => {
      const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      document.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(tab()).toBe(true);
    expect(document.activeElement).toBe(close);
    expect(tab(true)).toBe(true);
    expect(document.activeElement).toBe(ok);
    outside.focus();
    tab();
    expect(q('.modal').contains(document.activeElement)).toBe(true);
    byText('취소').click();
    await p;
  });
  it('Escape while composing does not close; backdrop cancels confirm only', async () => {
    const p = workModal('r');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
    expect(isModalOpen()).toBe(true);
    q('.modal-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(isModalOpen()).toBe(true);
    byText('취소').click();
    await p;
    const c = confirmModal(opts);
    q('.modal-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(await c).toBe(false);
  });
  it('returns focus to the opener, or to its replacement after a re-render', async () => {
    document.body.innerHTML = '<div data-desk="w"><button class="remove-worktree">x</button></div>';
    const old = q<HTMLElement>('button');
    old.focus();
    const p = confirmModal(opts);
    document.body.innerHTML = '<div data-desk="w"><button class="remove-worktree">x</button></div>';
    const fresh = q<HTMLElement>('button');
    // the modal root was wiped too; re-open the modal host the way the app would keep it
    document.body.append(document.getElementById('modal-root') ?? document.createElement('div'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await p;
    expect(document.activeElement).toBe(fresh);
  });
});
