import type { HireResult, HireSpec } from '../backend/types.js';
import { validateHire } from '../hire.js';
import type { OfficeSnapshot } from '../model.js';
import { AttachSession, type AttachHost, type TermOut } from './attach.js';
import { decodeKeysAt, type Key } from './keys.js';
import { lobbyFits, lobbyRows, renderLobby, type LobbyRow } from './lobby.js';
import { Form } from './prompt.js';
import { ALT_ON, CLEAR, HIDE_CURSOR, HOME, moveTo, SHOW_CURSOR } from './screen.js';
import { displayWidth, clean } from './text.js';

export interface TuiDeps {
  snapshot(): OfficeSnapshot;
  onSnapshot(fn: () => void): () => void;
  refresh(): Promise<void>;
  hire(spec: HireSpec): Promise<HireResult>;
  addRepo(path: string): Promise<void>;
  terminalOf(agentId: string): string | null;
  host: AttachHost;
  url: string;
}

export interface TermIn {
  on(ev: 'data', fn: (d: string) => void): unknown;
  off?(ev: 'data', fn: (d: string) => void): unknown;
}

type Mode = 'lobby' | 'form' | 'attach' | 'confirm';
type FormKind = 'repo' | 'agent' | 'work';

const ESC_WAIT_MS = 50;
const AGENT_FIELD = { label: '에이전트 (claude/codex/gemini)', initial: 'claude' };
const PROMPT_FIELD = { label: '첫 지시 (선택)', optional: true };
const FORMS: Record<FormKind, (row: LobbyRow | null) => Form> = {
  repo: () => new Form([{ label: 'git 저장소 경로' }]),
  agent: () => new Form([AGENT_FIELD, PROMPT_FIELD]),
  work: (row) => new Form([{ label: `새 워크트리 이름 (${row?.repo ?? ''})` }, AGENT_FIELD, PROMPT_FIELD]),
};
const BUSY: Record<FormKind, string> = { repo: '추가하는 중…', agent: '만드는 중…', work: '만드는 중…' };
// An escape sequence cut off at the end of a chunk (lone ESC, ESC [ 9, ESC O).
const INCOMPLETE_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*|O)?$/;

const idOf = (r: LobbyRow | undefined) => (r ? (r.agentId ?? r.deskId) : null);

export class App {
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private mode: Mode = 'lobby';
  private rows: LobbyRow[] = [];
  private selected = 0;
  private notice: string | null = null;
  private form: Form | null = null;
  private formKind: FormKind | null = null;
  private target: LobbyRow | null = null;
  private session: AttachSession | null = null;
  private pending = '';
  private pendingTimer: NodeJS.Timeout | null = null;
  private readonly onData = (d: string) => {
    this.queue = this.queue.then(() => this.handle(String(d))).catch(() => {});
  };
  private offSnapshot: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly onResize = () => this.refit();

  constructor(
    private readonly deps: TuiDeps,
    private readonly input: TermIn,
    private readonly out: TermOut & { on?(ev: 'resize', fn: () => void): unknown; off?(ev: 'resize', fn: () => void): unknown },
    private readonly escWaitMs = ESC_WAIT_MS,
  ) {
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  start(): void {
    this.out.write(ALT_ON + HIDE_CURSOR + CLEAR);
    this.rows = lobbyRows(this.deps.snapshot());
    this.input.on('data', this.onData);
    this.out.on?.('resize', this.onResize);
    this.offSnapshot = this.deps.onSnapshot(() => this.refit(true));
    this.render();
  }

  async handle(chunk: string): Promise<void> {
    if (this.closed) return;
    if (this.mode === 'attach') {
      this.session?.input(chunk);
      return;
    }
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    const full = this.pending + chunk;
    let data = full;
    this.pending = '';
    const cut = INCOMPLETE_ESCAPE.exec(data);
    if (cut) {
      this.pending = cut[0];
      data = data.slice(0, cut.index);
      const held = this.pending;
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        if (this.pending !== held) return;
        this.pending = '';
        // In line with any input still being handled (a hire in flight, say).
        if (held === '\x1b') this.queue = this.queue.then(() => this.keys([{ key: { name: 'escape' }, end: 0 }], '')).catch(() => {});
      }, this.escWaitMs);
    }
    await this.keys(decodeKeysAt(data), full);
  }

  private async keys(keys: { key: Key; end: number }[], raw: string): Promise<void> {
    for (const { key, end } of keys) {
      await this.key(key);
      if (this.closed) return;
      if (this.mode === 'attach') {
        // Whatever followed the Enter in the same chunk belongs to the agent, byte for byte
        // (a held partial escape sequence included).
        this.pending = '';
        const rest = raw.slice(end);
        if (rest) this.session?.input(rest);
        return;
      }
    }
  }

  private async key(k: Key): Promise<void> {
    if (this.closed || this.mode === 'attach') return;
    if (this.mode === 'confirm') {
      if (k.name === 'char' && k.ch === 'y') this.quit();
      else this.mode = 'lobby';
    } else if (this.mode === 'form') {
      await this.formKey(k);
    } else {
      this.notice = null;
      await this.lobbyKey(k);
    }
    this.render();
  }

  private async lobbyKey(k: Key): Promise<void> {
    const row = this.rows[this.selected];
    if (k.name === 'up') this.move(-1);
    else if (k.name === 'down') this.move(1);
    else if (k.name === 'enter') this.attach(row);
    else if (k.name === 'ctrl-c') this.askQuit();
    else if (k.name === 'char') {
      if (k.ch === 'k') this.move(-1);
      else if (k.ch === 'j') this.move(1);
      else if (k.ch === 'q') this.askQuit();
      else if (k.ch === 'p') this.openForm('repo', row);
      else if (k.ch === 'a' && row) this.openForm('agent', row);
      else if (k.ch === 'n') {
        if (row) this.openForm('work', row);
        else this.notice = '먼저 p로 프로젝트를 추가하세요';
      }
    }
  }

  private async formKey(k: Key): Promise<void> {
    const result = this.form?.key(k);
    if (!result) return;
    const kind = this.formKind!;
    const target = this.target;
    this.mode = 'lobby';
    this.form = this.formKind = this.target = null;
    if (result.done === 'cancel') return;
    this.notice = BUSY[kind];
    this.render();
    try {
      this.notice = await this.submit(kind, result.values, target);
      void this.deps.refresh().catch(() => {});
    } catch (e) {
      this.notice = '⚠️ ' + (e instanceof Error ? e.message : String(e));
    }
  }

  private async submit(kind: FormKind, v: string[], row: LobbyRow | null): Promise<string> {
    if (kind === 'repo') {
      await this.deps.addRepo(v[0]);
      return '프로젝트를 추가했어요';
    }
    const desks = this.deps.snapshot().desks;
    const spec = validateHire(
      kind === 'agent' ? { deskId: row?.deskId, agent: v[0], prompt: v[1] } : { repoId: row?.repoId, name: v[0], agent: v[1], prompt: v[2] },
      desks,
    );
    if ('error' in spec) throw new Error(spec.error);
    const res = await this.deps.hire(spec);
    return res.warning ?? '에이전트를 띄웠어요';
  }

  private openForm(kind: FormKind, row: LobbyRow | undefined): void {
    this.form = FORMS[kind](row ?? null);
    this.formKind = kind;
    this.target = row ?? null;
    this.mode = 'form';
  }

  private move(delta: number): void {
    this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
  }

  private askQuit(): void {
    if (this.rows.some((r) => r.agentId)) this.mode = 'confirm';
    else this.quit();
  }

  /** Stop rendering and listening (idempotent); `done` resolves. */
  close(): void {
    if (!this.closed) this.quit();
  }

  private quit(): void {
    this.closed = true;
    this.session?.stop();
    this.session = null;
    this.out.off?.('resize', this.onResize);
    this.offSnapshot?.();
    this.input.off?.('data', this.onData);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.resolveDone();
  }

  private attach(row: LobbyRow | undefined): void {
    if (!row?.agentId) return;
    const ptyId = this.deps.terminalOf(row.agentId);
    if (!ptyId) {
      this.notice = '에이전트가 이미 종료됐어요';
      return;
    }
    // onLeave may fire synchronously inside start(), so the state is set first.
    this.mode = 'attach';
    this.pending = '';
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.out.write(SHOW_CURSOR);
    this.session = new AttachSession(this.deps.host, ptyId, this.out, `${row.repo}/${row.desk} · ${row.agentType}`, (reason) => {
      this.session = null;
      this.mode = 'lobby';
      this.notice = reason === 'exited' ? '에이전트가 종료됐어요' : null;
      this.reloadRows();
      // The agent may have left the alternate screen on its way out.
      this.out.write(ALT_ON + HIDE_CURSOR + CLEAR);
      this.render();
    });
    this.session.start();
  }

  private refit(snapshotChanged = false): void {
    if (this.mode === 'attach') {
      // Only a real terminal resize concerns the attached agent; the lobby reloads on return.
      if (!snapshotChanged) this.session?.resized();
      return;
    }
    if (snapshotChanged) this.reloadRows();
    this.render();
  }

  /** Reload rows from the snapshot; the selection follows the same agent/desk when it still exists. */
  private reloadRows(): void {
    const keep = idOf(this.rows[this.selected]);
    this.rows = lobbyRows(this.deps.snapshot());
    const at = keep ? this.rows.findIndex((r) => idOf(r) === keep) : -1;
    this.selected = at >= 0 ? at : Math.max(0, Math.min(this.rows.length - 1, this.selected));
  }

  private render(): void {
    if (this.closed || this.mode === 'attach') return;
    let footer: string | undefined;
    let cursor = HIDE_CURSOR;
    const { columns: cols, rows: lines } = this.out;
    if (this.mode === 'form' && this.form) {
      const typed = this.form.line();
      footer = typed + '  (Enter 다음 · Esc 취소)';
      // The real cursor right after the typed text, so an IME composes in place.
      if (lobbyFits(cols, lines)) cursor = moveTo(lines, Math.min(cols, displayWidth(clean(` ${typed}`)) + 1)) + SHOW_CURSOR;
    }
    else if (this.mode === 'confirm') footer = `에이전트 ${this.rows.filter((r) => r.agentId).length}개가 함께 종료됩니다. 종료할까요? (y/N)`;
    const screen = renderLobby({ rows: this.rows, selected: this.selected, url: this.deps.url, notice: this.notice, footer }, cols, lines);
    this.out.write(HIDE_CURSOR + HOME + screen.join('\r\n') + '\x1b[J' + cursor);
  }
}
