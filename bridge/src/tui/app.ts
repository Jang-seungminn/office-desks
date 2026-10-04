import type { HireResult, HireSpec } from '../backend/types.js';
import type { OfficeSnapshot } from '../model.js';
import { busyNotice, confirmQuestion, newForm, runConfirmed, submitForm, type ConfirmKind, type FormKind } from './actions.js';
import { AttachSession, type AttachHost, type TermOut } from './attach.js';
import type { View } from './compose.js';
import { encodePanelInput } from './input.js';
import { decodeKeysAt, type Key } from './keys.js';
import { layout } from './layout.js';
import { lobbyRows, type LobbyRow } from './lobby.js';
import { maxScroll, type HeadlessLike } from './panel.js';
import { INCOMPLETE_ESCAPE, PanelInput } from './panelInput.js';
import type { Form } from './prompt.js';
import { Renderer } from './renderer.js';
import { ALT_ON, CLEAR, HIDE_CURSOR, PASTE_ON, SHOW_CURSOR } from './screen.js';
import { clean, displayWidth } from './text.js';

// The TUI: a sidebar of agents and the selected agent's live screen in a panel. In list focus keys
// drive the list; in panel focus every key goes to the agent except Ctrl+]. `z` zooms one agent to
// the whole screen (AttachSession). Input is handled strictly in order, one chunk at a time.

export interface TuiDeps {
  snapshot(): OfficeSnapshot;
  onSnapshot(fn: () => void): () => void;
  refresh(): Promise<void>;
  hire(spec: HireSpec): Promise<HireResult>;
  addRepo(path: string): Promise<void>;
  stopAgent(agentId: string): Promise<void>;
  removeWorktree(deskId: string): Promise<void>;
  terminalOf(agentId: string): string | null;
  /** The agent's headless terminal; `write('', cb)` is used only as a barrier (cb once parsed). */
  terminal(ptyId: string): (HeadlessLike & { modes: AgentModes; write(data: string, cb?: () => void): void }) | null;
  /** Whether the agent hid its cursor (DECTCEM). */
  cursorHidden(ptyId: string): boolean;
  resizeAgents(cols: number, rows: number): void;
  host: AttachHost;
  url: string;
}

export interface AgentModes {
  bracketedPasteMode: boolean;
  applicationCursorKeysMode: boolean;
}

export interface TermIn {
  on(ev: 'data', fn: (d: string) => void): unknown;
  off?(ev: 'data', fn: (d: string) => void): unknown;
}

type Mode = 'list' | 'panel' | 'form' | 'confirm' | 'zoom';

const ESC_WAIT_MS = 50;
const PASTE_WAIT_MS = 1000;
const LIST_HELP = 'q 나가기 · Enter 입력 · ↑↓ 이동 · z 크게 · a 추가 · n 새 작업 · p 프로젝트 · x 종료 · d 삭제 · PgUp 기록';
const PANEL_HELP = '패널 입력 중 · Ctrl+] 목록으로';
const EXITED = '에이전트가 종료됐어요';

const idOf = (r: LobbyRow | undefined) => (r ? (r.agentId ?? r.deskId) : null);

export class App {
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private mode: Mode = 'list';
  private rows: LobbyRow[] = [];
  private selected = 0;
  private notice: string | null = null;
  private form: Form | null = null;
  private formKind: FormKind | null = null;
  private confirmKind: ConfirmKind | null = null;
  private target: LobbyRow | null = null;
  /** Input chunks seen so far, and the one that opened the confirmation (never its answer). */
  private chunks = 0;
  private confirmChunk = -1;
  private session: AttachSession | null = null;
  private pending = '';
  private pendingTimer: NodeJS.Timeout | null = null;
  /** A bracketed paste in list/form focus (last pasted input at): typed into a form, never taken as keys. */
  private pasteSince: number | null = null;
  private shownPty: string | null = null;
  private offShown: (() => void) | null = null;
  private scroll = 0;
  /** The shown agent's baseY when last looked at: new lines while scrolled back move `scroll` along. */
  private seenBase = 0;
  private readonly renderer: Renderer;
  private readonly panelInput: PanelInput;
  private readonly onData = (d: string) => this.enqueue(() => this.handle(String(d)));
  private offSnapshot: (() => void) | null = null;
  private offExit: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly onResize = () => this.resized();

  constructor(
    private readonly deps: TuiDeps,
    private readonly input: TermIn,
    private readonly out: TermOut & { on?(ev: 'resize', fn: () => void): unknown; off?(ev: 'resize', fn: () => void): unknown },
    private readonly escWaitMs = ESC_WAIT_MS,
    renderMs?: number,
  ) {
    this.done = new Promise((r) => (this.resolveDone = r));
    // A held paste or escape whose rest never came goes to the agent, in line with other input.
    this.panelInput = new PanelInput((held) => this.enqueue(async () => this.sendToAgent(held)), escWaitMs, PASTE_WAIT_MS);
    this.renderer = new Renderer(out, () => this.view(), renderMs);
  }

  start(): void {
    this.out.write(ALT_ON + PASTE_ON + HIDE_CURSOR + CLEAR);
    this.rows = lobbyRows(this.deps.snapshot());
    this.input.on('data', this.onData);
    this.out.on?.('resize', this.onResize);
    this.offSnapshot = this.deps.onSnapshot(() => this.snapshotChanged());
    this.offExit = this.deps.host.onExit((id) => this.agentExited(id));
    this.fitAgents();
    this.syncShown();
    this.render();
  }

  async handle(chunk: string): Promise<void> {
    if (this.closed) return;
    if (this.mode === 'zoom') return void this.session?.input(chunk);
    if (this.mode === 'panel') return this.panelChunk(chunk);
    this.chunks++;
    this.clearPending();
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
        if (held === '\x1b') {
          this.enqueue(async () => {
            this.chunks++; // a key of its own, not part of the chunk it arrived with
            await this.keys([{ key: { name: 'escape' }, end: 0 }], '');
          });
        }
      }, this.escWaitMs);
    }
    await this.keys(decodeKeysAt(data), full);
  }

  /** Draw now if agent output is waiting to be drawn (tests; the timer does it otherwise). */
  flush(): void {
    this.renderer.flush();
  }

  /** Stop rendering and listening (idempotent); `done` resolves. */
  close(): void {
    if (!this.closed) this.quit();
  }

  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch(() => {});
  }

  private clearPending(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
  }

  private async keys(keys: { key: Key; end: number }[], raw: string): Promise<void> {
    for (const { key, end } of keys) {
      await this.key(key);
      if (this.closed) return;
      if (this.mode === 'zoom' || this.mode === 'panel') {
        // Whatever followed in the same chunk belongs to the agent, byte for byte
        // (a held partial escape sequence included).
        this.pending = '';
        this.clearPending();
        const rest = raw.slice(end);
        if (rest) await this.handle(rest);
        return;
      }
    }
  }

  private async key(k: Key): Promise<void> {
    if (this.closed || this.mode === 'zoom' || this.mode === 'panel') return;
    if (this.pasted(k)) return;
    if (this.mode === 'confirm') await this.confirmKey(k);
    else if (this.mode === 'form') await this.formKey(k);
    else {
      this.notice = null;
      await this.listKey(k);
    }
    this.render();
  }

  /** Paste markers and pasted keys: text into an open form, nothing else (a paste is not commands). */
  private pasted(k: Key): boolean {
    if (k.name === 'paste-start' || k.name === 'paste-end') {
      this.pasteSince = k.name === 'paste-start' ? Date.now() : null;
      return true;
    }
    if (this.pasteSince === null) return false;
    if (Date.now() - this.pasteSince > PASTE_WAIT_MS) {
      this.pasteSince = null; // no pasted input for a while: the end marker got lost
      return false;
    }
    this.pasteSince = Date.now(); // a slow paste (over SSH, say) stays a paste while it keeps coming
    if (this.mode === 'form' && k.name === 'char') {
      this.form?.key(k);
      this.render();
    }
    return true;
  }

  private async listKey(k: Key): Promise<void> {
    const row = this.rows[this.selected];
    if (k.name !== 'pgup' && k.name !== 'pgdn') this.scroll = 0;
    const ch = k.name === 'char' ? k.ch : null;
    if (k.name === 'up' || ch === 'k') this.move(-1);
    else if (k.name === 'down' || ch === 'j') this.move(1);
    else if (k.name === 'pgup') this.page(1);
    else if (k.name === 'pgdn') this.page(-1);
    else if (k.name === 'enter' || k.name === 'right' || k.name === 'ctrl-]') this.focusPanel(row);
    else if (k.name === 'ctrl-c' || ch === 'q') this.askQuit();
    else if (ch === 'z') this.zoom(row);
    else if (ch === 'p') this.openForm('repo', row);
    else if (ch === 'a' && row) this.openForm('agent', row);
    else if (ch === 'n') {
      if (row) this.openForm('work', row);
      else this.notice = '먼저 p로 프로젝트를 추가하세요';
    } else if (ch === 'x') {
      if (row?.agentId) this.ask('stop', row);
      else if (row) this.notice = '종료할 에이전트가 없어요';
    } else if (ch === 'd' && row) {
      if (row.isMain) this.notice = '메인 체크아웃은 지울 수 없어요';
      else if (row.agentId) this.notice = '에이전트가 실행 중인 워크트리는 지울 수 없어요 (x로 먼저 종료)';
      else this.ask('remove', row);
    }
  }

  private async formKey(k: Key): Promise<void> {
    const result = this.form?.key(k);
    if (!result) return;
    const kind = this.formKind!;
    const target = this.target;
    this.mode = 'list';
    this.form = this.formKind = this.target = null;
    if (result.done === 'cancel') return;
    await this.act(kind, () => submitForm(this.deps, kind, result.values, target));
  }

  private async confirmKey(k: Key): Promise<void> {
    // A pasted "dy" (no bracketed paste) must not answer its own question: wait for the next chunk.
    if (this.chunks === this.confirmChunk) return;
    const kind = this.confirmKind!;
    const target = this.target;
    this.mode = 'list';
    this.confirmKind = this.target = null;
    if (!(k.name === 'char' && k.ch === 'y')) return;
    if (kind === 'quit') return this.quit();
    if (kind === 'stop' || kind === 'remove') await this.act(kind, () => runConfirmed(this.deps, kind, target!));
  }

  /** Run a backend action with a busy notice; its result or error becomes the notice. */
  private async act(kind: FormKind | ConfirmKind, run: () => Promise<string>): Promise<void> {
    this.notice = busyNotice(kind);
    this.render();
    try {
      this.notice = await run();
      void this.deps.refresh().catch(() => {});
    } catch (e) {
      this.notice = '⚠ ' + (e instanceof Error ? e.message : String(e));
    }
  }

  private openForm(kind: FormKind, row: LobbyRow | undefined): void {
    this.form = newForm(kind, row ?? null);
    this.formKind = kind;
    this.target = row ?? null;
    this.mode = 'form';
  }

  private ask(kind: ConfirmKind, row: LobbyRow | null): void {
    this.confirmKind = kind;
    this.target = row;
    this.confirmChunk = this.chunks;
    this.mode = 'confirm';
  }

  private askQuit(): void {
    if (this.rows.some((r) => r.agentId)) this.ask('quit', null);
    else this.quit();
  }

  private move(delta: number): void {
    this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
    this.syncShown();
  }

  /** Scroll the panel back (dir 1) or forward (-1) by a page, within the agent's history. */
  private page(dir: 1 | -1): void {
    const L = layout(this.out.columns, this.out.rows);
    const term = this.shownTerminal();
    if (!L || !term) return;
    this.seenBase = term.buffer.active.baseY;
    this.scroll = Math.max(0, Math.min(maxScroll(term), this.scroll + dir * (L.panel.rows - 1)));
  }

  private focusPanel(row: LobbyRow | undefined): void {
    if (!row?.agentId) return;
    if (!this.shownPty || !this.deps.host.has(this.shownPty)) {
      this.notice = EXITED;
      return;
    }
    this.mode = 'panel';
    this.panelInput.reset();
  }

  private leavePanel(notice: string | null): void {
    this.mode = 'list';
    this.panelInput.reset();
    this.notice = notice;
    this.render();
  }

  private async panelChunk(chunk: string): Promise<void> {
    const { send, leave } = this.panelInput.feed(chunk);
    if (send) this.sendToAgent(send);
    if (leave && this.mode === 'panel') this.leavePanel(null);
  }

  /** Bytes typed in panel focus, encoded for the agent's own terminal modes. */
  private sendToAgent(data: string): void {
    if (this.closed || this.mode !== 'panel') return;
    const pty = this.shownPty;
    const term = pty ? this.deps.terminal(pty) : null;
    try {
      if (!pty || !term || !this.deps.host.has(pty)) throw new Error('gone');
      this.deps.host.write(pty, encodePanelInput(data, term.modes));
    } catch {
      this.leavePanel(EXITED); // the exit event may still be in flight
    }
  }

  private zoom(row: LobbyRow | undefined): void {
    if (!row?.agentId) return;
    const ptyId = this.deps.terminalOf(row.agentId);
    if (!ptyId) {
      this.notice = '에이전트가 이미 종료됐어요';
      return;
    }
    // onLeave may fire synchronously inside start(), so the state is set first.
    this.mode = 'zoom';
    this.pending = '';
    this.clearPending();
    this.renderer.cancel();
    this.out.write(SHOW_CURSOR);
    this.session = new AttachSession(this.deps.host, ptyId, this.out, `${row.repo}/${row.desk} · ${row.agentType}`, (reason) => {
      this.session = null;
      this.mode = 'list';
      this.notice = reason === 'exited' ? EXITED : null;
      this.reloadRows();
      // The agent may have left the alternate screen (and paste mode) on its way out.
      this.out.write(ALT_ON + PASTE_ON + HIDE_CURSOR + CLEAR);
      this.renderer.invalidate();
      this.fitAgents(); // zoom sized this agent to the whole screen
      this.syncShown();
      this.render();
    });
    this.session.start();
  }

  private resized(): void {
    if (this.closed) return;
    if (this.mode === 'zoom') return this.session?.resized();
    this.fitAgents();
    this.renderer.invalidate();
    this.render();
  }

  private snapshotChanged(): void {
    if (this.closed || this.mode === 'zoom') return;
    this.reloadRows();
    this.fitAgents(); // new agents start at their own size
    if (this.syncShown() && this.mode === 'panel') this.leavePanel(EXITED);
    this.render();
  }

  private agentExited(id: string): void {
    if (this.closed || this.mode === 'zoom' || id !== this.shownPty) return;
    this.syncShown();
    if (this.mode === 'panel') this.leavePanel(EXITED);
    this.render();
  }

  /** Every agent PTY at the panel's size, so switching agents never needs a resize. */
  private fitAgents(): void {
    const L = layout(this.out.columns, this.out.rows);
    if (L) this.deps.resizeAgents(L.panel.cols, L.panel.rows);
  }

  /** Follow the selected row's agent: its output (only) schedules renders. True when it changed. */
  private syncShown(): boolean {
    const row = this.rows[this.selected];
    const pty = row?.agentId ? this.deps.terminalOf(row.agentId) : null;
    if (pty === this.shownPty) return false;
    this.offShown?.();
    this.offShown = null;
    this.shownPty = pty;
    this.scroll = 0;
    this.seenBase = pty ? (this.deps.terminal(pty)?.buffer.active.baseY ?? 0) : 0;
    if (pty) this.offShown = this.deps.host.onData(pty, () => this.outputSeen(pty));
    return true;
  }

  /**
   * PtyHost queues output into the headless terminal and tells us at once; xterm parses it later
   * (in slices, for a burst). Drawing only after an empty write's callback means the screen we
   * copy is the one that output produced, not a half-parsed one that nothing would redraw.
   */
  private outputSeen(pty: string): void {
    if (this.closed || this.mode === 'zoom') return; // zoom passes output through; we draw nothing
    const term = this.deps.terminal(pty);
    if (!term) return this.renderer.schedule();
    term.write('', () => {
      if (pty !== this.shownPty) return;
      this.anchorScroll(term);
      this.renderer.schedule();
    });
  }

  /** Scrolled back while the agent prints: keep the same history lines in view. */
  private anchorScroll(term: HeadlessLike): void {
    const base = term.buffer.active.baseY;
    if (this.scroll > 0) this.scroll = Math.max(0, Math.min(maxScroll(term), this.scroll + base - this.seenBase));
    this.seenBase = base;
  }

  /** The shown agent's headless terminal, fetched fresh: it is disposed when the agent exits. */
  private shownTerminal() {
    return this.shownPty ? this.deps.terminal(this.shownPty) : null;
  }

  /** Reload rows from the snapshot; the selection follows the same agent/desk when it still exists. */
  private reloadRows(): void {
    const keep = idOf(this.rows[this.selected]);
    this.rows = lobbyRows(this.deps.snapshot());
    const at = keep ? this.rows.findIndex((r) => idOf(r) === keep) : -1;
    this.selected = at >= 0 ? at : Math.max(0, Math.min(this.rows.length - 1, this.selected));
  }

  private quit(): void {
    this.closed = true;
    this.session?.stop();
    this.session = null;
    this.out.off?.('resize', this.onResize);
    this.offSnapshot?.();
    this.offExit?.();
    this.offShown?.();
    this.input.off?.('data', this.onData);
    this.clearPending();
    this.renderer.stop();
    this.panelInput.reset();
    this.resolveDone();
  }

  private help(): { help: string; helpCursor: number | null } {
    if (this.mode === 'form' && this.form) {
      const typed = ` ${this.form.line()}`;
      // The real cursor right after the typed text, so an IME composes in place.
      return { help: `${typed}  (Enter 다음 · Esc 취소)`, helpCursor: displayWidth(clean(typed)) };
    }
    if (this.mode === 'confirm') return { help: ` ${confirmQuestion(this.confirmKind!, this.target, this.rows)}`, helpCursor: null };
    if (this.notice) return { help: ` ${this.notice}`, helpCursor: null };
    return { help: ` ${this.mode === 'panel' ? PANEL_HELP : LIST_HELP}`, helpCursor: null };
  }

  private view(): View | null {
    if (this.closed || this.mode === 'zoom') return null;
    return {
      rows: this.rows,
      selected: this.selected,
      focus: this.mode === 'panel' ? 'panel' : 'list',
      url: this.deps.url,
      agent: this.shownTerminal(),
      agentCursorHidden: this.shownPty ? this.deps.cursorHidden(this.shownPty) : false,
      scroll: this.scroll,
      ...this.help(),
    };
  }

  private render(): void {
    this.renderer.draw();
  }
}
