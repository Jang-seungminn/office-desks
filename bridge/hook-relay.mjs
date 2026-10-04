// Claude Code hook → Office Desks bridge. Claude runs this for each hook event with the event
// JSON on stdin; we POST it to the bridge that spawned the agent. It must never block or fail
// the agent, so every error is swallowed and the exit code is always 0.
const url = process.env.OFFICE_DESKS_HOOK_URL;
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (body += d));
process.stdin.on('end', async () => {
  if (url) {
    try {
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(2000) });
    } catch {
      /* the bridge may be gone; the agent goes on */
    }
  }
  process.exit(0);
});
