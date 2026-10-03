import type { ImageUpload, TerminalKey } from '../../../bridge/src/model';

// Small helpers shared by the side panel's parts.

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** "3분 전부터" — how long an agent has been in its current state. */
export function ago(ts: number | null): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}초 전부터`;
  if (s < 3600) return `${Math.round(s / 60)}분 전부터`;
  return `${Math.round(s / 3600)}시간 전부터`;
}

/** Local HH:MM of an ISO timestamp. */
export function clock(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function readAsUpload(file: File): Promise<ImageUpload & { url: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ mediaType: file.type, data: url.slice(url.indexOf(',') + 1), url });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Map a browser key event to a key the bridge can press in an agent's terminal. */
export function terminalKeyFromEvent(e: KeyboardEvent): TerminalKey | { char: string } | null {
  const named: Record<string, TerminalKey> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Enter: 'enter',
    Escape: 'esc',
    Backspace: 'backspace',
    ' ': 'space',
  };
  if (e.key === 'Tab') return e.shiftKey ? 'shift-tab' : 'tab';
  if (e.ctrlKey && e.key.toLowerCase() === 'c') return 'ctrl-c';
  if (named[e.key]) return named[e.key];
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) return { char: e.key };
  return null;
}
