// Scratch folders for tests: created under the OS temp dir and removed after the test file
// (afterAll), with a process-exit fallback, so test runs leave nothing in $TMPDIR.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const dirs: string[] = [];

function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

afterAll(cleanup);
process.once('exit', cleanup);

/** A fresh `<tmpdir>/<prefix>XXXXXX` folder, removed when the test file is done. */
export function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
