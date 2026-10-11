import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, removeWorktree, postJson } from '../src/api';

afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: string, type: string) =>
  vi.fn(async () => new Response(body, { status, headers: { 'content-type': type } }));

describe('api', () => {
  it('resolves on 200', async () => {
    vi.stubGlobal('fetch', reply(200, '{"ok":true}', 'application/json'));
    expect(await postJson('/api/x', {})).toEqual({ ok: true });
  });

  it('rejects with ApiError carrying message, status and code', async () => {
    vi.stubGlobal('fetch', reply(409, '{"error":"변경사항이 있는 워크트리는 지울 수 없어요","code":"dirty"}', 'application/json'));
    const err: any = await postJson('/api/remove', {}).catch((e: any) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('변경사항이 있는 워크트리는 지울 수 없어요');
    expect(err.status).toBe(409);
    expect(err.code).toBe('dirty');
  });

  it('non-JSON error body gives HTTP <status>', async () => {
    vi.stubGlobal('fetch', reply(502, 'oops', 'text/plain'));
    const err: any = await postJson('/api/x', {}).catch((e: any) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('HTTP 502');
    expect(err.status).toBe(502);
  });

  it('removeWorktree posts the deskId as JSON', async () => {
    const f = reply(200, '{"ok":true}', 'application/json');
    vi.stubGlobal('fetch', f);
    await removeWorktree('r::/x');
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/remove');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"deskId":"r::/x"}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('network failure becomes ApiError network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fail'); }));
    const err: any = await postJson('/api/x', {}).catch((e: any) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect([err.message, err.status, err.code]).toEqual(['서버에 연결할 수 없어요', 0, 'network']);
  });

  it('non-string error and code are ignored', async () => {
    vi.stubGlobal('fetch', reply(400, '{"error":{"a":1},"code":5}', 'application/json'));
    const err: any = await postJson('/api/x', {}).catch((e: any) => e);
    expect([err.message, err.code]).toEqual(['HTTP 400', undefined]);
  });

  it('2xx with an unparseable body throws bad-body', async () => {
    vi.stubGlobal('fetch', reply(200, 'nope', 'text/plain'));
    const err: any = await postJson('/api/x', {}).catch((e: any) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('bad-body');
  });
});
