import type { HireResult, HireSpec } from '../backend/types.js';
import type { OfficeSnapshot } from '../model.js';
import { busyNotice, confirmQuestion, newForm, runConfirmed, submitForm, type ConfirmKind, type FormKind } from './actions.js';
import { AttachSession, type AttachHost, type TermOut } from './attach.js';
import type { PaneView, View } from './compose.js';
import { encodePanelInput } from './input.js';
import { decodeKeysAt, type Key } from './keys.js';
import { layout, type Layout, type Preset } from './layout.js';
import { lobbyRows, type LobbyRow } from './lobby.js';
import type { MouseEvent } from './mouse.js';
import { clampToBody, hitTest, PARTIAL_MOUSE, splitMouse } from './mouseActions.js';
import { maxScroll, type HeadlessLike } from './panel.js';
import { INCOMPLETE_ESCAPE, PanelInput } from './panelInput.js';
import { PaneSet } from './panes.js';
import type { Form } from './prompt.js';
import { Renderer } from './renderer.js';
import { ALT_ON, CLEAR, HIDE_CURSOR, MOUSE_ON, PASTE_ON, SHOW_CURSOR } from './screen.js';
import { selectionText, topLine, type Selection, type TextBufferLike } from './selection.js';
import { sidebarRowAt } from './sidebar.js';
import { clean, displayWidth } from './text.js';

// The TUI: a sidebar of agents and up to four panes of live agent screens (presets 1–4). Moving
// the list selection shows that agent in the focused pane. In list focus keys drive the list; in
// panel focus every key goes to the focused pane's agent except Ctrl+]. The mouse selects rows,
// focuses panes, scrolls, and drag-selects text to copy; mouse reports never reach an agent.
// `z` zooms one agent to the whole screen (AttachSession). Input is handled strictly in order.

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
  terminal(ptyId: string): (HeadlessLike & TextBufferLike & { modes: AgentModes; write(data: string, cb?: () => void): void }) | null;
  /** Whether the agent hid its cursor (DECTCEM). */
  cursorHidden(ptyId: string): boolean;
  /** Size one agent's PTY (a pane's body); must not throw for a dying PTY. */
  resizeAgent(ptyId: string, cols: number, rows: number): void;
  copyText(text: string): Promise<'file' | 'command' | 'osc52'>;
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
const LIST_HELP = 'q 나가기 · Enter 입력 · ↑↓ 이동 · 1-4 화면 · Tab 칸 · z 크게 · a 추가 · n 새 작업 · p 프로젝트 · x 종료 · d 삭제 · PgUp 기록';
const PANEL_HELP = '패널 입력 중 · Ctrl+] 목록으로 · 드래그하면 복사 · 터미널 선택은 Shift/Option+드래그';
const EXITED = '에이전트가 종료됐어요';
const WHEEL_LINES = 3;
const PRESETS: Record<string, Preset> = { '1': 1, '2': 2, '3': 3, '4': 4 };

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
  private readonly panes = new PaneSet(1);
  /** The PTY typed into in panel focus (the focused pane's agent when focus was given). */
  private typingPty: string | null = null;
  /** onData subscriptions of the shown agents, by PTY. */
  private readonly subs = new Map<string, () => void>();
  /** Each pane's agent baseY when last looked at: new lines while scrolled back move its scroll along. */
  private readonly seenBase = [0, 0, 0, 0];
  /** A drag selection, the agent it was made in, and whether the button is still down. */
  private selection: Selection | null = null;
  private selectionAgent: string | null = null;
  private dragging = false;
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
    // A partial mouse report whose rest never came is dropped, never typed.
    this.panelInput = new PanelInput((held) => this.enqueue(async () => void (PARTIAL_MOUSE.test(held) || this.sendToAgent(held))), escWaitMs, PASTE_WAIT_MS);
    this.renderer = new Renderer(out, () => this.view(), renderMs);
  }

  start(): void {
    this.out.write(ALT_ON + PASTE_ON + MOUSE_ON + HIDE_CURSOR + CLEAR);
    this.rows = lobbyRows(this.deps.snapshot());
    this.input.on('data', this.onData);
    this.out.on?.('resize', this.onResize);
    this.offSnapshot = this.deps.onSnapshot(() => this.snapshotChanged());
    this.offExit = this.deps.host.onExit((id) => this.agentExited(id));
    this.assign();
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
    if (k.name === 'mouse') {
      // A click is never an answer to a question or a form: only the list takes the mouse.
      if (this.mode === 'list') this.mouse(k.event);
    } else {
      this.clearSelection();
      if (this.mode === 'confirm') await this.confirmKey(k);
      else if (this.mode === 'form') await this.formKey(k);
      else {
        this.notice = null;
        await this.listKey(k);
      }
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
    if (k.name !== 'pgup' && k.name !== 'pgdn') this.panes.scroll[this.panes.focused] = 0;
    const ch = k.name === 'char' ? k.ch : null;
    if (k.name === 'up' || ch === 'k') this.move(-1);
    else if (k.name === 'down' || ch === 'j') this.move(1);
    else if (k.name === 'pgup') this.page(1);
    else if (k.name === 'pgdn') this.page(-1);
    else if (k.name === 'tab' || k.name === 'shift-tab') this.focusNext(k.name === 'tab' ? 1 : -1);
    else if (ch && PRESETS[ch]) this.setPreset(PRESETS[ch]);
    else if (k.name === 'enter' || k.name === 'right' || k.name === 'ctrl-]') this.focusPanel();
    else if (k.name === 'ctrl-c' || ch === 'q') this.askQuit();
    else if (ch === 'z') this.zoom();
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
    const to = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
    if (to === this.selected) return;
    this.selected = to;
    this.assign();
  }

  /** Scroll the focused pane back (dir 1) or forward (-1) by a page, within its agent's history. */
  private page(dir: 1 | -1): void {
    const L = this.currentLayout();
    if (L) this.scrollPane(this.panes.focused, dir * (L.panes[this.panes.focused].body.rows - 1));
  }

  /** Scroll pane `i` back by `delta` lines (negative: forward), clamped to its agent's history. */
  private scrollPane(i: number, delta: number): void {
    const term = this.paneTerminal(i);
    if (!term) return;
    if (this.panes.scroll[i] === 0) this.seenBase[i] = term.buffer.active.baseY;
    this.panes.scroll[i] = Math.max(0, Math.min(maxScroll(term), this.panes.scroll[i] + delta));
  }

  private setPreset(p: Preset): void {
    this.panes.setPreset(p);
    const L = this.currentLayout();
    if (L && L.preset !== p) this.notice = `창이 작아서 ${L.panes.length}칸으로 보여요`;
    this.layoutChanged();
  }

  private focusNext(dir: 1 | -1): void {
    this.panes.focusNext(dir, this.visible());
    this.followFocused();
  }

  /** The list selection follows the focused pane's agent, so the two agree. */
  private followFocused(): void {
    const id = this.panes.agents[this.panes.focused];
    const at = id ? this.rows.findIndex((r) => r.agentId === id) : -1;
    if (at >= 0) this.selected = at;
  }

  /** Typing focus on the focused pane's agent, if it is alive. */
  private focusPanel(): void {
    const id = this.panes.agents[this.panes.focused];
    if (!id) return;
    const pty = this.deps.terminalOf(id);
    if (!pty || !this.deps.host.has(pty)) {
      this.notice = EXITED;
      return;
    }
    if (this.mode !== 'panel') this.panelInput.reset();
    this.mode = 'panel';
    this.typingPty = pty;
  }

  private toList(): void {
    this.mode = 'list';
    this.typingPty = null;
    this.panelInput.reset();
  }

  private leavePanel(notice: string | null): void {
    this.toList();
    this.notice = notice;
    this.render();
  }

  private async panelChunk(chunk: string): Promise<void> {
    const { send, leave } = this.panelInput.feed(chunk);
    if (send) await this.panelData(send);
    if (leave && this.mode === 'panel') {
      this.clearSelection();
      this.leavePanel(null);
    }
  }

  /** Panel-focus input: mouse reports are handled here (never sent), the rest goes to the agent. */
  private async panelData(data: string): Promise<void> {
    const parts = splitMouse(data);
    for (let i = 0; i < parts.length; i++) {
      if (this.closed) return;
      if (this.mode !== 'panel') {
        // A click took focus to the list: what followed (and any held partial) is list input now.
        const rest = parts.slice(i).map((p) => (p.kind === 'text' ? p.text : p.raw)).join('') + this.panelInput.take();
        if (rest) await this.handle(rest);
        return;
      }
      const part = parts[i];
      if (part.kind === 'mouse') {
        if (part.event) this.mouse(part.event);
        this.render();
        continue;
      }
      if (this.selection || this.notice) {
        // Typing clears the highlight and an old notice.
        this.clearSelection();
        this.notice = null;
        this.render();
      }
      this.sendToAgent(part.text);
    }
  }

  /** Bytes typed in panel focus, encoded for the agent's own terminal modes. */
  private sendToAgent(data: string): void {
    if (this.closed || this.mode !== 'panel') return;
    const pty = this.typingPty;
    const term = pty ? this.deps.terminal(pty) : null;
    try {
      if (!pty || !term || !this.deps.host.has(pty)) throw new Error('gone');
      this.deps.host.write(pty, encodePanelInput(data, term.modes));
    } catch {
      this.leavePanel(EXITED); // the exit event may still be in flight
    }
  }

  private mouse(ev: MouseEvent): void {
    const L = this.currentLayout();
    if (!L) return;
    if (ev.kind === 'drag') return this.drag(L, ev);
    if (ev.kind === 'release') return this.release();
    if (ev.kind === 'move') return;
    this.notice = null;
    const hit = hitTest(L, ev.x, ev.y);
    if (ev.kind === 'wheelUp' || ev.kind === 'wheelDown') {
      const up = ev.kind === 'wheelUp';
      if (hit.area === 'list') {
        if (this.mode === 'panel') this.toList();
        this.move(up ? -1 : 1);
      } else if (hit.area === 'pane' || hit.area === 'head') this.scrollPane(hit.pane, up ? WHEEL_LINES : -WHEEL_LINES);
      return;
    }
    this.clearSelection();
    if (hit.area === 'list') {
      if (this.mode === 'panel') this.toList();
      const at = sidebarRowAt(this.rows, this.selected, L.list, hit.y);
      if (at !== null && at !== this.selected) {
        this.selected = at;
        this.assign();
      }
    } else if (hit.area === 'pane' || hit.area === 'head') {
      this.panes.focused = hit.pane;
      this.followFocused();
      const pty = this.panePty(hit.pane);
      if (pty && this.deps.host.has(pty)) this.focusPanel();
      else if (this.mode === 'panel') this.toList();
      const term = this.paneTerminal(hit.pane);
      if (hit.area === 'pane' && ev.button === 0 && term) {
        const at = { line: topLine(term, this.panes.scroll[hit.pane]) + hit.y, col: hit.x };
        this.selection = { pane: hit.pane, anchor: at, head: { ...at } };
        this.selectionAgent = this.panes.agents[hit.pane];
        this.dragging = true;
      }
    }
  }

  /** Extend the selection, inside its own pane; past the top or bottom edge the pane scrolls. */
  private drag(L: Layout, ev: MouseEvent): void {
    const sel = this.selection;
    if (!this.dragging || !sel || sel.pane >= L.panes.length) return;
    const term = this.paneTerminal(sel.pane);
    if (!term) return;
    const c = clampToBody(L, sel.pane, ev.x, ev.y);
    if (c.edge) this.scrollPane(sel.pane, -c.edge);
    sel.head = { line: topLine(term, this.panes.scroll[sel.pane]) + c.y, col: c.x };
  }

  /** Copy what a drag selected (a plain click copies nothing); the highlight stays until the next key or click. */
  private release(): void {
    const sel = this.selection;
    if (!this.dragging || !sel) return;
    this.dragging = false;
    const term = this.paneTerminal(sel.pane);
    if (!term || (sel.anchor.line === sel.head.line && sel.anchor.col === sel.head.col)) return this.clearSelection();
    const text = selectionText(term, sel);
    if (text) void this.copy(text);
  }

  /** Not awaited: a slow clipboard command must not hold up input. */
  private async copy(text: string): Promise<void> {
    try {
      await this.deps.copyText(text);
      this.notice = `복사했어요 (${[...text].length}자)`;
    } catch {
      this.notice = '⚠ 복사하지 못했어요';
    }
    if (!this.closed) this.render();
  }

  private clearSelection(): void {
    this.selection = this.selectionAgent = null;
    this.dragging = false;
  }

  /** Zoom the focused pane's agent. */
  private zoom(): void {
    const id = this.panes.agents[this.panes.focused];
    const row = id ? this.rows.find((r) => r.agentId === id) : undefined;
    if (!row?.agentId) return;
    const ptyId = this.deps.terminalOf(row.agentId);
    if (!ptyId) {
      this.notice = '에이전트가 이미 종료됐어요';
      return;
    }
    // onLeave may fire synchronously inside start(), so the state is set first.
    this.mode = 'zoom';
    this.clearSelection();
    this.pending = '';
    this.clearPending();
    this.renderer.cancel();
    this.out.write(SHOW_CURSOR);
    this.session = new AttachSession(this.deps.host, ptyId, this.out, `${row.repo}/${row.desk} · ${row.agentType}`, (reason) => {
      this.session = null;
      this.mode = 'list';
      this.notice = reason === 'exited' ? EXITED : null;
      this.reloadRows();
      // The agent may have left the alternate screen (and paste/mouse modes) on its way out.
      this.out.write(ALT_ON + PASTE_ON + MOUSE_ON + HIDE_CURSOR + CLEAR);
      this.renderer.invalidate();
      this.refreshPanes(); // and zoom sized this agent to the whole screen: fit it back
      this.render();
    });
    this.session.start();
  }

  private resized(): void {
    if (this.closed) return;
    if (this.mode === 'zoom') return this.session?.resized();
    this.layoutChanged();
    this.render();
  }

  private snapshotChanged(): void {
    if (this.closed || this.mode === 'zoom') return;
    this.reloadRows();
    this.refreshPanes();
    this.render();
  }

  private agentExited(id: string): void {
    if (this.closed || this.mode === 'zoom') return;
    if (!this.subs.has(id) && id !== this.typingPty) return;
    this.syncSubs();
    if (this.mode === 'panel' && id === this.typingPty) this.leavePanel(EXITED);
    this.render();
  }

  private currentLayout(): Layout | null {
    return layout(this.out.columns, this.out.rows, this.panes.preset);
  }

  /** Panes on screen (after fallback); 1 when the terminal is too small to draw any. */
  private visible(): number {
    return this.currentLayout()?.panes.length ?? 1;
  }

  private panePty(i: number): string | null {
    const id = this.panes.agents[i];
    return id ? this.deps.terminalOf(id) : null;
  }

  /** Pane i's agent's headless terminal, fetched fresh: it is disposed when the agent exits. */
  private paneTerminal(i: number) {
    const pty = this.panePty(i);
    return pty ? this.deps.terminal(pty) : null;
  }

  /** Show the selected row's agent in the focused pane (swapping if it is shown elsewhere). */
  private assign(): void {
    this.panes.show(this.rows[this.selected]?.agentId ?? null, this.visible());
    this.panesChanged();
  }

  /** Preset or terminal size changed: clamp focus, refit and repaint everything. */
  private layoutChanged(): void {
    const before = this.panes.focused;
    this.panes.clamp(this.visible());
    if (this.panes.focused !== before) this.followFocused();
    this.panesChanged();
    this.renderer.invalidate();
  }

  /**
   * After a snapshot (or zoom): agents gone from the office leave their panes; a focused pane
   * left empty shows the selection again. Typing focus ends if its agent is no longer there.
   */
  private refreshPanes(): void {
    const had = this.panes.agents[this.panes.focused];
    this.panes.prune((id) => this.rows.some((r) => r.agentId === id));
    this.panes.clamp(this.visible());
    if (had && !this.panes.agents[this.panes.focused]) this.assign();
    else this.panesChanged();
    if (this.mode === 'panel' && this.panePty(this.panes.focused) !== this.typingPty) this.leavePanel(EXITED);
  }

  private panesChanged(): void {
    if (this.selection && this.panes.agents[this.selection.pane] !== this.selectionAgent) this.clearSelection();
    this.syncSubs();
    this.fitAgents();
  }

  /** Each shown agent's PTY at its pane's body size. Agents not shown keep their size. */
  private fitAgents(): void {
    const L = this.currentLayout();
    L?.panes.forEach((p, i) => {
      const pty = this.panePty(i);
      if (pty) this.deps.resizeAgent(pty, p.body.cols, p.body.rows);
    });
  }

  /** Subscribe to the output of every shown agent (only those schedule renders); drop the rest. */
  private syncSubs(): void {
    const want = new Set<string>();
    for (const id of this.panes.shown(this.visible())) {
      const pty = this.deps.terminalOf(id);
      if (pty) want.add(pty);
    }
    for (const [pty, off] of this.subs) {
      if (want.has(pty)) continue;
      off();
      this.subs.delete(pty);
    }
    for (const pty of want) if (!this.subs.has(pty)) this.subs.set(pty, this.deps.host.onData(pty, () => this.outputSeen(pty)));
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
      if (!this.subs.has(pty)) return;
      const vis = this.visible();
      for (let i = 0; i < vis; i++) if (this.panePty(i) === pty) this.anchorScroll(i, term);
      this.renderer.schedule();
    });
  }

  /** Pane i scrolled back while its agent prints: keep the same history lines in view. */
  private anchorScroll(i: number, term: HeadlessLike): void {
    const base = term.buffer.active.baseY;
    const s = this.panes.scroll[i];
    if (s > 0) this.panes.scroll[i] = Math.max(0, Math.min(maxScroll(term), s + base - this.seenBase[i]));
    this.seenBase[i] = base;
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
    for (const off of this.subs.values()) off();
    this.subs.clear();
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
      preset: this.panes.preset,
      focusedPane: this.panes.focused,
      panes: Array.from({ length: this.visible() }, (_, i) => this.paneView(i)),
      ...this.help(),
    };
  }

  private paneView(i: number): PaneView {
    const id = this.panes.agents[i];
    const sel = this.rows[this.selected];
    // A focused, empty pane stands for a selected row without an agent (its head says so).
    const row = id ? (this.rows.find((r) => r.agentId === id) ?? null) : i === this.panes.focused && sel && !sel.agentId ? sel : null;
    const pty = this.panePty(i);
    return {
      row,
      agent: pty ? this.deps.terminal(pty) : null,
      cursorHidden: pty ? this.deps.cursorHidden(pty) : false,
      scroll: this.panes.scroll[i],
      selection: this.selection?.pane === i ? this.selection : null,
    };
  }

  private render(): void {
    this.renderer.draw();
  }
}
