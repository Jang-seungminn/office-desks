import { describe, expect, it } from 'vitest';
import { displayWidth, fit } from '../src/tui/text.js';

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
