import { hashToken } from '@leadops/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
} from '../test/fixtures.js';
import { withTenantContext } from '../tenancy/context.js';
import {
  consumeTokenAndDecide,
  createApproval,
  createApprovalToken,
  lookupApprovalByToken,
  revokeApprovalToken,
  type CreateApprovalParams,
} from './approvals.js';
import { createIntegration } from './integrations.js';

function sql(value: unknown): postgres.Sql {
  return value as postgres.Sql;
}

describe('Phase 5 approval token security (db)', () => {
  let handle: FixtureHandle;
  let orgId: string;
  let clientId: string;
  let otherOrgId: string;
  let otherClientId: string;
  let integrationId: string;
  let actor: { userId: string; organizationId: string; role: 'agency_owner' };
  let otherActor: { userId: string; organizationId: string; role: 'agency_owner' };

  beforeAll(() => {
    handle = createFixtureHandle();
  });

  beforeEach(async () => {
    await resetSchema(handle);
    const seeded = await seedTenancyFixture(handle);
    orgId = seeded.orgA.id;
    clientId = seeded.clients.a1.id;
    otherOrgId = seeded.orgB.id;
    otherClientId = seeded.clients.b1.id;
    actor = {
      userId: seeded.users.ownerA.id,
      organizationId: orgId,
      role: 'agency_owner',
    };
    otherActor = {
      userId: seeded.users.ownerB.id,
      organizationId: otherOrgId,
      role: 'agency_owner',
    };
    const integration = await withTenantContext(handle.app, actor, async (tx) =>
      createIntegration(sql(tx), {
        organizationId: orgId,
        clientId,
        name: 'approval-token-security',
        callbackUrl: 'https://example.com/approval-result',
      }),
    );
    integrationId = integration.integration.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  function params(): CreateApprovalParams {
    return {
      organizationId: orgId,
      clientId,
      integrationId,
      requestedBy: actor.userId,
      correlationId: `token-${crypto.randomUUID()}`,
      requestVersion: '1',
      snapshot: {
        contactName: 'Token Test',
        company: 'Test Corp',
        message: 'Safe public snapshot',
        score: 80,
      },
    };
  }

  async function createWithToken(ttlSeconds = 3_600) {
    return withTenantContext(handle.app, actor, async (tx) => {
      const approval = await createApproval(sql(tx), params());
      const token = await createApprovalToken(sql(tx), {
        approvalId: approval.id,
        organizationId: orgId,
        clientId,
        ttlSeconds,
      });
      return { approval, token };
    });
  }

  it('stores only the SHA-256 token hash', async () => {
    const { approval, token } = await createWithToken();
    const [stored] = await handle.owner.unsafe<{ token_hash: string }[]>(
      'SELECT token_hash FROM approval_tokens WHERE "approvalId" = $1',
      [approval.id],
    );
    expect(stored?.token_hash).toBe(hashToken(token.token));
    expect(stored?.token_hash).not.toBe(token.token);
    expect(stored?.token_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('consumes a token once and creates exactly one completed delivery', async () => {
    const { approval, token } = await createWithToken();
    const first = await consumeTokenAndDecide(
      handle.app,
      token.token,
      'approved',
      'public_token',
    );
    expect(first).toMatchObject({ decided: true, tokenStatus: 'used', status: 'approved' });

    const replay = await consumeTokenAndDecide(
      handle.app,
      token.token,
      'rejected',
      'public_token',
    );
    expect(replay).toMatchObject({ decided: false, tokenStatus: 'already_used' });

    const [counts] = await handle.owner.unsafe<{ history: string; deliveries: string }[]>(
      `SELECT
         (SELECT count(*) FROM approval_history WHERE "approvalId" = $1
           AND "command" = 'decide_public') AS history,
         (SELECT count(*) FROM approval_deliveries WHERE "approvalId" = $1
           AND message_type = 'approval.completed') AS deliveries`,
      [approval.id],
    );
    expect(counts).toEqual({ history: '1', deliveries: '1' });
  });

  it('rejects revoked and expired tokens precisely', async () => {
    const revoked = await createWithToken();
    await withTenantContext(handle.app, actor, async (tx) =>
      revokeApprovalToken(sql(tx), {
        tokenPlaintext: revoked.token.token,
        organizationId: orgId,
        clientId,
      }),
    );
    expect(await lookupApprovalByToken(handle.app, revoked.token.token)).toMatchObject({
      tokenStatus: 'revoked',
    });

    const expired = await createWithToken(1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await lookupApprovalByToken(handle.app, expired.token.token)).toMatchObject({
      tokenStatus: 'expired',
    });
  });

  it('does not let another tenant revoke a token', async () => {
    const { token } = await createWithToken();
    await expect(
      withTenantContext(handle.app, otherActor, async (tx) =>
        revokeApprovalToken(sql(tx), {
          tokenPlaintext: token.token,
          organizationId: otherOrgId,
          clientId: otherClientId,
        }),
      ),
    ).resolves.toBe(false);
    expect(await lookupApprovalByToken(handle.app, token.token)).toMatchObject({
      tokenStatus: 'valid',
    });
  });

  it('does not enumerate another approval from a valid or forged token', async () => {
    const first = await createWithToken();
    const second = await createWithToken();
    const firstLookup = await lookupApprovalByToken(handle.app, first.token.token);
    const secondLookup = await lookupApprovalByToken(handle.app, second.token.token);
    expect(firstLookup.approvalId).toBe(first.approval.id);
    expect(firstLookup.approvalId).not.toBe(second.approval.id);
    expect(secondLookup.approvalId).toBe(second.approval.id);

    await expect(
      lookupApprovalByToken(handle.app, 'A'.repeat(43)),
    ).resolves.toEqual({
      approvalId: null,
      status: null,
      tokenStatus: 'not_found',
      snapshot: null,
      expiresAt: null,
    });
  });

  it('denies runtime direct reads and writes to the token table', async () => {
    await expect(handle.app.unsafe('SELECT token_hash FROM approval_tokens')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      handle.app.unsafe(
        `INSERT INTO approval_tokens
           ("approvalId", "organizationId", "clientId", token_hash, expires_at)
         VALUES (gen_random_uuid(), $1, $2, 'forged', now())`,
        [orgId, clientId],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
