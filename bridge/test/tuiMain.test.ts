import { describe, expect, it } from 'vitest';
import { createExit, installRestore, notTtyMessage, pickPort, portFromEnv } from '../src/tui/main.js';
import { ALT_OFF, SHOW_CURSOR } from '../src/tui/screen.js';

describe('pickPort', () => {
  it('keeps an explicit port, else takes the first free one from 4317 up to 4336', async () => {
    expect(await pickPort(5000, true, async () => false)).toBe(5000);
    expect(await pickPort(4317, false, async (p) => p === 4319)).toBe(4319);
    await expect(pickPort(4317, false, async () => false)).rejects.toThrow(/4317/);
  });
});

describe('installRestore', () => {
  it('restores the terminal once, on exit or when called', () => {
    let text = '';
    const raws: boolean[] = [];
    const restore = installRestore({ write: (s: string) => (text += s) }, (on) => raws.push(on));
    restore();
    restore();
    expect(text).toContain(SHOW_CURSOR);
    expect(text).toContain(ALT_OFF);
    expect(text.split(ALT_OFF)).toHaveLength(2);
    expect(raws).toEqual([false]);
  });
});

describe('portFromEnv', () => {
  it('treats an empty or missing OFFICE_DESKS_PORT as unset', () => {
    expect(portFromEnv({})).toEqual({ port: 4317, explicit: false });
    expect(portFromEnv({ OFFICE_DESKS_PORT: '' })).toEqual({ port: 4317, explicit: false });
    expect(portFromEnv({ OFFICE_DESKS_PORT: '5000' })).toEqual({ port: 5000, explicit: true });
  });
});

describe('installRestore on a dead terminal', () => {
  it('does not throw when the terminal is gone (SIGHUP)', () => {
    const restore = installRestore({ write: () => { throw new Error('EIO'); } }, () => { throw new Error('EBADF'); });
    expect(() => restore()).not.toThrow();
  });
});

describe('createExit', () => {
  function rig(opts: { restoreThrows?: boolean; closeThrows?: boolean } = {}) {
    const steps: string[] = [];
    const finish = createExit({
      close: () => {
        steps.push('close');
        if (opts.closeThrows) throw new Error('EIO');
      },
      restore: () => {
        steps.push('restore');
        if (opts.restoreThrows) throw new Error('EIO');
      },
      dispose: async () => void steps.push('dispose'),
      exit: (code) => void steps.push(`exit ${code}`),
      report: (m) => void steps.push(`report ${m}`),
    });
    return { steps, finish };
  }

  it('restores the terminal before disposing, then exits, once: a crash wins over the normal quit it triggers', async () => {
    const { steps, finish } = rig();
    finish(1, 'boom');
    finish(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(steps).toEqual(['close', 'restore', 'report boom', 'dispose', 'exit 1']);
  });

  it('still disposes (agents, settings files) when the terminal is already gone', async () => {
    const { steps, finish } = rig({ restoreThrows: true });
    finish(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(steps).toEqual(['close', 'restore', 'dispose', 'exit 0']);
    const closing = rig({ closeThrows: true });
    closing.finish(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(closing.steps).toEqual(['close', 'restore', 'dispose', 'exit 0']);
  });
});

describe('notTtyMessage', () => {
  it('explains in Korean when stdin or stdout is not a terminal', () => {
    expect(notTtyMessage({ isTTY: true }, { isTTY: true })).toBeNull();
    expect(notTtyMessage({ isTTY: false }, { isTTY: true })).toMatch(/터미널/);
    expect(notTtyMessage({}, { isTTY: true })).toMatch(/--no-tui/);
  });
});
