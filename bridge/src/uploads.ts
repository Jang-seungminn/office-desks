import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ImageUpload } from './model.js';

// Images pasted into the web UI are written to a temp folder and handed to the agent by
// path: Claude Code and Codex can both open an image file path they are given.

/**
 * Per-user folder: on Linux /tmp is shared, so another user must not be able to pre-create
 * it, read pasted screenshots or swap them before the agent opens them.
 */
function defaultUploadDir(): string {
  const runtime = process.platform === 'linux' ? process.env.XDG_RUNTIME_DIR : undefined;
  const uid = typeof process.getuid === 'function' ? `-${process.getuid()}` : '';
  return runtime ? path.join(runtime, 'office-desks', 'uploads') : path.join(os.tmpdir(), `office-desks${uid}`, 'uploads');
}

export const UPLOAD_DIR = defaultUploadDir();

/** Create the folder 0700 and refuse one that is a symlink or owned by someone else. */
async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Check our own folders (…/office-desks-<uid> and …/uploads), not the system temp root.
  const ours = path.basename(path.dirname(dir)).startsWith('office-desks') ? [path.dirname(dir), dir] : [dir];
  for (const d of ours) {
    const st = await lstat(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UploadError('업로드 폴더가 올바르지 않습니다');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new UploadError('업로드 폴더의 소유자가 다릅니다');
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) await chmod(d, 0o700);
  }
}
export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const KEEP_MS = 24 * 60 * 60 * 1000;

export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export class UploadError extends Error {}

export async function saveImages(images: ImageUpload[] | undefined, dir = UPLOAD_DIR): Promise<string[]> {
  if (!images?.length) return [];
  if (images.length > MAX_IMAGES) throw new UploadError(`이미지는 한 번에 ${MAX_IMAGES}장까지 보낼 수 있습니다`);
  await ensurePrivateDir(dir);
  const paths: string[] = [];
  for (const img of images) {
    const ext = IMAGE_TYPES[img?.mediaType];
    if (!ext || typeof img.data !== 'string') throw new UploadError('지원하지 않는 이미지 형식입니다 (png, jpg, gif, webp)');
    const buf = Buffer.from(img.data, 'base64');
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new UploadError('이미지가 비어 있거나 10MB를 넘습니다');
    const file = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`);
    await writeFile(file, buf, { mode: 0o600, flag: 'wx' });
    paths.push(file);
  }
  return paths;
}

/** The text typed into the agent: the message, then one image path per line. */
export function composePrompt(text: string, imagePaths: string[]): string {
  const body = text.trim();
  if (!imagePaths.length) return body;
  return [body, ...imagePaths].filter(Boolean).join('\n');
}

/** Resolve a served upload by bare file name only, so the route can't escape the folder. */
export function uploadPath(name: string, dir = UPLOAD_DIR): string | null {
  if (!/^[\w-]+\.(png|jpg|gif|webp)$/.test(name)) return null;
  return path.join(dir, name);
}

export async function cleanOldUploads(dir = UPLOAD_DIR, now = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names.map(async (n) => {
      const f = path.join(dir, n);
      const st = await stat(f).catch(() => null);
      if (st && now - st.mtimeMs > KEEP_MS) await rm(f, { force: true });
    }),
  );
}
