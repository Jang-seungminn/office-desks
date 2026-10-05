import { defineConfig } from 'vitest/config';
// Served by od-server under /app/ (same origin as /api, /ws and /term).
export default defineConfig({
  base: '/app/',
  // Playwright's specs live in e2e/ (npm run e2e); vitest runs test/ only.
  test: { include: ['test/**/*.test.ts'] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    // od-server's MIME table knows .html .js .css .png .json .svg; with nosniff a script or
    // stylesheet under another extension would be refused.
    rollupOptions: { output: { entryFileNames: 'assets/[name]-[hash].js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' } },
  },
});
