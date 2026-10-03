import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });
// How to show a local image path (e.g. a screenshot the agent linked). Set per render call.
let localImage: ((path: string) => string | null) | null = null;

marked.use({
  renderer: {
    image({ href, text }) {
      const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      // Never auto-load remote images: agent output could use them as a tracking/exfiltration beacon.
      if (/^(https?:)?\/\//i.test(href)) return `<a href="${attr(href)}">🖼️ ${attr(text || href)}</a>`;
      let file = href;
      try {
        file = decodeURI(href.replace(/^file:\/\//, ''));
      } catch {
        /* keep raw */
      }
      const src = localImage?.(file);
      if (src) return `<img class="shot" loading="lazy" src="${attr(src)}" alt="${attr(text || '')}" />`;
      return `<span class="img-ref" title="${attr(href)}">🖼️ ${attr(text || 'image')}</span>`;
    },
  },
});

// Links in agent messages open in a new tab instead of navigating the office away.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  // Raw <img>/<source> in agent output: only our own same-origin endpoints may load.
  for (const attr of ['src', 'srcset']) {
    const v = node.getAttribute(attr);
    if (v !== null && !v.startsWith('/api/')) node.removeAttribute(attr);
  }
});

/** Agent text is Markdown; transcripts can contain arbitrary HTML from tool output, so always sanitize. */
export function renderMarkdown(text: string, opts: { localImage?: (path: string) => string | null } = {}): string {
  localImage = opts.localImage ?? null;
  let html: string;
  try {
    html = marked.parse(text, { async: false });
  } finally {
    localImage = null;
  }
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'video', 'audio'],
    // style/class/id would let transcript text restyle or overlay the panel (fake prompts over the key buttons).
    FORBID_ATTR: ['style', 'class', 'id'],
    ADD_ATTR: ['target'],
  });
}
