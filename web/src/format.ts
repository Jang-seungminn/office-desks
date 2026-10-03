// Small display helpers shared by the office scene, tooltip and panel.

/** "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5", others unchanged. */
export function prettyModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  return model;
}

/** "Opus 5.5 · xhigh", or null when nothing is known yet. */
export function modelLine(model: string | null | undefined, effort: string | null | undefined): string | null {
  const name = prettyModel(model);
  if (!name && !effort) return null;
  return [name, effort].filter(Boolean).join(' · ');
}

const EFFORT_SHORT: Record<string, string> = { minimal: 'min', medium: 'med', maximum: 'max' };

/** Compact form for the tiny desk tag: "Opus 5.5 xhigh", "gpt-5.4 med". */
export function modelTag(model: string | null | undefined, effort: string | null | undefined): string | null {
  const name = prettyModel(model);
  const e = effort ? (EFFORT_SHORT[effort] ?? effort) : null;
  if (!name && !e) return null;
  return [name, e].filter(Boolean).join(' ');
}
