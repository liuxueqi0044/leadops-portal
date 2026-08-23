import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { middleware } from './middleware.js';

function request(method: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://portal.example.com/api/v1/clients', {
    method,
    headers,
  });
}

function pageRequest(): NextRequest {
  return new NextRequest('https://portal.example.com/?section=overview');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('web security middleware', () => {
  it('rejects credentialed state changes without same-origin evidence', () => {
    const response = middleware(request('POST', { cookie: 'session=value' }));
    expect(response.status).toBe(403);
  });

  it('allows a configured origin without wildcard credential CORS', () => {
    vi.stubEnv('CORS_ORIGIN', 'https://console.example.com');
    const response = middleware(
      request('POST', {
        cookie: 'session=value',
        origin: 'https://console.example.com',
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://console.example.com');
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('rejects cross-origin requests and oversized declared bodies', () => {
    vi.stubEnv('CORS_ORIGIN', 'https://console.example.com');
    expect(middleware(request('POST', { origin: 'https://evil.example.net' })).status).toBe(403);
    expect(
      middleware(
        request('POST', {
          origin: 'https://console.example.com',
          'content-length': String(256 * 1024 + 1),
        }),
      ).status,
    ).toBe(413);
  });

  it('does not permit unsafe-eval in the production CSP', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = middleware(request('GET'));
    expect(response.headers.get('content-security-policy')).not.toContain("'unsafe-eval'");
    expect(response.headers.get('strict-transport-security')).toContain('max-age=63072000');
  });

  it('forwards the preview marker only when explicit demo mode is enabled', () => {
    vi.stubEnv('LEADOPS_DEMO_MODE', 'true');
    const enabled = middleware(pageRequest());
    expect(enabled.headers.get('x-middleware-request-x-leadops-preview')).toBe('1');

    vi.stubEnv('LEADOPS_DEMO_MODE', 'false');
    const disabled = middleware(pageRequest());
    expect(disabled.headers.get('x-middleware-request-x-leadops-preview')).toBeNull();
  });
});
