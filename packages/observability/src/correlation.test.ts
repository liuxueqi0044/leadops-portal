import { describe, expect, it } from 'vitest';
import { generateCorrelationId, validateCorrelationId, extractOrGenerateCorrelationId, sanitizeCorrelationIdForLog } from './correlation.js';

describe('generateCorrelationId', () => {
  it('generates a valid UUID', () => {
    const id = generateCorrelationId();
    expect(id).toBeTypeOf('string');
    expect(id.length).toBe(36);
  });

  it('generates unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateCorrelationId()));
    expect(ids.size).toBe(100);
  });
});

describe('validateCorrelationId', () => {
  it('accepts a valid correlation ID', () => {
    expect(validateCorrelationId('abc123-xyz_456')).toBe('abc123-xyz_456');
    expect(validateCorrelationId('aBcDeF0123456789-_')).toBe('aBcDeF0123456789-_');
  });

  it('accepts a UUID', () => {
    const id = generateCorrelationId();
    expect(validateCorrelationId(id)).toBe(id);
  });

  it('rejects empty string', () => {
    expect(validateCorrelationId('')).toBeNull();
  });

  it('rejects null and non-strings', () => {
    expect(validateCorrelationId(null)).toBeNull();
    expect(validateCorrelationId(undefined)).toBeNull();
    expect(validateCorrelationId(123)).toBeNull();
  });

  it('rejects strings with dangerous characters', () => {
    expect(validateCorrelationId('abc<script>')).toBeNull();
    expect(validateCorrelationId('abc; drop table')).toBeNull();
    expect(validateCorrelationId("abc' OR 1=1")).toBeNull();
    expect(validateCorrelationId('abc${env:SECRET}')).toBeNull();
  });

  it('rejects overly long strings', () => {
    expect(validateCorrelationId('a'.repeat(129))).toBeNull();
    expect(validateCorrelationId('a'.repeat(128))).not.toBeNull();
  });
});

describe('extractOrGenerateCorrelationId', () => {
  it('extracts from Headers object', () => {
    const headers = new Headers();
    headers.set('x-correlation-id', 'test-id-123');
    const result = extractOrGenerateCorrelationId(headers);
    expect(result.correlationId).toBe('test-id-123');
    expect(result.wasProvided).toBe(true);
  });

  it('extracts from plain object', () => {
    const result = extractOrGenerateCorrelationId({ 'x-correlation-id': 'test-id-456' });
    expect(result.correlationId).toBe('test-id-456');
    expect(result.wasProvided).toBe(true);
  });

  it('generates new ID when no header present', () => {
    const headers = new Headers();
    const result = extractOrGenerateCorrelationId(headers);
    expect(result.correlationId).toBeTypeOf('string');
    expect(result.wasProvided).toBe(false);
  });

  it('generates new ID when header is invalid', () => {
    const headers = new Headers();
    headers.set('x-correlation-id', '<script>alert(1)</script>');
    const result = extractOrGenerateCorrelationId(headers);
    expect(result.wasProvided).toBe(false);
    expect(result.correlationId.length).toBe(36);
  });
});

describe('sanitizeCorrelationIdForLog', () => {
  it('returns valid value', () => {
    expect(sanitizeCorrelationIdForLog('abc-123')).toBe('abc-123');
  });

  it('returns marker for invalid values', () => {
    expect(sanitizeCorrelationIdForLog('<script>')).toBe('[INVALID_CORRELATION]');
    expect(sanitizeCorrelationIdForLog(null)).toBe('[INVALID_CORRELATION]');
    expect(sanitizeCorrelationIdForLog(123)).toBe('[INVALID_CORRELATION]');
  });
});
