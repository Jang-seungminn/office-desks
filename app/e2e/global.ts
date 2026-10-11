// Global setup and teardown: one harness for every project (chromium, then webkit on macOS).
// The E2E build lives in app/dist-e2e; the production app/dist is never touched.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_DIST, startHarness } from './harness';

const MARKER = '__gongbangE2E';

export default async function globalSetup(): Promise<() => Promise<void>> {
  let js = '';
  try {
    const dir = join(E2E_DIST, 'assets');
    js = readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
  } catch {
    // reported below
  }
  if (!js.includes(MARKER)) {
    throw new Error(`${E2E_DIST} is not an E2E build (no ${MARKER}); run: npm run e2e -w app (it builds with --mode e2e first)`);
  }
  const { info, stop } = await startHarness();
  process.env.GONGBANG_E2E = JSON.stringify(info);
  // stop() runs every check and reports all failures together (AggregateError).
  return stop;
}
