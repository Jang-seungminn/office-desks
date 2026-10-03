#!/usr/bin/env node
// `npx office-desks` — start the bridge and serve the office UI.
//   --port <n>   listen on another port (default 4317)
//   --demo       fake office, no Orca needed
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
  console.log(`office-desks — a pixel-art office over your Orca agents

Usage: npx office-desks [--port <n>] [--demo]

  --port <n>  port to listen on (default 4317, or OFFICE_DESKS_PORT)
  --demo      run with fake data, no Orca needed

Then open http://127.0.0.1:<port>. Orca must be running with its CLI on PATH
(set ORCA_CLI_COMMAND to point at it otherwise).`);
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
if (args.includes('--demo')) process.env.OFFICE_DESKS_DEMO = '1';

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'bridge', 'dist', 'server.js')).href);
