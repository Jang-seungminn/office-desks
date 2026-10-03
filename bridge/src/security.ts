import type { IncomingHttpHeaders, ServerResponse } from 'node:http';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocal(hostPort: string, allowedPorts: number[]): boolean {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostPort);
  if (!m) return false;
  const [, hostname, port] = m;
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase()) && port !== undefined && allowedPorts.includes(Number(port));
}

/**
 * The bridge can type into local terminals, so a random website must not be able to
 * reach it from the user's browser. Reject DNS-rebinding (Host), cross-site (Origin,
 * Sec-Fetch-Site) and framed (Sec-Fetch-Dest) requests. Requests without these headers
 * come from non-browser local tools and are allowed.
 */
export function isAllowedRequest(headers: IncomingHttpHeaders, allowedPorts: number[]): boolean {
  if (!headers.host || !isLocal(headers.host, allowedPorts)) return false;
  // Browsers label every request; only our own pages ("same-origin") or a typed URL ("none") may pass.
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const dest = headers['sec-fetch-dest'];
  if (dest === 'iframe' || dest === 'frame' || dest === 'embed' || dest === 'object') return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && isLocal(u.host, allowedPorts);
  } catch {
    return false;
  }
}

/** Headers on every response: no framing (clickjacking), no sniffing, no referrer, strict CSP. */
export function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      // Remote images are never loaded: agent output could use them as a tracking/exfiltration beacon.
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "object-src 'none'",
    ].join('; '),
  );
}
