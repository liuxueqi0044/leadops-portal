import { describe, expect, it } from 'vitest';

import { approvalsListQuerySchema } from './dto.js';

describe('approval list query DTO', () => {
  const clientId = '00000000-0000-4000-8000-000000000001';

  it('accepts a canonical keyset cursor and bounded limit', () => {
    const cursor = Buffer.from(
      '2026-08-12T00:00:00.000Z|00000000-0000-4000-8000-000000000002',
      'utf8',
    ).toString('base64url');

    expect(
      approvalsListQuerySchema.safeParse({ clientId, cursor, limit: '50', status: 'pending' })
        .success,
    ).toBe(true);
  });

  it('rejects malformed cursors and unsafe query values', () => {
    expect(approvalsListQuerySchema.safeParse({ clientId, cursor: 'not-a-cursor' }).success).toBe(
      false,
    );
    expect(approvalsListQuerySchema.safeParse({ clientId, limit: 101 }).success).toBe(false);
    expect(approvalsListQuerySchema.safeParse({ clientId, status: 'unknown' }).success).toBe(false);
  });
});
