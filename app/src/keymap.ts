import { isModalOpen } from './modal';
import type { Platform } from './host';

export type AppAction =
  | { kind: 'newWork' }
  | { kind: 'closeTab' }
  | { kind: 'sidebar' }
  | { kind: 'split' }
  | { kind: 'switchTab'; index: number }
  | { kind: 'copy' }
  | { kind: 'paste' };

type Mods = Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

/**
 * Maps a keydown to an app action by the physical key (`code`), never `key`, so the layout and the
 * Korean IME do not matter. macOS: Cmd+key. Windows: Ctrl+Shift+key, so plain Ctrl+T/W/B/\ stay
 * with the agent in the terminal.
 */
export function appAction(e: Mods, p: Platform): AppAction | null {
  if (p === 'mac') {
    if (!(e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey)) return null;
  } else if (!(e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey)) return null;
  switch (e.code) {
    case 'KeyT': return { kind: 'newWork' };
    case 'KeyW': return { kind: 'closeTab' };
    case 'KeyB': return { kind: 'sidebar' };
    case 'Backslash':
    case 'IntlYen': return { kind: 'split' }; // IntlYen: JIS backslash key. IntlBackslash stays unbound.
    case 'KeyC': return p === 'win' ? { kind: 'copy' } : null; // macOS: the Edit menu
    case 'KeyV': return p === 'win' ? { kind: 'paste' } : null;
  }
  const m = /^Digit([1-9])$/.exec(e.code);
  return m ? { kind: 'switchTab', index: Number(m[1]) - 1 } : null;
}

export function shortcutLabel(kind: 'newWork' | 'closeTab' | 'split' | 'sidebar', p: Platform): string {
  const key = { newWork: 'T', closeTab: 'W', split: '\\', sidebar: 'B' }[kind];
  return p === 'mac' ? `⌘${key}` : `Ctrl+Shift+${key}`;
}

/** Page-reload chords. A reload would drop every terminal, so the page cancels them. */
function isReload(e: KeyboardEvent, p: Platform): boolean {
  if (e.code === 'F5') return true;
  if (e.code !== 'KeyR' || e.altKey) return false;
  return p === 'mac' ? e.metaKey : e.ctrlKey;
}

/**
 * Capture-phase listener: runs before xterm's textarea handlers, so xterm never sees an app chord.
 * Only bound chords are consumed; everything else reaches the terminal. IME composition is ignored,
 * and so is everything while a modal is open (Esc/Enter belong to the form).
 */
export function installKeys(w: Window, p: Platform, run: (a: AppAction) => void): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229) return;
    if (isReload(e, p)) {
      // cancel the WebView's reload only; xterm still gets the key (Ctrl+R is reverse-i-search)
      e.preventDefault();
      return;
    }
    if (isModalOpen()) return;
    const a = appAction(e, p);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    run(a);
  };
  w.addEventListener('keydown', onKey, { capture: true });
  return () => w.removeEventListener('keydown', onKey, { capture: true });
}
