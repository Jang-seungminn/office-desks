import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { relayScript } from '../src/native/hooks.js';

function runRelay(input: string, env: Record<string, string>): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [relayScript()], { env: { ...process.env, ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('exit', (code) => resolve(code));
    p.stdin.end(input);
  });
}

describe('hook-relay.mjs', () => {
  it('posts the hook JSON to OFFICE_DESKS_HOOK_URL', async () => {
    let got = '';
    const server = createServer((req, res) => {
      req.setEncoding('utf8').on('data', (d: string) => (got += d)).on('end', () => res.end());
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const code = await runRelay('{"hook_event_name":"Stop"}', { OFFICE_DESKS_HOOK_URL: `http://127.0.0.1:${port}/hook/a?token=t` });
    server.close();
    expect(code).toBe(0);
    expect(JSON.parse(got)).toEqual({ hook_event_name: 'Stop' });
  });

  it('never fails the agent: no URL or an unreachable bridge still exits 0', async () => {
    expect(await runRelay('{}', { OFFICE_DESKS_HOOK_URL: '' })).toBe(0);
    expect(await runRelay('{}', { OFFICE_DESKS_HOOK_URL: 'http://127.0.0.1:9/hook/a?token=t' })).toBe(0);
  });
});
