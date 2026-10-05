// Records crates/od-server/tests/contract/fixtures/*.json from the real Node bridge
// (bridge/src/server.ts, native backend) in a scratch world. The Rust test
// `cargo test -p od-server --test native` replays the same steps against od-server and compares.
// Run (macOS only): npm run contract:record [-- --only native|demo]
//
// `--only demo` records fixtures/demo.json from steps-demo.json: the bridge's demo backend
// (OFFICE_DESKS_BACKEND=demo, a fake Orca) with the demo clock fixed by OFFICE_DESKS_DEMO_EPOCH,
// replayed by the Rust trial `contract_demo`. No fake agent and no git are needed for it.
//
// The step format, the normalizer and the template rules are mirrored in
// crates/od-server/tests/native/contract.rs; normalize-cases.json pins the normalizer on both sides.
// Safety: everything lives under one mkdtemp root (HOME, TMPDIR, CLAUDE_CONFIG_DIR,
// OFFICE_DESKS_HOME, git config); the agent is the fake `claude` from the Rust test binary; the
// only processes this script signals are the bridge it spawned and the fake agents listed in that
// root's agents.jsonl.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { KNOWN_AGENTS } from '../src/hire.js';
import { findCommand } from '../src/native/env.js';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };
type Vars = Record<string, string>;
type Step = JsonObject & { name: string; group: string; kind: string };

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONTRACT_DIR = path.join(REPO_ROOT, 'crates', 'od-server', 'tests', 'contract');
const GROUPS = ['guard', 'empty', 'manage', 'hook', 'read', 'media', 'input'];
const HEADER_ALLOWLIST = ['content-type', 'cache-control', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'cross-origin-resource-policy', 'content-security-policy'];
const TIMESTAMP_KEYS = ['updatedAt', 'since', 'lastActivityAt', 'resetsAt'];
/** Request-only built-ins: PORT/HOST are covered by the port rule, REPO/NOTREPO by the ROOT rule. */
const NOT_NORMALIZED = ['PORT', 'HOST', 'REPO', 'NOTREPO'];
const WAIT_FOR_TIMEOUT_MS = 20_000;
const WAIT_FOR_EVERY_MS = 200;
const WS_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

// --- Normalizer -------------------------------------------------------------------------------

function rootForms(root: string): string[] {
  const forms = [root, root.replace(/\//g, '\\')];
  if (root.startsWith('/private/')) forms.push(root.slice('/private'.length));
  return forms.filter((f, i) => i === 0 || f !== forms[i - 1]);
}

export class Normalizer {
  private reps: [string, string][] = [];
  private readonly port: string | null;

  constructor(vars: Vars) {
    for (const [name, value] of Object.entries(vars)) {
      if (!value || NOT_NORMALIZED.includes(name)) continue;
      for (const f of name === 'ROOT' ? rootForms(value) : [value]) {
        const enc = encodeURIComponent(f);
        if (enc !== f) this.reps.push([enc, `\${${name}|uri}`]);
        this.reps.push([f, `\${${name}}`]);
      }
    }
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    this.reps.sort((a, b) => b[0].length - a[0].length || cmp(a[0], b[0]) || cmp(a[1], b[1]));
    this.reps = this.reps.filter((r, i) => i === 0 || r[0] !== this.reps[i - 1][0]);
    this.port = vars.PORT || null;
  }

  string(s: string): string {
    let out = s;
    for (const [pattern, placeholder] of this.reps) if (out.includes(pattern)) out = out.split(pattern).join(placeholder);
    if (this.port) out = out.replace(new RegExp(`(127\\.0\\.0\\.1|localhost):${this.port}(?![0-9])`, 'g'), (_m, host: string) => `${host}:\${PORT}`);
    if (out.includes('${ROOT}')) out = out.replace(/\\/g, '/');
    return out;
  }

  value(v: Json): Json {
    if (typeof v === 'string') return this.string(v);
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (isObject(v)) {
      const out: JsonObject = {};
      for (const [k, x] of Object.entries(v)) {
        out[this.string(k)] = TIMESTAMP_KEYS.includes(k) && typeof x === 'number' ? 0 : k === 'fileId' && typeof x === 'string' ? '${FILE_ID}' : this.value(x);
      }
      return out;
    }
    return v;
  }
}

export const normalize = (v: Json, vars: Vars): Json => new Normalizer(vars).value(v);

/**
 * Id shapes in captured values: lowercase UUIDs become `${UUID}`, then every alphanumeric run of
 * 8+ lowercase hex digits becomes `${HEX<n>}`. Uppercase hex stays, so a format change shows.
 */
export function maskIds(s: string): string {
  return s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, () => '${UUID}')
    .replace(/[0-9A-Za-z]+/g, (t) => (t.length >= 8 && /^[0-9a-f]+$/.test(t) ? `\${HEX${t.length}}` : t));
}

function maskValue(v: Json): Json {
  if (typeof v === 'string') return maskIds(v);
  if (Array.isArray(v)) return v.map(maskValue);
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskValue(x)]));
  return v;
}

/** Each captured value normalized with the variables before the step plus its other captures, then masked. */
export function capturedBlock(before: Vars, captured: Vars): JsonObject {
  const out: JsonObject = {};
  for (const [name, value] of Object.entries(captured)) {
    const vars: Vars = { ...before };
    for (const [k, v] of Object.entries(captured)) if (k !== name) vars[k] = v;
    out[name] = maskIds(new Normalizer(vars).string(value));
  }
  return out;
}

function checkNormalizeCases(): void {
  const cases = JSON.parse(readFileSync(path.join(CONTRACT_DIR, 'normalize-cases.json'), 'utf8')) as { vars: Vars; input: Json; output: Json; mask?: boolean }[];
  if (cases.length < 8) throw new Error(`normalize-cases.json: only ${cases.length} cases`);
  cases.forEach((c, i) => {
    const got = c.mask ? maskValue(normalize(c.input, c.vars)) : normalize(c.input, c.vars);
    if (!deepEqual(got, c.output)) throw new Error(`normalize case ${i}: expected ${JSON.stringify(c.output)} got ${JSON.stringify(got)}`);
  });
}

// --- Templates, segments, recording -----------------------------------------------------------

export function expand(s: string, vars: Vars): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(\|uri)?\}/g, (_m, name: string, uri?: string) => {
    if (!(name in vars)) throw new Error(`unknown template variable ${name} in ${JSON.stringify(s)}`);
    return uri ? encodeURIComponent(vars[name]) : vars[name];
  });
}

function expandJson(v: Json, vars: Vars): Json {
  if (typeof v === 'string') return expand(v, vars);
  if (Array.isArray(v)) return v.map((x) => expandJson(x, vars));
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandJson(x, vars)]));
  return v;
}

function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Object keys, array indexes or `{ where: { k: v } }` (first array element with those fields). */
function resolve(v: Json, segments: Json[]): Json | undefined {
  let cur: Json | undefined = v;
  for (const seg of segments) {
    if (cur === undefined) return undefined;
    if (typeof seg === 'string') cur = isObject(cur) && seg in cur ? cur[seg] : undefined;
    else if (typeof seg === 'number') cur = Array.isArray(cur) && Number.isInteger(seg) && seg >= 0 && seg < cur.length ? cur[seg] : undefined;
    else if (isObject(seg) && typeof seg.contains === 'string') {
      const text = seg.contains;
      cur = Array.isArray(cur) ? cur.find((el) => typeof el === 'string' && el.includes(text)) : undefined;
    } else if (isObject(seg) && isObject(seg.where)) {
      const want = seg.where;
      cur = Array.isArray(cur) ? cur.find((el) => isObject(el) && Object.entries(want).every(([k, x]) => k in el && deepEqual(el[k], x))) : undefined;
    } else return undefined;
  }
  return cur;
}

/** Every segment exists, the value is not null, and it deep-equals `equals` when given. */
function resolves(v: Json, segments: Json[], equals: Json | undefined): boolean {
  const x = resolve(v, segments);
  return x !== undefined && x !== null && (equals === undefined || deepEqual(x, equals));
}

function classify(contentType: string, body: Buffer): Json {
  if (!body.length) return { empty: true };
  if (contentType.startsWith('application/json')) {
    try {
      return { json: JSON.parse(body.toString('utf8')) as Json };
    } catch {
      return { invalidJson: body.toString('utf8') };
    }
  }
  if (contentType.startsWith('text/')) return { text: body.toString('utf8') };
  return { sha256: createHash('sha256').update(body).digest('hex'), len: body.length };
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function record(r: RawResponse): Json {
  const headers: JsonObject = {};
  for (const name of HEADER_ALLOWLIST) {
    const v = r.headers[name];
    if (v !== undefined) headers[name] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return { status: r.status, headers, body: classify(String(r.headers['content-type'] ?? ''), r.body) };
}

function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// --- HTTP and WebSocket clients ---------------------------------------------------------------

function request(port: number, method: string, p: string, headers: Record<string, string>, body: Buffer | null): Promise<RawResponse> {
  return new Promise((resolveP, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false, timeout: 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolveP({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${p}: timed out`)));
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}

interface Sock {
  ws: WebSocket;
  queue: { t: number; v: Json }[];
}

/** Node destroys the socket of an upgrade it refuses: require EOF without a single byte. */
function wsReject(port: number, p: string, headers: Record<string, string>): Promise<void> {
  return new Promise((resolveP, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let got = Buffer.alloc(0);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`wsReject ${p}: the socket stayed open for ${WS_TIMEOUT_MS} ms`));
    }, WS_TIMEOUT_MS);
    sock.on('connect', () => {
      let req = `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n`;
      for (const [k, v] of Object.entries(headers)) req += `${k}: ${v}\r\n`;
      sock.write(`${req}\r\n`);
    });
    sock.on('data', (c: Buffer) => (got = Buffer.concat([got, c])));
    sock.on('error', () => {
      /* ECONNRESET is a destroyed socket too; 'close' follows */
    });
    sock.on('close', () => {
      clearTimeout(timer);
      if (got.length) reject(new Error(`wsReject ${p}: Node answered ${JSON.stringify(got.toString('latin1').split('\r\n')[0])}; expected the socket to be destroyed`));
      else resolveP();
    });
  });
}

// --- The scratch world ------------------------------------------------------------------------

function writeFile(p: string, data: string | Buffer): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, data);
}

function git(gitPath: string, cwd: string, env: Vars, args: string[]): void {
  const r = spawnSync(gitPath, args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.error?.message}`);
}

function buildFakeAgent(): string {
  const r = spawnSync('cargo', ['test', '-p', 'od-server', '--test', 'native', '--no-run', '--message-format=json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (r.status !== 0) throw new Error('cargo test --no-run failed');
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    const msg = JSON.parse(line) as { reason?: string; target?: { name?: string }; executable?: string | null };
    if (msg.reason === 'compiler-artifact' && msg.target?.name === 'native' && msg.executable) return msg.executable;
  }
  throw new Error('no executable for the od-server `native` test');
}

function buildSetup(root: string, setup: JsonObject, env: Vars, gitPath: string): void {
  const repo = path.join(root, 'repo');
  const rs = setup.repo as JsonObject;
  for (const [f, text] of Object.entries(rs.files as JsonObject)) writeFile(path.join(repo, f), String(text));
  git(gitPath, repo, env, ['init', '-q', '-b', 'main']);
  git(gitPath, repo, env, ['config', 'core.autocrlf', 'false']);
  git(gitPath, repo, env, ['add', '-A']);
  const c = rs.commit as Record<string, string>;
  const who = {
    GIT_AUTHOR_NAME: c.name,
    GIT_AUTHOR_EMAIL: c.email,
    GIT_AUTHOR_DATE: c.date,
    GIT_COMMITTER_NAME: c.name,
    GIT_COMMITTER_EMAIL: c.email,
    GIT_COMMITTER_DATE: c.date,
  };
  git(gitPath, repo, { ...env, ...who }, ['commit', '-q', '-m', c.message]);
  for (const [f, text] of Object.entries(rs.after as JsonObject)) writeFile(path.join(repo, f), String(text));
  for (const [f, text] of Object.entries(setup.files as JsonObject)) writeFile(path.join(root, f), String(text));
  for (const d of setup.dirs as string[]) mkdirSync(path.join(root, d), { recursive: true });
  // The bridge's upload folder: os.tmpdir() (our TMPDIR) / office-desks-<uid> / uploads, 0700.
  const ours = path.join(root, 'tmp', `office-desks-${process.getuid!()}`);
  const uploads = path.join(ours, 'uploads');
  mkdirSync(uploads, { recursive: true });
  chmodSync(ours, 0o700);
  chmodSync(uploads, 0o700);
  for (const [f, b64] of Object.entries(setup.uploads as JsonObject)) writeFile(path.join(uploads, f), Buffer.from(String(b64), 'base64'));
}

function preflight(env: Vars, root: string): void {
  const ours = realpathSync.native(path.join(root, 'bin', 'claude'));
  for (const name of KNOWN_AGENTS) {
    const found = findCommand(name, env);
    const ok = name === 'claude' ? found !== null && realpathSync.native(found) === ours : found === null;
    if (!ok) throw new Error(`contract: ${name} found on the scratch PATH at ${found ?? '<nowhere>'}; refusing to record`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => (port === 4317 ? reject(new Error('got port 4317')) : resolveP(port)));
    });
  });
}

function agentLines(out: string): JsonObject[] {
  let text = '';
  try {
    text = readFileSync(path.join(out, 'agents.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as JsonObject);
}

/**
 * `pid` is alive and runs our fake agent: its first `txt` file (the executable) per `lsof` is
 * `exe`. `ps -o comm=` is no use here: it shows argv[0] (`claude`), not the path.
 */
function isOurAgent(pid: number, exe: string): boolean {
  const r = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { encoding: 'utf8' });
  const file = r.stdout?.split('\n').find((l) => l.startsWith('n'))?.slice(1);
  if (!file) return false;
  try {
    return realpathSync.native(file) === realpathSync.native(exe);
  } catch {
    return false;
  }
}

// --- The run ----------------------------------------------------------------------------------

class Run {
  readonly vars: Vars;
  readonly sockets = new Map<string, Sock>();
  readonly started = new Map<string, number>();
  /** What the current step captured. */
  captured: Vars = {};

  constructor(
    private readonly port: number,
    private readonly root: string,
    vars: Vars,
  ) {
    this.vars = vars;
  }

  private capture(step: Step, from: Json): void {
    if (!isObject(step.capture)) return;
    for (const [name, segs] of Object.entries(step.capture)) {
      const v = resolve(from, segs as Json[]);
      if (typeof v !== 'string') throw new Error(`capture ${name}: ${JSON.stringify(segs)} is not a string`);
      this.vars[name] = v;
      this.captured[name] = v;
    }
  }

  /** The recorded value, or undefined for steps that record nothing. */
  async run(step: Step): Promise<Json | undefined> {
    switch (step.kind) {
      case 'http':
        return this.http(step);
      case 'waitFor':
        return void (await this.waitFor(step));
      case 'sleep':
        return void (await sleep(step.ms as number));
      case 'wsOpen':
        return this.wsOpen(step);
      case 'wsExpect':
        return this.wsExpect(step);
      case 'wsReject': {
        const headers = Object.fromEntries(Object.entries((step.headers ?? {}) as JsonObject).filter(([, v]) => v !== null).map(([k, v]) => [k, expand(String(v), this.vars)]));
        await wsReject(this.port, expand(step.path as string, this.vars), headers);
        return { rejected: true };
      }
      case 'agentInfo':
        return void (await this.agentInfo());
      case 'seedTranscript':
        return void this.seedTranscript(step);
      case 'writeFile':
        return void writeFile(expand(step.path as string, this.vars), Buffer.from(step.base64 as string, 'base64'));
      default:
        throw new Error(`unknown step kind ${step.kind}`);
    }
  }

  private async http(step: Step): Promise<Json> {
    const headers: Record<string, string> = {};
    let hasContentType = false;
    for (const [k, v] of Object.entries((step.headers ?? {}) as JsonObject)) {
      if (k.toLowerCase() === 'content-type') hasContentType = true;
      if (v !== null) headers[k] = expand(String(v), this.vars);
    }
    let body: Buffer | null = null;
    if ('body' in step) body = Buffer.from(JSON.stringify(expandJson(step.body, this.vars)));
    else if (typeof step.bodyRaw === 'string') body = Buffer.from(expand(step.bodyRaw, this.vars));
    else if (isObject(step.bodyRepeat)) {
      const r = step.bodyRepeat as { prefix?: string; char: string; count: number; suffix?: string };
      body = Buffer.from(`${r.prefix ?? ''}${r.char.repeat(r.count)}${r.suffix ?? ''}`);
    }
    if (body && !hasContentType) headers['content-type'] = 'application/json';
    const res = await request(this.port, step.method as string, expand(step.path as string, this.vars), headers, body);
    const rec = record(res) as JsonObject;
    if (step.capture) this.capture(step, ((rec.body as JsonObject).json ?? null) as Json);
    return rec;
  }

  private async waitFor(step: Step): Promise<void> {
    const segs = step.path as Json[];
    const url = typeof step.url === 'string' ? expand(step.url, this.vars) : '/api/snapshot';
    const deadline = Date.now() + WAIT_FOR_TIMEOUT_MS;
    for (;;) {
      const r = await request(this.port, 'GET', url, {}, null);
      let snap: Json = null;
      try {
        snap = JSON.parse(r.body.toString('utf8')) as Json;
      } catch {
        /* keep waiting */
      }
      if (resolves(snap, segs, step.equals)) return this.capture(step, snap);
      if (Date.now() >= deadline) throw new Error(`waitFor ${JSON.stringify(segs)} did not resolve in ${WAIT_FOR_TIMEOUT_MS} ms at ${url}; last answer:\n${JSON.stringify(snap, null, 2)}`);
      await sleep(WAIT_FOR_EVERY_MS);
    }
  }

  private async wsOpen(step: Step): Promise<Json> {
    const count = step.count as number;
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
    const sock: Sock = { ws, queue: [] };
    ws.on('message', (data) => sock.queue.push({ t: performance.now(), v: JSON.parse(String(data)) as Json }));
    this.sockets.set(step.id as string, sock);
    await new Promise<void>((resolveP, reject) => {
      ws.once('open', () => resolveP());
      ws.once('error', reject);
    });
    const deadline = Date.now() + WS_TIMEOUT_MS;
    while (sock.queue.length < count) {
      if (Date.now() >= deadline) throw new Error(`wsOpen: fewer than ${count} messages in ${WS_TIMEOUT_MS} ms`);
      await sleep(20);
    }
    return { messages: sock.queue.slice(0, count).map((m) => m.v) };
  }

  private async wsExpect(step: Step): Promise<Json> {
    const since = this.started.get(step.after as string);
    if (since === undefined) throw new Error(`wsExpect: step ${String(step.after)} has not run`);
    const sock = this.sockets.get(step.id as string);
    if (!sock) throw new Error(`wsExpect: no socket ${String(step.id)}`);
    const deadline = Date.now() + WS_TIMEOUT_MS;
    for (;;) {
      const hit = sock.queue.find((m) => m.t >= since && isObject(m.v) && m.v.type === step.type);
      if (hit) return { messages: [hit.v] };
      if (Date.now() >= deadline) throw new Error(`wsExpect: no ${String(step.type)} message after ${String(step.after)}`);
      await sleep(20);
    }
  }

  private async agentInfo(): Promise<void> {
    const agent = this.vars.AGENT;
    if (!agent) throw new Error('agentInfo needs AGENT');
    const needle = encodeURIComponent(agent);
    const deadline = Date.now() + WS_TIMEOUT_MS;
    let line: JsonObject | undefined;
    while (!(line = agentLines(path.join(this.root, 'out')).find((l) => typeof l.hookUrl === 'string' && l.hookUrl.includes(needle)))) {
      if (Date.now() >= deadline) throw new Error(`agentInfo: no agents.jsonl line for ${agent}`);
      await sleep(100);
    }
    const token = new URL(String(line.hookUrl)).searchParams.get('token');
    const args = (line.args as string[]) ?? [];
    const i = args.indexOf('--session-id');
    if (!token || i < 0 || !args[i + 1]) throw new Error(`agentInfo: bad line ${JSON.stringify(line)}`);
    this.vars.TOKEN = this.captured.TOKEN = token;
    this.vars.SID = this.captured.SID = args[i + 1];
  }

  private seedTranscript(step: Step): void {
    const sid = this.vars.SID;
    if (!sid) throw new Error('seedTranscript needs SID');
    let text = readFileSync(path.join(REPO_ROOT, 'bridge', 'test', 'fixtures', 'claude-rich.jsonl'), 'utf8').replace(/\r\n/g, '\n');
    if (!text.endsWith('\n')) text += '\n';
    for (const line of (step.append ?? []) as string[]) text += `${expand(line, this.vars)}\n`;
    writeFile(path.join(this.root, 'claude', 'projects', 'scratch', `${sid}.jsonl`), text);
  }
}

/** Spawns the bridge with exactly `env` and waits for `GET /api/snapshot` to answer 200. */
async function startBridge(env: Vars, port: number, root: string, log: string[]): Promise<ChildProcess> {
  const bridge = spawn(process.execPath, ['--import', 'tsx', 'bridge/src/server.ts'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`contract: bridge pid ${bridge.pid} on 127.0.0.1:${port}, scratch ${root}`);
  bridge.stdout!.on('data', (c: Buffer) => log.push(c.toString()));
  bridge.stderr!.on('data', (c: Buffer) => log.push(c.toString()));
  return bridge;
}

async function waitForBridge(bridge: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (bridge.exitCode !== null) throw new Error(`contract: the bridge exited with ${bridge.exitCode}`);
    const ok = await request(port, 'GET', '/api/snapshot', {}, null).then((r) => r.status === 200, () => false);
    if (ok) return;
    if (Date.now() >= deadline) throw new Error('contract: the bridge did not answer in 20 s');
    await sleep(200);
  }
}

/** SIGTERM the bridge this script spawned, then SIGKILL that same pid after 5 s. Nothing else. */
async function stopBridge(bridge: ChildProcess | null): Promise<void> {
  if (bridge?.pid && bridge.exitCode === null && bridge.signalCode === null) {
    const exited = new Promise<void>((r) => bridge.once('exit', () => r()));
    bridge.kill('SIGTERM');
    const t = await Promise.race([exited.then(() => 'exit'), sleep(5000).then(() => 'timeout')]);
    if (t === 'timeout') {
      console.error(`contract: bridge ${bridge.pid} did not exit in 5 s; SIGKILL`);
      bridge.kill('SIGKILL');
      await exited;
    }
  }
}

/** Runs `steps` in order and returns each group's fixture entries. */
async function recordSteps(run: Run, steps: Step[], groups: string[]): Promise<Record<string, JsonObject>> {
  const fixtures: Record<string, JsonObject> = Object.fromEntries(groups.map((g) => [g, {}]));
  for (const step of steps) {
    run.started.set(step.name, performance.now());
    const before: Vars = { ...run.vars };
    run.captured = {};
    let rec: Json | undefined;
    try {
      rec = await run.run(step);
    } catch (err) {
      throw new Error(`step ${step.name}: ${(err as Error).message}`);
    }
    // Normalized with the variables known after this step (its own captures included), so a
    // fixture never depends on a later step: the Rust replay may stop at any group.
    // A capturing step also records `captured`: id shapes, normalized with the variables
    // before the step (never normalized again).
    const captured = Object.keys(run.captured).length ? capturedBlock(before, run.captured) : null;
    if (rec !== undefined) {
      const n = normalize(rec, run.vars) as JsonObject;
      if (captured) n.captured = captured;
      fixtures[step.group][step.name] = n;
    } else if (captured) fixtures[step.group][step.name] = { captured };
    const status = isObject(rec) && typeof rec.status === 'number' ? rec.status : rec === undefined ? '-' : 'ws';
    console.log(`  ${step.group.padEnd(6)} ${step.name} ${status}`);
  }
  return fixtures;
}

function writeFixture(group: string, entries: JsonObject): void {
  writeFileSync(path.join(CONTRACT_DIR, 'fixtures', `${group}.json`), `${JSON.stringify(sortKeys(entries), null, 2)}\n`);
}

/** steps.json against the native backend: fixtures/<group>.json for every group in GROUPS. */
async function recordNative(): Promise<void> {
  const doc = JSON.parse(readFileSync(path.join(CONTRACT_DIR, 'steps.json'), 'utf8')) as { version: number; setup: JsonObject; steps: Step[] };
  if (doc.version !== 1) throw new Error(`steps.json version ${doc.version}`);
  const names = new Set<string>();
  let lastGroup = 0;
  for (const st of doc.steps) {
    if (names.has(st.name)) throw new Error(`duplicate step ${st.name}`);
    names.add(st.name);
    const g = GROUPS.indexOf(st.group);
    if (g < lastGroup) throw new Error(`step ${st.name}: unknown group or groups out of order`);
    lastGroup = g;
  }

  const exe = buildFakeAgent();
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'od-contract-')));
  let bridge: ChildProcess | null = null;
  let run: Run | null = null;
  const log: string[] = [];
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    for (const s of run?.sockets.values() ?? []) s.ws.terminate();
    await stopBridge(bridge);
    const ours = path.join(root, 'bin', 'claude');
    for (const line of agentLines(path.join(root, 'out'))) {
      const pid = line.pid as number;
      if (!isOurAgent(pid, ours)) continue; // gone, or the pid now belongs to someone else
      console.error(`contract: fake agent ${pid} outlived the bridge; SIGKILL`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* exited meanwhile */
      }
    }
    rmSync(root, { recursive: true, force: true });
  };
  const onSignal = () => void cleanup().finally(() => process.exit(130));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    for (const d of ['bin', 'out', 'tmp', 'home', 'office', 'claude']) mkdirSync(path.join(root, d), { recursive: true });
    writeFileSync(path.join(root, 'gitconfig'), '');
    const agentBin = path.join(root, 'bin', 'claude');
    copyFileSync(exe, agentBin);
    chmodSync(agentBin, 0o755);

    const gitPath = findCommand('git', process.env as Vars);
    if (!gitPath) throw new Error('contract: git not found');
    const port = await freePort();
    // git through a symlink of its own, so a folder next to git (Homebrew's bin, with a real
    // claude or codex in it) never lands on the scratch PATH.
    mkdirSync(path.join(root, 'gitbin'));
    symlinkSync(gitPath, path.join(root, 'gitbin', 'git'));
    const pathDirs = [path.join(root, 'bin'), path.join(root, 'gitbin'), '/usr/bin', '/bin'];
    const env: Vars = {
      PATH: pathDirs.join(path.delimiter),
      HOME: path.join(root, 'home'),
      USERPROFILE: path.join(root, 'home'),
      TMPDIR: path.join(root, 'tmp'),
      TMP: path.join(root, 'tmp'),
      TEMP: path.join(root, 'tmp'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      OFFICE_DESKS_HOME: path.join(root, 'office'),
      OFFICE_DESKS_BACKEND: 'native',
      OFFICE_DESKS_PORT: String(port),
      OD_FAKE_AGENT_OUT: path.join(root, 'out'),
      GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      LANG: 'C.UTF-8',
    };
    const v = spawnSync(gitPath, ['--version'], { env, encoding: 'utf8' });
    if (v.status !== 0) throw new Error(`contract: ${gitPath} --version failed under the scratch env: ${v.stderr || v.error?.message}`);
    buildSetup(root, doc.setup, env, gitPath);
    preflight(env, root);

    bridge = await startBridge(env, port, root, log);
    await waitForBridge(bridge, port);

    const vars: Vars = {
      ROOT: root.replace(/\\/g, '/'),
      REPO: path.join(root, 'repo'),
      NOTREPO: path.join(root, 'home'),
      PORT: String(port),
      HOST: `127.0.0.1:${port}`,
    };
    run = new Run(port, root, vars);
    const fixtures = await recordSteps(run, doc.steps, GROUPS);
    for (const g of GROUPS) writeFixture(g, fixtures[g]);
    console.log(`wrote ${GROUPS.length} fixture files`);
  } catch (err) {
    if (log.length) console.error(`--- bridge output ---\n${log.join('')}`);
    throw err;
  } finally {
    await cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/** steps-demo.json against the demo backend with a fixed clock: fixtures/demo.json. */
async function recordDemo(): Promise<void> {
  const doc = JSON.parse(readFileSync(path.join(CONTRACT_DIR, 'steps-demo.json'), 'utf8')) as { version: number; epoch: unknown; steps: Step[] };
  if (doc.version !== 1) throw new Error(`steps-demo.json version ${doc.version}`);
  const epoch = doc.epoch;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch <= 0) throw new Error(`steps-demo.json: epoch ${JSON.stringify(epoch)} is not a positive integer`);
  const names = new Set<string>();
  for (const st of doc.steps) {
    if (names.has(st.name)) throw new Error(`steps-demo.json: duplicate step ${st.name}`);
    names.add(st.name);
    if (st.group !== 'demo') throw new Error(`steps-demo.json: step ${st.name} is in group ${st.group}, not demo`);
  }

  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'od-contract-demo-')));
  let bridge: ChildProcess | null = null;
  let run: Run | null = null;
  const log: string[] = [];
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    for (const s of run?.sockets.values() ?? []) s.ws.terminate();
    await stopBridge(bridge);
    rmSync(root, { recursive: true, force: true });
  };
  const onSignal = () => void cleanup().finally(() => process.exit(130));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    for (const d of ['tmp', 'home', 'office', 'claude']) mkdirSync(path.join(root, d), { recursive: true });
    writeFileSync(path.join(root, 'gitconfig'), '');
    const port = await freePort();
    const env: Vars = {
      PATH: ['/usr/bin', '/bin'].join(path.delimiter),
      HOME: path.join(root, 'home'),
      USERPROFILE: path.join(root, 'home'),
      TMPDIR: path.join(root, 'tmp'),
      TMP: path.join(root, 'tmp'),
      TEMP: path.join(root, 'tmp'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      OFFICE_DESKS_HOME: path.join(root, 'office'),
      // Explicit, so the bridge never probes Orca.
      OFFICE_DESKS_BACKEND: 'demo',
      OFFICE_DESKS_DEMO_EPOCH: String(epoch),
      OFFICE_DESKS_PORT: String(port),
      GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      LANG: 'C.UTF-8',
    };

    bridge = await startBridge(env, port, root, log);
    await waitForBridge(bridge, port);

    const vars: Vars = { ROOT: root.replace(/\\/g, '/'), PORT: String(port), HOST: `127.0.0.1:${port}` };
    run = new Run(port, root, vars);
    const fixtures = await recordSteps(run, doc.steps, ['demo']);
    writeFixture('demo', fixtures.demo);
    console.log('wrote fixtures/demo.json');
  } catch (err) {
    if (log.length) console.error(`--- bridge output ---\n${log.join('')}`);
    throw err;
  } finally {
    await cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/** `--only native|demo`; both when absent. */
function parseOnly(argv: string[]): 'native' | 'demo' | null {
  if (!argv.length) return null;
  if (argv.length === 2 && argv[0] === '--only' && (argv[1] === 'native' || argv[1] === 'demo')) return argv[1];
  throw new Error(`usage: npm run contract:record [-- --only native|demo] (got ${JSON.stringify(argv)})`);
}

async function main(): Promise<void> {
  if (process.platform === 'win32') throw new Error('contract: the recorder runs on macOS only (Windows replays the committed fixtures)');
  const only = parseOnly(process.argv.slice(2));
  checkNormalizeCases();
  if (only !== 'demo') await recordNative();
  if (only !== 'native') await recordDemo();
}

main().catch((err: unknown) => {
  console.error((err as Error).message ?? err);
  process.exitCode = 1;
});
