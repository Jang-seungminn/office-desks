// Keys for the lobby and its prompts. While attached, everything goes to the agent except
// Ctrl+], which can arrive as a raw byte or, if the agent turned on an extended keyboard
// protocol in our terminal, as kitty CSI-u or xterm modifyOtherKeys.

export const ESCAPE_BYTE = '\x1d';
const ESCAPE_FORMS = [ESCAPE_BYTE, '\x1b[93;5u', '\x1b[27;5;93~'];

export type Key =
  | { name: 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'backspace' | 'tab' | 'ctrl-c' | 'ctrl-]' }
  | { name: 'char'; ch: string };

export function isAttachEscape(chunk: string): boolean {
  return ESCAPE_FORMS.some((f) => chunk.includes(f));
}

const SEQUENCES: [string, Key][] = [
  ['\x1b[A', { name: 'up' }], ['\x1bOA', { name: 'up' }],
  ['\x1b[B', { name: 'down' }], ['\x1bOB', { name: 'down' }],
  ['\x1b[C', { name: 'right' }], ['\x1bOC', { name: 'right' }],
  ['\x1b[D', { name: 'left' }], ['\x1bOD', { name: 'left' }],
  ['\x1b[93;5u', { name: 'ctrl-]' }], ['\x1b[27;5;93~', { name: 'ctrl-]' }],
];

export function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    const seq = SEQUENCES.find(([s]) => chunk.startsWith(s, i));
    if (seq) {
      keys.push(seq[1]);
      i += seq[0].length;
      continue;
    }
    const ch = String.fromCodePoint(chunk.codePointAt(i)!);
    i += ch.length;
    if (ch === '\r' || ch === '\n') keys.push({ name: 'enter' });
    else if (ch === '\x7f' || ch === '\x08') keys.push({ name: 'backspace' });
    else if (ch === '\t') keys.push({ name: 'tab' });
    else if (ch === '\x03') keys.push({ name: 'ctrl-c' });
    else if (ch === ESCAPE_BYTE) keys.push({ name: 'ctrl-]' });
    else if (ch === '\x1b') {
      // A lone ESC; skip the rest of an unknown CSI/SS3 sequence so it can't type garbage.
      const m = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O.)/.exec(chunk.slice(i - 1));
      if (m && m[0].length > 1) i += m[0].length - 1;
      else keys.push({ name: 'escape' });
    } else if (ch >= ' ') keys.push({ name: 'char', ch });
  }
  return keys;
}
