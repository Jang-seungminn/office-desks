import { defineConfig } from '@playwright/test';

// One harness (global setup) and one worker: the projects share the server's state, in order.
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  globalSetup: './e2e/global.ts',
  reporter: [['list'], ['html', { open: 'never' }]],
  // No tracing: the specs keep one page for a whole project, and recording its DOM snapshots
  // (xterm's rows) made each WebKit action slower as the run went on (seconds by the end).
  use: { trace: 'off' },
  // The browsers' own user agents, not `devices[...]`: the app picks ⌘ or Ctrl+Shift from the UA,
  // and the specs press the chord of the OS they run on (Desktop Chrome would claim Windows).
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    // WebKit is the macOS webview's engine. It runs after chromium: the project already exists.
    ...(process.platform === 'darwin'
      ? [{ name: 'webkit', use: { browserName: 'webkit' as const }, dependencies: ['chromium'] }]
      : []),
  ],
});
