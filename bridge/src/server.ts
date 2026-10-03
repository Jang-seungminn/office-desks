import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { CommandCatalog } from './commands.js';
import { createDemoRunner, demoEnrichment } from './demo.js';
import { fetchUsage } from './usage.js';
import { changeSummary, fileDiff } from './gitInfo.js';
import { planHire } from './hire.js';
import { charBytes, keyBytes } from './keys.js';
import { answerQuestions, validateChoices } from './answer.js';
import { composerState, screenSupport } from './screen.js';
import type { AnswerRequest, ConversationResponse, FocusRequest, KeyRequest, QueueRequest, TerminalKey, WorktreeUpdate, HireRequest, OfficeAgent, OfficeDesk, SendRequest, ServerMessage, TerminalScreen, UsageSnapshot, FileDiffResponse } from './model.js';
import { createOrcaRunner, OrcaCliError, resolveOrcaCommand } from './orcaCli.js';
import { OfficePoller } from './poller.js';
import { isAllowedRequest, setSecurityHeaders } from './security.js';
import { isLinkedImage, readLocalImage } from './localImage.js';
import { SessionResolver } from './sessionResolver.js';
import { readTranscript } from './transcript.js';
import { subagentFile, subagentIds, subagentInfos } from './subagents.js';
import { cleanOldUploads, composePrompt, IMAGE_TYPES, saveImages, UploadError, uploadPath } from './uploads.js';

const HOST = '127.0.0.1'; // never expose: this server types into local terminals
const PORT = Number(process.env.OFFICE_DESKS_PORT ?? 4317);
const DEV_WEB_PORT = 5173;
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

const DEMO = Boolean(process.env.OFFICE_DESKS_DEMO);
const orca = DEMO ? createDemoRunner() : createOrcaRunner();
const commands = new CommandCatalog();
const poller = new OfficePoller(orca, 1500, (s) => enrichFromTranscripts(s.desks));
// Only accept a session whose transcript actually contains what we searched for.
const sessions = new SessionResolver(orca, async (filePath, key) => {
  const t = await readTranscript(filePath);
  if (key.title) return t.title?.toLowerCase() === key.title.toLowerCase() || t.messages.length > 0;
  const needle = key.phrase.slice(0, 40);
  return t.messages.some((m) => m.role !== 'tool' && m.text.replace(/\s+/g, ' ').includes(needle));
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage, maxBytes = 64_000): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new UploadError('요청이 너무 큽니다');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function sendBinary(res: ServerResponse, contentType: string, buf: Buffer): void {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
  res.end(buf);
}

/** Only allow terminals that are currently in the office, so the API can't target arbitrary handles. */
function knownHandle(handle: unknown): handle is string {
  return (
    typeof handle === 'string' &&
    poller.current.desks.some((d) => d.agents.some((a) => a.terminalHandle === handle))
  );
}

async function readScreen(handle: string): Promise<string[]> {
  const r = (await orca(['terminal', 'read', '--terminal', handle, '--screen'])) as { terminal?: { tail?: string[] } };
  return r?.terminal?.tail ?? [];
}

function findAgent(agentId: string | null): { desk: OfficeDesk; agent: OfficeAgent } | null {
  for (const desk of poller.current.desks) {
    const agent = desk.agents.find((a) => a.id === agentId);
    if (agent) return { desk, agent };
  }
  return null;
}

async function conversation(agentId: string | null, after: number, sub: string | null): Promise<ConversationResponse> {
  const empty = (reason: string): ConversationResponse => ({
    found: false,
    reason,
    fileId: null,
    title: null,
    total: 0,
    after: 0,
    messages: [],
    subagents: [],
    questions: [],
    pending: [],
    claudeVersion: null,
    screenSupport: 'unknown',
  });
  const found = findAgent(agentId);
  if (!found) return empty('이 에이전트는 더 이상 사무실에 없습니다.');
  // The file path only ever comes from Orca's session index, never from the client.
  const filePath = await sessions.resolve(found.desk, found.agent).catch(() => null);
  if (!filePath) return empty('Orca 세션 검색에서 이 에이전트의 대화 기록을 찾지 못했습니다. (Orca Settings → Agent Session History가 켜져 있어야 합니다)');
  const main = await readTranscript(filePath);
  const subagents = subagentInfos(main.calls, await subagentIds(filePath));
  let t = main;
  if (sub) {
    // A subagent's own conversation: only ids this session actually started.
    const file = subagents.some((s) => s.agentId === sub) ? subagentFile(filePath, sub) : null;
    if (!file || !existsSync(file)) return { ...empty('서브에이전트 기록을 찾지 못했습니다.'), subagents };
    t = await readTranscript(file, { sidechain: true });
  }
  const from = Number.isInteger(after) && after >= 0 && after <= t.messages.length ? after : 0;
  return {
    found: true,
    fileId: t.fileId,
    title: sub ? null : t.title,
    total: t.messages.length,
    after: from,
    messages: t.messages.slice(from),
    subagents,
    questions: main.questions,
    pending: sub ? [] : main.pending,
    claudeVersion: main.claudeVersion,
    screenSupport: screenSupport(found.agent.agentType, main.claudeVersion),
  };
}

/** git change counts per worktree path, refreshed in the background at most every 10s. */
const changeCache = new Map<string, { at: number; value: OfficeDesk['changes']; busy: boolean }>();
const CHANGES_TTL_MS = 10_000;

function cachedChanges(desk: OfficeDesk): OfficeDesk['changes'] {
  const hit = changeCache.get(desk.path);
  if (!hit || (Date.now() - hit.at > CHANGES_TTL_MS && !hit.busy)) {
    const entry = { at: hit?.at ?? 0, value: hit?.value ?? null, busy: true };
    changeCache.set(desk.path, entry);
    changeSummary(desk.path)
      .then((c) => (entry.value = { files: c.files.length, added: c.added, deleted: c.deleted }))
      .catch(() => (entry.value = null))
      .finally(() => {
        entry.at = Date.now();
        entry.busy = false;
      });
  }
  return changeCache.get(desk.path)!.value;
}

/** Add what only transcripts know (running subagents, model, effort) to every agent. */
async function enrichFromTranscripts(desks: OfficeDesk[]): Promise<void> {
  if (!DEMO) for (const d of desks) d.changes = cachedChanges(d);
  if (DEMO) {
    for (const a of desks.flatMap((d) => d.agents)) Object.assign(a, demoEnrichment(a.id));
    for (const [i, d] of desks.entries()) d.changes = d.agents.length ? { files: (i % 4) + 1, added: 12 + i * 37, deleted: i * 9 } : null;
    return;
  }
  await Promise.all(
    desks.flatMap((desk) =>
      desk.agents
        .filter((a) => a.agentType === 'claude' || a.agentType === 'codex')
        .map(async (agent) => {
          // Never block the office poll on a search: use what we know, refresh in the background.
          void sessions.resolve(desk, agent).catch(() => null);
          const filePath = sessions.cached(agent.id);
          if (!filePath) return;
          const t = await readTranscript(filePath).catch(() => null);
          if (!t) return;
          agent.subagentsRunning = t.calls.filter((c) => c.status === 'running').length;
          agent.model = t.model;
          agent.effort = t.effort;
        }),
    ),
  );
}

/**
 * Orca refuses a prompt while the agent can't take one (mid-transition, dialog, …) and hands
 * back a request id; the exact same command plus that id may be retried later. Keep the
 * command server-side so the client only ever names the id.
 */
/** Terminals currently being driven through a question dialog (one at a time each). */
const answering = new Set<string>();

const blockedPrompts = new Map<string, { args: string[]; at: number }>();
const BLOCKED_TTL_MS = 10 * 60_000;

async function deliver(res: ServerResponse, args: string[], retryOf?: string): Promise<void> {
  try {
    const result = await orca(args);
    if (retryOf) blockedPrompts.delete(retryOf);
    void poller.refresh();
    return json(res, 200, { ok: true, result });
  } catch (err) {
    const e = err as OrcaCliError;
    const requestId = /request ID:\s*([0-9a-f-]{8,64})/i.exec(e.message)?.[1] ?? retryOf;
    if ((e.code === 'agent_prompt_blocked' || /agent_prompt_blocked/.test(e.message)) && requestId) {
      const base = retryOf ? blockedPrompts.get(retryOf)?.args : args;
      if (base) blockedPrompts.set(requestId, { args: base, at: Date.now() });
      for (const [id, p] of blockedPrompts) if (Date.now() - p.at > BLOCKED_TTL_MS) blockedPrompts.delete(id);
      return json(res, 409, {
        code: 'agent_busy',
        requestId,
        error: '에이전트가 지금 새 메시지를 받을 수 없는 상태예요 (질문·권한 확인 중이거나 화면 전환 중). 잠시 후 다시 보내기를 눌러 주세요',
      });
    }
    throw err;
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/api/snapshot') {
    return json(res, 200, poller.current);
  }
  if (req.method === 'GET' && pathname === '/api/conversation/image') {
    // Images embedded in the agent's transcript (e.g. screenshots pasted into Claude Code).
    const agentId = url.searchParams.get('agentId');
    const desk = poller.current.desks.find((d) => d.agents.some((a) => a.id === agentId));
    const agent = desk?.agents.find((a) => a.id === agentId);
    const filePath = desk && agent ? await sessions.resolve(desk, agent).catch(() => null) : null;
    const img = filePath ? (await readTranscript(filePath)).images[Number(url.searchParams.get('i'))] : undefined;
    if (!img || !IMAGE_TYPES[img.mediaType]) return json(res, 404, { error: 'no such image' });
    return sendBinary(res, img.mediaType, Buffer.from(img.data, 'base64'));
  }
  if (req.method === 'GET' && pathname === '/api/local-image') {
    // Local screenshots an agent linked in its own messages (e.g. ![shot](/tmp/x.png)).
    const found = findAgent(url.searchParams.get('agentId'));
    const want = url.searchParams.get('path') ?? '';
    if (!found || !path.isAbsolute(want)) return json(res, 404, { error: 'no such image' });
    const filePath = await sessions.resolve(found.desk, found.agent).catch(() => null);
    const t = filePath ? await readTranscript(filePath) : null;
    if (!t || !isLinkedImage(t.messages, want)) return json(res, 404, { error: 'image not referenced by this agent' });
    const image = readLocalImage(want);
    if (!image) return json(res, 404, { error: 'no such image' });
    return sendBinary(res, image.type, image.buf);
  }
  if (req.method === 'GET' && pathname.startsWith('/api/uploads/')) {
    // Images sent from this UI, referenced by path in the agent's transcript.
    const file = uploadPath(pathname.slice('/api/uploads/'.length));
    const image = file && existsSync(file) ? readLocalImage(file) : null;
    if (!image) return json(res, 404, { error: 'no such upload' });
    return sendBinary(res, image.type, image.buf);
  }
  if (req.method === 'GET' && (pathname === '/api/changes' || pathname === '/api/diff')) {
    // Only worktrees Orca reports; files only from git's own list of changes.
    const desk = poller.current.desks.find((d) => d.id === url.searchParams.get('deskId'));
    if (!desk || DEMO) return json(res, 404, { error: 'unknown worktree' });
    const summary = await changeSummary(desk.path);
    if (pathname === '/api/changes') return json(res, 200, summary);
    const file = summary.files.find((f) => f.path === url.searchParams.get('file'));
    if (!file) return json(res, 404, { error: 'not a changed file' });
    return json(res, 200, { file, ...(await fileDiff(desk.path, file)) } satisfies FileDiffResponse);
  }
  if (req.method === 'GET' && pathname === '/api/commands') {
    const found = findAgent(url.searchParams.get('agentId'));
    return json(res, 200, found ? await commands.get(found.agent.agentType, found.desk.path) : []);
  }
  if (req.method === 'GET' && pathname === '/api/terminal') {
    // The rendered screen, for TUI menus (/config, /model) and permission prompts.
    const found = findAgent(url.searchParams.get('agentId'));
    if (!found?.agent.terminalHandle) return json(res, 200, { found: false, lines: [], composer: 'unknown' } satisfies TerminalScreen);
    const lines = await readScreen(found.agent.terminalHandle);
    return json(res, 200, { found: true, lines, composer: composerState(lines, found.agent.agentType) } satisfies TerminalScreen);
  }
  if (req.method === 'GET' && pathname === '/api/conversation') {
    return json(res, 200, await conversation(url.searchParams.get('agentId'), Number(url.searchParams.get('after') ?? 0), url.searchParams.get('sub')));
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  if (!req.headers['content-type']?.startsWith('application/json')) {
    return json(res, 415, { error: 'expected application/json' });
  }

  if (pathname === '/api/send') {
    const body = await readJson<SendRequest>(req, 80 * 1024 * 1024);
    if (!knownHandle(body.terminalHandle)) return json(res, 404, { error: 'unknown terminal' });
    // A dialog (/usage, /config, permission prompt) would swallow the text: refuse unless forced.
    const owner = poller.current.desks.flatMap((d) => d.agents).find((a) => a.terminalHandle === body.terminalHandle);
    if (!body.force && owner && composerState(await readScreen(body.terminalHandle), owner.agentType) === 'menu') {
      return json(res, 409, { error: '에이전트 터미널에 메뉴가 열려 있어 메시지가 전달되지 않습니다', code: 'menu_open' });
    }
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim() && !body.images?.length) return json(res, 400, { error: 'empty message' });
    const imagePaths = await saveImages(body.images);
    // cmd.exe shims can't carry newlines in an argument on Windows; send those lines space-joined.
    const composed = composePrompt(text, imagePaths);
    const prompt = process.platform === 'win32' ? composed.replace(/\s*\r?\n\s*/g, ' ') : composed;
    const args = ['terminal', 'send', '--terminal', body.terminalHandle, `--text=${prompt}`, '--enter'];
    return deliver(res, args);
  }

  if (pathname === '/api/send/retry') {
    // Re-issue a prompt Orca blocked, with its request id, so it can't be typed twice.
    const body = await readJson<{ requestId?: string }>(req);
    const pending = typeof body.requestId === 'string' ? blockedPrompts.get(body.requestId) : undefined;
    if (!pending || !knownHandle(pending.args[3])) return json(res, 404, { error: '다시 보낼 메시지를 찾지 못했습니다. 새로 보내주세요' });
    return deliver(res, [...pending.args, `--retry-request=${body.requestId}`, '--wait-submit=10'], body.requestId);
  }

  if (pathname === '/api/keys') {
    const body = await readJson<KeyRequest>(req);
    if (!knownHandle(body.terminalHandle)) return json(res, 404, { error: 'unknown terminal' });
    const bytes = body.char !== undefined ? charBytes(body.char) : keyBytes(body.key);
    if (!bytes) return json(res, 400, { error: 'unsupported key' });
    // `--text=value` so text starting with `--` can never be parsed as another flag.
    await orca(['terminal', 'send', '--terminal', body.terminalHandle, ...(body.key === 'enter' ? ['--enter'] : [`--text=${bytes}`])]);
    void poller.refresh();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/answer') {
    // Answer an AskUserQuestion dialog from the chat card by pressing the same keys a person would.
    const body = await readJson<AnswerRequest>(req);
    const found = findAgent(body.agentId);
    const handle = found?.agent.terminalHandle;
    if (!found || !handle) return json(res, 404, { error: 'unknown agent' });
    const filePath = await sessions.resolve(found.desk, found.agent).catch(() => null);
    const ask = filePath ? (await readTranscript(filePath)).questions.find((q) => q.toolUseId === body.toolUseId) : undefined;
    if (!ask) return json(res, 404, { error: '질문을 찾지 못했습니다' });
    if (ask.status !== 'pending') return json(res, 409, { error: '이미 답했거나 취소된 질문입니다' });
    const invalid = validateChoices(ask.questions, body.choices);
    if (invalid) return json(res, 400, { error: invalid });
    if (answering.has(handle)) return json(res, 409, { error: '답을 입력하는 중입니다' });
    answering.add(handle);
    try {
      await answerQuestions(
        {
          readScreen: () => readScreen(handle),
          press: async (key) => {
            await orca(['terminal', 'send', '--terminal', handle, ...(key === 'enter' ? ['--enter'] : [`--text=${keyBytes(key)}`])]);
          },
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        },
        ask.questions,
        body.choices,
      );
    } catch (err) {
      return json(res, 409, { error: (err as Error).message });
    } finally {
      answering.delete(handle);
    }
    void poller.refresh();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/queue') {
    const body = await readJson<QueueRequest>(req);
    if (!knownHandle(body.terminalHandle)) return json(res, 404, { error: 'unknown terminal' });
    const keys: TerminalKey[] = body.action === 'send-now' ? ['ctrl-enter'] : body.action === 'cancel' ? ['up', 'ctrl-u'] : [];
    if (!keys.length) return json(res, 400, { error: 'unknown action' });
    for (const key of keys) {
      await orca(['terminal', 'send', '--terminal', body.terminalHandle, `--text=${keyBytes(key)}`]);
      await new Promise((r) => setTimeout(r, 300));
    }
    void poller.refresh();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/hire') {
    const body = await readJson<HireRequest>(req);
    if (DEMO) return json(res, 400, { error: '데모 모드에서는 만들 수 없어요' });
    const plan = planHire(body, poller.current.desks);
    if ('error' in plan) return json(res, 400, { error: plan.error });
    const result = (await orca(plan.args)) as { terminal?: { handle?: string }; handle?: string };
    if (plan.promptAfter) {
      // The agent's TUI needs a moment; Orca can wait for it to be idle before we type.
      const handle = result?.terminal?.handle ?? result?.handle;
      if (handle) {
        const wait = (await orca(['terminal', 'wait', `--terminal=${handle}`, '--for=tui-idle', '--timeout-ms=60000'])) as {
          wait?: { satisfied?: boolean };
        };
        if (wait?.wait?.satisfied) await orca(['terminal', 'send', `--terminal=${handle}`, `--text=${plan.promptAfter}`, '--enter']);
        else return json(res, 200, { ok: true, warning: '에이전트는 띄웠지만 준비가 늦어 첫 지시는 보내지 못했어요. 패널에서 보내 주세요' });
      }
    }
    void poller.refresh();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/worktree') {
    const body = await readJson<WorktreeUpdate>(req);
    const desk = poller.current.desks.find((d) => d.id === body.deskId);
    if (!desk || DEMO) return json(res, 404, { error: 'unknown worktree' });
    const args = ['worktree', 'set', `--worktree=id:${desk.id}`];
    if (body.workspaceStatus !== undefined) {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.workspaceStatus)) return json(res, 400, { error: 'invalid status' });
      args.push(`--workspace-status=${body.workspaceStatus}`);
    }
    if (body.comment !== undefined) {
      const c = String(body.comment).replace(/\s+/g, ' ').trim();
      if (c.length > 200) return json(res, 400, { error: '코멘트는 200자까지 쓸 수 있어요' });
      // Orca can't clear a comment; a single space is the closest (shown as empty everywhere).
      args.push(`--comment=${c || ' '}`);
    }
    if (args.length === 3) return json(res, 400, { error: 'nothing to change' });
    await orca(args);
    void poller.refresh();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/focus') {
    const body = await readJson<FocusRequest>(req);
    if (!knownHandle(body.terminalHandle)) return json(res, 404, { error: 'unknown terminal' });
    await orca(['terminal', 'switch', '--terminal', body.terminalHandle]);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
}

function serveStatic(res: ServerResponse, pathname: string): void {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Office Desks bridge is running. Build the web UI with "npm run build", or use "npm run dev" and open http://localhost:${DEV_WEB_PORT}`);
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return json(res, 400, { error: 'bad path' });
  }
  let file = path.resolve(WEB_DIST, `.${path.sep}${path.normalize(decoded)}`);
  const rel = path.relative(WEB_DIST, file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !existsSync(file) || statSync(file).isDirectory()) {
    file = path.join(WEB_DIST, 'index.html');
  }
  // The file can vanish between the check and the read (e.g. while `vite build` rewrites dist):
  // answer with an error instead of letting the stream error take the bridge down.
  const stream = createReadStream(file);
  stream.on('open', () => {
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    stream.pipe(res);
  });
  stream.on('error', () => {
    if (!res.headersSent) json(res, 503, { error: 'web UI is being rebuilt, reload in a moment' });
    else res.destroy();
  });
}

const allowedPorts = [PORT, DEV_WEB_PORT];

const server = createServer((req, res) => {
  setSecurityHeaders(res);
  try {
    if (!isAllowedRequest(req.headers, allowedPorts)) return json(res, 403, { error: 'forbidden origin' });
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err: Error) => {
        const status = err instanceof SyntaxError || err instanceof UploadError ? 400 : 502;
        if (!res.headersSent) json(res, status, { error: err.message, code: (err as OrcaCliError).code });
      });
      return;
    }
    serveStatic(res, url.pathname);
  } catch (err) {
    // Never let one malformed request take the bridge down.
    if (!res.headersSent) json(res, 400, { error: (err as Error).message });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !isAllowedRequest(req.headers, allowedPorts)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function send(ws: WebSocket, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  poller.setIdle(false);
  ws.on('close', () => poller.setIdle(wss.clients.size === 0));
  send(ws, { type: 'snapshot', snapshot: poller.current });
  if (usage) send(ws, { type: 'usage', usage });
});

// Plan usage (5-hour / weekly / Fable) changes slowly; Orca refreshes it itself.
let usage: UsageSnapshot | null = null;
async function refreshUsage(): Promise<void> {
  try {
    const next = await fetchUsage(orca);
    if (JSON.stringify(next.providers) === JSON.stringify(usage?.providers)) return;
    usage = next;
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) send(ws, { type: 'usage', usage });
  } catch {
    /* keep the last value */
  }
}
void refreshUsage();
setInterval(() => void refreshUsage(), 60_000);

poller.onChange((snapshot) => {
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) send(ws, { type: 'snapshot', snapshot });
});

poller.setIdle(true); // until a browser connects
poller.start();
void cleanOldUploads();
server.listen(PORT, HOST, () => {
  console.log(`[office-desks] bridge on http://${HOST}:${PORT} (${DEMO ? 'DEMO data' : `orca cli: ${resolveOrcaCommand()}`})`);
});
