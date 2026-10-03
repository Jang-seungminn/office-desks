// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { snippetHtml } from '../src/searchDialog';

describe('snippetHtml', () => {
  it('highlights Orca matches and escapes everything else', () => {
    expect(snippetHtml('…진짜 [[픽셀 에셋]](LimeZu)…')).toBe('…진짜 <mark>픽셀 에셋</mark>(LimeZu)…');
    expect(snippetHtml('<img src=x onerror=1> [[<b>]]')).toBe('&lt;img src=x onerror=1&gt; <mark>&lt;b&gt;</mark>');
  });
});
