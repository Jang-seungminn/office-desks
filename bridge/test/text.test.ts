import { describe, expect, it } from 'vitest';
import { clean, displayWidth, fit } from '../src/tui/text.js';

describe('text width', () => {
  it('counts Hangul and CJK as two columns and combining marks as zero', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('한글')).toBe(4);
    expect(displayWidth('a한b')).toBe(4);
    expect(displayWidth('é')).toBe(1);
    expect(displayWidth('✓·▶')).toBe(3);
  });

  it('fits to an exact width, truncating with an ellipsis and never splitting a wide char', () => {
    expect(fit('abc', 5)).toBe('abc  ');
    expect(fit('abcdef', 4)).toBe('abc…');
    expect(fit('한글이름', 5)).toBe('한글…');
    expect(displayWidth(fit('한글이름', 4))).toBe(4);
    expect(fit('한글이름', 4)).toBe('한… ');
    expect(fit('x', 0)).toBe('');
  });
});

describe('emoji and control characters', () => {
  it('counts emoji as two columns, a base plus VS16 as two in total', () => {
    expect(displayWidth('⚠️')).toBe(2);
    expect(displayWidth('✅🚀')).toBe(4);
    expect(displayWidth('⭐⌚🇰🇷🪄')).toBe(2 + 2 + 4 + 2);
    expect(displayWidth('✓✎')).toBe(2); // narrow dingbats stay narrow
  });

  it('fits a notice with an emoji to the exact width and never splits base and VS16', () => {
    const s = fit(' ⚠️ git 저장소가 아니에요: /nope', 20);
    expect(displayWidth(s)).toBe(20);
    expect(displayWidth(fit('⚠️ abc', 8))).toBe(8);
    expect(fit('a⚠️b', 3)).toBe('a… ');
  });

  it('drops control characters and escape sequences, turning tabs and newlines into spaces', () => {
    expect(fit('a\x1b[31mred\x1b[0m\x07b', 8)).toBe('aredb   ');
    expect(fit('x\ty\nz\r', 6)).toBe('x y z ');
    expect(fit('a\x9bb\x85c', 3)).toBe('abc');
    expect(clean('\x1b]0;title\x07ok')).toBe('ok');
  });
});
