import type { OfficeSnapshot, OrgChart, ServerMessage, UsageSnapshot } from '../../bridge/src/model';

export type ConnectionState = 'connecting' | 'open' | 'closed';

/** Subscribe to bridge snapshots over WebSocket, reconnecting with backoff. */
export function connectOffice(
  onSnapshot: (s: OfficeSnapshot) => void,
  onConnection: (state: ConnectionState) => void,
  onUsage: (u: UsageSnapshot) => void = () => {},
  onOrg: (o: OrgChart) => void = () => {},
): void {
  let delay = 500;
  const open = () => {
    onConnection('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      delay = 500;
      onConnection('open');
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as ServerMessage;
      if (msg.type === 'snapshot') onSnapshot(msg.snapshot);
      else if (msg.type === 'usage') onUsage(msg.usage);
      else if (msg.type === 'org') onOrg(msg.org);
    };
    ws.onclose = () => {
      onConnection('closed');
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };
  open();
}

export async function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string; requestId?: string };
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, data.code, data.requestId);
  return data as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}
