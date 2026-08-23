import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { Logger } from 'pino';
import type PgBoss from 'pg-boss';

import {
  createApproval,
  createEmailDelivery,
  createIntegration,
  decideApproval,
  withTenantContext,
} from '@leadops/db';
import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
} from '../../../packages/db/src/test/fixtures.js';
import {
  createApprovalDeliveryEnqueueScheduler,
  createApprovalExpireScheduler,
  createEmailDeliveryEnqueueScheduler,
  type SchedulerOptions,
} from './scheduler.js';

function sql(value: unknown): postgres.Sql {
  return value as postgres.Sql;
}

describe('Phase 6A scheduler integration', () => {
  let handle: FixtureHandle;

  beforeAll(() => {
    handle = createFixtureHandle();
  });

  beforeEach(async () => {
    await resetSchema(handle);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('discovers and enqueues expiration, callback, and email jobs without direct table reads', async () => {
    const fixture = await seedTenancyFixture(handle);
    const organizationId = fixture.orgA.id;
    const clientId = fixture.clients.a1.id;
    const actor = {
      userId: fixture.users.ownerA.id,
      organizationId,
      role: 'agency_owner' as const,
    };
    const integration = await withTenantContext(handle.app, actor, async (tx) =>
      createIntegration(sql(tx), {
        organizationId,
        clientId,
        name: 'phase6-scheduler-integration',
        callbackUrl: 'https://example.com/approval-result',
      }),
    );
    const integrationId = integration.integration.id;

    await withTenantContext(handle.app, actor, async (tx) => {
      const scoped = sql(tx);
      await createApproval(scoped, {
        organizationId,
        clientId,
        integrationId,
        correlationId: 'phase6-expiration-job',
        requestedBy: actor.userId,
        expiresInSeconds: -1,
        snapshot: { contactName: 'Expired approval' },
      });
      const decided = await createApproval(scoped, {
        organizationId,
        clientId,
        integrationId,
        correlationId: 'phase6-callback-job',
        requestedBy: actor.userId,
        snapshot: { contactName: 'Decided approval' },
      });
      await decideApproval(scoped, {
        approvalId: decided.id,
        organizationId,
        clientId,
        decision: 'approved',
        decidedBy: actor.userId,
        expectedVersion: decided.version,
      });
      await createEmailDelivery(scoped, {
        organizationId,
        clientId,
        integrationId,
        templateName: 'approval-result',
        toEmail: 'customer@example.com',
        subject: 'Approved',
        htmlBody: '<p>Approved</p>',
        textBody: 'Approved',
        idempotencyKey: 'phase6-email-job',
      });
    });

    const send = vi
      .fn<(name: string, payload: unknown, options: unknown) => Promise<string>>()
      .mockResolvedValue('job-id');
    const logger = { info: vi.fn(), error: vi.fn() } as unknown as Logger;
    const schedulerOptions: SchedulerOptions = {
      logger,
      sql: handle.worker,
      workerId: 'phase6-scheduler',
      pollIntervalMs: 60_000,
      batchSize: 10,
      getBoss: () => ({ send } as unknown as PgBoss),
    };

    await createApprovalExpireScheduler(schedulerOptions).runOnce();
    await createApprovalDeliveryEnqueueScheduler(schedulerOptions).runOnce();
    await createEmailDeliveryEnqueueScheduler(schedulerOptions).runOnce();

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map((call) => call[0])).toEqual([
      'approvals.expire',
      'approvals.deliver-result',
      'emails.send',
    ]);
    for (const call of send.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({
        schemaVersion: 1,
        organizationId,
        clientId,
        integrationId,
      }));
    }
  });
});
