import path from 'node:path';
import type { OfficeAgent, OfficeDesk } from './model.js';
import type { OrcaRunner } from './orcaCli.js';

interface SearchHit {
  title?: string;
  cwd?: string;
  updatedAt?: string;
  source?: { presence?: string; filePath?: string };
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const n = path.normalize(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? n.toLowerCase() : n;
  };
  return norm(a) === norm(b);
}

export interface SearchKey {
  phrase: string;
  /** Set when searching by session title, so the exact-title hit wins. */
  title: string | null;
}

/** Pick a distinctive phrase from what Orca tells us about the agent's latest turn. */
export function searchKey(
  agent: Pick<OfficeAgent, 'prompt' | 'lastMessage' | 'terminalTitle'>,
  platform: NodeJS.Platform = process.platform,
): SearchKey | null {
  // Search phrases come from agent output (even terminal titles, which any program can set),
  // so on Windows drop characters cmd.exe would interpret; it's only a search query.
  const clean = (s: string | null) =>
    (s ?? '')
      .replace(platform === 'win32' ? /["%&|<>^!`]/g : /$^/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const prompt = clean(agent.prompt);
  if (prompt.length >= 6) return { phrase: prompt.slice(0, 80), title: null };
  // Claude Code names the terminal tab after the session title (e.g. "✳ Fix login bug").
  const title = clean(agent.terminalTitle);
  if (title.length >= 4 && !/^(claude|codex|zsh|bash|pwsh|powershell|terminal)$/i.test(title)) return { phrase: title, title };
  const last = clean(agent.lastMessage);
  if (last.length >= 12) return { phrase: last.slice(0, 80), title: null };
  return null;
}

/**
 * Map an Orca agent to its transcript file using Orca's own session index
 * (`orca search`), which covers Claude and Codex on every OS. The cache is keyed by
 * the phrase, so a new prompt (or /clear → new session) re-resolves.
 */
const MISS_TTL_MS = 30_000;

export type SessionVerifier = (filePath: string, key: SearchKey) => Promise<boolean>;

export class SessionResolver {
  private cache = new Map<string, { phrase: string; filePath: string | null; at: number; lastGood: string | null }>();

  constructor(
    private readonly orca: OrcaRunner,
    /** Confirms a candidate transcript really belongs to this agent (guards against fuzzy search hits). */
    private readonly verify: SessionVerifier = async () => true,
    private readonly now: () => number = Date.now,
  ) {}

  private inflight = new Map<string, Promise<string | null>>();

  /** Last known transcript for an agent, without searching. */
  cached(agentId: string): string | null {
    return this.cache.get(agentId)?.lastGood ?? null;
  }

  /** Like resolve(), but concurrent callers for the same agent share one search. */
  resolve(desk: OfficeDesk, agent: OfficeAgent): Promise<string | null> {
    const running = this.inflight.get(agent.id);
    if (running) return running;
    const p = this.resolveNow(desk, agent).finally(() => this.inflight.delete(agent.id));
    this.inflight.set(agent.id, p);
    return p;
  }

  private async resolveNow(desk: OfficeDesk, agent: OfficeAgent): Promise<string | null> {
    const key = searchKey(agent);
    if (!key) return this.cache.get(agent.id)?.lastGood ?? null;
    const phrase = key.phrase;
    const cached = this.cache.get(agent.id);
    if (cached && cached.phrase === phrase) {
      if (cached.filePath) return cached.filePath;
      // Don't hammer `orca search --fresh` every poll for an agent we just failed to find.
      if (this.now() - cached.at < MISS_TTL_MS) return cached.lastGood;
    }

    const result = (await this.orca([
      'search',
      `--query=${phrase}`,
      `--path=${desk.path}`,
      `--agent=${agent.agentType}`,
      '--sort=newest',
      '--limit=5',
      '--fresh',
    ])) as { hits?: SearchHit[] };
    const hits = (result?.hits ?? []).filter(
      (h) => h.source?.presence !== 'missing' && h.source?.filePath && h.cwd && samePath(h.cwd, desk.path),
    );
    const wanted = key.title?.toLowerCase();
    if (wanted) hits.sort((a, b) => Number(b.title?.toLowerCase() === wanted) - Number(a.title?.toLowerCase() === wanted));
    let found: string | null = null;
    for (const h of hits) {
      if (await this.verify(h.source!.filePath!, key).catch(() => false)) {
        found = h.source!.filePath!;
        break;
      }
    }
    // Keep showing the last known session while a brand-new prompt isn't indexed yet.
    const lastGood = found ?? cached?.lastGood ?? null;
    this.cache.set(agent.id, { phrase, filePath: found, at: this.now(), lastGood });
    return lastGood;
  }
}
