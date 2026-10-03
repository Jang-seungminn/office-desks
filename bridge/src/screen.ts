import type { ComposerState } from './model.js';

/** Claude Code versions whose screens are covered by test/fixtures/screens (major.minor). */
export const TESTED_CLAUDE_VERSIONS = ['2.1'];

export function screenSupport(agentType: string, version: string | null): 'tested' | 'untested' | 'unknown' {
  if (agentType !== 'claude' || !version) return 'unknown';
  const mm = /^(\d+\.\d+)/.exec(version)?.[1];
  return mm && TESTED_CLAUDE_VERSIONS.includes(mm) ? 'tested' : 'untested';
}

const RULE = /^\s*[─━]{8,}/;
const PROMPT = /^\s*❯(\s|$)/;

/**
 * Is the agent's input box on screen? Claude Code draws its composer as a `❯` line framed
 * by horizontal rules. Dialogs such as /usage, /config or a permission prompt replace it
 * and swallow typed text, so the web UI must not send a message then.
 */
export function composerState(lines: string[], agentType: string): ComposerState {
  if (agentType !== 'claude') return 'unknown';
  const rows = lines.map((l) => l.replace(/\s+$/, ''));
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!PROMPT.test(rows[i])) continue;
    // Multi-line drafts: walk down past continuation lines to the closing rule.
    let below = i + 1;
    while (below < rows.length && !RULE.test(rows[below]) && below - i < 12) below++;
    if (RULE.test(rows[i - 1] ?? '') && RULE.test(rows[below] ?? '')) return 'ready';
  }
  return rows.some((r) => r.trim()) ? 'menu' : 'unknown';
}
