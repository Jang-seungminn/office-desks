import { defineConfig } from 'vite';

const bridge = `http://127.0.0.1:${process.env.OFFICE_DESKS_PORT ?? 4317}`;

export default defineConfig({
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    // Same anti-framing policy as the bridge: the dev UI can also press keys in agent terminals.
    headers: {
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    },
    proxy: {
      '/api': { target: bridge },
      '/ws': { target: bridge, ws: true },
    },
  },
});
