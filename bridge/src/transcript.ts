import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { AskedQuestion, ConversationMessage, QuestionState, SubagentStatus } from './model.js';

// Parse agent session transcripts (Claude Code and Codex JSONL) into a flat chat log.
// Only conversation turns and one-line tool summaries are kept: thinking, meta entries,
// tool output and harness wrappers are dropped so the panel reads like the chat itself.
// Files are append-only, so after the first read only the new bytes are parsed and the
// whole history is kept.

const TOOL_SUMMARY = 140;

type Json = Record<string, any>;

function oneLine(s: unknown, max = TOOL_SUMMARY): string {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Harness-injected user text that is not something the human typed. */
function isWrapper(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<command-') ||
    t.startsWith('<local-command') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('<environment_context>') ||
    t.startsWith('<user_instructions>') ||
    t.startsWith('<permissions instructions>') ||
    t.startsWith('[Image: original') ||
    t.startsWith('<task-notification>')
  );
}

function toolSummary(name: string, input: unknown): string {
  let args: Json = {};
  if (typeof input === 'string') {
    try {
      args = JSON.parse(input);
    } catch {
      return oneLine(`${name}: ${input}`);
    }
  } else if (input && typeof input === 'object') {
    args = input as Json;
  }
  const main =
    args.command ?? args.cmd ?? args.file_path ?? args.path ?? args.pattern ?? args.query ?? args.url ?? args.description ?? args.skill ?? args.prompt;
  return oneLine(main !== undefined ? `${name}: ${Array.isArray(main) ? main.join(' ') : main}` : name);
}

export interface TranscriptImage {
  mediaType: string;
  data: string; // base64
}

export interface SubagentCall {
  toolUseId: string;
  description: string;
  agentType: string;
  status: SubagentStatus;
}

interface ParseState {
  title: string | null;
  messages: ConversationMessage[];
  images: TranscriptImage[];
  /** Subagent transcripts are all `isSidechain`; the main one skips sidechain records. */
  sidechain?: boolean;
  calls?: Map<string, SubagentCall>;
  asks?: Map<string, QuestionState>;
  /** Model and reasoning effort of the latest turn. */
  model?: string;
  effort?: string;
  /** queued_command ids already shown (the same mid-turn message can be recorded twice). */
  queued?: Set<string>;
}

/** Text + base64 images from a Claude user content array. */
function userContent(blocks: Json[], st: ParseState): { text: string; images: number[] } {
  const parts: string[] = [];
  const images: number[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string' && !isWrapper(b.text)) parts.push(b.text);
    if (b.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string') {
      images.push(st.images.push({ mediaType: String(b.source.media_type ?? 'image/png'), data: b.source.data }) - 1);
    }
  }
  return { text: parts.join('\n\n').trim(), images };
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

function askedQuestions(input: Json): AskedQuestion[] {
  return (Array.isArray(input?.questions) ? input.questions : []).map((q: Json) => ({
    header: String(q?.header ?? ''),
    question: String(q?.question ?? ''),
    multiSelect: Boolean(q?.multiSelect),
    options: (Array.isArray(q?.options) ? q.options : []).map((o: Json) => ({
      label: String(o?.label ?? ''),
      description: String(o?.description ?? ''),
    })),
  }));
}

/** `<task-notification>…<tool-use-id>X</tool-use-id>…<status>completed</status>` → finish call X. */
function applyTaskNotification(text: string, st: ParseState): void {
  const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1];
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1];
  const call = id ? st.calls?.get(id.trim()) : undefined;
  if (call && status) call.status = /complete|success|done/i.test(status) ? 'done' : /fail|kill|error|cancel/i.test(status) ? 'failed' : call.status;
}

function addClaude(r: Json, st: ParseState): void {
  if (r.type === 'ai-title' && typeof r.aiTitle === 'string') st.title = r.aiTitle;
  if (r.type === 'summary' && typeof r.summary === 'string') st.title ??= r.summary;
  // Messages typed while the agent was busy are stored as queued_command attachments, not user turns.
  const q = r.type === 'attachment' ? r.attachment : null;
  if (q?.type === 'queued_command' && typeof q.prompt === 'string' && q.prompt.includes('<task-notification>')) {
    applyTaskNotification(q.prompt, st);
    return;
  }
  if (q?.type === 'queued_command' && (q.origin?.kind === 'human' || q.humanTurn)) {
    const id = String(q.source_uuid ?? q.delivery_id ?? r.uuid ?? '');
    st.queued ??= new Set();
    if (id && st.queued.has(id)) return;
    if (id) st.queued.add(id);
    const blocks: Json[] = typeof q.prompt === 'string' ? [{ type: 'text', text: q.prompt }] : Array.isArray(q.prompt) ? q.prompt : [];
    const { text, images } = userContent(blocks, st);
    const ts = typeof r.timestamp === 'string' ? r.timestamp : null;
    if (text || images.length) st.messages.push({ role: 'user', text, ts, queued: true, ...(images.length ? { images } : {}) });
    return;
  }
  if ((r.type !== 'user' && r.type !== 'assistant') || r.isMeta || (r.isSidechain && !st.sidechain)) return;
  if (r.type === 'assistant') {
    const model = r.message?.model;
    if (typeof model === 'string' && !model.startsWith('<')) st.model = model;
    const effort = r.effort ?? r.perTurnEffort;
    if (typeof effort === 'string') st.effort = effort;
  }
  const ts = typeof r.timestamp === 'string' ? r.timestamp : null;
  const content = r.message?.content;
  const blocks: Json[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];

  if (r.type === 'user') {
    for (const b of blocks) {
      const ask = b.type === 'tool_result' ? st.asks?.get(String(b.tool_use_id)) : undefined;
      if (ask) {
        const answers = r.toolUseResult?.answers;
        if (answers && typeof answers === 'object' && !b.is_error) {
          ask.status = 'answered';
          ask.answers = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, String(v)]));
        } else {
          ask.status = 'cancelled';
        }
      }
      if (b.type === 'text' && typeof b.text === 'string' && b.text.includes('<task-notification>')) applyTaskNotification(b.text, st);
      const call = b.type === 'tool_result' ? st.calls?.get(String(b.tool_use_id)) : undefined;
      if (!call) continue;
      const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      // Background launches answer immediately ("Async agent launched"); the real end comes as a notification.
      if (!/Async agent launched/i.test(out)) call.status = b.is_error ? 'failed' : 'done';
    }
    if (blocks.some((b) => b.type === 'tool_result')) return;
    const { text, images } = userContent(blocks, st);
    if (text || images.length) st.messages.push({ role: 'user', text, ts, ...(images.length ? { images } : {}) });
    return;
  }

  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      st.messages.push({ role: 'assistant', text: b.text, ts });
    } else if (b.type === 'tool_use' && b.name === 'SubagentHandback' && typeof b.input?.message === 'string') {
      // A subagent's final report is a tool call, not a text block.
      st.messages.push({ role: 'assistant', text: b.input.message, ts });
    } else if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && typeof b.id === 'string') {
      st.asks ??= new Map();
      st.asks.set(b.id, { toolUseId: b.id, questions: askedQuestions(b.input), status: 'pending', answers: {} });
      st.messages.push({ role: 'question', text: askedQuestions(b.input).map((q) => q.question).join('\n'), ts, toolUseId: b.id });
    } else if (b.type === 'tool_use' && SUBAGENT_TOOLS.has(b.name) && typeof b.id === 'string') {
      const description = oneLine(b.input?.description ?? b.input?.prompt ?? 'subagent', 120);
      st.calls ??= new Map();
      st.calls.set(b.id, { toolUseId: b.id, description, agentType: String(b.input?.subagent_type ?? 'general-purpose'), status: 'running' });
      st.messages.push({ role: 'subagent', text: description, ts, toolUseId: b.id });
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      st.messages.push({ role: 'tool', text: toolSummary(b.name, b.input), ts });
    }
  }
}

function addCodex(r: Json, st: ParseState): void {
  const p = r.payload ?? {};
  const ts = typeof r.timestamp === 'string' ? r.timestamp : null;
  if (r.type === 'turn_context') {
    if (typeof p.model === 'string') st.model = p.model;
    if (typeof p.effort === 'string') st.effort = p.effort;
    return;
  }
  // event_msg/user_message is the clean human text; response_item user messages carry injected context.
  if (r.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
    if (p.message.trim() && !isWrapper(p.message)) st.messages.push({ role: 'user', text: p.message, ts });
  } else if (r.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
    const text = (Array.isArray(p.content) ? p.content : [])
      .filter((c: Json) => c.type === 'output_text' && typeof c.text === 'string')
      .map((c: Json) => c.text)
      .join('\n\n')
      .trim();
    if (text) st.messages.push({ role: 'assistant', text, ts });
  } else if (r.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
    st.messages.push({ role: 'tool', text: toolSummary(String(p.name ?? 'tool'), p.arguments ?? p.input), ts });
  } else if (r.type === 'response_item' && p.type === 'web_search_call') {
    st.messages.push({ role: 'tool', text: oneLine(`web_search: ${p.action?.query ?? ''}`), ts });
  }
}

function addLines(text: string, st: ParseState): void {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r: Json;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    // Codex records wrap everything in `payload`; Claude Code records don't.
    if (r && typeof r === 'object' && 'payload' in r) addCodex(r, st);
    else if (r && typeof r === 'object') addClaude(r, st);
  }
}

export function parseTranscript(text: string): ParseState {
  const st: ParseState = { title: null, messages: [], images: [] };
  addLines(text, st);
  return st;
}

export interface TranscriptResult {
  /** Identifies this file + read generation; changes if the file is replaced or truncated. */
  fileId: string;
  title: string | null;
  messages: ConversationMessage[];
  images: TranscriptImage[];
  calls: SubagentCall[];
  questions: QuestionState[];
  model: string | null;
  effort: string | null;
}

interface FileState extends ParseState {
  offset: number;
  carry: Buffer;
  generation: number;
}

const files = new Map<string, FileState>();
/** Parsed transcripts kept in memory (they hold base64 images); least recently read is dropped. */
const MAX_FILES = 12;

/** Read a transcript incrementally: the first call parses the whole file, later calls only new bytes. */
export async function readTranscript(filePath: string, opts: { sidechain?: boolean } = {}): Promise<TranscriptResult> {
  const { size } = await stat(filePath);
  let st = files.get(filePath);
  if (!st || size < st.offset) {
    st = { title: null, messages: [], images: [], sidechain: opts.sidechain, offset: 0, carry: Buffer.alloc(0), generation: (st?.generation ?? 0) + 1 };
    files.set(filePath, st);
  }
  if (size > st.offset) {
    const fh = await open(filePath, 'r');
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(size - st.offset);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, st.offset);
      chunk = chunk.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    st.offset += chunk.length;
    // Only parse complete lines; keep a half-written last line (and split UTF-8) for next time.
    const buf = st.carry.length ? Buffer.concat([st.carry, chunk]) : chunk;
    const lastNl = buf.lastIndexOf(0x0a);
    st.carry = Buffer.from(buf.subarray(lastNl + 1));
    if (lastNl >= 0) addLines(buf.subarray(0, lastNl).toString('utf8'), st);
  }
  files.delete(filePath); // re-insert to mark as most recently used
  files.set(filePath, st);
  while (files.size > MAX_FILES) files.delete(files.keys().next().value!);
  const fileId = createHash('sha1').update(`${filePath}#${st.generation}`).digest('hex').slice(0, 12);
  return { fileId, title: st.title, messages: st.messages, images: st.images, calls: [...(st.calls?.values() ?? [])], questions: [...(st.asks?.values() ?? [])], model: st.model ?? null, effort: st.effort ?? null };
}

/** Forget cached parse state (tests). */
export function resetTranscriptCache(): void {
  files.clear();
}
