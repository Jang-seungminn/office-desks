#!/usr/bin/env node
// `npx office-desks` — start the bridge and serve the office UI.
//   --port <n>   listen on another port (default 4317)
//   --backend <orca|native|demo>   pick the backend (default: orca if running, else native)
//   --demo       same as --backend demo
//   --help
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`office-desks needs Node.js 22 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`office-desks — a pixel-art office for your coding agents

Usage: npx office-desks [--port <n>] [--backend orca|native|demo] [--demo]

  --port <n>        port to listen on (default 4317, or OFFICE_DESKS_PORT)
  --backend <kind>  orca: on top of a running Orca app
                    native: run agents in Office Desks itself (no Orca needed)
                    demo: fake office
                    default: orca if Orca is running, otherwise native
  --demo            same as --backend demo

Then open http://127.0.0.1:<port>.`);
  process.exit(0);
}
const portIdx = args.indexOf('--port');
if (portIdx >= 0) {
  const port = Number(args[portIdx + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('--port needs a number between 1 and 65535');
    process.exit(1);
  }
  process.env.OFFICE_DESKS_PORT = String(port);
}
const backendIdx = args.indexOf('--backend');
if (backendIdx >= 0) {
  const kind = args[backendIdx + 1];
  if (!['orca', 'native', 'demo'].includes(kind)) {
    console.error('--backend needs one of: orca, native, demo');
    process.exit(1);
  }
  process.env.OFFICE_DESKS_BACKEND = kind;
}
if (args.includes('--demo')) process.env.OFFICE_DESKS_DEMO = '1';

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'bridge', 'dist', 'server.js')).href);
