import type { BackendCapabilities, OfficeAgent, OfficeDesk, OfficeSnapshot, UsageSnapshot } from '../model.js';

export type { BackendCapabilities };

// What the bridge needs from whatever runs the agents (Orca today, our own PTY host later).
// server.ts and the poller only ever talk to this interface.

export class BackendError extends Error {
  constructor(
    message: string,
    readonly code: string = 'backend_error',
  ) {
    super(message);
  }
}

/** The agent can't take a prompt right now; the same prompt may be retried with this id. */
export class BackendBusyError extends BackendError {
  constructor(readonly requestId: string) {
    super('agent can not take a prompt right now', 'agent_busy');
  }
}

/** User-facing text that depends on the backend. */
export interface BackendMessages {
  /** Shown when an agent's conversation can't be found. */
  noSession: string;
  /** Shown when hiring is not available. */
  hireDisabled: string;
}

/** A validated request to start work (see hire.ts). */
export type HireSpec =
  | { kind: 'agent'; deskId: string; agent: string; prompt: string | null }
  | { kind: 'worktree'; repoId: string; name: string; agent: string; baseBranch: string | null; prompt: string | null };

export interface HireResult {
  /** Set when the agent started but its first prompt could not be delivered. */
  warning?: string;
}

export interface ConversationHit {
  agent: string;
  title: string;
  cwd: string;
  updatedAt: string | null;
  /** Matched text with [[highlights]]. */
  snippet: string;
  role: string | null;
  filePath: string | null;
  resumeCommand: string | null;
}

/** Raw bytes to type, or the terminal's own Enter. */
export type KeyInput = { bytes: string } | { enter: true };

export interface OfficeBackend {
  readonly name: string;
  readonly capabilities: BackendCapabilities;
  /** User-facing text that depends on the backend. */
  readonly messages: BackendMessages;
  /** Desks and agents as the backend knows them, before git/transcript enrichment. */
  snapshot(): Promise<OfficeSnapshot>;
  /** The rendered screen, one string per row. */
  readScreen(handle: string): Promise<string[]>;
  /** Type a prompt and submit it. Throws BackendBusyError when the agent can't take it now. */
  sendPrompt(handle: string, text: string): Promise<void>;
  /** Re-send a prompt refused with BackendBusyError. Throws BackendBusyError again if still busy. */
  retryPrompt(requestId: string): Promise<void>;
  /** Terminal of a refused prompt that can still be retried, or null. */
  blockedHandle(requestId: string): string | null;
  sendKeys(handle: string, input: KeyInput): Promise<void>;
  /** Bring a terminal to the front of the host app. */
  focus(handle: string): Promise<void>;
  hire(spec: HireSpec): Promise<HireResult>;
  /** An empty comment clears it. */
  setBoard(deskId: string, update: { workspaceStatus?: string; comment?: string }): Promise<void>;
  /** Transcript file of the agent's current session, or null. May search. */
  findSession(desk: OfficeDesk, agent: OfficeAgent): Promise<string | null>;
  /** Last known transcript file for an agent, without searching. */
  cachedSession(agentId: string): string | null;
  searchConversations(query: string): Promise<ConversationHit[]>;
  usage(): Promise<UsageSnapshot | null>;
  /** Register a local git repo as a project, for capabilities.repos. */
  addRepo(repoPath: string): Promise<void>;
  /** Stop a running agent. */
  stopAgent(agentId: string): Promise<void>;
  /** Remove a worktree; refuses the main checkout, running agents and uncommitted changes. Keeps the branch. */
  removeWorktree(deskId: string): Promise<void>;
  /** An agent hook event from a backend-spawned agent; returns false if unknown or unauthorized. */
  hook(agentId: string, token: string, payload: unknown): boolean;
  /** Stop everything the backend started; called once on shutdown. */
  dispose(): Promise<void>;
}
