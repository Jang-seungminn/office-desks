import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { officeHome } from '../src/home.js';
import { Registry } from '../src/native/registry.js';

describe('officeHome', () => {
  it('honors OFFICE_DESKS_HOME, else ~/.office-desks', () => {
    expect(officeHome({ OFFICE_DESKS_HOME: '/tmp/od' })).toBe('/tmp/od');
    expect(officeHome({})).toBe(path.join(os.homedir(), '.office-desks'));
  });
});

describe('Registry', () => {
  it('persists repos and desk metadata atomically and reloads them', async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'od-reg-')), 'state.json');
    const r = new Registry(file);
    await r.load();
    expect(r.repos).toEqual([]);
    await r.addRepo({ id: 'abc', path: '/p/app', name: 'app' });
    await r.addRepo({ id: 'abc', path: '/p/app', name: 'app' });
    await r.setMeta('abc::/p/app', { workspaceStatus: 'in-review', comment: 'hi' });
    await r.setMeta('abc::/p/app', { comment: '' });

    const again = new Registry(file);
    await again.load();
    expect(again.repos).toEqual([{ id: 'abc', path: '/p/app', name: 'app' }]);
    expect(again.meta('abc::/p/app')).toEqual({ workspaceStatus: 'in-review' });
    expect(again.meta('nope')).toEqual({});
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
  });
});
