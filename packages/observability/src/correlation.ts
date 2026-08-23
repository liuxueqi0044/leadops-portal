import { randomUUID } from 'node:crypto';

const CORRELATION_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const HEADER_NAME = 'x-correlation-id';

export function generateCorrelationId(): string {
  return randomUUID();
}

export function validateCorrelationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > 128) return null;
  if (!CORRELATION_ID_REGEX.test(value)) return null;
  return value;
}

export function extractOrGenerateCorrelationId(headers: Headers | Record<string, string | string[] | undefined>): { correlationId: string; wasProvided: boolean } {
  let raw: string | undefined = undefined;

  if (headers instanceof Headers) {
    raw = headers.get(HEADER_NAME) ?? undefined;
  } else {
    const val = headers[HEADER_NAME] ?? headers['x-correlation-id'];
    if (Array.isArray(val)) {
      raw = val[0];
    } else {
      raw = val;
    }
  }

  const validated = raw ? validateCorrelationId(raw) : null;
  if (validated) {
    return { correlationId: validated, wasProvided: true };
  }
  return { correlationId: generateCorrelationId(), wasProvided: false };
}

export function correlationHeaderName(): string {
  return HEADER_NAME;
}

export function sanitizeCorrelationIdForLog(input: unknown): string {
  if (typeof input === 'string' && CORRELATION_ID_REGEX.test(input)) {
    return input;
  }
  return '[INVALID_CORRELATION]';
}
