import { describe, expect, it } from 'vitest';
import { installRestore, pickPort, portFromEnv } from '../src/tui/main.js';
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
