import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'X-DNS-Prefetch-Control': 'off',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
];

const WINDOW_MS = 60_000;
const RATE_BUCKETS = new Map<string, { count: number; resetAt: number }>();

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function applySecurityHeaders(headers: Headers): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  const directives = isProduction()
    ? PRODUCTION_CSP
    : PRODUCTION_CSP.map((directive) =>
        directive.startsWith('script-src ')
          ? `${directive} 'unsafe-eval'`
          : directive.startsWith('connect-src ')
            ? `${directive} http://localhost:* ws://localhost:*`
            : directive,
      );
  headers.set('Content-Security-Policy', directives.join('; '));
  if (isProduction()) {
    headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
}

function configuredOrigins(): Set<string> {
  const values = [process.env.CORS_ORIGIN, process.env.BETTER_AUTH_URL]
    .flatMap((value) => value?.split(',') ?? [])
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter((value) => value.length > 0 && value !== '*');
  return new Set(values);
}

function requestOrigin(request: NextRequest): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  try {
    return new URL(origin).origin;
  } catch {
    return 'invalid';
  }
}

function isAllowedOrigin(request: NextRequest, origin: string): boolean {
  if (origin === request.nextUrl.origin) return true;
  if (configuredOrigins().has(origin)) return true;
  if (!isProduction()) {
    try {
      const parsed = new URL(origin);
      return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  }
  return false;
}

function jsonError(status: number, error: string, baseHeaders: Headers): NextResponse {
  return NextResponse.json({ error }, { status, headers: baseHeaders });
}

function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded ?? request.headers.get('x-real-ip') ?? 'unknown';
}

function isRateLimited(request: NextRequest): { limited: boolean; retryAfter: number } {
  const now = Date.now();
  if (RATE_BUCKETS.size > 10_000) {
    for (const [key, bucket] of RATE_BUCKETS) {
      if (bucket.resetAt <= now) RATE_BUCKETS.delete(key);
    }
  }
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
  const limit = mutating ? 120 : 600;
  const key = `${clientKey(request)}:${mutating ? 'write' : 'read'}`;
  const current = RATE_BUCKETS.get(key);
  if (!current || current.resetAt <= now) {
    RATE_BUCKETS.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { limited: false, retryAfter: 0 };
  }
  current.count += 1;
  return {
    limited: current.count > limit,
    retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

function bodyLimitFor(pathname: string): number {
  return pathname === '/api/v1/events' ? 1024 * 1024 : 256 * 1024;
}

export function middleware(request: NextRequest): NextResponse {
  const headers = new Headers();
  applySecurityHeaders(headers);
  const requestHeaders = new Headers(request.headers);
  if (process.env.LEADOPS_DEMO_MODE === 'true') requestHeaders.set('x-leadops-preview', '1');

  const { pathname } = request.nextUrl;
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next({ request: { headers: requestHeaders }, headers });
  }

  const origin = requestOrigin(request);
  if (origin && !isAllowedOrigin(request, origin)) {
    return jsonError(403, 'Origin is not allowed', headers);
  }
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Vary', 'Origin');
  }
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-correlation-id');

  if (request.method === 'OPTIONS') {
    if (!origin) return jsonError(400, 'Origin header is required', headers);
    return new NextResponse(null, { status: 204, headers });
  }

  const rate = isRateLimited(request);
  if (rate.limited) {
    headers.set('Retry-After', String(rate.retryAfter));
    return jsonError(429, 'Rate limit exceeded', headers);
  }

  // The event endpoint performs a streaming byte limit itself so it can keep
  // its signed-webhook error contract without trusting Content-Length.
  if (pathname !== '/api/v1/events' && ['POST', 'PUT', 'PATCH'].includes(request.method)) {
    const declaredLength = request.headers.get('content-length');
    if (declaredLength && Number(declaredLength) > bodyLimitFor(pathname)) {
      return jsonError(413, 'Request body is too large', headers);
    }
  }

  const mutating = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method);
  const csrfExempt =
    pathname.startsWith('/api/v1/events') || pathname.includes('/approvals/public/');
  const hasSessionCookie = request.headers.has('cookie');
  if (mutating && !csrfExempt && hasSessionCookie) {
    const source =
      origin ??
      (() => {
        const referer = request.headers.get('referer');
        try {
          return referer ? new URL(referer).origin : null;
        } catch {
          return 'invalid';
        }
      })();
    if (!source || !isAllowedOrigin(request, source)) {
      return jsonError(403, 'CSRF validation failed', headers);
    }
  }

  return NextResponse.next({ headers });
}

export const config = {
  matcher: [
    '/((?!api/health|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
