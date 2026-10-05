import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { CommandCatalog } from './commands.js';
import { createDemoAwards, demoOrg } from './demo.js';
import { agentStats } from './stats.js';
import { loadOrg, orgFile, saveOrg, sanitizeOrg } from './org.js';
import { AwardBook, awardsFile } from './awards.js';
import { changeSummary, fileDiff } from './gitInfo.js';
import { validateHire } from './hire.js';
import { createBackend } from './backend/index.js';
import { BackendBusyError, BackendError, type OfficeBackend } from './backend/types.js';
import { charBytes, keyBytes } from './keys.js';
import { answerQuestions, validateChoices } from './answer.js';
import { composerState, screenSupport } from './screen.js';
import type { AnswerRequest, ConversationResponse, FocusRequest, KeyRequest, QueueRequest, TerminalKey, WorktreeUpdate, HireRequest, SearchResult, OfficeAgent, OfficeDesk, SendRequest, ServerMessage, TerminalScreen, UsageSnapshot, FileDiffResponse, OrgChart } from './model.js';
import { resolveOrcaCommand } from './orcaCli.js';
import { OfficePoller } from './poller.js';
import { isAllowedRequest, setSecurityHeaders } from './security.js';
import { isLinkedImage, readLocalImage } from './localImage.js';
import { readTranscript } from './transcript.js';
import { subagentFile, subagentIds, subagentInfos } from './subagents.js';
import { cleanOldUploads, composePrompt, IMAGE_TYPES, saveImages, UploadError, uploadPath } from './uploads.js';

const HOST = '127.0.0.1'; // never expose: this server types into local terminals
const PORT = Number(process.env.OFFICE_DESKS_PORT ?? 4317);
const DEV_WEB_PORT = 5173;
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

// Only accept a session whose transcript actually contains what we searched for.
const backend: OfficeBackend = await createBackend(
  process.env,
  async (filePath, key) => {
    const t = await readTranscript(filePath);
    if (key.title) return t.title?.toLowerCase() === key.title.toLowerCase() || t.messages.length > 0;
    const needle = key.phrase.slice(0, 40);
    return t.messages.some((m) => m.role !== 'tool' && m.text.replace(/\s+/g, ' ').includes(needle));
  },
  { port: PORT },
);
// Sample awards and org chart for the demo office (not a backend concern).
const DEMO = backend.name === 'demo';
const commands = new CommandCatalog();
const poller = new OfficePoller(() => backend.snapshot(), 1500, async (s) => {
  await enrichFromTranscripts(s.desks);
  updateAwards(s.desks);
});

/** Past NativeBackend's 2 s startup grace, in which a splash screen doesn't count as a dialog. */
const HIRE_RECHECK_MS = 2500;

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
  return backend.readScreen(handle);
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
  // The file path comes from the backend (Orca's session index or the agent's own session id), never from the client.
  const filePath = await backend.findSession(found.desk, found.agent).catch(() => null);
  if (!filePath) return empty(backend.messages.noSession);
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

// Employee of the day (see awards.ts); the demo writes its own sample hall of fame.
const awards = new AwardBook(DEMO ? createDemoAwards() : awardsFile());
void awards.load();

function updateAwards(desks: OfficeDesk[]): void {
  if (!awards.update(desks)) return;
  void awards.save().catch(() => {});
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) send(ws, { type: 'awards', awards: awards.current });
}

/** Add what only transcripts know (running subagents, model, effort) to every agent. */
async function enrichFromTranscripts(desks: OfficeDesk[]): Promise<void> {
  if (backend.capabilities.changes) for (const d of desks) d.changes = cachedChanges(d);
  if (!backend.capabilities.transcripts) return;
  await Promise.all(
    desks.flatMap((desk) =>
      desk.agents
        .filter((a) => a.agentType === 'claude' || a.agentType === 'codex')
        .map(async (agent) => {
          // Never block the office poll on a search: use what we know, refresh in the background.
          void backend.findSession(desk, agent).catch(() => null);
          const filePath = backend.cachedSession(agent.id);
          if (!filePath) return;
          const t = await readTranscript(filePath).catch(() => null);
          if (!t) return;
          agent.subagentsRunning = t.calls.filter((c) => c.status === 'running').length;
          agent.model = t.model;
          agent.effort = t.effort;
          agent.stats = agentStats(t);
        }),
    ),
  );
}

/** Terminals currently being driven through a question dialog (one at a time each). */
const answering = new Set<string>();

/** Submit a prompt; a busy agent becomes a 409 the panel can retry by request id. */
async function deliver(res: ServerResponse, send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (err) {
    if (!(err instanceof BackendBusyError)) throw err;
    return json(res, 409, {
      code: 'agent_busy',
      requestId: err.requestId,
      error: '에이전트가 지금 새 메시지를 받을 수 없는 상태예요 (질문·권한 확인 중이거나 화면 전환 중). 잠시 후 다시 보내기를 눌러 주세요',
    });
  }
  void poller.refresh();
  return json(res, 200, { ok: true });
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/api/snapshot') {
    return json(res, 200, poller.current);
  }
  if (req.method === 'GET' && pathname === '/api/org') {
    return json(res, 200, org);
  }
  if (req.method === 'POST' && pathname === '/api/org') {
    const next = sanitizeOrg(await readJson<unknown>(req));
    if ('error' in next) return json(res, 400, next);
    await saveOrg(next, ORG_FILE);
    org = next;
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) send(ws, { type: 'org', org });
    return json(res, 200, org);
  }
  if (req.method === 'GET' && pathname === '/api/conversation/image') {
    // Images embedded in the agent's transcript (e.g. screenshots pasted into Claude Code).
    const agentId = url.searchParams.get('agentId');
    const desk = poller.current.desks.find((d) => d.agents.some((a) => a.id === agentId));
    const agent = desk?.agents.find((a) => a.id === agentId);
    const filePath = desk && agent ? await backend.findSession(desk, agent).catch(() => null) : null;
    const img = filePath ? (await readTranscript(filePath)).images[Number(url.searchParams.get('i'))] : undefined;
    if (!img || !IMAGE_TYPES[img.mediaType]) return json(res, 404, { error: 'no such image' });
    return sendBinary(res, img.mediaType, Buffer.from(img.data, 'base64'));
  }
  if (req.method === 'GET' && pathname === '/api/local-image') {
    // Local screenshots an agent linked in its own messages (e.g. ![shot](/tmp/x.png)).
    const found = findAgent(url.searchParams.get('agentId'));
    const want = url.searchParams.get('path') ?? '';
    if (!found || !path.isAbsolute(want)) return json(res, 404, { error: 'no such image' });
    const filePath = await backend.findSession(found.desk, found.agent).catch(() => null);
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
    if (!desk || !backend.capabilities.changes) return json(res, 404, { error: 'unknown worktree' });
    const summary = await changeSummary(desk.path);
    if (pathname === '/api/changes') return json(res, 200, summary);
    const file = summary.files.find((f) => f.path === url.searchParams.get('file'));
    if (!file) return json(res, 404, { error: 'not a changed file' });
    return json(res, 200, { file, ...(await fileDiff(desk.path, file)) } satisfies FileDiffResponse);
  }
  if (req.method === 'GET' && pathname === '/api/search') {
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!q || q.length > 200) return json(res, 400, { error: '검색어를 1~200자로 입력해 주세요' });
    if (!backend.capabilities.search) return json(res, 200, { results: [] });
    const hits = await backend.searchConversations(q);
    const results: SearchResult[] = hits.map((h) => {
      // Is this the session an agent in the office is running right now?
      let deskId: string | null = null;
      let agentId: string | null = null;
      for (const d of poller.current.desks) {
        const a = d.agents.find((x) => h.filePath && backend.cachedSession(x.id) === h.filePath);
        if (a) {
          deskId = d.id;
          agentId = a.id;
          break;
        }
      }
      return {
        title: h.title,
        agent: h.agent,
        project: path.basename(h.cwd),
        updatedAt: h.updatedAt,
        snippet: h.snippet,
        role: h.role,
        deskId,
        agentId,
        resumeCommand: agentId ? null : h.resumeCommand,
      };
    });
    return json(res, 200, { results });
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
    const prompt = composePrompt(text, imagePaths);
    return deliver(res, () => backend.sendPrompt(body.terminalHandle, prompt));
  }

  if (pathname === '/api/send/retry') {
    // Re-issue a prompt Orca blocked, with its request id, so it can't be typed twice.
    const body = await readJson<{ requestId?: string }>(req);
    const requestId = typeof body.requestId === 'string' ? body.requestId : '';
    if (!knownHandle(backend.blockedHandle(requestId))) return json(res, 404, { error: '다시 보낼 메시지를 찾지 못했습니다. 새로 보내주세요' });
    return deliver(res, () => backend.retryPrompt(requestId));
  }

  if (pathname === '/api/keys') {
    const body = await readJson<KeyRequest>(req);
    if (!knownHandle(body.terminalHandle)) return json(res, 404, { error: 'unknown terminal' });
    const bytes = body.char !== undefined ? charBytes(body.char) : keyBytes(body.key);
    if (!bytes) return json(res, 400, { error: 'unsupported key' });
    await backend.sendKeys(body.terminalHandle, body.key === 'enter' ? { enter: true } : { bytes });
    void poller.refresh();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/answer') {
    // Answer an AskUserQuestion dialog from the chat card by pressing the same keys a person would.
    const body = await readJson<AnswerRequest>(req);
    const found = findAgent(body.agentId);
    const handle = found?.agent.terminalHandle;
    if (!found || !handle) return json(res, 404, { error: 'unknown agent' });
    const filePath = await backend.findSession(found.desk, found.agent).catch(() => null);
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
            await backend.sendKeys(handle, key === 'enter' ? { enter: true } : { bytes: keyBytes(key)! });
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
      await backend.sendKeys(body.terminalHandle, { bytes: keyBytes(key)! });
      await new Promise((r) => setTimeout(r, 300));
    }
    void poller.refresh();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/hire') {
    const body = await readJson<HireRequest>(req);
    if (!backend.capabilities.hire) return json(res, 400, { error: backend.messages.hireDisabled });
    const spec = validateHire(body, poller.current.desks);
    if ('error' in spec) return json(res, 400, { error: spec.error });
    let result;
    try {
      result = await backend.hire(spec);
    } catch (err) {
      if (err instanceof Error) return json(res, 400, { error: err.message });
      throw err;
    }
    void poller.refresh();
    // Once more after the startup grace, so a trust dialog shows as waiting right away.
    setTimeout(() => void poller.refresh(), HIRE_RECHECK_MS).unref();
    if (result.warning) return json(res, 200, { ok: true, warning: result.warning });
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/worktree') {
    const body = await readJson<WorktreeUpdate>(req);
    const desk = poller.current.desks.find((d) => d.id === body.deskId);
    if (!desk || !backend.capabilities.board) return json(res, 404, { error: 'unknown worktree' });
    const update: { workspaceStatus?: string; comment?: string } = {};
    if (body.workspaceStatus !== undefined) {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.workspaceStatus)) return json(res, 400, { error: 'invalid status' });
      update.workspaceStatus = body.workspaceStatus;
    }
    if (body.comment !== undefined) {
      const c = String(body.comment).replace(/\s+/g, ' ').trim();
      if (c.length > 200) return json(res, 400, { error: '코멘트는 200자까지 쓸 수 있어요' });
      update.comment = c;
    }
    if (!Object.keys(update).length) return json(res, 400, { error: 'nothing to change' });
    await backend.setBoard(desk.id, update);
    void poller.refresh();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/focus') {
    const body = await readJson<FocusRequest>(req);
    if (!knownHandle(body.terminalHandle)) return json(res, 404, { error: 'unknown terminal' });
    await backend.focus(body.terminalHandle);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/repos') {
    const body = await readJson<{ path?: string }>(req);
    if (!backend.capabilities.repos) return json(res, 400, { error: '이 백엔드에서는 여기서 프로젝트를 추가할 수 없어요' });
    if (typeof body.path !== 'string' || !body.path.trim() || body.path.length > 1000) return json(res, 400, { error: '저장소 경로를 입력해 주세요' });
    try {
      await backend.addRepo(body.path.trim());
    } catch (err) {
      if (err instanceof BackendError) return json(res, 400, { error: err.message, code: err.code });
      throw err;
    }
    void poller.refresh();
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
    if (req.method === 'POST' && url.pathname.startsWith('/hook/')) {
      // Agent hooks from our own spawned agents (bridge/hook-relay.mjs); the per-agent token is the key.
      readJson<unknown>(req, 2 * 1024 * 1024)
        .then((payload) => {
          const ok = backend.hook(decodeURIComponent(url.pathname.slice('/hook/'.length)), url.searchParams.get('token') ?? '', payload);
          if (ok) void poller.refresh();
          res.writeHead(ok ? 204 : 404).end();
        })
        .catch(() => {
          if (!res.headersSent) res.writeHead(400).end();
        });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err: Error) => {
        const status = err instanceof SyntaxError || err instanceof UploadError ? 400 : (err as BackendError).code === 'terminal_not_writable' ? 409 : 502;
        if (!res.headersSent) json(res, status, { error: err.message, code: (err as BackendError).code });
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
  send(ws, { type: 'backend', backend: { name: backend.name, capabilities: backend.capabilities } });
  send(ws, { type: 'snapshot', snapshot: poller.current });
  if (usage) send(ws, { type: 'usage', usage });
  send(ws, { type: 'org', org });
  send(ws, { type: 'awards', awards: awards.current });
});

// Departments the user set up (shared by every browser); the demo keeps its own sample chart.
const ORG_FILE = DEMO ? path.join(os.tmpdir(), 'office-desks-demo', 'org.json') : orgFile();
let org: OrgChart = { departments: [] };
void loadOrg(ORG_FILE).then((loaded) => {
  org = DEMO && !loaded.departments.length ? demoOrg() : loaded;
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) send(ws, { type: 'org', org });
});

// Plan usage (5-hour / weekly / Fable) changes slowly; Orca refreshes it itself.
let usage: UsageSnapshot | null = null;
async function refreshUsage(): Promise<void> {
  try {
    const next = await backend.usage();
    if (!next) return;
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
  console.log(`[office-desks] bridge on http://${HOST}:${PORT} (${DEMO ? 'DEMO data' : backend.name === 'orca' ? `orca backend, orca cli: ${resolveOrcaCommand()}` : `${backend.name} backend`})`);
});

// Native agents live in this process: stop them with it.
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    void backend.dispose().finally(() => process.exit(0));
  });
}
