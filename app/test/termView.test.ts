// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { bannerText, fitSize, frameDebounce } from '../src/termView';

describe('fitSize (never 0×0, never a hidden pane)', () => {
  const shown = { clientWidth: 800, clientHeight: 600 };
  it('passes a real size through', () => {
    expect(fitSize(shown, { cols: 100, rows: 40 })).toEqual({ cols: 100, rows: 40 });
  });
  it('refuses a hidden or collapsed pane', () => {
    expect(fitSize({ clientWidth: 0, clientHeight: 0 }, { cols: 2, rows: 1 })).toBeNull();
    expect(fitSize({ clientWidth: 0, clientHeight: 600 }, { cols: 2, rows: 40 })).toBeNull();
    expect(fitSize({ clientWidth: 800, clientHeight: 0 }, { cols: 100, rows: 1 })).toBeNull();
  });
  it('refuses missing or degenerate proposals', () => {
    expect(fitSize(shown, undefined)).toBeNull();
    expect(fitSize(shown, { cols: 0, rows: 0 })).toBeNull();
    expect(fitSize(shown, { cols: NaN, rows: 24 })).toBeNull();
    expect(fitSize(shown, { cols: Infinity, rows: 24 })).toBeNull();
  });
  it('clamps to the server limit', () => {
    expect(fitSize(shown, { cols: 5000, rows: 900 })).toEqual({ cols: 1000, rows: 500 });
  });
});

describe('frameDebounce', () => {
  it('runs once per frame however often it is called', () => {
    const frames: (() => void)[] = [];
    const fn = vi.fn();
    const d = frameDebounce(fn, (cb) => frames.push(cb), () => {});
    d();
    d();
    d();
    expect(frames).toHaveLength(1);
    expect(fn).not.toHaveBeenCalled();
    frames[0]();
    expect(fn).toHaveBeenCalledTimes(1);
    d();
    expect(frames).toHaveLength(2);
  });
  it('cancel drops the pending frame', () => {
    const cancelled: number[] = [];
    const fn = vi.fn();
    const d = frameDebounce(fn, () => 7, (id) => cancelled.push(id));
    d();
    d.cancel();
    expect(cancelled).toEqual([7]);
    d.cancel();
    expect(cancelled).toEqual([7]);
  });
});

describe('bannerText', () => {
  it('has a Korean banner for every ending', () => {
    expect(bannerText('connecting')).toBeNull();
    expect(bannerText('open')).toBeNull();
    expect(bannerText('reconnecting')).toBe('다시 연결하는 중…');
    expect(bannerText('exited', 3)).toBe('에이전트가 종료됐어요 (코드 3) — 탭을 닫아 주세요');
    expect(bannerText('exited', null)).toBe('에이전트가 종료됐어요 (코드 알 수 없음) — 탭을 닫아 주세요');
    expect(bannerText('exited', 0)).toBe('에이전트가 종료됐어요 (코드 0) — 탭을 닫아 주세요');
    expect(bannerText('closed')).toBe('공방이 닫히는 중이에요');
    expect(bannerText('failed')).toBe('터미널에 연결하지 못했어요 — 에이전트가 이미 끝났을 수 있어요');
  });
});
