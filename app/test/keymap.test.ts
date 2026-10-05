// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appAction, installKeys, shortcutLabel } from '../src/keymap';
import { confirmModal } from '../src/modal';

const M = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
const cmd = { ...M, metaKey: true };
const ctrl = { ...M, ctrlKey: true };
const cs = { ...M, ctrlKey: true, shiftKey: true };

describe('appAction', () => {
  const rows: [string, 'mac' | 'win', string, object, unknown][] = [
    ['mac cmd T', 'mac', 'KeyT', cmd, { kind: 'newWork' }],
    ['mac cmd W', 'mac', 'KeyW', cmd, { kind: 'closeTab' }],
    ['mac cmd 3', 'mac', 'Digit3', cmd, { kind: 'switchTab', index: 2 }],
    ['mac cmd \\', 'mac', 'Backslash', cmd, { kind: 'split' }],
    ['mac cmd B', 'mac', 'KeyB', cmd, { kind: 'sidebar' }],
    ['mac cmd shift T', 'mac', 'KeyT', { ...cmd, shiftKey: true }, null],
    ['mac ctrl T', 'mac', 'KeyT', ctrl, null],
    ['mac ctrl B', 'mac', 'KeyB', ctrl, null],
    ['mac cmd C (menu)', 'mac', 'KeyC', cmd, null],
    ['mac cmd V (menu)', 'mac', 'KeyV', cmd, null],
    ['win ctrl T', 'win', 'KeyT', ctrl, null],
    ['win ctrl W', 'win', 'KeyW', ctrl, null],
    ['win ctrl B', 'win', 'KeyB', ctrl, null],
    ['win ctrl \\', 'win', 'Backslash', ctrl, null],
    ['win ctrl 1', 'win', 'Digit1', ctrl, null],
    ['win ctrl shift T', 'win', 'KeyT', cs, { kind: 'newWork' }],
    ['win ctrl shift 9', 'win', 'Digit9', cs, { kind: 'switchTab', index: 8 }],
    ['win ctrl shift 0', 'win', 'Digit0', cs, null],
    ['win ctrl shift C', 'win', 'KeyC', cs, { kind: 'copy' }],
    ['win ctrl shift V', 'win', 'KeyV', cs, { kind: 'paste' }],
    ['win ctrl shift alt T', 'win', 'KeyT', { ...cs, altKey: true }, null],
    ['win meta ctrl shift T', 'win', 'KeyT', { ...cs, metaKey: true }, null],
    ['win unbound key', 'win', 'KeyQ', cs, null],
  ];
  it.each(rows)('%s', (_n, p, code, mods, want) => {
    expect(appAction({ code, ...(mods as typeof M) }, p)).toEqual(want);
  });

  it('matches on code, not key (Korean layout / shifted digit)', () => {
    const hangul = new KeyboardEvent('keydown', { code: 'KeyT', key: 'ㅅ', ctrlKey: true, shiftKey: true });
    expect(appAction(hangul, 'win')).toEqual({ kind: 'newWork' });
    const paren = new KeyboardEvent('keydown', { code: 'Digit9', key: '(', ctrlKey: true, shiftKey: true });
    expect(appAction(paren, 'win')).toEqual({ kind: 'switchTab', index: 8 });
    const macHangul = new KeyboardEvent('keydown', { code: 'KeyT', key: 'ㅅ', metaKey: true });
    expect(appAction(macHangul, 'mac')).toEqual({ kind: 'newWork' });
  });
});

describe('shortcutLabel', () => {
  it('shows the real keys', () => {
    expect(shortcutLabel('split', 'win')).toBe('Ctrl+Shift+\\');
    expect(shortcutLabel('newWork', 'win')).toBe('Ctrl+Shift+T');
    expect(shortcutLabel('newWork', 'mac')).toBe('⌘T');
    expect(shortcutLabel('closeTab', 'mac')).toBe('⌘W');
    expect(shortcutLabel('sidebar', 'mac')).toBe('⌘B');
  });
});

describe('installKeys', () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
    document.body.replaceChildren();
  });

  function setup(p: 'mac' | 'win') {
    const run = vi.fn();
    off = installKeys(window, p, run);
    const ta = document.createElement('textarea');
    document.body.append(ta);
    const bubbled = vi.fn();
    ta.addEventListener('keydown', bubbled);
    const press = (init: KeyboardEventInit) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      ta.dispatchEvent(e);
      return e;
    };
    return { run, bubbled, press };
  }

  it('win: a bound chord runs, is prevented and never reaches the terminal', () => {
    const { run, bubbled, press } = setup('win');
    const e = press({ code: 'KeyT', ctrlKey: true, shiftKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ kind: 'newWork' });
    expect(e.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
  });

  it('win: plain Ctrl and unbound keys pass through untouched', () => {
    const { run, bubbled, press } = setup('win');
    for (const init of [{ code: 'KeyT', ctrlKey: true }, { code: 'KeyW', ctrlKey: true }, { code: 'Backslash', ctrlKey: true }, { code: 'KeyA' }]) {
      const e = press(init);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
    expect(bubbled).toHaveBeenCalledTimes(4);
  });

  it('mac: cmd chords run; cmd+C passes to the menu', () => {
    const { run, bubbled, press } = setup('mac');
    expect(press({ code: 'Digit2', metaKey: true }).defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledWith({ kind: 'switchTab', index: 1 });
    expect(press({ code: 'KeyC', metaKey: true }).defaultPrevented).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(bubbled).toHaveBeenCalledTimes(1);
  });

  it('ignores IME composition', () => {
    const { run, bubbled, press } = setup('win');
    const e = press({ code: 'KeyT', ctrlKey: true, shiftKey: true, isComposing: true });
    expect(e.defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(bubbled).toHaveBeenCalled();
    press({ code: 'KeyT', ctrlKey: true, shiftKey: true, keyCode: 229 });
    expect(run).not.toHaveBeenCalled();
  });

  it('does nothing while a modal is open', async () => {
    const { run, bubbled, press } = setup('mac');
    const p = confirmModal({ title: 't', body: 'b', confirm: 'ok' });
    const e = press({ code: 'KeyW', metaKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(bubbled).toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('#modal-root button')!.click();
    await p;
    press({ code: 'KeyW', metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cancels reload chords but still lets the terminal see them', () => {
    const w = setup('win');
    for (const init of [{ code: 'F5' }, { code: 'KeyR', ctrlKey: true }, { code: 'KeyR', ctrlKey: true, shiftKey: true }]) {
      expect(w.press(init).defaultPrevented).toBe(true);
    }
    expect(w.bubbled).toHaveBeenCalledTimes(3);
    expect(w.run).not.toHaveBeenCalled();
  });

  it('the remover detaches the listener', () => {
    const { run, press } = setup('win');
    off!();
    off = null;
    press({ code: 'KeyT', ctrlKey: true, shiftKey: true });
    expect(run).not.toHaveBeenCalled();
  });
});
