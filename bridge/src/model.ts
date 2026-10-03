// Office model shared by the bridge and the web UI (web imports these types only).

/** What a character is visibly doing at its desk. */
export type CharacterState =
  | 'typing' // editing / writing code, or thinking
  | 'reading' // reading, searching, browsing
  | 'running' // running a shell command
  | 'waiting' // needs the human (permission, question, plan approval)
  | 'done' // finished its turn, idle at desk
  | 'away'; // no live agent signal

export interface OfficeAgent {
  /** Orca paneKey (`<tabId>:<leafId>`), stable per terminal pane. */
  id: string;
  /** Orca terminal handle used for send/switch; null if not matched. */
  terminalHandle: string | null;
  agentType: string;
  /** Terminal tab title minus spinner glyphs; Claude Code sets it to the session title. */
  terminalTitle: string | null;
  /** Subagents of this agent that are still working (Claude Code only; 0 if unknown). */
  subagentsRunning: number;
  /** Model and reasoning effort of the agent's latest turn, from its transcript. */
  model: string | null;
  effort: string | null;
  state: CharacterState;
  /** Raw Orca agent state, kept for debugging and the side panel. */
  rawState: string;
  /** Short human line, e.g. "Bash: npm test" or "확인 필요: ExitPlanMode". */
  activity: string;
  prompt: string | null;
  lastMessage: string | null;
  since: number | null;
}

export interface OfficeDesk {
  /** Orca worktree id (`<repoId>::<path>`). */
  id: string;
  /** Desks with the same repoId share a room. */
  repoId: string;
  /** The repo's primary checkout (as opposed to an extra worktree). */
  isMain: boolean;
  /** Orca lineage: the worktree this one was spawned from, if any. */
  parentId: string | null;
  name: string;
  repo: string;
  branch: string;
  path: string;
  /** Orca worktree row status: working | permission | active | inactive ... */
  status: string;
  workspaceStatus: string | null;
  comment: string;
  preview: string;
  isActive: boolean;
  /** Orca's own "unread" flag: something happened here you haven't looked at in Orca yet. */
  unread: boolean;
  /** Orca's last activity time for the worktree (ms), used to order idle desks. */
  lastActivityAt: number | null;
  agents: OfficeAgent[];
}

export interface OfficeSnapshot {
  desks: OfficeDesk[];
  updatedAt: number;
  error: string | null;
}

// --- Bridge <-> web protocol ---

export type ServerMessage = { type: 'snapshot'; snapshot: OfficeSnapshot } | { type: 'usage'; usage: UsageSnapshot };

export interface UsageWindow {
  /** Orca's key: session | weekly | monthly | fableWeekly | … */
  key: string;
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  resetDescription: string | null;
}

export interface UsageProvider {
  provider: string;
  windows: UsageWindow[];
}

export interface UsageSnapshot {
  providers: UsageProvider[];
  updatedAt: number;
}

export interface ImageUpload {
  mediaType: string;
  /** Base64 without the data: prefix. */
  data: string;
}

export interface SendRequest {
  terminalHandle: string;
  text: string;
  images?: ImageUpload[];
  /** Send even if a dialog seems to be open in the agent's terminal. */
  force?: boolean;
}

export interface FocusRequest {
  terminalHandle: string;
}


export interface ConversationMessage {
  /** `subagent` marks an Agent/Task tool call; `question` an AskUserQuestion call (see `questions`). */
  role: 'user' | 'assistant' | 'tool' | 'subagent' | 'question';
  /** Markdown for user/assistant, a one-line summary for tool calls. */
  text: string;
  ts: string | null;
  /** Indices of images attached to this message, served by /api/conversation/image. */
  images?: number[];
  /** A message the human sent while the agent was still working (absorbed mid-turn). */
  queued?: boolean;
  /** For role `subagent`: the tool call id that links to the subagent's own transcript. */
  toolUseId?: string;
}

export type SubagentStatus = 'running' | 'done' | 'failed';

export interface QuestionOption {
  label: string;
  description: string;
}

export interface AskedQuestion {
  header: string;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/** An AskUserQuestion call: what was asked, and whether/how it was answered. */
export interface QuestionState {
  toolUseId: string;
  questions: AskedQuestion[];
  status: 'pending' | 'answered' | 'cancelled';
  /** question text → answer text (comma-joined for multi-select), once answered. */
  answers: Record<string, string>;
}

export interface AnswerRequest {
  agentId: string;
  toolUseId: string;
  /** Per question, the 0-based indexes of the chosen options. */
  choices: number[][];
}

export interface SubagentInfo {
  toolUseId: string;
  /** Id of the subagent transcript (agent-<id>.jsonl), once Claude Code has written it. */
  agentId: string | null;
  description: string;
  agentType: string;
  status: SubagentStatus;
}

export interface ConversationResponse {
  found: boolean;
  /** Why no transcript was found, shown in the panel. */
  reason?: string;
  /** Changes when the agent's session file changes (new session, /clear, truncation): client must reset. */
  fileId: string | null;
  title: string | null;
  /** Total messages in the session; `messages` holds those from index `after` on. */
  total: number;
  after: number;
  messages: ConversationMessage[];
  /** Subagents this session started (main conversation only). */
  subagents: SubagentInfo[];
  /** Questions this session asked the human, with their current status. */
  questions: QuestionState[];
  /** Messages typed while the agent was busy that it hasn't picked up yet (Claude Code's queue). */
  pending: { text: string; ts: string | null }[];
}

export interface SlashCommand {
  /** Without the leading slash, e.g. `compact` or `superpowers:brainstorming`. */
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'project' | 'plugin';
}

/** ready: the input box is on screen; menu: a dialog/prompt has the keyboard; unknown: can't tell. */
export type ComposerState = 'ready' | 'menu' | 'unknown';

export interface TerminalScreen {
  found: boolean;
  lines: string[];
  composer: ComposerState;
}

/** Named keys the panel can press in an agent's terminal (menus, permission prompts). */
export type TerminalKey =
  | 'up' | 'down' | 'left' | 'right' | 'enter' | 'esc' | 'tab' | 'shift-tab' | 'space' | 'ctrl-c'
  | 'backspace' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'y' | 'n';

export interface KeyRequest {
  terminalHandle: string;
  /** A named key, or `char` for one printable character (typing into a dialog's search box). */
  key?: TerminalKey;
  char?: string;
}
