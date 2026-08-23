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
  claimApprovalDeliveries,
  createApproval,
  decideApproval,
  type CreateApprovalParams,
} from './approvals.js';
import { createIntegration } from './integrations.js';

function sql(value: unknown): postgres.Sql {
  return value as postgres.Sql;
}

describe('Phase 5 approval concurrency (db)', () => {
  let handle: FixtureHandle;
  let orgId: string;
  let clientId: string;
  let integrationId: string;
  let actor: { userId: string; organizationId: string; role: 'agency_owner' };

  beforeAll(() => {
    handle = createFixtureHandle();
  });

  beforeEach(async () => {
    await resetSchema(handle);
    const seeded = await seedTenancyFixture(handle);
    orgId = seeded.orgA.id;
    clientId = seeded.clients.a1.id;
    actor = {
      userId: seeded.users.ownerA.id,
      organizationId: orgId,
      role: 'agency_owner',
    };
    const integration = await withTenantContext(handle.app, actor, async (tx) =>
      createIntegration(sql(tx), {
        organizationId: orgId,
        clientId,
        name: 'approval-concurrency',
        callbackUrl: 'https://example.com/approval-result',
      }),
    );
    integrationId = integration.integration.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  function buildParams(correlationId: string): CreateApprovalParams {
    return {
      organizationId: orgId,
      clientId,
      integrationId,
      correlationId,
      requestVersion: '1',
      requestedBy: actor.userId,
      snapshot: {
        contactName: 'Concurrent Test',
        company: 'Test Corp',
        message: 'test',
      },
    };
  }

  async function create(correlationId: string, expiresInSeconds?: number) {
    return withTenantContext(handle.app, actor, async (tx) =>
      createApproval(sql(tx), {
        ...buildParams(correlationId),
        expiresInSeconds,
      }),
    );
  }

  async function decide(
    approvalId: string,
    decision: 'approved' | 'rejected',
    expectedVersion?: number,
  ) {
    return withTenantContext(handle.app, actor, async (tx) =>
      decideApproval(sql(tx), {
        approvalId,
        organizationId: orgId,
        clientId,
        decision,
        decidedBy: actor.userId,
        expectedVersion,
      }),
    );
  }

  it('allows exactly one winner across 100 opposite decisions', async () => {
    const approval = await create('concurrent-100');
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        decide(
          approval.id,
          index % 2 === 0 ? 'approved' : 'rejected',
          approval.version,
        ),
      ),
    );

    expect(results.filter((result) => result.decided)).toHaveLength(1);
    expect(results.filter((result) => !result.decided)).toHaveLength(99);

    const [counts] = await handle.owner.unsafe<{
      history: string;
      deliveries: string;
      status: string;
    }[]>(
      `SELECT
         (SELECT count(*) FROM approval_history
           WHERE "approvalId" = $1 AND "command" = 'decide') AS history,
         (SELECT count(*) FROM approval_deliveries
           WHERE "approvalId" = $1 AND message_type = 'approval.completed') AS deliveries,
         (SELECT status FROM approvals WHERE id = $1) AS status`,
      [approval.id],
    );
    expect(counts?.history).toBe('1');
    expect(counts?.deliveries).toBe('1');
    expect(['approved', 'rejected']).toContain(counts?.status);
  }, 20_000);

  it('allows only one terminal transition when expiry races a decision', async () => {
    const approval = await create('expire-decision-race', 1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const [expiredRows, decision] = await Promise.all([
      withTenantContext(handle.app, actor, async (tx) =>
        tx.unsafe(
          'SELECT * FROM expire_pending_approvals($1::uuid, $2::uuid)',
          [orgId, clientId],
        ),
      ),
      decide(approval.id, 'approved', approval.version),
    ]);

    const [stored] = await handle.owner.unsafe<{ status: string; history: string; deliveries: string }[]>(
      `SELECT status,
              (SELECT count(*) FROM approval_history h
                WHERE h."approvalId" = approvals.id
                  AND h."command" IN ('decide', 'expire')) AS history,
              (SELECT count(*) FROM approval_deliveries d
                WHERE d."approvalId" = approvals.id
                  AND d.message_type = 'approval.completed') AS deliveries
       FROM approvals WHERE id = $1`,
      [approval.id],
    );

    expect(['approved', 'expired']).toContain(stored?.status);
    expect(stored?.history).toBe('1');
    expect(stored?.deliveries).toBe('1');
    expect((expiredRows.length === 1 ? 1 : 0) + (decision.decided ? 1 : 0)).toBe(1);
  });

  it('leases one completed delivery to only one worker', async () => {
    const approval = await create('delivery-lease');
    expect((await decide(approval.id, 'approved', approval.version)).decided).toBe(true);

    const [first, second] = await Promise.all([
      claimApprovalDeliveries(handle.worker, 'approval-worker-a', 1),
      claimApprovalDeliveries(handle.worker, 'approval-worker-b', 1),
    ]);
    expect(first.length + second.length).toBe(1);

    const [stored] = await handle.owner.unsafe<{ status: string; lockedBy: string }[]>(
      `SELECT status, "lockedBy" FROM approval_deliveries WHERE "approvalId" = $1`,
      [approval.id],
    );
    expect(stored?.status).toBe('processing');
    expect(['approval-worker-a', 'approval-worker-b']).toContain(stored?.lockedBy);
  });
});
