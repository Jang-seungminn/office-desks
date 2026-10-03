import type { TerminalKey } from './model.js';

/** Raw bytes for each key the web panel may press. Anything else is rejected. */
export const KEY_BYTES: Record<TerminalKey, string> = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  space: ' ',
  'ctrl-c': '\x03',
  backspace: '\x7f',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  y: 'y',
  n: 'n',
};

export function keyBytes(key: unknown): string | null {
  return typeof key === 'string' && Object.hasOwn(KEY_BYTES, key) ? KEY_BYTES[key as TerminalKey] : null;
}

/** One printable character (no control characters, no escape sequences). */
export function charBytes(ch: unknown): string | null {
  if (typeof ch !== 'string' || [...ch].length !== 1) return null;
  return /^[\p{L}\p{N}\p{P}\p{S} ]$/u.test(ch) ? ch : null;
}
