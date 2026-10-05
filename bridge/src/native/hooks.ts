import { fileURLToPath } from 'node:url';

// Claude Code reports what it is doing through hooks. We pass them in with `--settings` so the
// user's own settings stay untouched, relay each event to the bridge, and fold the events into
// the same raw states Orca reports (see stateMapper.mapAgentState).

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'] as const;
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

/** bridge/hook-relay.mjs, from both src/native/ and dist/native/. */
export function relayScript(): string {
  return fileURLToPath(new URL('../../hook-relay.mjs', import.meta.url));
}

/** Forward slashes: hook commands run in a POSIX shell (Git Bash on Windows). */
export function hookSettings(relay: string, node: string = process.execPath) {
  const q = (p: string) => `"${p.replace(/\\/g, '/')}"`;
  const hook = { type: 'command' as const, command: `${q(node)} ${q(relay)}` };
  const hooks: Record<string, { matcher?: string; hooks: (typeof hook)[] }[]> = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [{ ...(TOOL_EVENTS.has(ev) ? { matcher: '*' } : {}), hooks: [hook] }];
  return { hooks };
}

export interface HookState {
  rawState: string;
  toolName: string | null;
  toolInput: string | null;
  prompt: string | null;
  lastMessage: string | null;
  since: number;
  /** SessionStart arrived: the agent is past any startup dialog and ready for a prompt. */
  started: boolean;
  sessionId: string | null;
  transcriptPath: string | null;
}

export function initialHookState(now: number): HookState {
  return { rawState: 'unknown', toolName: null, toolInput: null, prompt: null, lastMessage: null, since: now, started: false, sessionId: null, transcriptPath: null };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);

/** The one field of a tool call worth showing ("npm test", "src/a.ts", …). */
function toolSummary(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const v = str(o[k]);
    if (v) return v.slice(0, 200);
  }
  return null;
}

function isPermission(p: Record<string, unknown>): boolean {
  const type = str(p.notification_type);
  if (type) return type === 'permission_prompt';
  return /permission|approve|needs your/i.test(str(p.message) ?? '');
}

export function applyHook(s: HookState, p: Record<string, unknown>, now: number): HookState {
  const ev = str(p.hook_event_name);
  const base: HookState = {
    ...s,
    sessionId: str(p.session_id) ?? s.sessionId,
    transcriptPath: str(p.transcript_path) ?? s.transcriptPath,
  };
  const to = (rawState: string, patch: Partial<HookState> = {}): HookState => ({
    ...base,
    ...patch,
    rawState,
    since: rawState === s.rawState ? s.since : now,
  });
  switch (ev) {
    case 'SessionStart':
      return to('done', { started: true });
    case 'UserPromptSubmit':
      return to('working', { prompt: str(p.prompt) ?? s.prompt, toolName: null, toolInput: null });
    case 'PreToolUse':
      return to('working', { toolName: str(p.tool_name), toolInput: toolSummary(p.tool_input) });
    case 'PostToolUse':
      return to('working', { toolName: null, toolInput: null });
    case 'Notification':
      return isPermission(p) ? to('waiting') : to('done');
    case 'Stop':
      return to('done', { lastMessage: str(p.last_assistant_message) ?? s.lastMessage, toolName: null, toolInput: null });
    default:
      return s;
  }
}
