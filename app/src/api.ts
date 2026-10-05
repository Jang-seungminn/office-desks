export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) throw new ApiError(json?.error ?? `HTTP ${res.status}`, res.status, json?.code);
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
