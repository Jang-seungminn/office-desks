import { describe, expect, it } from 'vitest';
import { isAllowedRequest } from '../src/security.js';

const ports = [4317, 5173];

describe('isAllowedRequest', () => {
  it('allows same-origin and dev-server origins on localhost', () => {
    expect(isAllowedRequest({ host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' }, ports)).toBe(true);
    expect(isAllowedRequest({ host: 'localhost:5173', origin: 'http://localhost:5173' }, ports)).toBe(true);
  });

  it('allows non-browser local tools without Origin', () => {
    expect(isAllowedRequest({ host: '127.0.0.1:4317' }, ports)).toBe(true);
  });

  it('rejects cross-site origins', () => {
    expect(isAllowedRequest({ host: '127.0.0.1:4317', origin: 'https://evil.example' }, ports)).toBe(false);
    expect(isAllowedRequest({ host: '127.0.0.1:4317', origin: 'http://localhost:9999' }, ports)).toBe(false);
    expect(isAllowedRequest({ host: '127.0.0.1:4317', origin: 'null' }, ports)).toBe(false);
  });

  it('rejects cross-site and framed browser requests even without Origin (img tags, iframes)', () => {
    const host = '127.0.0.1:4317';
    expect(isAllowedRequest({ host, 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' }, ports)).toBe(false);
    expect(isAllowedRequest({ host, 'sec-fetch-site': 'same-site' }, ports)).toBe(false);
    expect(isAllowedRequest({ host, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe' }, ports)).toBe(false);
    expect(isAllowedRequest({ host, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }, ports)).toBe(true);
    expect(isAllowedRequest({ host, 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document' }, ports)).toBe(true);
  });

  it('rejects DNS rebinding hosts', () => {
    expect(isAllowedRequest({ host: 'evil.example:4317' }, ports)).toBe(false);
    expect(isAllowedRequest({}, ports)).toBe(false);
  });
});
