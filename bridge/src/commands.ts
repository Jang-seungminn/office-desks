import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SlashCommand } from './model.js';

// Slash commands an agent's TUI accepts: the agent's built-ins plus user/project/plugin
// commands and skills found on disk. Used for `/` autocomplete in the web compose box.

const CLAUDE_BUILTINS: [string, string][] = [
  ['add-dir', 'Add a working directory'],
  ['agents', 'Manage subagents'],
  ['clear', 'Clear conversation history'],
  ['compact', 'Compact the conversation'],
  ['config', 'Open settings'],
  ['context', 'Show context usage'],
  ['cost', 'Show token cost'],
  ['doctor', 'Check installation health'],
  ['exit', 'Exit Claude Code'],
  ['export', 'Export the conversation'],
  ['help', 'Show help'],
  ['hooks', 'Manage hooks'],
  ['init', 'Create a CLAUDE.md for this project'],
  ['mcp', 'Manage MCP servers'],
  ['memory', 'Edit memory files'],
  ['model', 'Choose the model'],
  ['permissions', 'Manage tool permissions'],
  ['plugin', 'Manage plugins'],
  ['resume', 'Resume a previous conversation'],
  ['review', 'Review a pull request'],
  ['rewind', 'Rewind the conversation or code'],
  ['status', 'Show status'],
  ['usage', 'Show plan usage limits'],
  ['vim', 'Toggle vim mode'],
];

const CODEX_BUILTINS: [string, string][] = [
  ['model', 'Choose model and reasoning effort'],
  ['approvals', 'Choose what Codex can do without asking'],
  ['new', 'Start a new chat'],
  ['init', 'Create an AGENTS.md'],
  ['compact', 'Summarize the conversation'],
  ['diff', 'Show git diff'],
  ['mention', 'Mention a file'],
  ['status', 'Show session status'],
  ['mcp', 'List MCP tools'],
  ['review', 'Review current changes'],
  ['logout', 'Log out'],
  ['quit', 'Exit Codex'],
];

/** Pull `name` and `description` out of a Markdown file's YAML front matter (or its first line). */
export function frontMatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: { name?: string; description?: string } = {};
  if (m) {
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
      if (!kv) continue;
      let value = kv[2].trim();
      if (/^[>|][-+]?$/.test(value)) {
        // Folded/literal block: take the indented lines that follow.
        const block: string[] = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
        value = block.join(' ');
      }
      out[kv[1] as 'name' | 'description'] = value.replace(/^(['"])(.*)\1$/, '$2');
    }
  } else {
    const first = text.split(/\r?\n/).find((l) => l.trim());
    if (first) out.description = first.replace(/^#+\s*/, '').trim();
  }
  return out;
}

async function safeReaddir(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readHead(file: string): Promise<string> {
  try {
    return (await readFile(file, 'utf8')).slice(0, 4000);
  } catch {
    return '';
  }
}

/** `commands/foo.md` → foo, `commands/git/push.md` → git:push. */
async function scanCommands(dir: string, source: SlashCommand['source'], prefix = ''): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  for (const e of await safeReaddir(dir)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await scanCommands(full, source, `${prefix}${e.name}:`)));
    else if (e.name.endsWith('.md')) {
      const fm = frontMatter(await readHead(full));
      out.push({ name: `${prefix}${e.name.slice(0, -3)}`, description: fm.description ?? '', source });
    }
  }
  return out;
}

/** `skills/<dir>/SKILL.md` → its front-matter name (or the dir name). */
async function scanSkills(dir: string, source: SlashCommand['source'], prefix = ''): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  for (const e of await safeReaddir(dir)) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const text = await readHead(path.join(dir, e.name, 'SKILL.md'));
    if (!text) continue;
    const fm = frontMatter(text);
    out.push({ name: `${prefix}${fm.name || e.name}`, description: fm.description ?? '', source });
  }
  return out;
}

async function enabledPlugins(home: string): Promise<{ name: string; dir: string }[]> {
  try {
    const installed = JSON.parse(await readFile(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    let enabled: Record<string, boolean> = {};
    try {
      enabled = JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins ?? {};
    } catch {
      /* no settings: treat installed as enabled */
    }
    return Object.entries(installed.plugins ?? {})
      .filter(([id]) => enabled[id] !== false)
      .flatMap(([id, entries]) => {
        const last = (entries as { installPath?: string }[]).at(-1);
        return last?.installPath ? [{ name: id.split('@')[0], dir: last.installPath }] : [];
      });
  } catch {
    return [];
  }
}

function dedupe(list: SlashCommand[]): SlashCommand[] {
  const seen = new Map<string, SlashCommand>();
  for (const c of list) if (!seen.has(c.name)) seen.set(c.name, c);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listCommands(agentType: string, projectPath: string, home = os.homedir()): Promise<SlashCommand[]> {
  if (agentType === 'codex') {
    const prompts = (await scanCommands(path.join(home, '.codex', 'prompts'), 'user')).map((c) => ({ ...c, name: `prompts:${c.name}` }));
    return dedupe([...CODEX_BUILTINS.map(([name, description]) => ({ name, description, source: 'builtin' as const })), ...prompts]);
  }
  if (agentType !== 'claude') return [];
  const plugins = await enabledPlugins(home);
  const found = await Promise.all([
    scanCommands(path.join(projectPath, '.claude', 'commands'), 'project'),
    scanSkills(path.join(projectPath, '.claude', 'skills'), 'project'),
    scanCommands(path.join(home, '.claude', 'commands'), 'user'),
    scanSkills(path.join(home, '.claude', 'skills'), 'user'),
    ...plugins.flatMap((p) => [
      scanCommands(path.join(p.dir, 'commands'), 'plugin', `${p.name}:`),
      scanSkills(path.join(p.dir, 'skills'), 'plugin', `${p.name}:`),
    ]),
  ]);
  return dedupe([...CLAUDE_BUILTINS.map(([name, description]) => ({ name, description, source: 'builtin' as const })), ...found.flat()]);
}

/** Small TTL cache so typing `/` doesn't rescan the disk every keystroke. */
export class CommandCatalog {
  private cache = new Map<string, { at: number; list: Promise<SlashCommand[]> }>();
  constructor(private readonly ttlMs = 30_000) {}

  get(agentType: string, projectPath: string): Promise<SlashCommand[]> {
    const key = `${agentType}|${projectPath}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.list;
    const list = listCommands(agentType, projectPath);
    this.cache.set(key, { at: Date.now(), list });
    return list;
  }
}
