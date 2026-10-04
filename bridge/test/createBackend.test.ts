import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBackend, probeOrca } from '../src/backend/index.js';

const home = () => mkdtempSync(path.join(os.tmpdir(), 'od-cb-'));

describe('createBackend', () => {
  it('honors OFFICE_DESKS_BACKEND and OFFICE_DESKS_DEMO without probing', async () => {
    const never = async () => {
      throw new Error('should not probe');
    };
    expect((await createBackend({ OFFICE_DESKS_BACKEND: 'orca' }, undefined, { port: 1, probeOrca: never })).name).toBe('orca');
    expect((await createBackend({ OFFICE_DESKS_DEMO: '1' }, undefined, { port: 1, probeOrca: never })).name).toBe('demo');
    const native = await createBackend({ OFFICE_DESKS_BACKEND: 'native', OFFICE_DESKS_HOME: home() }, undefined, { port: 1, probeOrca: never });
    expect(native.name).toBe('native');
    await native.dispose();
    await expect(createBackend({ OFFICE_DESKS_BACKEND: 'tmux' }, undefined, { port: 1, probeOrca: never })).rejects.toThrow(/OFFICE_DESKS_BACKEND/);
  });

  it('uses Orca when it answers, otherwise runs natively', async () => {
    expect((await createBackend({}, undefined, { port: 1, probeOrca: async () => true })).name).toBe('orca');
    const native = await createBackend({ OFFICE_DESKS_HOME: home() }, undefined, { port: 1, probeOrca: async () => false });
    expect(native.name).toBe('native');
    await native.dispose();
  });
});

describe('probeOrca', () => {
  it('is true only when the Orca runtime is reachable', async () => {
    expect(await probeOrca(async () => ({ app: { running: true }, runtime: { reachable: true } }))).toBe(true);
    expect(await probeOrca(async () => ({ app: { running: true }, runtime: { reachable: false } }))).toBe(false);
    expect(
      await probeOrca(async () => {
        throw new Error('not found');
      }),
    ).toBe(false);
  });
});
