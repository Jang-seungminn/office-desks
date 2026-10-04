import type { OfficeAgent, OfficeDesk, OfficeSnapshot, UsageSnapshot } from '../model.js';
import type { OrcaCliError, OrcaRunner } from '../orcaCli.js';
import { SessionResolver, type SessionVerifier } from '../sessionResolver.js';
import { toSnapshot, type OrcaTerminalRow, type OrcaWorktreeRow } from '../stateMapper.js';
import { toUsage } from '../usage.js';
import {
  BackendBusyError,
  BackendError,
  type BackendCapabilities,
  type BackendMessages,
  type ConversationHit,
  type HireResult,
  type HireSpec,
  type KeyInput,
  type OfficeBackend,
} from './types.js';

/** Terminal rows only change when terminals open/close or retitle: refresh them sparingly. */
const TERMINALS_MAX_AGE_MS = 15_000;
const BLOCKED_TTL_MS = 10 * 60_000;

/** Orca argv for a validated hire. Values only ever go in as --flag=value. */
export function orcaHireArgs(spec: HireSpec): string[] {
  if (spec.kind === 'agent') {
    return ['terminal', 'create', `--worktree=id:${spec.deskId}`, `--command=${spec.agent}`, `--title=${spec.agent}`];
  }
  const args = ['worktree', 'create', `--repo=id:${spec.repoId}`, `--name=${spec.name}`, '--no-parent', `--agent=${spec.agent}`];
  if (spec.baseBranch) args.push(`--base-branch=${spec.baseBranch}`);
  if (spec.prompt) args.push(`--prompt=${spec.prompt}`);
  return args;
}

interface OrcaSearchHit {
  agent?: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
  evidence?: { snippet?: string; role?: string };
  source?: { filePath?: string };
  resumeCommand?: string;
}

const NOT_WRITABLE = '이 에이전트 터미널에 입력할 수 없어요 (터미널이 끊겼거나 Orca 화면에 붙어 있지 않음). Orca에서 터미널을 다시 연 뒤 보내 주세요';

/** Orca refuses input to a terminal whose process is gone or detached; say so in words. */
function notWritable(err: unknown): unknown {
  const e = err as OrcaCliError;
  return e?.code === 'terminal_not_writable' || /terminal_not_writable/.test(e?.message ?? '') ? new BackendError(NOT_WRITABLE, 'terminal_not_writable') : err;
}

/** Everything the office needs, through the Orca CLI. Every argv is built here. */
export class OrcaBackend implements OfficeBackend {
  readonly name: string = 'orca';
  readonly capabilities: BackendCapabilities = { usage: true, search: true, board: true, hire: true, changes: true, transcripts: true, focus: true, repos: false, stop: false, remove: false };
  readonly messages: BackendMessages = {
    noSession: 'Orca 세션 검색에서 이 에이전트의 대화 기록을 찾지 못했습니다. (Orca Settings → Agent Session History가 켜져 있어야 합니다)',
    hireDisabled: '이 백엔드에서는 새 작업을 만들 수 없어요',
  };
  private terminals: { rows: OrcaTerminalRow[]; at: number } | null = null;
  /**
   * Orca refuses a prompt while the agent can't take one (mid-transition, dialog, …) and hands
   * back a request id; the exact same command plus that id may be retried later.
   */
  private blocked = new Map<string, { args: string[]; at: number }>();
  private readonly sessions: SessionResolver;

  constructor(
    private readonly orca: OrcaRunner,
    verify?: SessionVerifier,
    private readonly now: () => number = Date.now,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.sessions = new SessionResolver(orca, verify, now);
  }

  async snapshot(): Promise<OfficeSnapshot> {
    const ps = (await this.orca(['worktree', 'ps'])) as { worktrees?: OrcaWorktreeRow[] };
    const worktrees = ps?.worktrees ?? [];
    return toSnapshot(worktrees, await this.terminalRows(worktrees), this.now());
  }

  /** Cached `terminal list`, refreshed when stale or when an agent shows up in a pane we don't know. */
  private async terminalRows(worktrees: OrcaWorktreeRow[]): Promise<OrcaTerminalRow[]> {
    const known = new Set((this.terminals?.rows ?? []).map((t) => `${t.tabId}:${t.leafId}`));
    const unknownPane = worktrees.some((w) => (w.agents ?? []).some((a) => a.paneKey && !known.has(a.paneKey)));
    const stale = !this.terminals || this.now() - this.terminals.at > TERMINALS_MAX_AGE_MS;
    if (stale || unknownPane) {
      const r = (await this.orca(['terminal', 'list'])) as { terminals?: OrcaTerminalRow[] };
      this.terminals = { rows: r?.terminals ?? [], at: this.now() };
    }
    return this.terminals!.rows;
  }

  async readScreen(handle: string): Promise<string[]> {
    const r = (await this.orca(['terminal', 'read', '--terminal', handle, '--screen'])) as { terminal?: { tail?: string[] } };
    return r?.terminal?.tail ?? [];
  }

  sendPrompt(handle: string, text: string): Promise<void> {
    // cmd.exe shims can't carry newlines in an argument on Windows; send those lines space-joined.
    const body = this.platform === 'win32' ? text.replace(/\s*\r?\n\s*/g, ' ') : text;
    return this.deliver(['terminal', 'send', '--terminal', handle, `--text=${body}`, '--enter']);
  }

  retryPrompt(requestId: string): Promise<void> {
    const pending = this.blocked.get(requestId);
    if (!pending) return Promise.reject(new BackendError('다시 보낼 메시지를 찾지 못했습니다. 새로 보내주세요', 'not_found'));
    return this.deliver([...pending.args, `--retry-request=${requestId}`, '--wait-submit=10'], requestId);
  }

  blockedHandle(requestId: string): string | null {
    return this.blocked.get(requestId)?.args[3] ?? null;
  }

  private async deliver(args: string[], retryOf?: string): Promise<void> {
    try {
      await this.orca(args);
      if (retryOf) this.blocked.delete(retryOf);
    } catch (err) {
      const e = err as OrcaCliError;
      const requestId = /request ID:\s*([0-9a-f-]{8,64})/i.exec(e.message)?.[1] ?? retryOf;
      if ((e.code === 'agent_prompt_blocked' || /agent_prompt_blocked/.test(e.message)) && requestId) {
        // A re-blocked retry keeps pointing at the original prompt, never at the retry argv.
        const base = retryOf ? this.blocked.get(retryOf)?.args : args;
        if (base) this.blocked.set(requestId, { args: base, at: this.now() });
        for (const [id, p] of this.blocked) if (this.now() - p.at > BLOCKED_TTL_MS) this.blocked.delete(id);
        throw new BackendBusyError(requestId);
      }
      throw notWritable(err);
    }
  }

  addRepo(_repoPath: string): Promise<void> {
    return Promise.reject(new BackendError('Orca에서는 Orca 앱에서 프로젝트를 추가해 주세요', 'unsupported'));
  }

  stopAgent(_agentId: string): Promise<void> {
    return Promise.reject(new BackendError('이 백엔드에서는 할 수 없어요', 'unsupported'));
  }

  removeWorktree(_deskId: string): Promise<void> {
    return Promise.reject(new BackendError('이 백엔드에서는 할 수 없어요', 'unsupported'));
  }

  hook(_agentId: string, _token: string, _payload: unknown): boolean {
    return false;
  }

  async dispose(): Promise<void> {}

  async sendKeys(handle: string, input: KeyInput): Promise<void> {
    // `--text=value` so text starting with `--` can never be parsed as another flag.
    try {
      await this.orca(['terminal', 'send', '--terminal', handle, ...('enter' in input ? ['--enter'] : [`--text=${input.bytes}`])]);
    } catch (err) {
      throw notWritable(err);
    }
  }

  async focus(handle: string): Promise<void> {
    await this.orca(['terminal', 'switch', '--terminal', handle]);
  }

  async hire(spec: HireSpec): Promise<HireResult> {
    const result = (await this.orca(orcaHireArgs(spec))) as { terminal?: { handle?: string }; handle?: string };
    // A new worktree gets its prompt from Orca itself; a new terminal needs us to type it.
    if (spec.kind !== 'agent' || !spec.prompt) return {};
    const handle = result?.terminal?.handle ?? result?.handle;
    if (!handle) return {};
    // The agent's TUI needs a moment; Orca can wait for it to be idle before we type.
    const wait = (await this.orca(['terminal', 'wait', `--terminal=${handle}`, '--for=tui-idle', '--timeout-ms=60000'])) as {
      wait?: { satisfied?: boolean };
    };
    if (!wait?.wait?.satisfied) return { warning: '에이전트는 띄웠지만 준비가 늦어 첫 지시는 보내지 못했어요. 패널에서 보내 주세요' };
    await this.orca(['terminal', 'send', `--terminal=${handle}`, `--text=${spec.prompt}`, '--enter']);
    return {};
  }

  async setBoard(deskId: string, update: { workspaceStatus?: string; comment?: string }): Promise<void> {
    const args = ['worktree', 'set', `--worktree=id:${deskId}`];
    if (update.workspaceStatus !== undefined) args.push(`--workspace-status=${update.workspaceStatus}`);
    // Orca can't clear a comment; a single space is the closest (shown as empty everywhere).
    if (update.comment !== undefined) args.push(`--comment=${update.comment || ' '}`);
    await this.orca(args);
  }

  findSession(desk: OfficeDesk, agent: OfficeAgent): Promise<string | null> {
    return this.sessions.resolve(desk, agent);
  }

  cachedSession(agentId: string): string | null {
    return this.sessions.cached(agentId);
  }

  async searchConversations(query: string): Promise<ConversationHit[]> {
    const r = (await this.orca(['search', `--query=${query}`, '--scope=conversation', '--limit=30'])) as { hits?: OrcaSearchHit[] };
    return (r?.hits ?? []).map((h) => ({
      agent: String(h.agent ?? ''),
      title: String(h.title ?? ''),
      cwd: h.cwd ?? '',
      updatedAt: h.updatedAt ?? null,
      snippet: String(h.evidence?.snippet ?? ''),
      role: h.evidence?.role ?? null,
      filePath: h.source?.filePath ?? null,
      resumeCommand: h.resumeCommand ?? null,
    }));
  }

  async usage(): Promise<UsageSnapshot | null> {
    const r = (await this.orca(['account', 'list'])) as { rateLimits?: Record<string, unknown> };
    return toUsage(r?.rateLimits);
  }
}
