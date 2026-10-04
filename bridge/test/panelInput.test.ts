import { describe, expect, it, vi } from 'vitest';
import { INCOMPLETE_ESCAPE, PanelInput } from '../src/tui/panelInput.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(pasteWaitMs = 1000) {
  const flushed: string[] = [];
  const p = new PanelInput((held) => flushed.push(held), 10, pasteWaitMs);
  return { p, flushed };
}

describe('PanelInput', () => {
  it('passes plain input through', () => {
    const { p } = make();
    expect(p.feed('hi')).toEqual({ send: 'hi', leave: false });
  });

  it('stops at Ctrl+] in any of its encodings and drops what follows', () => {
    for (const esc of ['\x1d', '\x1b[93;5u', '\x1b[27;5;93~']) {
      const { p } = make();
      expect(p.feed(`ab${esc}zz`)).toEqual({ send: 'ab', leave: true });
    }
  });

  it('holds an unterminated paste until its end marker arrives', () => {
    const { p } = make();
    expect(p.feed('x\x1b[200~par')).toEqual({ send: 'x', leave: false });
    expect(p.feed('t one')).toEqual({ send: '', leave: false });
    expect(p.feed('\x1b[201~y')).toEqual({ send: '\x1b[200~part one\x1b[201~y', leave: false });
  });

  it('flushes a paste whose end never comes after the safety wait', async () => {
    const { p, flushed } = make(30);
    p.feed('\x1b[200~lost');
    await wait(10);
    expect(flushed).toEqual([]);
    await wait(50);
    expect(flushed).toEqual(['\x1b[200~lost']);
  });

  it('joins an escape sequence split across chunks and flushes a lone ESC after a short wait', async () => {
    const { p, flushed } = make();
    expect(p.feed('\x1b[')).toEqual({ send: '', leave: false });
    expect(p.feed('A')).toEqual({ send: '\x1b[A', leave: false });
    expect(p.feed('\x1b')).toEqual({ send: '', leave: false });
    await wait(40);
    expect(flushed).toEqual(['\x1b']);
  });

  it('drops a paste end marker whose paste was already flushed', async () => {
    const { p, flushed } = make(20);
    p.feed('\x1b[200~slow');
    await wait(40);
    expect(flushed).toEqual(['\x1b[200~slow']);
    expect(p.feed(' rest\x1b[201~ok')).toEqual({ send: ' restok', leave: false });
    expect(p.feed('\x1b[200~a\x1b[201~')).toEqual({ send: '\x1b[200~a\x1b[201~', leave: false });
  });

  it('drops held bytes on reset, and their timer with them', async () => {
    const { p, flushed } = make(20);
    p.feed('\x1b[200~gone');
    p.reset();
    await wait(50);
    expect(flushed).toEqual([]);
    expect(p.feed('ok')).toEqual({ send: 'ok', leave: false });
  });
});

describe('PanelInput: split mouse reports', () => {
  it('holds a cut-off mouse report for the long wait, not the escape wait, and joins its rest', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const flushed: string[] = [];
      const p = new PanelInput((h) => flushed.push(h), 50, 1000);
      expect(p.feed('a\x1b[<0;3')).toEqual({ send: 'a', leave: false });
      vi.advanceTimersByTime(100);
      expect(flushed).toEqual([]);
      expect(p.feed(';14m')).toEqual({ send: '\x1b[<0;3;14m', leave: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a cut-off mouse report whose rest never comes, but still flushes a lone ESC after the short wait', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const flushed: string[] = [];
      const p = new PanelInput((h) => flushed.push(h), 50, 1000);
      p.feed('\x1b[<0;3');
      vi.advanceTimersByTime(1100);
      expect(flushed).toEqual([]);
      expect(p.feed('x')).toEqual({ send: 'x', leave: false });
      p.feed('\x1b');
      vi.advanceTimersByTime(60);
      expect(flushed).toEqual(['\x1b']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('INCOMPLETE_ESCAPE', () => {
  it('holds a chunk cut off inside an SGR mouse report', () => {
    expect(INCOMPLETE_ESCAPE.test('x\x1b[<0;10')).toBe(true);
    expect(INCOMPLETE_ESCAPE.test('x\x1b[<0;10;5M')).toBe(false);
  });
});
