// One agent terminal: xterm.js (WebGL, fit, unicode11) over a TermSocket.
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { platform, type TermConfig } from './host';
import { MAX_COLS, MAX_ROWS, TermSocket, type TermStatus } from './termClient';

/** ESC c (RIS): a full terminal reset, in order with the output stream. */
export const RIS = new Uint8Array([0x1b, 0x63]);

/** The banner for a status, or null for none (connecting, open). */
export function bannerText(s: TermStatus, code?: number | null): string | null {
  switch (s) {
    case 'reconnecting':
      return '다시 연결하는 중…';
    case 'exited':
      return `에이전트가 종료됐어요 (코드 ${code ?? '알 수 없음'}) — 탭을 닫아 주세요`;
    case 'closed':
      return '공방이 닫히는 중이에요';
    case 'failed':
      return '터미널에 연결하지 못했어요 — 에이전트가 이미 끝났을 수 있어요';
    default:
      return null;
  }
}

/**
 * The size to fit to, or null when the pane is hidden or collapsed (no 0×0, and no 2×1 from
 * FitAddon's minimum either): the server would resize the agent's PTY to it.
 */
export function fitSize(
  host: { clientWidth: number; clientHeight: number },
  proposed: { cols: number; rows: number } | undefined,
): { cols: number; rows: number } | null {
  if (host.clientWidth <= 0 || host.clientHeight <= 0 || !proposed) return null;
  const { cols, rows } = proposed;
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return null;
  return { cols: Math.min(Math.floor(cols), MAX_COLS), rows: Math.min(Math.floor(rows), MAX_ROWS) };
}

/** Coalesces calls into one per animation frame. */
export function frameDebounce(
  fn: () => void,
  raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  caf: (id: number) => void = (id) => cancelAnimationFrame(id),
): { (): void; cancel(): void } {
  let id: number | null = null;
  const run = () => {
    if (id !== null) return;
    id = raf(() => {
      id = null;
      fn();
    });
  };
  run.cancel = () => {
    if (id !== null) caf(id);
    id = null;
  };
  return run;
}

export class TermView {
  private readonly term: Terminal;
  private readonly fitter = new FitAddon();
  private readonly socket: TermSocket;
  private readonly banner: HTMLDivElement;
  private readonly subs: IDisposable[] = [];
  private readonly observer: ResizeObserver | null;
  private readonly schedule: ReturnType<typeof frameDebounce>;
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    cfg: TermConfig,
    agentId: string,
  ) {
    this.banner = document.createElement('div');
    this.banner.className = 'term-banner';
    this.banner.hidden = true;
    const screen = document.createElement('div');
    screen.className = 'term-screen';
    host.replaceChildren(screen, this.banner);

    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: '"SF Mono", Menlo, Consolas, "D2Coding", monospace',
      fontSize: 13,
      lineHeight: 1.1,
      scrollback: 5000,
      cursorBlink: true,
      // ConPTY reprints the screen on resize; without this xterm also reflows the scrollback down
      // and lines come out twice.
      // TODO: pass buildNumber for Windows 10 builds older than 21376 (their ConPTY reflows
      // differently); it needs the OS build from the host.
      windowsPty: platform() === 'win' ? { backend: 'conpty' } : undefined,
      theme: { background: '#151210', foreground: '#efe6d8' },
    });
    this.term = term;
    term.loadAddon(this.fitter);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(screen);
    try {
      const gl = new WebglAddon();
      // On a lost context xterm goes back to its DOM renderer (the app CSP allows its <style>).
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch {
      // No WebGL2: the DOM renderer stays.
    }

    this.socket = new TermSocket(cfg, agentId, {
      output: (bytes) => term.write(bytes),
      // RIS through the write queue, not term.reset(): reset() applies at once and leaves earlier
      // queued writes (the old socket's output) to land on top of the fresh snapshot.
      reset: () => term.write(RIS),
      status: (s, code) => this.setStatus(s, code),
    });
    this.subs.push(
      term.onData((d) => this.socket.input(d)),
      term.onBinary((d) => this.socket.inputBinary(d)),
      term.onResize(({ cols, rows }) => this.socket.resize(cols, rows)),
    );

    this.schedule = frameDebounce(() => this.fit());
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.schedule());
    this.observer?.observe(host);
    this.fit();
  }

  private setStatus(s: TermStatus, code?: number | null): void {
    const text = bannerText(s, code);
    this.banner.textContent = text ?? '';
    this.banner.hidden = text === null;
    this.host.classList.toggle('term-ended', s === 'exited' || s === 'failed' || s === 'closed');
  }

  /** Fits to the pane, unless it is hidden or collapsed; tells the server the size either way. */
  fit(): void {
    if (this.disposed) return;
    const size = fitSize(this.host, this.fitter.proposeDimensions());
    if (!size) return;
    if (size.cols !== this.term.cols || size.rows !== this.term.rows) this.term.resize(size.cols, size.rows);
    // onResize does not fire when the size is unchanged (e.g. xterm's 80×24 default): the socket
    // drops repeats, so say it again.
    this.socket.resize(this.term.cols, this.term.rows);
  }

  focus(): void {
    if (!this.disposed) this.term.focus();
  }

  copySelection(): string {
    return this.disposed ? '' : this.term.getSelection();
  }

  paste(text: string): void {
    if (!this.disposed) this.term.paste(text);
  }

  /** The active buffer as text, for the E2E hook only. */
  text(): string {
    if (this.disposed) return '';
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  }

  /** Detach: the agent keeps running. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.schedule.cancel();
    this.socket.close();
    for (const s of this.subs) s.dispose();
    this.term.dispose(); // disposes the addons too
    this.host.replaceChildren();
  }
}
