import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGit, type GitRunner } from '../gitInfo.js';
import type { OfficeAgent, OfficeDesk, OfficeSnapshot, UsageSnapshot } from '../model.js';
import { agentEnv, findCommand } from '../native/env.js';
import { applyHook, hookSettings, initialHookState, relayScript, type HookState } from '../native/hooks.js';
import type { PtyHost } from '../native/ptyHost.js';
import type { Registry } from '../native/registry.js';
import { addWorktree, listWorktrees, resolveRepo, worktreeDest, type WorktreeInfo } from '../native/worktrees.js';
import { composerState } from '../screen.js';
import { toSnapshot, type OrcaTerminalRow, type OrcaWorktreeRow } from '../stateMapper.js';
import {
  BackendError,
  type BackendCapabilities,
  type BackendMessages,
  type ConversationHit,
  type HireResult,
  type HireSpec,
  type KeyInput,
  type OfficeBackend,
} from './types.js';

export type PtyLike = Pick<PtyHost, 'spawn' | 'has' | 'write' | 'screenLines' | 'onExit' | 'kill' | 'dispose' | 'onData' | 'resize' | 'serialize' | 'setReplies' | 'size'>;

export interface NativeDeps {
  pty: PtyLike;
  registry: Registry;
  home: string;
  hookUrl: (agentId: string, token: string) => string;
  git?: GitRunner;
  claudeProjects?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  relay?: string;
  node?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Where an agent command lives on the given PATH, or null when it isn't installed. */
  which?: (cmd: string, env: Record<string, string>) => string | null;
}

interface Agent {
  /** The PTY id; the office knows the agent as `${id}:main`, its terminal as `pty_${id}`. */
  id: string;
  deskId: string;
  agentType: string;
  token: string;
  settingsFile: string | null;
  sessionId: string | null;
  hook: HookState;
  /** First prompt from the hire dialog, typed once the agent is ready (after any trust dialog). */
  pending: string | null;
  transcript: string | null;
  lookedAt: number;
  spawnedAt: number;
  /** A valid hook arrived, so a dialog on screen is real (not the startup splash). */
  hooked: boolean;
}

const WORKTREES_TTL_MS = 5000;
const PASTE_SETTLE_MS = 400;
const SESSION_RESCAN_MS = 5000;
/** Claude's splash right after spawn looks like a menu; don't raise 🙋 for it. */
const STARTUP_GRACE_MS = 2000;
const PROMPT_NOT_SENT = '첫 지시는 Claude에만 자동으로 전달돼요. 패널에서 보내 주세요';

const agentKey = (id: string) => `${id}:main`;
/** Desk ids use forward slashes on every OS (git prints them that way on Windows too). */
const slash = (p: string) => p.replace(/\\/g, '/');
const ptyId = (handle: string) => handle.replace(/^pty_/, '');

/** Office Desks running the agents itself: PTYs, git worktrees and Claude hooks, no Orca. */
export class NativeBackend implements OfficeBackend {
  readonly name: string = 'native';
  readonly capabilities: BackendCapabilities = { usage: false, search: false, board: true, hire: true, changes: true, transcripts: true, focus: false, repos: true };
  readonly messages: BackendMessages = {
    noSession: '이 에이전트의 대화 기록이 아직 없어요. 첫 지시를 보내면 생깁니다.',
    hireDisabled: '이 백엔드에서는 새 작업을 만들 수 없어요',
  };

  private agents = new Map<string, Agent>();

  /** The PTY host, for the TUI's attach view. */
  get pty(): PtyLike {
    return this.deps.pty;
  }

  /** The PTY id of a live agent (`<id>:main` → `<id>`), or null when it is gone. */
  terminalOf(agentId: string): string | null {
    const id = agentId.replace(/:main$/, '');
    return this.agents.has(id) && this.deps.pty.has(id) ? id : null;
  }
  private worktrees = new Map<string, { at: number; list: WorktreeInfo[] }>();
  private readonly git: GitRunner;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: NativeDeps) {
    this.git = deps.git ?? runGit;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    deps.pty.onExit((id) => {
      const a = this.agents.get(id);
      this.agents.delete(id);
      if (a?.settingsFile) void rm(a.settingsFile, { force: true });
    });
  }

  async snapshot(): Promise<OfficeSnapshot> {
    const rows: OrcaWorktreeRow[] = [];
    const terminals: OrcaTerminalRow[] = [];
    for (const repo of this.deps.registry.repos) {
      let list: WorktreeInfo[];
      try {
        list = await this.worktreesOf(repo.path);
      } catch {
        continue; // a repo that moved or was deleted just has no desks
      }
      for (const wt of list) {
        const deskId = `${repo.id}::${wt.path}`;
        const meta = this.deps.registry.meta(deskId);
        const agents = [...this.agents.values()].filter((a) => a.deskId === deskId);
        for (const a of agents) terminals.push({ handle: `pty_${a.id}`, tabId: a.id, leafId: 'main', title: a.agentType });
        const states = agents.map((a) => this.rawState(a));
        rows.push({
          worktreeId: deskId,
          repoId: repo.id,
          repo: repo.name,
          path: wt.path,
          branch: wt.branch,
          displayName: path.basename(wt.path),
          isMainWorktree: wt.isMain,
          workspaceStatus: meta.workspaceStatus ?? null,
          comment: meta.comment ?? '',
          status: states.includes('waiting') ? 'permission' : states.includes('working') ? 'working' : agents.length ? 'active' : 'inactive',
          agents: agents.map((a, i) => ({
            paneKey: agentKey(a.id),
            agentType: a.agentType,
            state: states[i],
            toolName: a.hook.toolName,
            toolInput: a.hook.toolInput,
            prompt: a.hook.prompt,
            lastAssistantMessage: a.hook.lastMessage,
            stateStartedAt: a.hook.since,
          })),
        });
      }
    }
    return toSnapshot(rows, terminals, this.now());
  }

  /**
   * Hooks are the main signal; the screen covers what hooks can't see. A dialog (trust prompt,
   * permission prompt, /usage) always means the user is needed. An agent without hooks (not
   * Claude, or hooks disabled by policy) counts as done while its input box shows.
   */
  private rawState(a: Agent): string {
    const screen = composerState(this.deps.pty.screenLines(a.id), a.agentType);
    if (screen === 'menu') return !a.hooked && this.now() - a.spawnedAt < STARTUP_GRACE_MS ? 'unknown' : 'waiting';
    if (a.hook.rawState === 'unknown') return screen === 'ready' || a.agentType !== 'claude' ? 'done' : 'unknown';
    return a.hook.rawState;
  }

  private async worktreesOf(repoPath: string): Promise<WorktreeInfo[]> {
    const hit = this.worktrees.get(repoPath);
    if (hit && this.now() - hit.at < WORKTREES_TTL_MS) return hit.list;
    const list = (await listWorktrees(repoPath, this.git)).map((w) => ({ ...w, path: slash(w.path) }));
    this.worktrees.set(repoPath, { at: this.now(), list });
    return list;
  }

  async readScreen(handle: string): Promise<string[]> {
    return this.deps.pty.screenLines(ptyId(handle));
  }

  async sendPrompt(handle: string, text: string): Promise<void> {
    await this.paste(ptyId(handle), text);
  }

  /** Bracketed paste keeps a multi-line prompt one message; Enter after the TUI took it in. */
  private async paste(id: string, text: string): Promise<void> {
    this.deps.pty.write(id, `\x1b[200~${text}\x1b[201~`);
    await this.sleep(PASTE_SETTLE_MS);
    this.deps.pty.write(id, '\r');
  }

  retryPrompt(_requestId: string): Promise<void> {
    return Promise.reject(new BackendError('다시 보낼 메시지를 찾지 못했습니다. 새로 보내주세요', 'not_found'));
  }

  blockedHandle(_requestId: string): string | null {
    return null;
  }

  async sendKeys(handle: string, input: KeyInput): Promise<void> {
    this.deps.pty.write(ptyId(handle), 'enter' in input ? '\r' : input.bytes);
  }

  async focus(): Promise<void> {}

  async hire(spec: HireSpec): Promise<HireResult> {
    // Before any worktree exists: a missing command would otherwise leave an empty desk behind.
    const env = agentEnv(this.deps.env ?? process.env);
    if (!(this.deps.which ?? findCommand)(spec.agent, env)) {
      throw new BackendError(`${spec.agent} 명령을 찾지 못했어요. 설치되어 있고 PATH에 있는지 확인해 주세요`, 'agent_not_found');
    }
    let deskId: string;
    let cwd: string;
    if (spec.kind === 'agent') {
      deskId = spec.deskId;
      cwd = spec.deskId.slice(spec.deskId.indexOf('::') + 2);
    } else {
      const repo = this.deps.registry.repos.find((r) => r.id === spec.repoId);
      if (!repo) throw new BackendError('알 수 없는 프로젝트입니다', 'unknown_repo');
      cwd = worktreeDest(this.deps.home, repo.name, spec.name);
      await mkdir(path.dirname(cwd), { recursive: true });
      await addWorktree(repo.path, cwd, spec.name, spec.baseBranch, this.git);
      this.worktrees.delete(repo.path);
      // git lists the resolved path (symlinked home, macOS /var → /private/var); the desk id must match.
      cwd = await realpath(cwd);
      deskId = `${repo.id}::${slash(cwd)}`;
    }
    await this.spawnAgent(deskId, cwd, spec.agent, spec.prompt);
    return spec.prompt && spec.agent !== 'claude' ? { warning: PROMPT_NOT_SENT } : {};
  }

  private async spawnAgent(deskId: string, cwd: string, agentType: string, prompt: string | null): Promise<void> {
    const id = randomUUID();
    const token = randomBytes(16).toString('hex');
    let args: string[] = [];
    let settingsFile: string | null = null;
    let sessionId: string | null = null;
    if (agentType === 'claude') {
      sessionId = randomUUID();
      settingsFile = path.join(this.deps.home, 'agents', `${id}.json`);
      await mkdir(path.dirname(settingsFile), { recursive: true });
      await writeFile(settingsFile, JSON.stringify(hookSettings(this.deps.relay ?? relayScript(), this.deps.node)));
      args = ['--session-id', sessionId, '--settings', settingsFile];
    }
    const env = agentEnv(this.deps.env ?? process.env, { OFFICE_DESKS_HOOK_URL: this.deps.hookUrl(agentKey(id), token) });
    this.agents.set(id, {
      id,
      deskId,
      agentType,
      token,
      settingsFile,
      sessionId,
      hook: initialHookState(this.now()),
      // Without hooks there is no reliable "ready" signal, so only Claude gets a queued first prompt.
      pending: agentType === 'claude' ? prompt : null,
      transcript: null,
      lookedAt: 0,
      spawnedAt: this.now(),
      hooked: false,
    });
    try {
      this.deps.pty.spawn(id, { file: agentType, args, cwd, env });
    } catch (err) {
      this.agents.delete(id);
      if (settingsFile) await rm(settingsFile, { force: true });
      throw err;
    }
  }

  hook(agentId: string, token: string, payload: unknown): boolean {
    const a = this.agents.get(agentId.replace(/:main$/, ''));
    if (!a || !payload || typeof payload !== 'object') return false;
    const want = Buffer.from(a.token);
    const got = Buffer.from(token);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
    a.hooked = true;
    // /clear, resume and compact start a new Claude session; follow it (only the token holder gets here).
    const body = payload as Record<string, unknown>;
    const sid = body.session_id;
    if (body.hook_event_name === 'SessionStart' && typeof sid === 'string' && /^[0-9a-f-]{8,64}$/i.test(sid) && sid !== a.sessionId) {
      a.sessionId = sid;
      a.transcript = null;
      a.lookedAt = 0;
    }
    a.hook = applyHook(a.hook, payload as Record<string, unknown>, this.now());
    const p = a.hook.transcriptPath;
    if (p && this.ownTranscript(a, p)) a.transcript = p;
    if (a.pending && a.hook.started) {
      const prompt = a.pending;
      a.pending = null;
      void this.paste(a.id, prompt).catch(() => undefined);
    }
    return true;
  }

  /** Only `<our session id>.jsonl` under Claude's projects folder; anything else falls back to the scan. */
  private ownTranscript(a: Agent, p: string): boolean {
    if (!a.sessionId || path.basename(p) !== `${a.sessionId}.jsonl`) return false;
    const rel = path.relative(this.projectsRoot(), path.resolve(p));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  private projectsRoot(): string {
    if (this.deps.claudeProjects) return this.deps.claudeProjects;
    const env = this.deps.env ?? process.env;
    return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  }

  async setBoard(deskId: string, update: { workspaceStatus?: string; comment?: string }): Promise<void> {
    await this.deps.registry.setMeta(deskId, update);
  }

  async findSession(_desk: OfficeDesk, agent: OfficeAgent): Promise<string | null> {
    return this.cachedSession(agent.id);
  }

  /** The hook names the file; until then look for `<session-id>.jsonl` (cheap, rate-limited). */
  cachedSession(agentId: string): string | null {
    const a = this.agents.get(agentId.replace(/:main$/, ''));
    if (!a?.sessionId) return null;
    // The hook named the file: never scan, just wait for it to appear on disk.
    if (a.transcript) return existsSync(a.transcript) ? a.transcript : null;
    if (this.now() - a.lookedAt < SESSION_RESCAN_MS && a.lookedAt) return null;
    a.lookedAt = this.now();
    const root = this.projectsRoot();
    try {
      for (const dir of readdirSync(root)) {
        const file = path.join(root, dir, `${a.sessionId}.jsonl`);
        if (existsSync(file)) return (a.transcript = file);
      }
    } catch {
      /* no projects folder yet */
    }
    return null;
  }

  async searchConversations(): Promise<ConversationHit[]> {
    return [];
  }

  async usage(): Promise<UsageSnapshot | null> {
    return null;
  }

  async addRepo(repoPath: string): Promise<void> {
    if (!path.isAbsolute(repoPath)) throw new BackendError('절대 경로를 입력해 주세요', 'not_absolute');
    await this.deps.registry.addRepo(await resolveRepo(repoPath, this.git));
  }

  async dispose(): Promise<void> {
    const files = [...this.agents.values()].flatMap((a) => (a.settingsFile ? [a.settingsFile] : []));
    await this.deps.pty.dispose();
    await Promise.all(files.map((f) => rm(f, { force: true })));
  }
}
