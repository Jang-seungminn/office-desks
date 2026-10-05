// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isE2E, pickFolder, platform, termConfig } from '../src/host';

afterEach(() => {
  delete (window as any).__TAURI_INTERNALS__;
});

describe('host', () => {
  it('platform from user agent', () => {
    expect(platform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('mac');
    expect(platform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('win');
  });

  it('calls invoke by command name', async () => {
    const invoke = vi.fn(async (c: string) => (c === 'term_config' ? { port: 5, token: 't' } : null));
    (window as any).__TAURI_INTERNALS__ = { invoke, __gongbangE2E: true };
    expect(await termConfig()).toEqual({ port: 5, token: 't' });
    expect(invoke.mock.calls[0][0]).toBe('term_config');
    expect(await pickFolder()).toBeNull();
    expect(isE2E()).toBe(true);
  });

  it('isE2E is false without the flag', () => {
    expect(isE2E()).toBe(false);
  });
});
