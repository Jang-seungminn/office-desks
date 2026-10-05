// @vitest-environment jsdom
// TermView with xterm, its addons and the socket faked: wiring, the WebGL fallback, the
// no-fit-while-hidden rule and the detach on dispose.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  terms: [] as any[],
  sockets: [] as any[],
  gl: { fail: false, instances: [] as any[] },
  proposed: { cols: 100, rows: 30 } as { cols: number; rows: number } | undefined,
  observers: [] as any[],
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80;
    rows = 24;
    opts: unknown;
    addons: any[] = [];
    unicode = { activeVersion: '6' };
    handlers: Record<string, (x: any) => void> = {};
    written: Uint8Array[] = [];
    disposed = false;
    resets = 0;
    constructor(o: unknown) {
      this.opts = o;
      m.terms.push(this);
    }
    loadAddon(a: any) {
      a.activate?.(this);
      this.addons.push(a);
    }
    open() {}
    private on(name: string) {
      return (fn: (x: any) => void) => {
        this.handlers[name] = fn;
        return { dispose: () => delete this.handlers[name] };
      };
    }
    onData = this.on('data');
    onBinary = this.on('binary');
    onResize = this.on('resize');
    resize(c: number, r: number) {
      this.cols = c;
      this.rows = r;
      this.handlers.resize?.({ cols: c, rows: r });
    }
    write(b: Uint8Array) {
      this.written.push(b);
    }
    reset() {
      this.resets++;
    }
    focus() {}
    getSelection() {
      return 'sel';
    }
    paste(t: string) {
      this.handlers.data?.(t);
    }
    buffer = { active: { length: 2, getLine: (i: number) => ({ translateToString: () => ['one', 'two'][i] }) } };
    dispose() {
      this.disposed = true;
      for (const a of this.addons) a.dispose?.();
    }
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions() {
      return m.proposed;
    }
  },
}));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    lost: (() => void) | null = null;
    disposed = false;
    constructor() {
      m.gl.instances.push(this);
    }
    activate() {
      if (m.gl.fail) throw new Error('no webgl2');
    }
    onContextLoss(fn: () => void) {
      this.lost = fn;
    }
    dispose() {
      this.disposed = true;
    }
  },
}));
vi.mock('../src/termClient', async (orig) => {
  const real = await orig<typeof import('../src/termClient')>();
  class TermSocket {
    input = vi.fn();
    inputBinary = vi.fn();
    resize = vi.fn();
    close = vi.fn();
    constructor(public cfg: unknown, public agentId: string, public h: any) {
      m.sockets.push(this);
      h.status('connecting');
    }
  }
  return { ...real, TermSocket };
});

class RO {
  cb: () => void;
  disconnected = false;
  constructor(cb: () => void) {
    this.cb = cb;
    m.observers.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
}

const { TermView } = await import('../src/termView');

function pane(w = 800, h = 600) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => w });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => h });
  document.body.append(el);
  return {
    el,
    resizeTo(nw: number, nh: number) {
      w = nw;
      h = nh;
    },
  };
}

beforeEach(() => {
  m.terms.length = 0;
  m.sockets.length = 0;
  m.gl.instances.length = 0;
  m.gl.fail = false;
  m.proposed = { cols: 100, rows: 30 };
  m.observers.length = 0;
  (globalThis as any).ResizeObserver = RO;
  document.body.replaceChildren();
});

describe('TermView', () => {
  it('builds xterm with the brief options, unicode 11 and WebGL', () => {
    const p = pane();
    new TermView(p.el, { port: 1, token: 't' }, 'a1');
    const t = m.terms[0];
    expect(t.opts).toMatchObject({ allowProposedApi: true, fontSize: 13, scrollback: 5000, theme: { background: '#151210', foreground: '#efe6d8' } });
    expect(t.unicode.activeVersion).toBe('11');
    expect(m.gl.instances).toHaveLength(1);
    expect(p.el.querySelector('.term-banner')).not.toBeNull();
  });

  it('falls back to the DOM renderer when WebGL fails, and drops WebGL on a lost context', () => {
    m.gl.fail = true;
    expect(() => new TermView(pane().el, { port: 1, token: 't' }, 'a')).not.toThrow();
    m.gl.fail = false;
    new TermView(pane().el, { port: 1, token: 't' }, 'b');
    const gl = m.gl.instances[1];
    gl.lost();
    expect(gl.disposed).toBe(true);
  });

  it('wires input, output, reset and the fitted size', () => {
    new TermView(pane().el, { port: 1, token: 't' }, 'a');
    const t = m.terms[0];
    const s = m.sockets[0];
    expect(t.cols).toBe(100);
    expect(s.resize).toHaveBeenLastCalledWith(100, 30);
    t.handlers.data('hi');
    expect(s.input).toHaveBeenCalledWith('hi');
    t.handlers.binary('\x80');
    expect(s.inputBinary).toHaveBeenCalledWith('\x80');
    s.h.output(new Uint8Array([65]));
    expect(t.written).toHaveLength(1);
    s.h.reset();
    expect(t.resets).toBe(1);
  });

  it('tells the server the size even when it equals the xterm default', () => {
    m.proposed = { cols: 80, rows: 24 };
    new TermView(pane().el, { port: 1, token: 't' }, 'a');
    expect(m.sockets[0].resize).toHaveBeenCalledWith(80, 24);
  });

  it('never fits a hidden or collapsed pane', () => {
    const p = pane(0, 0);
    m.proposed = { cols: 2, rows: 1 };
    const v = new TermView(p.el, { port: 1, token: 't' }, 'a');
    v.fit();
    expect(m.sockets[0].resize).not.toHaveBeenCalled();
    expect(m.terms[0].cols).toBe(80);
  });

  it('debounces ResizeObserver callbacks into one fit per frame', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const p = pane();
    new TermView(p.el, { port: 1, token: 't' }, 'a');
    const s = m.sockets[0];
    s.resize.mockClear();
    m.proposed = { cols: 120, rows: 40 };
    for (let i = 0; i < 5; i++) m.observers[0].cb();
    expect(frames).toHaveLength(1);
    expect(s.resize).not.toHaveBeenCalled();
    frames[0](0);
    expect(m.terms[0].cols).toBe(120);
    expect(s.resize).toHaveBeenLastCalledWith(120, 40);
    vi.unstubAllGlobals();
  });

  it('shows the Korean banner per status', () => {
    const p = pane();
    new TermView(p.el, { port: 1, token: 't' }, 'a');
    const banner = p.el.querySelector<HTMLElement>('.term-banner')!;
    const s = m.sockets[0];
    expect(banner.hidden).toBe(true);
    s.h.status('reconnecting');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toBe('다시 연결하는 중…');
    s.h.status('open');
    expect(banner.hidden).toBe(true);
    s.h.status('exited', 3);
    expect(banner.textContent).toBe('에이전트가 종료됐어요 (코드 3) — 탭을 닫아 주세요');
    expect(p.el.classList.contains('term-ended')).toBe(true);
  });

  it('dispose detaches: observer off, socket closed, terminal and addons disposed, input unhooked', () => {
    const p = pane();
    const v = new TermView(p.el, { port: 1, token: 't' }, 'a');
    const t = m.terms[0];
    const s = m.sockets[0];
    const gl = m.gl.instances[0];
    v.dispose();
    expect(m.observers[0].disconnected).toBe(true);
    expect(s.close).toHaveBeenCalledTimes(1);
    expect(t.disposed).toBe(true);
    expect(gl.disposed).toBe(true);
    expect(t.handlers.data).toBeUndefined();
    expect(p.el.childElementCount).toBe(0);
    v.dispose();
    v.fit();
    expect(s.close).toHaveBeenCalledTimes(1);
    expect(v.text()).toBe('');
  });

  it('text() joins the active buffer lines', () => {
    const v = new TermView(pane().el, { port: 1, token: 't' }, 'a');
    expect(v.text()).toBe('one\ntwo');
    expect(v.copySelection()).toBe('sel');
  });
});
