import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ConversationMessage } from './model.js';

const MAX_BYTES = 20 * 1024 * 1024;

const SIGNATURES: [type: string, test: (b: Buffer) => boolean][] = [
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];

/** Image type from the file's magic bytes, or null if it isn't one of the image formats we serve. */
export function sniffImage(head: Buffer): string | null {
  return SIGNATURES.find(([, test]) => test(head))?.[0] ?? null;
}

/**
 * Only paths the agent or the user actually linked as Markdown (`](path)` / `](<path>)`) in
 * a chat message count; tool-call summaries and stray mentions don't.
 */
export function isLinkedImage(messages: ConversationMessage[], wanted: string): boolean {
  return messages.some(
    (m) => m.role !== 'tool' && (m.text.includes(`](${wanted})`) || m.text.includes(`](<${wanted}>)`) || m.text.includes(`](file://${wanted})`)),
  );
}

/** Read a local image after resolving symlinks and checking it is really an image file. */
export function readLocalImage(wanted: string): { type: string; buf: Buffer } | null {
  let real: string;
  try {
    real = realpathSync(wanted);
  } catch {
    return null;
  }
  if (!/\.(png|jpe?g|gif|webp)$/i.test(real) || !path.isAbsolute(real)) return null;
  const st = statSync(real);
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  const fd = openSync(real, 'r');
  const head = Buffer.alloc(12);
  try {
    readSync(fd, head, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  const type = sniffImage(head);
  return type ? { type, buf: readFileSync(real) } : null;
}
