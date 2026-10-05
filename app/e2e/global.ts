// Global setup and teardown: one harness for every project (chromium, then webkit on macOS).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { startHarness } from './harness';

const APP = fileURLToPath(new URL('..', import.meta.url));
const MARKER = '__gongbangE2E';

/** The text of every script in app/dist (what the harness serves: debug rust-embed reads disk). */
function bundleJs(): string {
  const dir = join(APP, 'dist', 'assets');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

/**
 * Puts the production build back in app/dist (a later `tauri build` must never embed the E2E
 * build), and checks that it cannot turn the fake IPC on: the marker must be dead code there.
 */
async function restoreProductionBuild(): Promise<void> {
  await build({ root: APP, mode: 'production', logLevel: 'warn' });
  if (bundleJs().includes(MARKER)) throw new Error(`the production bundle contains ${MARKER}: the E2E hook is not build-gated`);
  console.log(`[e2e] app/dist rebuilt for production; it has no ${MARKER}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  let js = '';
  try {
    js = bundleJs();
  } catch {
    // reported below
  }
  if (!js.includes(MARKER)) {
    throw new Error(`app/dist is not an E2E build (no ${MARKER}); run: npm run e2e -w app (it builds with vite build --mode e2e)`);
  }
  const { info, stop } = await startHarness();
  process.env.GONGBANG_E2E = JSON.stringify(info);
  return async () => {
    try {
      await stop();
    } finally {
      await restoreProductionBuild();
    }
  };
}
