export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * POST JSON to the same origin. Always resolves with the parsed JSON body, never null:
 * a 2xx whose body is not JSON throws ApiError(code 'bad-body'); a network failure throws
 * ApiError(status 0, code 'network').
 */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('서버에 연결할 수 없어요', 0, 'network');
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = typeof json?.error === 'string' ? json.error : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, typeof json?.code === 'string' ? json.code : undefined);
  }
  if (json === null || typeof json !== 'object') {
    throw new ApiError('서버 응답을 읽을 수 없어요', res.status, 'bad-body');
  }
  return json as T;
}

export interface HireBody { agent: string; repoId?: string; deskId?: string; name?: string; baseBranch?: string; prompt?: string }

export function hire(b: HireBody): Promise<{ ok: true; warning?: string }> {
  return postJson('/api/hire', b);
}
export async function addRepo(path: string): Promise<void> {
  await postJson('/api/repos', { path });
}
export async function stopAgent(agentId: string): Promise<void> {
  await postJson('/api/stop', { agentId });
}
export async function removeWorktree(deskId: string): Promise<void> {
  await postJson('/api/remove', { deskId });
}
